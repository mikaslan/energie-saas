import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import { sql } from "drizzle-orm";
import { withTenantOn } from "../../lib/db/tenant";
import { tenantFixtures } from "../setup/tenant-fixtures";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F13-14 Planungsservice-Revision — Chromium-E2E (isolierter Workspace).
 * Angebots-Graph per Fixture-Kette, Editor stellt Planungsanfrage
 * (Standard 48 h) → Revisionsnotiz anlegen → signieren → Double-Sign per
 * stale Zweit-Tab (deterministisch, kein Race) → Revisionsfrist lesbar →
 * Überfällig-Badge nach Rückdatierung → Prüf-Button je Zustand.
 * KEIN Event-Pin (DB deckt planning_request.overdue), KEIN Preis-UI (S1).
 * NICHT lokal ausführen — Owner startet zentral (npm run test:e2e).
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  adminEmail: string;
  editorEmail: string;
  viewerEmail: string;
  externalEmail: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function trackBrowserErrors(page: Page): string[] {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "baseURL", "databaseUrl", "serverLogPath", "workspaceId",
    "adminEmail", "editorEmail", "viewerEmail", "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F13-14-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
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
    if (match) return match[1]!;
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

  const otp = await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset);
  const otpInput = page.getByLabel("Sechsstelliger Code");
  await otpInput.fill(otp);
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
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedPath);
}

async function seedPlanning(): Promise<{ workspaceId: string; projectId: string }> {
  const data = state();
  const workspaceId = randomUUID();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const identities = await pool.query<{ id: string; email: string }>(
      "select id, email from user_identity where email in ($1, $2)",
      [data.adminEmail, data.editorEmail],
    );
    const adminId = identities.rows.find((row) => row.email === data.adminEmail)?.id;
    const editorId = identities.rows.find((row) => row.email === data.editorEmail)?.id;
    if (!adminId) throw new Error("F13-14-E2E: Admin-Identität fehlt.");
    if (!editorId) throw new Error("F13-14-E2E: Editor-Identität fehlt.");
    let projectId = "";
    await withTenantOn(pool, workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-14 isoliert')
      `);
      await tx.execute(sql`
        insert into membership (workspace_id, user_id, role, capabilities)
        values (${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb),
               (${workspaceId}::uuid, ${editorId}::uuid, 'editor',
                '{"manage_catalog":true,"edit_prices":true,"see_purchase_prices":true,"assign_projects":true}'::jsonb)
      `);
      await tenantFixtures.offer?.(tx, workspaceId);
      const project = await tx.execute<{ id: string }>(sql`
        select project.id
          from project
          join offer on offer.workspace_id = project.workspace_id
                   and offer.project_id = project.id
         where project.workspace_id = ${workspaceId}::uuid
         limit 1
      `);
      projectId = project.rows[0]?.id ?? "";
      if (!projectId) throw new Error("F13-14-E2E: Fixture-Projekt fehlt.");
    });
    return { workspaceId, projectId };
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

// Rückdatierung für den Überfällig-Pfad: fixierter UTC-Mittag, damit die
// Frist (deadline_at, F13-11-Bestand) als 02.01.2026 pinbar ist — TZ-robust
// (±12 h um 12:00 UTC halten das de-DE-Datum stabil). CHECK-konform
// (deadline_at >= created_at): beide zurück, Frist 1 Tag nach Anlage.
async function backdatePlanningRequestCreatedAt(workspaceId: string): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await withTenantOn(pool, workspaceId, async (tx) => {
      await tx.execute(sql`
        update planning_request
           set created_at = '2026-01-01T12:00:00.000Z'::timestamptz,
               deadline_at = '2026-01-02T12:00:00.000Z'::timestamptz
         where workspace_id = ${workspaceId}::uuid
      `);
    });
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test("F1314-E2E-01: Anfrage → Notiz → Signatur → Double-Sign → Frist/Badge → Prüf-Button", async ({ page, context }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  const { workspaceId, projectId } = await seedPlanning();
  const path = `/w/${workspaceId}/anfragen/${projectId}`;

  await page.goto(`/login?${new URLSearchParams({ next: path }).toString()}`);
  await loginWithRealOtp(page, data.editorEmail, path);

  // 1) Anfrage stellen (F13-11-Bestand).
  const section = page.locator('[data-planning-requests="true"]');
  await expect(section).toBeVisible();
  await expect(section.getByText("Keine Planungsanfragen gestellt.")).toBeVisible();

  await section.getByTestId("planning-request-offer").selectOption({ index: 0 });
  await section.getByRole("button", { name: "Anfrage stellen", exact: true }).click();
  await expect(section.getByText("Planungsanfrage gestellt.")).toBeVisible();
  await expect(section.getByText("Angefragt", { exact: true }).first()).toBeVisible();

  // 2) Frist (deadline_at, F13-11-Bestand) lesbar, kein Badge bei frischer Anfrage.
  await expect(section.getByTestId("planning-request-due")).toContainText("Frist:");
  await expect(section.getByTestId("planning-request-overdue")).toHaveCount(0);

  // 3) Prüf-Button (frisch): Feedback „nicht überfällig", keine Automatik.
  await section.getByTestId("planning-request-check-overdue").click();
  await expect(section.getByTestId("planning-request-check-feedback"))
    .toContainText("nicht überfällig");

  // 4) Revisionsnotiz anlegen.
  await section.getByTestId("planning-revision-body").fill("Bitte das Dachmaß prüfen.");
  await section.getByTestId("planning-revision-create").click();
  await expect(section.getByTestId("planning-revision-create-feedback"))
    .toContainText("Revisionsnotiz angelegt.");
  const item = section.getByTestId("planning-revision-item").first();
  await expect(item).toContainText("Bitte das Dachmaß prüfen.");
  await expect(item).toContainText("Notiz #1");

  // 5) Double-Sign deterministisch: stale Zweit-Tab (gleicher Context =
  // gleiche Session) sieht die Notiz noch unsigniert.
  const stale = await context.newPage();
  const staleErrors = trackBrowserErrors(stale);
  const staleSection = stale.locator('[data-planning-requests="true"]');
  await stale.goto(path);
  await expect(staleSection.getByTestId("planning-revision-sign")).toBeVisible();

  await section.getByTestId("planning-revision-sign").click();
  await expect(section.getByTestId("planning-revision-sign-feedback"))
    .toContainText("Revisionsnotiz signiert.");
  await expect(section.getByTestId("planning-revision-signed")).toBeVisible();
  await expect(section.getByTestId("planning-revision-sign")).toHaveCount(0);

  await staleSection.getByTestId("planning-revision-sign").click();
  await expect(staleSection.getByTestId("planning-revision-sign-feedback"))
    .toContainText("bereits signiert");
  await stale.close();

  // 6) Überfällig-Pfad: Rückdatierung → Reload → Frist 02.01.2026 + Badge.
  await backdatePlanningRequestCreatedAt(workspaceId);
  await page.reload();
  await expect(section.getByTestId("planning-request-due")).toContainText("02.01.2026");
  await expect(section.getByTestId("planning-request-overdue")).toBeVisible();

  // 7) Prüf-Button (überfällig): Feedback „ist überfällig", kein Event-Pin.
  await section.getByTestId("planning-request-check-overdue").click();
  await expect(section.getByTestId("planning-request-check-feedback"))
    .toContainText("ist überfällig");

  expect(errors, "F13-14 Browser-Konsole und Page-Errors").toEqual([]);
  expect(staleErrors, "F13-14 Stale-Tab-Konsole und Page-Errors").toEqual([]);
});
