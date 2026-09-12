import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { sql } from "drizzle-orm";
import { expect, test, type Page } from "playwright/test";
import { withTenantOn } from "../../lib/db/tenant";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";
import {
  seedSignedGraphDirect,
  TENANT_LINE_NAME,
} from "../setup/f806-offer-import-seed";

/**
 * F8-06 Angebot als Rechnung übernehmen — Chromium-E2E.
 * - Setup (Node-seitig, ehrliche Kette): Fixture-Angebot → Revise →
 *   PDF-Entwurf → Freigabe → Issuance → Signatur (Klick).
 * - Browser: Editor öffnet die Angebotsseite, übernimmt die signierte
 *   Variante, folgt dem Erfolgslink und sieht die Positionen.
 */

type E2EState = {
  baseURL: string;
  databaseUrl: string;
  serverLogPath: string;
  workspaceId: string;
  adminEmail: string;
  editorEmail: string;
  viewerEmail: string;
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
    "baseURL", "databaseUrl", "serverLogPath", "workspaceId", "adminEmail", "editorEmail", "viewerEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F8-06-E2E-State ist unvollständig.");
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
    if (match) return match[1]!;
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
  await otpInput.fill(await otpFromPrivateDevMailLog(
    state().serverLogPath,
    email,
    logOffset,
  ));
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

async function seedSignedOffer(): Promise<{ workspaceId: string; offerId: string }> {
  const data = state();
  // Isolierter Workspace (M1-11g-Muster): Der Angebots-Graph zieht per
  // Fixture-Kette einen Katalog-Bestand herein; im geteilten Workspace
  // bräche das die exakte Katalogzählung von m1-05-triage (CI 34667557994).
  const workspaceId = randomUUID();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    const identities = await pool.query<{ id: string; email: string }>(
      "select id, email from user_identity where email in ($1, $2)",
      [data.adminEmail, data.editorEmail],
    );
    const adminId = identities.rows.find((row) => row.email === data.adminEmail)?.id;
    const editorId = identities.rows.find((row) => row.email === data.editorEmail)?.id;
    if (!adminId) throw new Error("F8-06-E2E: Admin-Identität fehlt.");
    if (!editorId) throw new Error("F8-06-E2E: Editor-Identität fehlt.");
    await withTenantOn(pool, workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into workspace (id, name) values (${workspaceId}::uuid, 'F8-06 isoliert')
      `);
      await tx.execute(sql`
        insert into membership (workspace_id, user_id, role, capabilities)
        values (${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb),
               (${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"invoicing":true}'::jsonb)
      `);
      // Ausstellungsdaten (Firma DE + IBAN) sind Import-Voraussetzung des
      // Services; der Runner seedet sie nur im Preview-Modus.
      await tx.execute(sql`
        insert into workspace_invoicing_settings (
          id, workspace_id, company_name, company_email, company_country,
          company_address_line1, company_postal_code, company_city,
          accounting_method, revision, created_by,
          payment_account_holder, payment_iban, payment_bic
        ) values (
          gen_random_uuid(), ${workspaceId}::uuid, 'Solarwerk Demo GmbH',
          'rechnung@demo.invalid', 'DE', 'Musterstraße 1', '10115', 'Berlin',
          'accrual', 1, ${editorId}::uuid,
          'Solarwerk Demo GmbH', 'DE89370400440532013000', 'MARKDEF1100'
        )
      `);
    });
    const { graph } = await seedSignedGraphDirect(pool, {
      workspaceId,
      adminId,
    });
    return { workspaceId, offerId: graph.offerId };
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test.beforeEach(async ({ page }) => {
  trackBrowserErrors(page);
});

test.afterEach(async ({ page }) => {
  expect(browserErrors.get(page) ?? [], "Browser-Konsole und Page-Errors").toEqual([]);
});

test("F8-06-E2E-01: signiertes Angebot übernehmen → Rechnung mit Positionen", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);
  const { workspaceId, offerId } = await seedSignedOffer();
  const path = `/w/${workspaceId}/angebote/${offerId}`;

  // Die Angebotsseite rendert ohne Sitzung einen Inline-Hinweis statt auf
  // /login umzuleiten (Bestandsverhalten); direkter Login mit next-Pfad.
  await page.goto(`/login?${new URLSearchParams({ next: path }).toString()}`);
  await loginWithRealOtp(page, data.editorEmail, path);

  const panel = page.getByTestId("offer-invoice-import-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Als Rechnung übernehmen" }).click();

  const success = page.getByTestId("offer-invoice-import-success");
  await expect(success).toBeVisible();
  await expect(success.getByRole("link", { name: "Rechnung öffnen" })).toBeVisible();

  await success.getByRole("link", { name: "Rechnung öffnen" }).click();
  await page.waitForURL((url) => url.pathname.includes("/rechnungen/invoice/"));
  await expect(page.getByText(TENANT_LINE_NAME, { exact: false }).first()).toBeVisible();
  expect(errors, "Browser-Konsole und Page-Errors des Angebots-Imports").toEqual([]);
});
