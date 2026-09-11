import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F1-07 Lead-Score — Chromium-E2E (isolierter Workspace).
 * Manueller Lead mit E-Mail + Telefon + PLZ/Ort erhält Score 30 (kalt),
 * das Badge zeigt Wert, Ampel und Signale; das Heiß-Preset filtert die
 * Karte aus, Alle holt sie zurück; ?score=bogus bricht mit 404 ab.
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
      throw new Error(`Der private F1-07-E2E-State ist unvollständig (${key}).`);
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

test("F1-07-E2E-01: Score-Badge, Preset-Filter und fail-closed Param", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);

  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);
  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill("E2E Score Kalt");
  await form.getByLabel("E-Mail").fill("score-kalt@example.com");
  await form.getByLabel("Telefon").fill("0151 23456789");
  await form.getByLabel("PLZ").fill("10115");
  await form.getByLabel("Ort").fill("Berlin");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  await expect(page.getByTestId("manual-lead-success")).toContainText("Anfrage angelegt");

  await page.reload();
  const badge = page.locator('[data-testid^="score-"]').first();
  await expect(badge).toContainText("Score 30 · Kalt");
  await expect(badge).toHaveAttribute("title", /Lead-Score 30 von 100 \(Kalt\).*E-Mail vorhanden.*Telefon erreichbar.*PLZ und Ort vorhanden/u);

  const presets = page.getByTestId("board-score-presets");
  await presets.getByRole("link", { name: "Heiß" }).click();
  await expect(page).toHaveURL(/score=heiss/u);
  await expect(page.getByText("Filter aktiv: Heiß")).toBeVisible();
  await expect(page.locator('[data-testid^="score-"]')).toHaveCount(0);

  await presets.getByRole("link", { name: "Alle" }).click();
  await expect(page).not.toHaveURL(/score=/u);
  await expect(page.locator('[data-testid^="score-"]').first()).toContainText("Score 30 · Kalt");

  // Unbekannter score-Wert → 404-Seite (fail-closed, kein stiller
  // Alle-Fallback; Muster wie F15-01 bereich=industrie).
  await page.goto(`${listPath}?score=bogus`);
  await expect(page.locator("h1").first()).toHaveText("404");
  await expect(page.getByTestId("board-score-presets")).toHaveCount(0);
  await expect(page.locator('[data-testid^="score-"]')).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Score-Grenze").toEqual([]);
});
