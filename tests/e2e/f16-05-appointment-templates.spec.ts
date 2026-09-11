import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F16-05 Termin-Vorlagen — Chromium-E2E.
 * - Editor legt eine Vorlage in den Einstellungen an und wendet sie am
 *   Projekt an (Beginn + Kalender) → Termin mit Titel/Dauer entsteht.
 * - Viewer: Einstellungsseite und Projektbereich bleiben read-only.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  mainProjectId: string;
  editorEmail: string;
  viewerEmail: string;
  mainContactName: string;
};

const CALENDAR_NAME = "F16-05 E2E Kalender";

async function seedTenancyCalendar(): Promise<void> {
  // Test-Seeds enthalten keinen Kalender im Haupt-Workspace (Kalender-Seeds
  // gehören zum Demo-Preview); direkter SQL-Seed wie F7.3-Katalog.
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    await pool.query(
      `insert into calendar (id, workspace_id, name, calendar_type, created_by)
       select $1::uuid, $2::uuid, $3, 'tenancy', u.id
         from user_identity u where u.email = $4
           and not exists (
             select 1 from calendar
              where workspace_id = $2::uuid and name = $3
           )
         limit 1`,
      [randomUUID(), data.workspaceId, CALENDAR_NAME, data.editorEmail],
    );
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

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
    "baseURL",
    "databaseUrl",
    "serverLogPath",
    "workspaceId",
    "mainProjectId",
    "editorEmail",
    "viewerEmail",
    "mainContactName",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F16-05-E2E-State ist unvollständig.");
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

  const otpInput = page.getByLabel("Sechsstelliger Code");
  await expect(otpInput).toBeVisible();
  await otpInput.fill(await otpFromPrivateDevMailLog(
    state().serverLogPath,
    email,
    logOffset,
  ));
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

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test("F16-05-E2E-01: Editor legt Vorlage an und wendet sie am Projekt an", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const settingsPath = `/w/${data.workspaceId}/einstellungen/termin-vorlagen`;
  const detailPath = `/w/${data.workspaceId}/anfragen/${data.mainProjectId}`;

  const templateName = `F16-05 E2E Vorlage ${Date.now()}`;
  const templateTitle = `F16-05 E2E Termin ${Date.now()}`;

  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Termin-Vorlagen", level: 1 })).toBeVisible();

  const createSection = page.locator("section[aria-label=\"Neue Vorlage\"]");
  await createSection.getByLabel("Name").fill(templateName);
  await createSection.getByLabel("Termin-Titel").fill(templateTitle);
  await createSection.getByLabel("Dauer in Minuten").fill("90");
  await createSection.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.locator("section[aria-label=\"Vorlagen\"]").getByRole("heading", { name: templateName })).toBeVisible();
  expect(errors, "Browser-Konsole beim Anlegen").toEqual([]);

  // Kalender vor dem Seiten-Render seeden (Formular braucht ihn serverseitig).
  await seedTenancyCalendar();

  await page.goto(detailPath);
  await expect(page.getByRole("heading", { name: data.mainContactName, level: 1 })).toBeVisible();

  const appointments = page.locator("#project-appointments");
  await appointments.getByLabel("Terminvorlage").selectOption({ label: `${templateName} – ${templateTitle} (1 Std. 30 Min.)` });
  await appointments.getByLabel("Beginn").fill("2026-09-04T08:00");
  await appointments.getByLabel("Kalender", { exact: true }).selectOption({ label: CALENDAR_NAME });
  await appointments.getByRole("button", { name: "Vorlage anwenden", exact: true }).click();
  await expect(appointments.getByText("Der Termin wurde aus der Vorlage erstellt.", { exact: true })).toBeVisible();
  const card = appointments.locator("article").filter({ hasText: templateTitle });
  await expect(card).toHaveCount(1);
  await expect(card.getByText(/04\.09\.2026.*08:00.*09:30/)).toBeVisible();
  expect(errors, "Browser-Konsole beim Anwenden").toEqual([]);
});

test("F16-05-E2E-02: Viewer sieht Vorlagen ausschließlich lesend", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const settingsPath = `/w/${data.workspaceId}/einstellungen/termin-vorlagen`;
  const detailPath = `/w/${data.workspaceId}/anfragen/${data.mainProjectId}`;

  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.viewerEmail, settingsPath);
  await expect(page.getByRole("heading", { name: "Termin-Vorlagen", level: 1 })).toBeVisible();
  await expect(page.locator("section[aria-label=\"Neue Vorlage\"]")).toHaveCount(0);

  await page.goto(detailPath);
  await expect(page.getByRole("heading", { name: data.mainContactName, level: 1 })).toBeVisible();
  const appointments = page.locator("#project-appointments");
  await expect(appointments.getByText("Du kannst Termine sehen, aber nicht verändern.", { exact: true })).toBeVisible();
  await expect(appointments.getByLabel("Terminvorlage")).toHaveCount(0);
});
