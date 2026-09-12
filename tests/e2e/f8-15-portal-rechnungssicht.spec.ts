import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F8-15 Portal-Rechnungssicht — Chromium-E2E.
 *
 * Rechnungs-Entwurf (brutto 119,00 €) per SQL auf dem f102-Projekt
 * seeden → echte Ausstellung über die UI → Portal-Link per UI →
 * öffentlicher Link, Abschnitt „Rechnungen“ zeigt Art, Betrag und
 * „Offen“. Rerun-sicher per Name.
 */

type E2EState = {
  serverLogPath: string;
  databaseUrl: string;
  w3WorkspaceId: string;
  f102ProjectId: string;
  editorEmail: string;
};

const INVOICE_NAME = "F815-Rechnung";

function state(): E2EState {
  const path = process.env.M1_05_E2E_STATE;
  if (!path) throw new Error("M1_05_E2E_STATE fehlt; bitte über npm run test:e2e starten.");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<E2EState>;
  const required: Array<keyof E2EState> = [
    "serverLogPath",
    "databaseUrl",
    "w3WorkspaceId",
    "f102ProjectId",
    "editorEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F8-15-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function seedDraftInvoice(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [data.w3WorkspaceId]);
    await client.query(
      `select pg_catalog.set_config('app.actor_id', u.id::text, true)
         from user_identity u where u.email = $1 limit 1`,
      [data.editorEmail],
    );
    // Issuing-Details für die echte UI-Ausstellung (M3-01-Muster).
    await client.query(
      `insert into workspace_invoicing_settings (
         id, workspace_id, company_name, company_email, company_country,
         company_address_line1, company_postal_code, company_city,
         accounting_method, revision, created_by,
         payment_account_holder, payment_iban, payment_bic
       ) select gen_random_uuid(), $1::uuid, 'Solarwerk E2E GmbH',
         'rechnung@e2e.invalid', 'DE', 'Teststraße 1', '10115', 'Berlin',
         'accrual', 1, (select id from user_identity where email = $2 limit 1),
         'Solarwerk E2E GmbH', 'DE89370400440532013000', 'MARKDEF1100'
       where not exists (
         select 1 from workspace_invoicing_settings where workspace_id = $1::uuid
       )`,
      [data.w3WorkspaceId, data.editorEmail],
    );
    await client.query(
      `update workspace_invoicing_settings
          set payment_account_holder = coalesce(payment_account_holder, 'Solarwerk E2E GmbH'),
              payment_iban = coalesce(payment_iban, 'DE89370400440532013000'),
              payment_bic = coalesce(payment_bic, 'MARKDEF1100')
        where workspace_id = $1::uuid`,
      [data.w3WorkspaceId],
    );
    await client.query(
      `delete from commercial_document_line
        where workspace_id = $1::uuid
          and document_id in (
            select id from commercial_document
             where workspace_id = $1::uuid and project_id = $2::uuid and name = $3
          )`,
      [data.w3WorkspaceId, data.f102ProjectId, INVOICE_NAME],
    );
    await client.query(
      `delete from commercial_document
        where workspace_id = $1::uuid and project_id = $2::uuid and name = $3`,
      [data.w3WorkspaceId, data.f102ProjectId, INVOICE_NAME],
    );
    // Entwurf mit einer 19-%-Zeile (brutto 119,00 €); Ausstellung läuft
    // echt über die UI (keine gefakten Issue-Artefakte).
    await client.query(
      `insert into commercial_document (
         workspace_id, project_id, type, status, name,
         currency, net_cents, tax_cents, gross_cents,
         payment_status, paid_cents, due_date, created_by
       ) values (
         $1::uuid, $2::uuid, 'invoice', 'draft', $3,
         'EUR', 10000, 1900, 11900,
         'unpaid', 0, '2026-09-26'::date,
         (select id from user_identity where email = $4 limit 1)
       )`,
      [data.w3WorkspaceId, data.f102ProjectId, INVOICE_NAME, data.editorEmail],
    );
    await client.query(
      `insert into commercial_document_line (
         workspace_id, document_id, position, name, quantity_milli, unit,
         net_cents, tax_cents, gross_cents, tax_rate_bps
       )
       select $1::uuid, doc.id, 1, 'Position', 1000, 'piece',
              10000, 1900, 11900, 1900
         from commercial_document doc
        where doc.workspace_id = $1::uuid and doc.project_id = $2::uuid and doc.name = $3`,
      [data.w3WorkspaceId, data.f102ProjectId, INVOICE_NAME],
    );
    await client.query("commit");
  } finally {
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function grantInvoicingCapability(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [data.w3WorkspaceId]);
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
      [data.w3WorkspaceId, data.editorEmail],
    );
    await client.query("commit");
  } finally {
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
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

test("F815-E2E-01: Portal zeigt ausgestellte Rechnung mit Betrag und Zahlstand", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

  await grantInvoicingCapability();
  await seedDraftInvoice();
  const invoicesPath = `/w/${data.w3WorkspaceId}/rechnungen/invoice`;
  await page.goto(invoicesPath);
  await loginWithRealOtp(page, data.editorEmail, invoicesPath);

  // Echte Ausstellung über die UI (Nummer aus der Serie, kein Fake).
  const draftRow = page.getByRole("row").filter({ hasText: INVOICE_NAME });
  await draftRow.getByRole("button", { name: "Ausstellen" }).click();
  await expect(draftRow.getByRole("button", { name: "Ausstellen" })).toHaveCount(0);

  const projectPath = `/w/${data.w3WorkspaceId}/anfragen/${data.f102ProjectId}`;
  await page.goto(projectPath);
  const portal = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Kundenportal", exact: true }),
  });
  await portal.getByRole("button", { name: "Link erstellen", exact: true }).click();
  const tokenText = await portal.locator("p.font-mono").textContent();
  const tokenPath = tokenText?.trim() ?? "";
  expect(tokenPath).toMatch(/^\/p\/[A-Za-z0-9_-]+$/u);

  await page.goto(tokenPath);
  await expect(page.getByText("Kundenportal", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Rechnungen", exact: true })).toBeVisible();
  await expect(page.getByText(/^Rechnung /u).first()).toBeVisible();
  await expect(page.getByText("119,00 €")).toBeVisible();
  await expect(page.getByText("Offen", { exact: true }).first()).toBeVisible();

  expect(errors, "Browser-Konsole und Page-Errors der Portal-Grenze").toEqual([]);
});
