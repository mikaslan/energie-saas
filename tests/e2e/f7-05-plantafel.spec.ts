import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F7.05 Plantafel (Slice 1, Lesepfad) — Chromium-E2E.
 *
 * E2E-01: Seed-Termin (per Direkt-SQL mit Actor-Kontext, M1-15-Muster) auf
 * dem f93-Projekt erscheint in der Wochentafel in der Editor-Zeile; Klick
 * öffnet den Drawer mit Projekt-Link; Folgenwoche blendet ihn aus;
 * ungültiges ?week= fällt tolerant auf die laufende Woche zurück.
 * Eigenes Datum (Juni 2025, vergangen → stört keine Upcoming-Ansichten).
 */

type E2EState = {
  serverLogPath: string;
  databaseUrl: string;
  w3WorkspaceId: string;
  f93ProjectId: string;
  editorEmail: string;
};

const APPOINTMENT_TITLE = "F705-Planken-Termin";
const WEEK_MONDAY = "2026-06-08";
const NEXT_MONDAY = "2026-06-15";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "databaseUrl",
    "w3WorkspaceId",
    "f93ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F7.05-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

async function seedBoardAppointment(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  // Eigener Client + Transaktion: SET LOCAL (app.actor_id) gilt nur dort
  // (Muster m115-Erasure-Test — der Guard verlangt Actor-Kontext).
  const seed = await pool.connect();
  try {
    const membership = await seed.query<{ membership_id: string; user_id: string }>(
      `select m.id as membership_id, m.user_id
         from membership m
         join user_identity u on u.id = m.user_id
        where m.workspace_id = $1::uuid and u.email = $2
        limit 1`,
      [data.w3WorkspaceId, data.editorEmail],
    );
    const membershipId = membership.rows[0]?.membership_id;
    const userId = membership.rows[0]?.user_id;
    if (!membershipId || !userId) throw new Error("Editor-Membership für F7.05 fehlt.");
    await seed.query("begin");
    await seed.query("select pg_catalog.set_config('app.actor_id', $1, true)", [userId]);
    await seed.query(
      `insert into calendar (id, workspace_id, name, calendar_type, created_by)
       select $1::uuid, $2::uuid, 'F7-05 E2E Kalender', 'tenancy', $3::uuid
        where not exists (
          select 1 from calendar
           where workspace_id = $2::uuid and name = 'F7-05 E2E Kalender'
        )`,
      [randomUUID(), data.w3WorkspaceId, userId],
    );
    const calendar = await seed.query<{ id: string }>(
      `select id from calendar where workspace_id = $1::uuid and name = 'F7-05 E2E Kalender' limit 1`,
      [data.w3WorkspaceId],
    );
    const calendarId = calendar.rows[0]?.id;
    if (!calendarId) throw new Error("F7-05 E2E-Kalender fehlt.");
    await seed.query(
      `insert into project_appointment (
         id, workspace_id, project_id, title, start_at, end_at,
         all_day, appointment_type, calendar_id, created_by
       )
       select $1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6::timestamptz,
              false, 'on_site', $7::uuid, $8::uuid
        where not exists (
          select 1 from project_appointment
           where workspace_id = $2::uuid and title = $4
        )`,
      [
        randomUUID(),
        data.w3WorkspaceId,
        data.f93ProjectId,
        APPOINTMENT_TITLE,
        "2026-06-09T10:00:00+02:00",
        "2026-06-09T11:00:00+02:00",
        calendarId,
        userId,
      ],
    );
    const appointment = await seed.query<{ id: string }>(
      `select id from project_appointment
        where workspace_id = $1::uuid and title = $2 limit 1`,
      [data.w3WorkspaceId, APPOINTMENT_TITLE],
    );
    const appointmentId = appointment.rows[0]?.id;
    if (!appointmentId) throw new Error("F7-05 Seed-Termin fehlt.");
    await seed.query(
      `insert into project_appointment_attendee (workspace_id, appointment_id, membership_id)
       select $1::uuid, $2::uuid, $3::uuid
        where not exists (
          select 1 from project_appointment_attendee
           where workspace_id = $1::uuid and appointment_id = $2::uuid
             and membership_id = $3::uuid
        )`,
      [data.w3WorkspaceId, appointmentId, membershipId],
    );
    await seed.query("commit");
  } finally {
    seed.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function otpFromPrivateDevMailLog(
  logPath: string,
  email: string,
  byteOffset: number,
): Promise<string> {
  const deadline = Date.now() + 12_000;
  const pattern = new RegExp(
    `\\[dev-mail\\] an ${escapeRegExp(email)}: Dein Login-Code\\s+Code: (\\d{6})`,
    "u",
  );
  while (Date.now() < deadline) {
    const log = readFileSync(logPath);
    const tail = log.subarray(Math.min(byteOffset, log.byteLength)).toString("utf8");
    const match = pattern.exec(tail);
    if (match) return match[1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
  const current = new URL(page.url());
  expect(current.pathname).toBe("/login");
  expect(current.searchParams.get("next")).toBe(expectedPath);

  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);

  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset));
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST");
  try {
    await page.getByRole("button", { name: "Anmelden" }).click();
    expect((await signInResponsePromise).status()).toBe(200);
  } finally {
    if (await otpInput.isVisible().catch(() => false)) {
      await otpInput.fill("").catch(() => undefined);
    }
  }
  await page.waitForURL((url) => url.pathname === expectedPath);
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

test("F7.05-E2E-01: Plantafel zeigt Termin, Drawer verlinkt das Projekt", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackErrors(page);
  await seedBoardAppointment();

  const url = `/w/${data.w3WorkspaceId}/plantafel?week=${WEEK_MONDAY}`;
  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, `/w/${data.w3WorkspaceId}/plantafel`);
  // Nach Login erneut die Seed-Woche öffnen (Login schluckt Query-Params).
  await page.goto(url);

  await expect(page.getByRole("heading", { name: "Plantafel", exact: true })).toBeVisible();
  await expect(page.getByText(`Woche ${WEEK_MONDAY} bis 2026-06-14`, { exact: true })).toBeVisible();

  // Editor-Zeile mit Seed-Termin.
  const row = page.locator("tbody tr").filter({ hasText: data.editorEmail });
  await expect(row.getByText(APPOINTMENT_TITLE, { exact: true })).toBeVisible();

  // Drawer mit Projekt-Link.
  await row.getByText(APPOINTMENT_TITLE, { exact: true }).click();
  await expect(page.getByRole("heading", { name: APPOINTMENT_TITLE, exact: true })).toBeVisible();
  const projectLink = page.getByRole("link", { name: /Zum Projekt/ });
  await expect(projectLink).toBeVisible();
  await projectLink.click();
  await page.waitForURL((url) => url.pathname === `/w/${data.w3WorkspaceId}/anfragen/${data.f93ProjectId}`);

  // Folgenwoche: Termin herausgefiltert.
  await page.goto(`/w/${data.w3WorkspaceId}/plantafel?week=${NEXT_MONDAY}`);
  await expect(page.getByText(`Woche ${NEXT_MONDAY} bis 2026-06-21`, { exact: true })).toBeVisible();
  await expect(page.getByText(APPOINTMENT_TITLE, { exact: true })).toHaveCount(0);

  // Ungültige Woche: tolerant auf laufende Woche, kein Crash.
  await page.goto(`/w/${data.w3WorkspaceId}/plantafel?week=kein-datum`);
  await expect(page.getByRole("heading", { name: "Plantafel", exact: true })).toBeVisible();
  await expect(page.getByText(/Woche \d{4}-\d{2}-\d{2} bis \d{4}-\d{2}-\d{2}/)).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Plantafel").toEqual([]);
});
