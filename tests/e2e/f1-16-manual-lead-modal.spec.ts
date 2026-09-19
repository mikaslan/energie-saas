import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  resolveEditorId,
  seedIsolatedWorkspace,
  state as fixtureState,
} from "./m1-11g-fixture";

/**
 * F1-16 Manuelle Anfrage als Modal — Chromium-E2E (isolierter Workspace).
 * - Dialog öffnet als role=dialog mit Overlay, Fokus-Trap und Escape.
 * - Kontakt-Suche füllt das Formular vor; Submit nutzt den Kontakt wieder.
 * - Ohne Treffer bleibt das Formular nutzbar (Neuanlage).
 * - Viewport-Gate 375/768/1440 ohne horizontalen Overflow (F1-15-Muster).
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
      throw new Error(`Der private F1-16-E2E-State ist unvollständig (${key}).`);
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

async function openBoard(page: Page): Promise<string> {
  const data = state();
  const actorId = await resolveEditorId();
  const workspaceId = await seedIsolatedWorkspace(actorId);
  const listPath = `/w/${workspaceId}/anfragen`;
  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);
  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();
  return listPath;
}

async function openManualLeadDialog(page: Page) {
  await page.getByTestId("manual-lead-open").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  return dialog;
}

async function expectNoHorizontalOverflow(page: Page, expectedWidth: number): Promise<void> {
  await expect.poll(() => page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))).toEqual({ clientWidth: expectedWidth, scrollWidth: expectedWidth });
}

test("F1-16-E2E-01: Dialog öffnet als Modal, Escape und Abbrechen schließen", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = trackBrowserErrors(page);
  await openBoard(page);

  const dialog = await openManualLeadDialog(page);
  await expect(dialog.getByTestId("manual-lead-form")).toBeVisible();
  // Fokus startet im ersten Feld (Kontakt-Suche).
  await expect(page.getByTestId("manual-lead-contact-search")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("manual-lead-open")).toBeFocused();

  await openManualLeadDialog(page);
  await page.getByTestId("manual-lead-cancel").click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("manual-lead-open")).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors des Modal-Dialogs").toEqual([]);
});

test("F1-16-E2E-02: Kontakt-Suche füllt vor, Submit nutzt den Kontakt wieder", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = trackBrowserErrors(page);
  const suffix = randomUUID().slice(0, 8);
  const contactName = `F116 Greta ${suffix}`;
  const email = `f116-greta-${suffix}@example.test`;
  const listPath = await openBoard(page);
  // Erstanlage legt den Kontakt an (Erfolgszustand ersetzt den Dialog).
  await openManualLeadDialog(page);
  const firstForm = page.getByTestId("manual-lead-form");
  await firstForm.getByLabel("Name *").fill(contactName);
  await firstForm.getByLabel("E-Mail").fill(email);
  await firstForm.getByRole("button", { name: "Anfrage anlegen" }).click();
  await expect(page.getByTestId("manual-lead-success")).toContainText("Anfrage angelegt");

  // Frisches Formular: Suche findet den Kontakt, Auswahl füllt vor.
  await page.goto(listPath);
  await expect(page.getByRole("heading", { name: "Anfragen", level: 1 })).toBeVisible();
  await openManualLeadDialog(page);
  const form = page.getByTestId("manual-lead-form");
  await form.getByTestId("manual-lead-contact-search").fill(`F116 Greta ${suffix}`);
  const option = form.getByTestId("manual-lead-contact-option").filter({ hasText: contactName });
  await expect(option).toBeVisible();
  await option.click();

  await expect(form.getByTestId("manual-lead-contact-selected")).toContainText(contactName);
  await expect(form.getByLabel("Name *")).toHaveValue(contactName);
  await expect(form.getByLabel("E-Mail")).toHaveValue(email);
  const contactId = await form.locator('input[name="contactId"]').inputValue();
  expect(contactId).toMatch(/^[0-9a-f-]{36}$/u);

  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await expect(success).toContainText("bestehender Kontakt");

  expect(errors, "Browser-Konsole und Page-Errors der Kontakt-Suche").toEqual([]);
});

test("F1-16-E2E-03: Ohne Treffer bleibt das Formular nutzbar", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = trackBrowserErrors(page);
  const suffix = randomUUID().slice(0, 8);
  await openBoard(page);

  await openManualLeadDialog(page);
  const form = page.getByTestId("manual-lead-form");
  await form.getByTestId("manual-lead-contact-search").fill(`F116 Xyzzy Niemand ${suffix}`);
  await expect(form.getByTestId("manual-lead-contact-empty")).toContainText("Keine Kontakte gefunden");
  await expect(form.getByTestId("manual-lead-contact-results")).toHaveCount(0);

  await form.getByLabel("Name *").fill(`F116 Neu ${suffix}`);
  await form.getByLabel("Telefon").fill("0151 23456789");
  await form.getByRole("button", { name: "Anfrage anlegen" }).click();
  const success = page.getByTestId("manual-lead-success");
  await expect(success).toContainText("Anfrage angelegt");
  await expect(success).not.toContainText("bestehender Kontakt");

  expect(errors, "Browser-Konsole und Page-Errors der leeren Suche").toEqual([]);
});

test("F1-16-E2E-04: Viewport-Gate 375/768/1440 ohne Overflow, Trap/Escape mobil", async ({ page }) => {
  test.setTimeout(150_000);
  const errors = trackBrowserErrors(page);
  await openBoard(page);

  await openManualLeadDialog(page);

  await page.setViewportSize({ width: 375, height: 900 });
  await expectNoHorizontalOverflow(page, 375);
  // Abbrechen ist am kleinsten Viewport bedienbar.
  await expect(page.getByTestId("manual-lead-cancel")).toBeVisible();

  await page.setViewportSize({ width: 768, height: 900 });
  await expectNoHorizontalOverflow(page, 768);

  await page.setViewportSize({ width: 1440, height: 900 });
  await expectNoHorizontalOverflow(page, 1440);

  await page.setViewportSize({ width: 375, height: 900 });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors des Viewport-Gates").toEqual([]);
});
