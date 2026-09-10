import { readFileSync } from "node:fs";
import { statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";

/**
 * F9-06 Pausen-Segmente — Chromium-E2E.
 *
 * Eintrag per UI, „Pause starten" klicken, „Pause beenden" sichtbar,
 * beenden, „Pausen (1)" aufklappen. Nutzt das bestehende f94-Projekt mit
 * eindeutigem Kommentar (kein run.mts-Eingriff, keine
 * Cross-Spec-Abhängigkeit).
 */

type E2EState = {
  serverLogPath: string;
  w3WorkspaceId: string;
  f94ProjectId: string;
  editorEmail: string;
};

const COMMENT = "W3-Pausen-Segment";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "w3WorkspaceId",
    "f94ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F9.6-E2E-State ist unvollständig.");
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

test("F9-06-E2E-01: Pause starten/beenden mit Segmentliste", async ({ page }) => {
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

  const form = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Neuer Zeiteintrag", exact: true }),
  });
  await form.getByLabel("Beginn").fill("2025-03-10T10:00");
  await form.getByLabel("Ende").fill("2025-03-10T11:30");
  await form.getByLabel("Arbeitszeit (Minuten)").fill("90");
  await form.getByLabel("Kommentar").fill(COMMENT);
  await form.getByRole("button", { name: "Erfassen", exact: true }).click();
  await expect(page.getByText(COMMENT, { exact: true })).toBeVisible();

  const entry = page.locator("li").filter({ hasText: COMMENT }).first();
  await expect(entry.getByText("Noch keine Pause erfasst.", { exact: true })).toBeVisible();

  await entry.getByRole("button", { name: "Pause starten", exact: true }).click();
  await expect(entry.getByRole("button", { name: "Pause beenden", exact: true })).toBeVisible();
  await expect(entry.getByText(/Pause läuft/u)).toBeVisible();

  await entry.getByRole("button", { name: "Pause beenden", exact: true }).click();
  await expect(entry.getByRole("button", { name: "Pause starten", exact: true })).toBeVisible();
  await expect(entry.getByText(/Pausen gesamt/u)).toBeVisible();

  const segments = entry.locator("details").filter({ hasText: "Pausen (1)" }).first();
  await expect(segments).toBeVisible();
  await segments.getByText("Pausen (1)", { exact: true }).click();
  await expect(segments.locator("li")).toHaveCount(1);

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});
