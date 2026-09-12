import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F9-09 Listen-/Export-Filter — Chromium-E2E.
 * - Editor erfasst zwei Eintraege an verschiedenen Tagen,
 *   der Datumsfilter blendet den ausserhalb liegenden Eintrag aus,
 *   Zuruecksetzen zeigt wieder beide.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  editorEmail: string;
  viewerEmail: string;
};

const VISIBLE_COMMENT = "F9-09 E2E im Zeitraum";
const HIDDEN_COMMENT = "F9-09 E2E ausserhalb";
const TYPE_NAME = "F9-09-Filtertyp";

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
    throw new Error("Der private F9-09-E2E-State ist unvollständig.");
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
    if (!result.rows[0]) throw new Error("Kein Projekt im F9-09-E2E-State vorhanden.");
    return result.rows[0].id;
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

const settingsPath = (): string => `/w/${state().workspaceId}/einstellungen/ereignistypen`;

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test("F9-09-E2E-01: Datumsfilter blendet Eintrag aus und Zurücksetzen zeigt beide", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const projectId = await firstProjectId();
  const path = `/w/${data.workspaceId}/anfragen/${projectId}/zeiterfassung`;

  await page.goto(settingsPath());
  await loginWithRealOtp(page, data.editorEmail, settingsPath());
  await page.getByLabel("Name").fill(TYPE_NAME);
  await page.getByRole("button", { name: "Anlegen" }).click();
  await expect(page.getByText("Ereignistyp angelegt.", { exact: true })).toBeVisible();

  await page.goto(path);
  const createForm = page.locator("section", {
    has: page.getByRole("heading", { name: "Neuer Zeiteintrag" }),
  });
  for (const [day, comment] of [["2026-09-10", VISIBLE_COMMENT], ["2026-09-12", HIDDEN_COMMENT]] as const) {
    await createForm.getByLabel("Ereignistyp").selectOption({ label: TYPE_NAME });
    await createForm.getByLabel("Beginn").fill(`${day}T08:00`);
    await createForm.getByLabel("Ende").fill(`${day}T10:00`);
    await createForm.getByLabel("Arbeitszeit (Minuten)").fill("120");
    await createForm.getByLabel("Kommentar").fill(comment);
    await createForm.getByRole("button", { name: "Erfassen" }).click();
    await expect(page.getByText("Zeiteintrag angelegt.", { exact: true })).toBeVisible();
  }

  const filterForm = page.locator("form", { hasText: "Nach Zeitraum filtern" });
  await filterForm.getByLabel("Von").fill("2026-09-10");
  await filterForm.getByLabel("Bis").fill("2026-09-10");
  await filterForm.getByRole("button", { name: "Filtern" }).click();
  await page.waitForURL((url) => url.searchParams.get("startDate") === "2026-09-10");

  await expect(page.locator("li", { hasText: VISIBLE_COMMENT })).toBeVisible();
  await expect(page.locator("li", { hasText: HIDDEN_COMMENT })).toHaveCount(0);

  await page.getByRole("link", { name: "Zurücksetzen" }).click();
  await page.waitForURL((url) => url.searchParams.get("startDate") === null);
  await expect(page.locator("li", { hasText: VISIBLE_COMMENT })).toBeVisible();
  await expect(page.locator("li", { hasText: HIDDEN_COMMENT })).toBeVisible();
  expect(errors, "Browser-Konsole und Page-Errors des Export-Filters").toEqual([]);
});
