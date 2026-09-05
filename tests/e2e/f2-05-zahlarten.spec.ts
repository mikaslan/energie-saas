import { readFileSync, statSync } from "node:fs";
import { Pool } from "pg";
import { expect, test, type Page } from "playwright/test";

/**
 * F2.5 Zahlarten Slice A — Chromium-E2E.
 *
 * Abdeckung: Stammdaten-CRUD in den Einstellungen (anlegen, umbenennen,
 * archivieren, reaktivieren) + Varianten-Auswahl im Angebots-Editor
 * (setzen, DB-Read-back, zurücksetzen) — reine Anzeige, kein Provider.
 * Service-Kanten (Konflikt, Isolation, Scope-Miss, Validierung) decken
 * die Vitest-DB-Tests tests/db/f205-payment-options.test.ts ab.
 * Eigenes W3-Projekt: keine Kopplung an andere Specs (f7-03-Lehre).
 */

type E2EState = {
  databaseUrl: string;
  serverLogPath: string;
  w3WorkspaceId: string;
  f25ProjectId: string;
  editorEmail: string;
};

const browserErrors = new WeakMap<Page, string[]>();

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "databaseUrl",
    "serverLogPath",
    "w3WorkspaceId",
    "f25ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F2.5-E2E-State ist unvollständig.");
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
  browserErrors.set(page, errors);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

async function readPaymentOptionId(offerId: string, variantId: string): Promise<string | null> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `select v.payment_option_id::text as "paymentOptionId"
         from offer_variant v
        where v.workspace_id = $1::uuid
          and v.offer_id = $2::uuid
          and v.id = $3::uuid`,
      [data.w3WorkspaceId, offerId, variantId],
    );
    return (result.rows[0]?.paymentOptionId as string | null) ?? null;
  } finally {
    await pool.end();
  }
}

test("F2.5-E2E-01: Zahlarten-Stammdaten — CRUD in den Einstellungen", async ({ page }) => {
  test.setTimeout(150_000);
  const data = state();
  const errors = trackErrors(page);

  const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/zahlarten`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);

  // Anlegen (Schlüssel Kauf, eigene Bezeichnung).
  await page.getByLabel("Schlüssel").selectOption("purchase");
  await page.getByLabel("Bezeichnung").fill("Kauf E2E");
  await page.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Zahlart angelegt.")).toBeVisible();
  await expect(page.getByText("Kauf E2E", { exact: true })).toBeVisible();

  // Umbenennen.
  const entry = page.locator("li", { hasText: "Kauf E2E" }).first();
  await entry.getByRole("button", { name: "Bearbeiten", exact: true }).click();
  await entry.getByLabel("Bezeichnung").fill("Kauf E2E Umbenannt");
  await entry.getByRole("button", { name: "Speichern", exact: true }).click();
  await expect(page.getByText("Zahlart aktualisiert.")).toBeVisible();
  await expect(page.getByText("Kauf E2E Umbenannt", { exact: true })).toBeVisible();

  // Archivieren → wandert in den Archiv-Bereich.
  const renamed = page.locator("li", { hasText: "Kauf E2E Umbenannt" }).first();
  await renamed.getByRole("button", { name: "Archivieren", exact: true }).click();
  await expect(page.getByText("Zahlart archiviert.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Archivierte Zahlarten", exact: true })).toBeVisible();

  // Reaktivieren.
  const archivedEntry = page.locator("li", { hasText: "Kauf E2E Umbenannt" }).first();
  await archivedEntry.getByRole("button", { name: "Reaktivieren", exact: true }).click();
  await expect(page.getByText("Zahlart reaktiviert.")).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Settings-Grenze").toEqual([]);
});

test("F2.5-E2E-02: Varianten-Auswahl — setzen, Read-back, zurücksetzen", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackErrors(page);

  // Stammdaten-Voraussetzung per UI (eigene Bezeichnung für stabile Selektoren).
  const settingsPath = `/w/${data.w3WorkspaceId}/einstellungen/zahlarten`;
  await page.goto(settingsPath);
  await loginWithRealOtp(page, data.editorEmail, settingsPath);
  await page.getByLabel("Schlüssel").selectOption("financing_classic");
  await page.getByLabel("Bezeichnung").fill("Finanzierung E2E");
  await page.getByRole("button", { name: "Anlegen", exact: true }).click();
  await expect(page.getByText("Zahlart angelegt.")).toBeVisible();

  // Angebot per UI erzeugen (Ready-Status aus dem M2-01-Seed).
  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f25ProjectId}`;
  await page.goto(projectPath);
  const createEntry = page.locator('[data-offer-create-state="ready"]');
  await expect(createEntry).toBeVisible();
  await createEntry.getByLabel("Forecast netto in Euro (optional)").fill("9800");
  await createEntry.getByLabel("B2C-Preiszielgruppe ausdrücklich bestätigen").check();
  await createEntry.getByLabel("Steuerentwurf").selectOption("standard_19");
  await createEntry.getByRole("button", { name: "Angebot erstellen", exact: true }).click();
  await page.waitForURL((url) =>
    /^\/w\/[0-9a-f-]+\/angebote\/[0-9a-f-]+$/u.test(url.pathname)
    && url.searchParams.has("variante"));
  const detailUrl = new URL(page.url());
  const detailPath = detailUrl.pathname;
  const variantId = detailUrl.searchParams.get("variante");
  expect(variantId).toBeTruthy();
  const offerId = detailPath.split("/").pop();
  if (!offerId) throw new Error("Der Angebots-Pfad enthält keine Offer-ID.");

  const controls = page.locator("section").filter({
    has: page.getByRole("heading", { name: /Zahlart/, exact: false }),
  });
  await expect(controls).toBeVisible();
  await expect(controls.getByText(/Keine Angabe/)).toBeVisible();

  // Zahlart per UI wählen und speichern.
  await controls.getByLabel("Zahlart wählen").selectOption({ label: "Finanzierung E2E (Finanzierung (Classic, Anzeige))" });
  await controls.getByRole("button", { name: "Zahlart speichern", exact: true }).click();
  await expect(controls.getByText("Die Zahlart wurde gespeichert.")).toBeVisible();
  await expect(controls.getByText(/Aktuell:/)).toContainText("Finanzierung E2E");

  // DB-Read-back: Auswahl ist an der Variante persistiert.
  const optionId = await controls
    .locator("#variant-payment-option option", { hasText: "Finanzierung E2E" })
    .getAttribute("value");
  expect(optionId).toBeTruthy();
  await expect.poll(async () => readPaymentOptionId(offerId, variantId!), {
    message: "Die Zahlart-Auswahl muss in der DB sichtbar sein.",
    timeout: 15_000,
  }).toBe(optionId);

  // Zurücksetzen auf „Keine Angabe".
  await controls.getByLabel("Zahlart wählen").selectOption("");
  await controls.getByRole("button", { name: "Zahlart speichern", exact: true }).click();
  await expect(controls.getByText("Die Zahlart wurde gespeichert.")).toBeVisible();
  await expect.poll(async () => readPaymentOptionId(offerId, variantId!), {
    message: "Das Zurücksetzen muss in der DB sichtbar sein.",
    timeout: 15_000,
  }).toBeNull();

  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});
