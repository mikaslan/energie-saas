import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { Pool } from "pg";
import { expect, test, type Page } from "playwright/test";

/**
 * M3-00 Workspace-Stammdaten (Rechnungsstellung) — Chromium-E2E.
 *
 * Vertikaler Slice über die Einstellungsseite
 * `/w/[workspaceId]/einstellungen/rechnungsstellung`:
 *
 * - Editor legt Stammdaten an (Singleton-Upsert, optimistic baseRevision)
 *   und lädt sie persistiert erneut.
 * - Zahlenkreis-Template validiert serverseitig (`{NUMBER}`-Pflicht) und
 *   speichert ohne Zähler-Reset.
 * - Viewer sieht die Seite read-only (keine Schreibfläche, keine
 *   Submit-Buttons).
 * - External bleibt fail-closed (Zugriffs-Sperrseite, keine Konsole-Fehler).
 *
 * Rollenmodell (0045): read = viewer/editor/admin; write = Admin ODER Editor
 * mit Invoicing-Capability (`invoicing` = true); external_only-Mitgliedschaften
 * sind in beiden Fällen ausgeschlossen. Der Seed-Editor trägt die Capability
 * nicht — die Fixture `grantInvoicingCapability` rüstet sie gemäß Spec nach.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  editorEmail: string;
  viewerEmail: string;
  externalEmail: string;
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
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "baseURL",
    "databaseUrl",
    "serverLogPath",
    "workspaceId",
    "editorEmail",
    "viewerEmail",
    "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private M3-00-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

/**
 * Spec M3-00 §5: Schreibrecht = Admin ODER Editor mit Invoicing-Recht.
 * Der M1-05-Seed-Editor hat die Capability nicht — die Fixture rüstet sie
 * nach (Produktweg wäre die Mitgliederpflege, die es in M3-00 noch nicht
 * gibt).
 */
async function grantInvoicingCapability(): Promise<void> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_catalog.set_config('app.workspace_id', $1, true)",
      [data.workspaceId],
    );
    await client.query(
      `update membership
          set capabilities = pg_catalog.jsonb_set(
            coalesce(capabilities, '{}'::jsonb),
            '{invoicing}',
            'true'::jsonb,
            true
          )
        where workspace_id = $1::uuid
          and user_id = (select id from user_identity where email = $2 limit 1)`,
      [data.workspaceId, data.editorEmail],
    );
    await client.query("commit");
  } finally {
    await client.release();
    await pool.end();
  }
}

function settingsPath(): string {
  return `/w/${state().workspaceId}/einstellungen/rechnungsstellung`;
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

async function expectNoWcagAaAxeViolations(page: Page, stateName: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(result.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  })), `${stateName}: keine automatisiert prüfbare WCAG-A/AA-Verletzung`).toEqual([]);
}

test("M3-00: Editor legt Stammdaten an und lädt sie persistiert erneut", async ({ page }) => {
  test.setTimeout(120_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const path = settingsPath();

  await grantInvoicingCapability();
  await page.goto(path);
  await loginWithRealOtp(page, data.editorEmail, path);

  await expect(page.getByRole("heading", { name: "Rechnungsstellung", level: 1 })).toBeVisible();
  // Der Hinweis ist ein Absatz mit Folgesatz — exakter Textmatch schlaegt fehl.
  await expect(page.getByText(/Noch keine Stammdaten hinterlegt\./u)).toBeVisible();

  await page.getByLabel("Name des Unternehmens").fill("Solarwerk E2E GmbH");
  await page.getByLabel("E-Mail").fill("rechnung@solarwerk-e2e.invalid");
  await page.getByLabel("Adresszeile 1").fill("Teststraße 1");
  await page.getByLabel("Postleitzahl").fill("10115");
  await page.getByLabel("Ort").fill("Berlin");
  await page.getByRole("button", { name: "Speichern" }).first().click();

  await expect(page.getByText("Gespeichert.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Noch keine Stammdaten hinterlegt\./u)).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel("Name des Unternehmens")).toHaveValue("Solarwerk E2E GmbH");
  await expect(page.getByLabel("E-Mail")).toHaveValue("rechnung@solarwerk-e2e.invalid");
  await expect(page.getByLabel("Adresszeile 1")).toHaveValue("Teststraße 1");
  await expect(page.getByLabel("Postleitzahl")).toHaveValue("10115");
  await expect(page.getByLabel("Ort")).toHaveValue("Berlin");
  await expect(page.getByLabel("Land")).toHaveValue("DE");
  await expect(page.getByLabel("Aufbewahrungsfrist (Tage)")).toHaveValue("3650");

  await expectNoWcagAaAxeViolations(page, "M3-00-Einstellungsseite");
  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});

test("M3-00: Zahlenkreis-Template validiert und speichert ohne Zähler-Reset", async ({ page }) => {
  test.setTimeout(120_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const path = settingsPath();

  await grantInvoicingCapability();
  await page.goto(path);
  await loginWithRealOtp(page, data.editorEmail, path);

  const invoiceRow = page.locator("form").filter({
    has: page.getByLabel("Rechnung", { exact: true }),
  });
  await expect(invoiceRow).toHaveCount(1);
  await expect(invoiceRow.getByText("Zähler: 0", { exact: true })).toBeVisible();

  const template = invoiceRow.getByLabel("Rechnung", { exact: true });
  await template.fill("INV-{YEAR}");
  await invoiceRow.getByRole("button", { name: "Speichern" }).click();
  await expect(invoiceRow.getByText("Ungültiges Template.", { exact: true })).toBeVisible();
  await expect(invoiceRow.getByText("Zähler: 0", { exact: true })).toBeVisible();

  await template.fill("RE-{YEAR}-{NUMBER}");
  await invoiceRow.getByRole("button", { name: "Speichern" }).click();
  await expect(invoiceRow.getByText("Gespeichert.", { exact: true })).toBeVisible();

  await page.reload();
  await expect(invoiceRow.getByLabel("Rechnung", { exact: true })).toHaveValue("RE-{YEAR}-{NUMBER}");
  await expect(invoiceRow.getByText("Zähler: 0", { exact: true })).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Template-Grenze").toEqual([]);
});

test("M3-00: Viewer sieht die Rechnungsstellung nur lesend", async ({ page }) => {
  test.setTimeout(120_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const path = settingsPath();

  await page.goto(path);
  await loginWithRealOtp(page, data.viewerEmail, path);

  await expect(page.getByRole("heading", { name: "Rechnungsstellung", level: 1 })).toBeVisible();
  await expect(page.getByText(
    "Du kannst die Rechnungsstellung sehen, aber nicht verändern.",
    { exact: true },
  )).toBeVisible();
  await expect(page.getByRole("button", { name: "Speichern" })).toHaveCount(0);

  expect(errors, "Browser-Konsole und Page-Errors der Viewer-Grenze").toEqual([]);
});

test("M3-00: External bleibt fail-closed", async ({ browser }) => {
  test.setTimeout(120_000);
  const data = state();
  const path = settingsPath();

  const externalContext = await browser.newContext({
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    reducedMotion: "reduce",
    viewport: { width: 375, height: 900 },
  });
  const externalPage = await externalContext.newPage();
  const externalErrors = trackBrowserErrors(externalPage);
  try {
    await externalPage.goto(path);
    await loginWithRealOtp(externalPage, data.externalEmail, path);

    await expect(externalPage.getByRole("heading", {
      name: "Kein Zugriff",
      level: 1,
    })).toBeVisible();
    await expect(externalPage.getByText(
      "Nur interne Mitglieder können die Rechnungsstellung einsehen.",
      { exact: true },
    )).toBeVisible();
    expect(externalErrors, "Browser-Konsole und Page-Errors der External-Grenze").toEqual([]);
  } finally {
    await externalContext.close();
  }
});
