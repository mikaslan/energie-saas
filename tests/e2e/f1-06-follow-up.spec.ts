import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F1-06 Lead-Wiedervorlage — Chromium-E2E (isolierter Workspace).
 * Editor setzt in der Projektakte ein Datum, die Karte zeigt das
 * WV-Badge mit Band; das Überfällig-Preset filtert sie aus, Anstehend
 * behält sie; ?wiedervorlage=bogus bricht mit 404 ab; Löschen leert
 * Badge und Akte.
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
      throw new Error(`Der private F1-06-E2E-State ist unvollständig (${key}).`);
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

function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

test("F1-06-E2E-01: Wiedervorlage setzen, Badge, Preset-Filter, Löschen", async ({ page }) => {
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
  await form.getByLabel("Name *").fill("E2E Wiedervorlage");
  await form.getByLabel("Telefon").fill("0151 23456789");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);
  const detailUrl = page.url();

  const targetDate = plusDays(10);
  await page.getByTestId("follow-up-date").fill(targetDate);
  await page.getByTestId("follow-up-save").click();
  await expect(page.getByTestId("follow-up-set-feedback")).toContainText("Wiedervorlage gespeichert.");
  await expect(page.getByTestId("follow-up-current")).toContainText("Anstehend");

  await page.goto(listPath);
  const badge = page.locator('[data-testid^="followup-"]').first();
  await expect(badge).toContainText("Anstehend");

  const presets = page.getByTestId("board-followup-presets");
  await presets.getByRole("link", { name: "Überfällig" }).click();
  await expect(page).toHaveURL(/wiedervorlage=ueberfaellig/u);
  await expect(page.getByText("Filter aktiv: Überfällig")).toBeVisible();
  await expect(page.locator('[data-testid^="followup-"]')).toHaveCount(0);

  await presets.getByRole("link", { name: "Anstehend" }).click();
  await expect(page).toHaveURL(/wiedervorlage=anstehend/u);
  await expect(page.locator('[data-testid^="followup-"]').first()).toContainText("Anstehend");

  await page.goto(`${listPath}?wiedervorlage=bogus`);
  await expect(page.locator("h1").first()).toHaveText("404");
  await expect(page.getByTestId("board-followup-presets")).toHaveCount(0);

  await page.goto(detailUrl);
  await page.getByTestId("follow-up-clear").click();
  await expect(page.getByTestId("follow-up-clear-feedback")).toContainText("Wiedervorlage gelöscht.");
  await expect(page.getByTestId("follow-up-current")).toContainText("Keine Wiedervorlage");
  await page.goto(listPath);
  await expect(page.locator('[data-testid^="followup-"]')).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Wiedervorlage-Grenze").toEqual([]);
});

test("F106B-E2E-01: Dashboard-Widget zeigt überfällige Wiedervorlage mit Band und Preset-Link", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const stamp = Date.now();
  const leadName = `F106B E2E Widget ${stamp}`;
  const targetDate = plusDays(-2);
  const expectedBerlin = new Date(`${targetDate}T12:00:00Z`)
    .toLocaleDateString("de-DE", { timeZone: "Europe/Berlin", day: "2-digit", month: "2-digit", year: "numeric" });

  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);

  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);
  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();

  await page.getByTestId("manual-lead-open").click();
  const form = page.getByTestId("manual-lead-form");
  await form.getByLabel("Name *").fill(leadName);
  await form.getByLabel("Telefon").fill("0151 23456789");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await success.getByRole("link", { name: "Projektakte öffnen" }).click();
  await expect(page).toHaveURL(/\/anfragen\/[0-9a-f-]+$/u);

  await page.getByTestId("follow-up-date").fill(targetDate);
  await page.getByTestId("follow-up-save").click();
  await expect(page.getByTestId("follow-up-current")).toContainText("Überfällig");

  await page.goto(`/w/${workspaceId}/dashboard`);
  await expect(page.getByRole("heading", { name: "Übersicht", level: 1 })).toBeVisible();
  const widget = page.locator('section[aria-label="Wiedervorlagen"]');
  await expect(widget).toBeVisible();
  await expect(widget.getByText(leadName, { exact: false })).toBeVisible();
  await expect(widget.getByText("Überfällig", { exact: true })).toBeVisible();
  await expect(widget.getByText(expectedBerlin, { exact: false })).toBeVisible();
  const presetLink = widget.getByRole("link", { name: "Alle überfälligen", exact: true });
  await expect(presetLink).toHaveAttribute("href", `/w/${workspaceId}/anfragen?wiedervorlage=ueberfaellig`);
  await presetLink.click();
  await expect(page).toHaveURL(/wiedervorlage=ueberfaellig/u);
  expect(errors, "Browser-Konsole beim Widget").toEqual([]);
});
