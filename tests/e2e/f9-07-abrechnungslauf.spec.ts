import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F9-07 Abrechnungslauf — Chromium-E2E.
 * - Editor erfasst + freigegebenen Eintrag, legt einen Zeitraum-Lauf an und
 *   schließt ihn → Snapshot sichtbar, Eintrag gegen Entsperren gesperrt.
 * - Viewer: Läufe lesend, keine Aktionen.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  editorEmail: string;
  viewerEmail: string;
};

const ENTRY_COMMENT = "F9-07 E2E Eintrag";
const RUN_LABEL = "F9-07 E2E Lauf";

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
    "baseURL", "databaseUrl", "serverLogPath", "workspaceId", "editorEmail", "viewerEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9-07-E2E-State ist unvollständig.");
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

async function firstProjectId(): Promise<string> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const result = await pool.query<{ id: string }>(
      `select id from project
        where workspace_id = $1::uuid
        order by created_at desc
        limit 1`,
      [data.workspaceId],
    );
    if (!result.rows[0]) throw new Error("Kein Projekt im F9-07-E2E-State vorhanden.");
    return result.rows[0].id;
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

const settingsPath = (): string => `/w/${state().workspaceId}/einstellungen/ereignistypen`;

function entryItem(page: Page) {
  return page.locator("li", { hasText: ENTRY_COMMENT }).first();
}

function runItem(page: Page) {
  return page.locator("li", { has: page.getByRole("heading", { name: RUN_LABEL }) }).first();
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test("F9-07-E2E-01: Editor legt Lauf an, schließt ihn, Eintrag ist gesperrt", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const projectId = await firstProjectId();
  const path = `/w/${data.workspaceId}/anfragen/${projectId}/zeiterfassung`;

  await page.goto(settingsPath());
  await loginWithRealOtp(page, data.editorEmail, settingsPath());
  await page.getByLabel("Name").fill("Abrechnung-Montage");
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Ereignistyp angelegt.", { exact: true })).toBeVisible();

  await page.goto(path);
  // Gegen Eintrags-Editformulare anderer Specs abgrenzen (gleiche Labels).
  const createForm = page.locator("section", {
    has: page.getByRole("heading", { name: "Neuer Zeiteintrag" }),
  });
  await createForm.getByLabel("Ereignistyp").selectOption({ label: "Abrechnung-Montage" });
  await createForm.getByLabel("Beginn").fill("2026-09-04T08:00");
  await createForm.getByLabel("Ende").fill("2026-09-04T10:00");
  await createForm.getByLabel("Arbeitszeit (Minuten)").fill("120");
  await createForm.getByLabel("Kommentar").fill(ENTRY_COMMENT);
  await createForm.getByRole("button", { name: "Erfassen" }).click();
  await expect(page.getByText("Zeiteintrag angelegt.", { exact: true })).toBeVisible();

  await entryItem(page).getByRole("button", { name: "Freigeben" }).click();
  await expect(page.getByText("Zeiteintrag freigegeben.", { exact: true })).toBeVisible();

  const runs = page.locator("section[aria-labelledby=\"billing-runs-title\"]");
  await runs.getByLabel("Bezeichnung").fill(RUN_LABEL);
  await runs.getByLabel("Von").fill("2026-09-01");
  await runs.getByLabel("Bis").fill("2026-09-30");
  await runs.getByRole("button", { name: "Lauf anlegen", exact: true }).click();
  await expect(page.getByText("Abrechnungslauf angelegt.", { exact: true })).toBeVisible();
  await expect(runItem(page)).toBeVisible();

  await runItem(page).getByRole("button", { name: "Lauf schließen", exact: true }).click();
  await expect(page.getByText(/Abrechnungslauf geschlossen: \d+ (Eintrag|Einträge)\./)).toBeVisible();
  await expect(runItem(page).getByText("geschlossen", { exact: true })).toBeVisible();
  // Snapshot-Sperre: „Abgerechnet"-Badge, Entsperren ist verschwunden.
  await expect(entryItem(page).getByText("Abgerechnet", { exact: true })).toBeVisible();
  await expect(entryItem(page).getByRole("button", { name: "Entsperren" })).toHaveCount(0);
  expect(errors, "Browser-Konsole und Page-Errors des Abrechnungslauf-Journey").toEqual([]);
});

test("F9-07-E2E-02: Viewer sieht Läufe ausschließlich lesend", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const projectId = await firstProjectId();
  const path = `/w/${data.workspaceId}/anfragen/${projectId}/zeiterfassung`;

  await page.goto(path);
  await loginWithRealOtp(page, data.viewerEmail, path);
  await expect(page.getByRole("heading", { name: "Zeiterfassung", level: 1 })).toBeVisible();
  const runs = page.locator("section[aria-labelledby=\"billing-runs-title\"]");
  await expect(runs).toBeVisible();
  await expect(runs.getByLabel("Bezeichnung")).toHaveCount(0);
  await expect(runs.getByRole("button", { name: "Lauf anlegen", exact: true })).toHaveCount(0);
  await expect(runs.getByRole("button", { name: "Lauf schließen", exact: true })).toHaveCount(0);
});
