import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F1-02 Lead-Bulk-CSV-Import — Chromium-E2E (isolierter Workspace).
 * Prüfen (Dry-Run) meldet 2 gültige + 1 fehlerhafte Zeile ohne Writes;
 * Importieren legt beide Anfragen als Karten auf dem Wohnbau-Board an.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  editorEmail: string;
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
  const full = fixtureState();
  for (const key of ["baseURL", "databaseUrl", "serverLogPath", "editorEmail"] as const) {
    if (typeof full[key] !== "string" || full[key] === "") {
      throw new Error(`Der private F1-02-E2E-State ist unvollständig (${key}).`);
    }
  }
  return full as unknown as E2EState;
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

const BULK_CSV = [
  "Name;E-Mail;Telefon;PLZ;Ort;Notiz",
  "Bulk E2E Eins;eins@f102.test;0151 44444444;10115;Berlin;Rückruf",
  "Bulk E2E Zwei;;0151 55555555;80331;München;",
  "Bulk E2E Ohne Weg;;;;;",
].join("\n");

test("F1-02-E2E-01: CSV prüfen ohne Writes, dann importieren", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);

  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);
  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();

  await page.getByTestId("manual-lead-bulk-open").click();
  const form = page.getByTestId("manual-lead-bulk-form");
  await form.getByLabel("CSV-Text").fill(BULK_CSV);
  await form.getByRole("button", { name: "Prüfen" }).click();

  const report = page.getByTestId("manual-lead-bulk-report");
  await expect(report).toContainText("2 gültig, 1 fehlerhaft");
  await expect(report).toContainText("Es wurde nichts angelegt");
  await expect(page.getByTestId("manual-lead-bulk-errors")).toContainText("E-Mail oder Telefon fehlt");
  await expect(page.getByRole("heading", { name: "Bulk E2E Eins" })).toHaveCount(0);

  await form.getByRole("button", { name: "Importieren" }).click();
  await expect(report).toContainText("2 von 3 Anfragen angelegt");
  await expect(page.getByRole("heading", { name: "Bulk E2E Eins" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bulk E2E Zwei" })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Bulk-Grenze").toEqual([]);
});
