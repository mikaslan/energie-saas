import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F9.09 Listen-/Export-Filter — Chromium-E2E.
 *
 * E2E-01: Editor erfasst zwei Einträge an verschiedenen Tagen (12.05.2025
 * 90 Min, 13.05.2025 30 Min); Datumsfilter Von=Bis=12.05.2025 grenzt Liste
 * UND Summe ein (90 Min); der Export-Link übernimmt die Filter
 * (startDate/endDate in href); der CSV-Download hinter dem Link enthält nur
 * den gefilterten Eintrag (WYSIWYG). Typfeld-Sets sind per DB-Test bewiesen;
 * hier wird zusätzlich die Sichtbarkeit der Filtergruppen geprüft.
 * Eigenes Datumspaar ohne Kollision zu anderen F9-Specs (f93-Projekt).
 */

type E2EState = {
  serverLogPath: string;
  w3WorkspaceId: string;
  f93ProjectId: string;
  editorEmail: string;
};

const COMMENT_A = "F909-TAG-A";
const COMMENT_B = "F909-TAG-B";
const DAY_A = "2025-05-12";
const DAY_B = "2025-05-13";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "w3WorkspaceId",
    "f93ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9.09-E2E-State ist unvollständig.");
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

test("F9.09-E2E-01: Datumsfilter grenzt Liste, Summe und Export ein", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackErrors(page);
  const url = path();

  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, url);
  await expect(page.getByRole("heading", { name: "Neuer Zeiteintrag", exact: true })).toBeVisible();
  await createEntry(page, `${DAY_A}T10:00`, `${DAY_A}T11:30`, "90", COMMENT_A);
  await createEntry(page, `${DAY_B}T14:00`, `${DAY_B}T14:30`, "30", COMMENT_B);

  // Filtergruppen sind sichtbar (beobachtbar).
  await expect(page.getByText("Nach Zeitraum filtern", { exact: true })).toBeVisible();
  await expect(page.getByText("Nach Ereignistyp filtern", { exact: true })).toBeVisible();

  // Datumsfilter setzen und absenden.
  const filterForm = page.locator("form").filter({
    has: page.getByText("Nach Zeitraum filtern", { exact: true }),
  });
  await filterForm.getByLabel("Von").fill(DAY_A);
  await filterForm.getByLabel("Bis").fill(DAY_A);
  await filterForm.getByRole("button", { name: "Filtern", exact: true }).click();

  // Liste und Summe folgen dem Filter.
  await expect(page.getByText(COMMENT_A, { exact: true })).toBeVisible();
  await expect(page.getByText(COMMENT_B, { exact: true })).toHaveCount(0);
  await expect(page.getByText("Summe: 1 Std. 30 Min.", { exact: true })).toBeVisible();

  // Export-Link übernimmt die Filter (WYSIWYG).
  const exportLink = page.getByRole("link", { name: "CSV exportieren", exact: true });
  const href = await exportLink.getAttribute("href");
  expect(href).toContain(`startDate=${DAY_A}`);
  expect(href).toContain(`endDate=${DAY_A}`);

  // CSV-Download hinter dem Link enthält nur den gefilterten Eintrag.
  const download = await page.request.get(new URL(href!, page.url()).toString());
  expect(download.status()).toBe(200);
  const csv = await download.text();
  expect(csv).toContain(COMMENT_A);
  expect(csv).not.toContain(COMMENT_B);

  expect(errors, "Browser-Konsole und Page-Errors der Filter-Grenze").toEqual([]);
});
