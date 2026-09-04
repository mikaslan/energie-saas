import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { Pool } from "pg";
import { expect, test, type Page } from "playwright/test";

/**
 * F9.2 Stoppuhr — Chromium-E2E.
 * - Editor startet die Stoppuhr, sieht den Lauf-Banner, stoppt mit
 *   Minuten → Summe steigt; zweite Stoppuhr ist blockiert (Conflict).
 * - Viewer: laufender Eintrag sichtbar, kein Start-Button.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  editorEmail: string;
  viewerEmail: string;
  mainProjectId: string;
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
    "baseURL", "databaseUrl", "serverLogPath", "workspaceId", "editorEmail", "viewerEmail", "mainProjectId",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9.2-E2E-State ist unvollständig.");
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
    if (match) return match[1];
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("Der echte Dev-Mail-OTP wurde nicht rechtzeitig protokolliert.");
}

async function loginWithRealOtp(page: Page, email: string, expectedPath: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === "/login");
  const logOffset = statSync(state().serverLogPath).size;
  await page.getByLabel("E-Mail-Adresse").fill(email);
  const sendResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/email-otp/send-verification-otp"
    && response.request().method() === "POST");
  await page.getByRole("button", { name: "Code anfordern" }).click();
  expect((await sendResponsePromise).status()).toBe(200);
  await page.getByLabel("Sechsstelliger Code").fill(
    await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset),
  );
  await page.getByRole("button", { name: "Anmelden" }).click();
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function seedRunningEntry(): Promise<void> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query(
      `insert into time_entry (
         workspace_id, user_id, project_id, start_at, end_at,
         working_time_minutes, created_by
       ) select $1::uuid, u.id, $2::uuid, now(), null, null, u.id
           from user_identity u where u.email = $3 limit 1`,
      [data.workspaceId, data.mainProjectId, data.editorEmail],
    );
  } finally {
    await pool.end();
  }
}

const path = (): string => `/w/${state().workspaceId}/anfragen/${state().mainProjectId}/zeiterfassung`;

test("F9.2-E2E-01: Editor startet, stoppt und sieht die Summe; zweite Stoppuhr blockiert", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const url = path();

  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, url);
  await expect(page.getByRole("heading", { name: "Zeiterfassung", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stoppuhr starten" })).toBeVisible();

  await page.getByRole("button", { name: "Stoppuhr starten" }).click();
  await expect(page.getByText("Stoppuhr gestartet.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Stoppuhr läuft" })).toBeVisible();
  await expect(page.getByText(/läuft seit/u).first()).toBeVisible();

  // Zweite Stoppuhr: Button ist weg, Banner bleibt.
  await expect(page.getByRole("button", { name: "Stoppuhr starten" })).toHaveCount(0);

  // Stoppen mit 90 Minuten → Summe 1 Std. 30 Min.
  const runningSection = page.locator("section").filter({ hasText: "Stoppuhr läuft" });
  await runningSection.getByLabel("Arbeitszeit (Minuten)").fill("90");
  await page.getByRole("button", { name: "Stoppen" }).click();
  await expect(page.getByText("Stoppuhr gestoppt.", { exact: true })).toBeVisible();
  await expect(page.getByText("Summe: 1 Std. 30 Min.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Stoppuhr starten" })).toBeVisible();

  // Verwerfen-Pfad: starten → verwerfen → leer.
  await page.getByRole("button", { name: "Stoppuhr starten" }).click();
  await expect(page.getByRole("heading", { name: "Stoppuhr läuft" })).toBeVisible();
  await page.getByRole("button", { name: "Verwerfen" }).click();
  await expect(page.getByText("Laufender Eintrag verworfen.", { exact: true })).toBeVisible();
  // Der laufende Eintrag ist weg; der gestoppte 90-Minuten-Eintrag bleibt.
  await expect(page.getByRole("heading", { name: "Stoppuhr läuft" })).toHaveCount(0);
  await expect(page.getByText("Summe: 1 Std. 30 Min.")).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});

test("F9.2-E2E-02: Viewer sieht laufenden Eintrag read-only", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const url = path();

  // Kimi-P2-7: laufender Eintrag des Editors existiert → Viewer sieht ihn,
  // hat aber keinen Start-Button.
  await seedRunningEntry();
  await page.goto(url);
  await loginWithRealOtp(page, data.viewerEmail, url);
  await expect(page.getByRole("heading", { name: "Zeiterfassung", level: 1 })).toBeVisible();
  await expect(page.getByText(/läuft seit/u).first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Stoppuhr starten" })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Rollengrenzen").toEqual([]);
});
