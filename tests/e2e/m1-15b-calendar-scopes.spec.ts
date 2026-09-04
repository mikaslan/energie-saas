import { readFileSync, statSync } from "node:fs";
import { Pool } from "pg";
import { expect, test, type Page } from "playwright/test";

/**
 * M1-15b Kalender-Scopes — Chromium-E2E (Workspace-Kalenderroute).
 * - Editor sieht die Kalenderliste read-only (kein Anlegen — Admin-only).
 * - Viewer sieht die Liste, External bleibt fail-closed.
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  m111bWorkspaceId: string;
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
  if (
    typeof parsed.databaseUrl !== "string"
    || typeof parsed.serverLogPath !== "string"
    || typeof parsed.m111bWorkspaceId !== "string"
    || typeof parsed.editorEmail !== "string"
    || typeof parsed.viewerEmail !== "string"
    || typeof parsed.externalEmail !== "string"
  ) {
    throw new Error("Der private M1-15b-E2E-State ist unvollständig.");
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

async function seedTenancyCalendar(): Promise<void> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query(
      `insert into calendar (id, workspace_id, name, calendar_type, created_by)
       select gen_random_uuid(), $1::uuid, 'M1-15b E2E Kalender', 'tenancy', u.id
         from user_identity u where u.email = $2
          and not exists (
            select 1 from calendar
             where workspace_id = $1::uuid and name = 'M1-15b E2E Kalender'
          )
        limit 1`,
      [data.m111bWorkspaceId, data.editorEmail],
    );
  } finally {
    await pool.end();
  }
}

const kalenderPath = (): string => `/w/${state().m111bWorkspaceId}/kalender`;

test("M1-15b-E2E-01: Editor sieht Kalender read-only (Admin-Verwaltung nicht sichtbar)", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const path = kalenderPath();

  await seedTenancyCalendar();
  await page.goto(path);
  await loginWithRealOtp(page, data.editorEmail, path);

  await expect(page.getByRole("heading", { name: "Kalender", level: 1 })).toBeVisible();
  await expect(page.getByText("M1-15b E2E Kalender")).toBeVisible();
  await expect(page.getByText("Unternehmen", { exact: true }).first()).toBeVisible();
  // calendar.write ist Admin-only → kein Anlegeformular, kein Archivieren.
  await expect(page.getByRole("button", { name: "Anlegen" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Archivieren" })).toHaveCount(0);
  await expect(page.getByText(/Du hast Lesezugriff\./u)).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});

test("M1-15b-E2E-02: Viewer read-only, External fail-closed", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const path = kalenderPath();

  await page.goto(path);
  await loginWithRealOtp(page, data.viewerEmail, path);
  await expect(page.getByRole("heading", { name: "Kalender", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Anlegen" })).toHaveCount(0);

  await page.context().clearCookies();
  await page.goto(path);
  await loginWithRealOtp(page, data.externalEmail, path);
  await expect(page.getByText("Zugriff eingeschränkt")).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Rollengrenzen").toEqual([]);
});
