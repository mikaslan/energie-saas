import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F16.3 Slice B Foerder-Vorlagen — Chromium-E2E (Welle 03/04).
 *
 * Fix- + Prozent-Vorlage per Einstellungs-UI anlegen, beide gelistet.
 * W3-Workspace (Editor trägt die discounts-Capability), kein Projekt nötig.
 */

type E2EState = {
  serverLogPath: string;
  w3WorkspaceId: string;
  editorEmail: string;
};

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = ["serverLogPath", "w3WorkspaceId", "editorEmail"];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F16.3B-E2E-State ist unvollständig.");
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

test("F16.3-E2E-02: Fix- und Prozent-Vorlage anlegen und sehen", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  const url = `/w/${data.w3WorkspaceId}/einstellungen/foerder-vorlagen`;
  await page.goto(url);
  await loginWithRealOtp(page, data.editorEmail, url);
  await expect(page.getByRole("heading", { name: "Förder-Vorlagen", exact: true })).toBeVisible();

  const creator = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Neue Vorlage", exact: true }),
  });
  await creator.getByLabel("Name").fill("W3-Fix-Foerderung");
  await creator.getByLabel("Betrag in Euro").fill("12.50");
  await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("W3-Fix-Foerderung", { exact: true })).toBeVisible();
  await expect(page.getByText("12.50 €", { exact: true })).toBeVisible();

  await creator.getByLabel("Name").fill("W3-Prozent-Foerderung");
  await creator.getByLabel("Art").selectOption("percent_bps");
  await creator.getByLabel("Prozentsatz").fill("5");
  await creator.getByLabel("Deckel in Euro").fill("100");
  await creator.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("W3-Prozent-Foerderung", { exact: true })).toBeVisible();
  await expect(page.getByText("5,00 %", { exact: false })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});
