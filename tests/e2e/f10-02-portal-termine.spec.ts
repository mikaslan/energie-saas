import { readFileSync, statSync } from "node:fs";
import { Pool } from "pg";
import { expect, test, type Page } from "playwright/test";

/**
 * F10.2 Slice A Termine-Tab — Chromium-E2E (Welle 03/04).
 *
 * Interner Termin (mit interner Beschreibung) + Portal-Link → öffentlicher
 * Link, Tab „Termine" zeigt Titel/Ort, aber NIEMALS die Beschreibung.
 * Eigenes f102-Projekt (Invite bleibt aktiv — kein Withdraw in diesem
 * Pfad). Kalender-Seed per Direkt-SQL (M1-15-Muster).
 */

type E2EState = {
  serverLogPath: string;
  databaseUrl: string;
  w3WorkspaceId: string;
  f102ProjectId: string;
  editorEmail: string;
};

const APPOINTMENT_TITLE = "W3-Portal-Termin";
const APPOINTMENT_LOCATION = "Musterstraße 1";
const INTERNAL_NOTE = "Interne Notiz — nie öffentlich";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "databaseUrl",
    "w3WorkspaceId",
    "f102ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F10.2-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function berlinDateToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

async function seedTenancyCalendar(): Promise<void> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query(
      `insert into calendar (id, workspace_id, name, calendar_type, created_by)
       select gen_random_uuid(), $1::uuid, 'F10.2 E2E Kalender', 'tenancy', u.id
         from user_identity u where u.email = $2
          and not exists (
            select 1 from calendar
             where workspace_id = $1::uuid and name = 'F10.2 E2E Kalender'
          )
        limit 1`,
      [data.w3WorkspaceId, data.editorEmail],
    );
  } finally {
    await pool.end();
  }
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

test("F10.2-E2E-01: Termine-Tab zeigt Termin ohne interne Beschreibung", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await seedTenancyCalendar();
  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f102ProjectId}`;
  await page.goto(projectPath);
  await loginWithRealOtp(page, data.editorEmail, projectPath);

  const section = page.locator("#project-appointments");
  await expect(section.getByRole("heading", { name: "Termine", level: 2 })).toBeVisible();
  await section.getByRole("button", { name: "Termin anlegen" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Termin anlegen", level: 2 })).toBeVisible();
  const date = berlinDateToday();
  await dialog.getByLabel("Titel").fill(APPOINTMENT_TITLE);
  await dialog.getByLabel("Typ").selectOption("on_site");
  await dialog.getByLabel("Beginn").fill(`${date}T10:00`);
  await dialog.getByLabel("Ende", { exact: true }).fill(`${date}T11:00`);
  // Gatefix: der Typ-Select traegt als accname "Typ" + Optionstext
// ("Typ Vor Ort") — nicht-exaktes "Ort" matcht ihn mit (Strict-
// Violation, nachgemessen). Exact-Match trifft nur das Ort-Feld.
  await dialog.getByLabel("Ort", { exact: true }).fill(APPOINTMENT_LOCATION);
  await dialog.getByLabel("Beschreibung").fill(INTERNAL_NOTE);
  await dialog.getByRole("checkbox", { name: data.editorEmail }).check();
  await dialog.getByRole("button", { name: "Speichern" }).click();
  await expect(dialog).toHaveCount(0);
  // Gatefix: Titel erscheint zweimal im Abschnitt (Kalender-Event + Listeneintrag) — first() statt Strict-Violation.
  await expect(section.getByText(APPOINTMENT_TITLE, { exact: true }).first()).toBeVisible();

  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  await page.goto(tokenPath);
  await expect(page.getByText("Kundenportal", { exact: true }).first()).toBeVisible();
  await page.getByRole("link", { name: /Termine/u }).click();
  await expect(page.getByText(APPOINTMENT_TITLE, { exact: true })).toBeVisible();
  // Gatefix: der Ort steht inline im Zeitraum-Text ("… · Musterstraße 1"),
// kein exakter Textknoten.
  await expect(page.getByText(APPOINTMENT_LOCATION)).toBeVisible();
  await expect(page.getByText(INTERNAL_NOTE, { exact: true })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Portal-Grenze").toEqual([]);
});
