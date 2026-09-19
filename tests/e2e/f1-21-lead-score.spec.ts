import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F1-21 Lead-Score-Vertiefung — Chromium-E2E (isolierter Workspace).
 * Manueller Lead mit E-Mail + Telefon + PLZ/Ort erhält Score 30 (kalt) mit
 * Stale-Banner („wird aktualisiert" + Aktualisieren, Cold-Start ohne
 * Worker-Recompute im Katalog-E2E-Modus); das Preset-Trio
 * (Kundenaktivität/Ansprache/Profil) filtert kombinierbar, unbekannte Werte
 * brechen mit 404 ab. Worker-Bounded-Wait: bounded Poll auf das gesetzte
 * Board statt offener Wartezeit.
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
      throw new Error(`Der private F1-21-E2E-State ist unvollständig (${key}).`);
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

test("F1-21-E2E-01: Stale-Banner, Preset-Trio und fail-closed Params", async ({ page }) => {
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
  await form.getByLabel("Name *").fill("E2E Score F121");
  await form.getByLabel("E-Mail").fill("score-f121@example.com");
  await form.getByLabel("Telefon").fill("0151 23456789");
  await form.getByLabel("PLZ").fill("10115");
  await form.getByLabel("Ort").fill("Berlin");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  await expect(page.getByTestId("manual-lead-success")).toContainText("Anfrage angelegt");

  await page.reload();
  const badge = page.locator('[data-testid^="score-"]').first();
  // Worker-Bounded-Wait: bounded Poll (15 s) auf das gesetzte Board — der
  // Sync-Fallback garantiert das Badge, mit oder ohne Worker-Recompute.
  await expect(async () => {
    await expect(badge).toContainText("Score 30 · Kalt");
  }).toPass({ timeout: 15_000 });

  // Cold-Start ohne Worker-Recompute (Katalog-E2E-Modus): Stale-Banner mit
  // Refresh-Link; der Refresh hält Badge und Banner stabil.
  const banner = page.getByTestId("lead-score-stale");
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText("wird aktualisiert");
  await banner.getByRole("link", { name: "Aktualisieren" }).click();
  await expect(page.locator('[data-testid^="score-"]').first()).toContainText("Score 30 · Kalt");
  await expect(page.getByTestId("lead-score-stale")).toBeVisible();

  // Intent-Preset: Lead ohne Kundenaktivität wird ausgefiltert.
  const intentPresets = page.getByTestId("board-intent-presets");
  await intentPresets.getByRole("link", { name: "Aktiv" }).click();
  await expect(page).toHaveURL(/intent=aktiv/u);
  await expect(page.getByText("Filter aktiv: Aktiv")).toBeVisible();
  await expect(page.locator('[data-testid^="score-"]')).toHaveCount(0);

  await intentPresets.getByRole("link", { name: "Alle" }).click();
  await expect(page).not.toHaveURL(/intent=/u);
  await expect(page.locator('[data-testid^="score-"]').first()).toContainText("Score 30 · Kalt");

  // Ansprache-Preset: kalter Lead ist nicht bereit.
  const ansprachePresets = page.getByTestId("board-ansprache-presets");
  await ansprachePresets.getByRole("link", { name: "Bereit" }).click();
  await expect(page).toHaveURL(/ansprache=bereit/u);
  await expect(page.getByText("Filter aktiv: Bereit")).toBeVisible();
  await expect(page.locator('[data-testid^="score-"]')).toHaveCount(0);

  await ansprachePresets.getByRole("link", { name: "Alle" }).click();
  await expect(page).not.toHaveURL(/ansprache=/u);

  // Lücke-Preset: Lead ohne Profil bleibt sichtbar; kombiniert mit Intent
  // (AND) filtert ihn wieder aus.
  const lueckePresets = page.getByTestId("board-luecke-presets");
  await lueckePresets.getByRole("link", { name: "Fehlt" }).click();
  await expect(page).toHaveURL(/luecke=profil/u);
  await expect(page.getByText("Filter aktiv: Profil fehlt")).toBeVisible();
  await expect(page.locator('[data-testid^="score-"]').first()).toContainText("Score 30 · Kalt");

  await intentPresets.getByRole("link", { name: "Aktiv" }).click();
  await expect(page).toHaveURL(/intent=aktiv/u);
  await expect(page).toHaveURL(/luecke=profil/u);
  await expect(page.locator('[data-testid^="score-"]')).toHaveCount(0);

  await intentPresets.getByRole("link", { name: "Alle" }).click();
  await expect(page).not.toHaveURL(/intent=/u);
  await lueckePresets.getByRole("link", { name: "Alle" }).click();
  await expect(page).not.toHaveURL(/luecke=/u);
  await expect(page.locator('[data-testid^="score-"]').first()).toContainText("Score 30 · Kalt");

  // Unbekannte Preset-Werte → 404-Seite (fail-closed, kein stiller
  // Alle-Fallback; Muster wie F15-01 bereich=industrie).
  for (const query of ["intent=bogus", "ansprache=bogus", "luecke=bogus"]) {
    await page.goto(`${listPath}?${query}`);
    await expect(page.locator("h1").first()).toHaveText("404");
    await expect(page.getByTestId("board-intent-presets")).toHaveCount(0);
    await expect(page.locator('[data-testid^="score-"]')).toHaveCount(0);
  }

  expect(errors, "Browser-Konsole und Page-Errors der F1-21-Grenze").toEqual([]);
});
