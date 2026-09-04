import { readFileSync } from "node:fs";
import { statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F9.4 Slice A CSV-Export — Chromium-E2E (Welle 03/04).
 *
 * Zwei Einträge per UI, „CSV exportieren" lädt eine Datei mit Kopf +
 * beiden Kommentarzeilen; mit Nutzerfilter nur die eigene Zeile.
 * Eigenes f94-Projekt im W3-Workspace (f7-03-Lehre, keine
 * Cross-Spec-Abhängigkeit).
 */

type E2EState = {
  serverLogPath: string;
  w3WorkspaceId: string;
  f94ProjectId: string;
  editorEmail: string;
  restrictedEditorEmail: string;
};

const FIRST_COMMENT = "W3-Export-Eintrag-eins";
const SECOND_COMMENT = "W3-Export-Eintrag-zwei";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "w3WorkspaceId",
    "f94ProjectId",
    "editorEmail",
    "restrictedEditorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9.4-E2E-State ist unvollständig.");
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

async function downloadExport(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("link", { name: "CSV exportieren", exact: true }).click(),
  ]);
  const filePath = await download.path();
  if (!filePath) throw new Error("Der Export-Download lieferte keine Datei.");
  return readFileSync(filePath, "utf8");
}

test("F9.4-E2E-01: CSV-Export folgt dem angezeigten Filter", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const url = `/w/${data.w3WorkspaceId}/anfragen/${data.f94ProjectId}/zeiterfassung`;
  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, url);
  await expect(page.getByRole("heading", { name: "Neuer Zeiteintrag", exact: true })).toBeVisible();
  await createEntry(page, "2025-02-10T10:00", "2025-02-10T11:30", "90", FIRST_COMMENT);

  await page.context().clearCookies();
  await page.goto(url);
  await loginWithRealOtp(page, data.restrictedEditorEmail, url);
  await createEntry(page, "2025-02-11T14:00", "2025-02-11T14:30", "30", SECOND_COMMENT);

  const unfiltered = await downloadExport(page);
  expect(unfiltered).toContain("datum;beginn;ende;minuten;pause_minuten;ereignistyp;kommentar;nutzer_id");
  expect(unfiltered).toContain(FIRST_COMMENT);
  expect(unfiltered).toContain(SECOND_COMMENT);

  await page.getByLabel(data.editorEmail).check();
  await page.getByRole("button", { name: "Filtern", exact: true }).click();
  await expect(page.getByText("Summe: 1 Std. 30 Min.", { exact: true })).toBeVisible();
  const filtered = await downloadExport(page);
  expect(filtered).toContain(FIRST_COMMENT);
  expect(filtered).not.toContain(SECOND_COMMENT);

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});
