import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F9.3 Fremdnutzer-Filter — Chromium-E2E (Nachholblock Welle 03).
 *
 * E2E-01: Editor (90 Min) und zweiter Schreiber (30 Min) erfassen je einen
 * Eintrag per UI; ungefiltert stehen beide + Summe 2 Std. in Liste/Summe;
 * nach Nutzerfilter (Editor) nur noch der eigene Eintrag + Summe 1 Std.
 * 30 Min. Das belegt userIds in Liste UND Summe (Lane-Scope).
 * E2E-02: Viewer sieht beide Einträge + Summe, aber kein Erfassen-Formular.
 * Eigenes f93-Projekt im W3-Workspace (f7-03-Lehre). E2E-02 nutzt die
 * Einträge aus E2E-01 (Datei läuft sequenziell, workers: 1).
 */

type E2EState = {
  serverLogPath: string;
  w3WorkspaceId: string;
  f93ProjectId: string;
  editorEmail: string;
  restrictedEditorEmail: string;
  viewerEmail: string;
};

const EDITOR_COMMENT = "W3-Editor-Eintrag";
const FOREIGN_COMMENT = "W3-Fremd-Eintrag";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "w3WorkspaceId",
    "f93ProjectId",
    "editorEmail",
    "restrictedEditorEmail",
    "viewerEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9.3-E2E-State ist unvollständig.");
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

const path = (): string => `/w/${state().w3WorkspaceId}/anfragen/${state().f93ProjectId}/zeiterfassung`;

async function createEntry(
  page: Page,
  start: string,
  end: string,
  minutes: string,
  comment: string,
): Promise<void> {
  const form = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Neuer Zeiteintrag", exact: true }),
  });
  await form.getByLabel("Beginn").fill(start);
  await form.getByLabel("Ende").fill(end);
  await form.getByLabel("Arbeitszeit (Minuten)").fill(minutes);
  await form.getByLabel("Kommentar").fill(comment);
  await form.getByRole("button", { name: "Erfassen", exact: true }).click();
  await expect(page.getByText(comment, { exact: true })).toBeVisible();
}

test("F9.3-E2E-01: Fremdnutzer-Filter grenzt Liste und Summe ein", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackErrors(page);
  const url = path();

  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, url);
  await expect(page.getByRole("heading", { name: "Neuer Zeiteintrag", exact: true })).toBeVisible();
  await createEntry(page, "2025-01-15T10:00", "2025-01-15T11:30", "90", EDITOR_COMMENT);
  await expect(page.getByText("Summe: 1 Std. 30 Min.", { exact: true })).toBeVisible();

  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, data.restrictedEditorEmail, url);
  await createEntry(page, "2025-01-15T14:00", "2025-01-15T14:30", "30", FOREIGN_COMMENT);
  await expect(page.getByText("Summe: 2 Std. 0 Min.", { exact: true })).toBeVisible();
  await expect(page.getByText(EDITOR_COMMENT, { exact: true })).toBeVisible();

  // Nach Nutzer filtern (Editor): nur eigener Eintrag + eigene Summe.
  await page.getByLabel(data.editorEmail).check();
  await page.getByRole("button", { name: "Filtern", exact: true }).click();
  await expect(page.getByText("Summe: 1 Std. 30 Min.", { exact: true })).toBeVisible();
  await expect(page.getByText(EDITOR_COMMENT, { exact: true })).toBeVisible();
  await expect(page.getByText(FOREIGN_COMMENT, { exact: true })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});

test("F9.3-E2E-02: Viewer sieht alles, erfasst nichts", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackErrors(page);
  const url = path();

  await page.goto(url);
  await loginWithRealOtp(page, data.viewerEmail, url);
  await expect(page.getByText(EDITOR_COMMENT, { exact: true })).toBeVisible();
  await expect(page.getByText(FOREIGN_COMMENT, { exact: true })).toBeVisible();
  await expect(page.getByText("Summe: 2 Std. 0 Min.", { exact: true })).toBeVisible();
  await expect(page.getByText("Du hast Lesezugriff. Zum Erfassen brauchst du Editor-Rechte."))
    .toBeVisible();
  await expect(page.getByRole("button", { name: "Erfassen", exact: true })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Viewer-Grenze").toEqual([]);
});
