import { readFileSync, statSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { Pool } from "pg";
import { expect, test, type Page } from "playwright/test";

/**
 * F4.6 Workspace-Simulationsdefaults — Chromium-E2E.
 *
 * - Editor mit Economics-Capability legt Defaults an und lädt sie
 *   persistiert erneut (leerer Zustand vorher sichtbar).
 * - Viewer sieht die Seite read-only (Speichern deaktiviert).
 * - External bleibt fail-closed (Zugriffs-Sperrseite).
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
    throw new Error("Der private F4.6-E2E-State ist unvollständig.");
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

async function grantEconomicsCapability(): Promise<void> {
  const data = state();
  const pool = new Pool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [data.workspaceId]);
    await client.query(
      `update membership
          set capabilities = pg_catalog.jsonb_set(
            coalesce(capabilities, '{}'::jsonb),
            '{economics}',
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
  return `/w/${state().workspaceId}/einstellungen/wirtschaftlichkeit`;
}

test("F4.6-E2E-01: Editor legt Defaults an und lädt sie persistiert erneut", async ({ page }) => {
  test.setTimeout(120_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const path = settingsPath();

  await grantEconomicsCapability();
  await page.goto(path);
  await loginWithRealOtp(page, data.editorEmail, path);

  await expect(page.getByRole("heading", { name: "Wirtschaftlichkeit", level: 1 })).toBeVisible();
  await expect(page.getByText(/Noch keine Defaults hinterlegt\./u)).toBeVisible();

  await page.getByLabel("Strompreis (Cent/kWh)").fill("32");
  await page.getByLabel("Eskalation (% pro Jahr)").fill("1.50");
  await page.getByLabel("Ölpreis (Cent/Liter)").fill("105");
  await page.getByLabel("Gaspreis (Cent/kWh)").fill("12");
  await page.getByLabel("Cashflow-Horizont (Jahre)").fill("25");
  await page.getByRole("button", { name: "Speichern" }).click();

  await expect(page.getByText("Gespeichert.", { exact: true })).toBeVisible();
  await expect(page.getByText(/Noch keine Defaults hinterlegt\./u)).toHaveCount(0);

  await page.reload();
  await expect(page.getByLabel("Strompreis (Cent/kWh)")).toHaveValue("32");
  await expect(page.getByLabel("Eskalation (% pro Jahr)")).toHaveValue("1.50");
  await expect(page.getByLabel("Cashflow-Horizont (Jahre)")).toHaveValue("25");

  // Kimi-P3-6: gesetztes Feld wieder leeren → null (Länderreferenz-Semantik).
  await page.getByLabel("Strompreis (Cent/kWh)").fill("");
  await page.getByRole("button", { name: "Speichern" }).click();
  await expect(page.getByText("Gespeichert.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Strompreis (Cent/kWh)")).toHaveValue("");
  await expect(page.getByLabel("Eskalation (% pro Jahr)")).toHaveValue("1.50");

  await expectNoWcagAaAxeViolations(page, "F4.6-Einstellungsseite");
  expect(errors, "Browser-Konsole und Page-Errors der Editor-Grenze").toEqual([]);
});

test("F4.6-E2E-02: Viewer read-only, External fail-closed", async ({ page }) => {
  test.setTimeout(120_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const path = settingsPath();

  await grantEconomicsCapability();
  await page.goto(path);
  await loginWithRealOtp(page, data.viewerEmail, path);
  await expect(page.getByRole("heading", { name: "Wirtschaftlichkeit", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Speichern" })).toBeDisabled();

  await page.context().clearCookies();
  await page.goto(path);
  await loginWithRealOtp(page, data.externalEmail, path);
  await expect(page.getByText("Zugriff eingeschränkt")).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Rollengrenzen").toEqual([]);
});
