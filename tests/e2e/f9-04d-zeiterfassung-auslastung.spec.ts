import { readFileSync } from "node:fs";
import { statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F9.4 Slice D Team-Auslastung — Chromium-E2E (Welle 03/04).
 *
 * Zwei Einträge per UI, die Auslastungs-Section zeigt Mitglied + Summe
 * (WYSIWYG zur Listensumme). Eigenes f94d-Projekt (Summen sind
 * aggregiert — Teilen mit A/B wäre assertions-unscharf).
 */

type E2EState = {
  serverLogPath: string;
  w3WorkspaceId: string;
  f94dProjectId: string;
  editorEmail: string;
};

const FIRST_COMMENT = "W3-Auslastung-eins";
const SECOND_COMMENT = "W3-Auslastung-zwei";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "w3WorkspaceId",
    "f94dProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9.4d-E2E-State ist unvollständig.");
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

test("F9.4-E2E-03: Auslastung zeigt Summe je Mitglied", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const url = `/w/${data.w3WorkspaceId}/anfragen/${data.f94dProjectId}/zeiterfassung`;
  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, url);
  await expect(page.getByRole("heading", { name: "Neuer Zeiteintrag", exact: true })).toBeVisible();

  const form = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Neuer Zeiteintrag", exact: true }),
  });
  await form.getByLabel("Beginn").fill("2025-04-10T10:00");
  await form.getByLabel("Ende").fill("2025-04-10T11:30");
  await form.getByLabel("Arbeitszeit (Minuten)").fill("90");
  await form.getByLabel("Kommentar").fill(FIRST_COMMENT);
  await form.getByRole("button", { name: "Erfassen", exact: true }).click();
  await expect(page.getByText(FIRST_COMMENT, { exact: true })).toBeVisible();

  await form.getByLabel("Beginn").fill("2025-04-11T14:00");
  await form.getByLabel("Ende").fill("2025-04-11T14:30");
  await form.getByLabel("Arbeitszeit (Minuten)").fill("30");
  await form.getByLabel("Kommentar").fill(SECOND_COMMENT);
  await form.getByRole("button", { name: "Erfassen", exact: true }).click();
  await expect(page.getByText(SECOND_COMMENT, { exact: true })).toBeVisible();

  // 90 + 30 = 120 Minuten = "2 Std. 0 Min." (eigene Zeile, WYSIWYG).
  const dashboard = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Auslastung", exact: true }),
  });
  await expect(dashboard).toBeVisible();
  await expect(dashboard.getByText("2 Std. 0 Min.", { exact: true })).toBeVisible();
  await expect(dashboard.getByText(data.editorEmail, { exact: true })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});
