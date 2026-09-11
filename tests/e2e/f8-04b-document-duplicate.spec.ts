import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F8-04b AB als Rechnung übernehmen — Chromium-E2E.
 * Auftragsbestätigung (Entwurf, 2 Positionen) per SQL seeden →
 * Detail-Panel „Als Rechnung übernehmen" → Rechnungs-Entwurf mit
 * denselben Positionen und Summen, verlinkt aus der Erfolgsmeldung.
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

const AB_NAME = "F804B-AB";
const INVOICE_NAME = `Rechnung zu ${AB_NAME}`;

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
    "baseURL", "databaseUrl", "serverLogPath", "workspaceId",
    "editorEmail", "viewerEmail", "externalEmail",
  ];
  if (required.some((key) => typeof parsed[key] !== "string" || parsed[key] === "")) {
    throw new Error("Der private F8-04b-E2E-State ist unvollständig.");
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
  await otpInput.fill(await otpFromPrivateDevMailLog(state().serverLogPath, email, logOffset));
  const signInResponsePromise = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/auth/sign-in/email-otp"
    && response.request().method() === "POST");
  try {
    await page.getByRole("button", { name: "Anmelden" }).click();
    expect((await signInResponsePromise).status()).toBe(200);
  } finally {
    if (await otpInput.isVisible().catch(() => undefined)) {
      await otpInput.fill("").catch(() => undefined);
    }
  }
  await page.waitForURL((url) => url.pathname === expectedPath);
}

async function grantInvoicingCapability(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [data.workspaceId]);
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
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function seedOrderConfirmationDraft(): Promise<void> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_catalog.set_config('app.workspace_id', $1, true)", [data.workspaceId]);
    await client.query(
      `select pg_catalog.set_config('app.actor_id', u.id::text, true)
         from user_identity u where u.email = $1 limit 1`,
      [data.editorEmail],
    );
    // Rerun-sicher: nur eigene Seed-Zeilen dieses Tests zurücksetzen.
    await client.query(
      `delete from commercial_document_line
        where workspace_id = $1::uuid
          and document_id in (
            select id from commercial_document
             where workspace_id = $1::uuid and name = any($2::text[])
          )`,
      [data.workspaceId, [AB_NAME, INVOICE_NAME]],
    );
    await client.query(
      `delete from commercial_document
        where workspace_id = $1::uuid and name = any($2::text[]) and status = 'draft'`,
      [data.workspaceId, [AB_NAME, INVOICE_NAME]],
    );
    await client.query(
      `insert into workspace_invoicing_settings (
         workspace_id, company_name, company_email,
         company_address_line1, company_postal_code, company_city,
         company_country, payment_account_holder, payment_iban,
         payment_bic, created_by
       ) values (
         $1::uuid, 'F804B GmbH', 'office@f804b.example',
         'Strasse 1', '10115', 'Berlin', 'DE',
         'F804B GmbH', 'DE89370400440532013000', 'MARKDEF1100',
         (select id from user_identity where email = $2 limit 1)
       )
       on conflict (workspace_id) do update set
         company_name = excluded.company_name,
         updated_at = statement_timestamp()`,
      [data.workspaceId, data.editorEmail],
    );
    await client.query(
      `insert into commercial_document (
         workspace_id, type, status, name, created_by,
         currency, net_cents, tax_cents, gross_cents,
         payment_status, paid_cents,
         planned_delivery_date, planned_service_date
       ) values (
         $1::uuid, 'order_confirmation', 'draft', $2,
         (select id from user_identity where email = $3 limit 1),
         'EUR', 950000, 180500, 1130500,
         'unpaid', 0,
         '2026-11-01'::date, '2026-11-15'::date
       )`,
      [data.workspaceId, AB_NAME, data.editorEmail],
    );
    await client.query(
      `insert into commercial_document_line (
         workspace_id, document_id, position, name, quantity_milli, unit,
         net_cents, tax_cents, gross_cents, tax_rate_bps
       )
       select $1::uuid, doc.id, line.position, line.name, line.quantity_milli, line.unit,
              line.net_cents, line.tax_cents, line.gross_cents, line.tax_rate_bps
         from commercial_document doc
         join (values
           (1, 'PV-Module', 20000, 'piece', 800000, 152000, 952000, 1900),
           (2, 'Montage', 1000, 'set', 150000, 28500, 178500, 1900)
         ) as line(position, name, quantity_milli, unit, net_cents, tax_cents, gross_cents, tax_rate_bps)
           on true
        where doc.workspace_id = $1::uuid and doc.name = $2`,
      [data.workspaceId, AB_NAME],
    );
    await client.query("commit");
  } finally {
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

function orderConfirmationsPath(): string {
  return `/w/${state().workspaceId}/rechnungen/order_confirmation`;
}

test("F8-04b-E2E-01: AB übernehmen → Rechnungs-Entwurf mit Positionen", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  await grantInvoicingCapability();
  await seedOrderConfirmationDraft();

  await page.goto(orderConfirmationsPath());
  await loginWithRealOtp(page, data.editorEmail, orderConfirmationsPath());

  const row = page.getByRole("row").filter({ hasText: AB_NAME });
  await row.getByRole("link", { name: AB_NAME }).click();

  const panel = page.getByTestId("duplicate-document-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Als Rechnung übernehmen" }).click();

  const success = page.getByTestId("duplicate-document-success");
  await expect(success).toContainText("Rechnungs-Entwurf angelegt");
  await success.getByRole("link", { name: "Rechnung öffnen" }).click();
  await expect(page).toHaveURL(/\/rechnungen\/invoice\/[0-9a-f-]+$/u);

  await expect(page.getByRole("heading", { name: INVOICE_NAME })).toBeVisible();
  const lines = page.locator('[data-invoice-detail="lines"]');
  await expect(lines.getByText("PV-Module")).toBeVisible();
  await expect(lines.getByText("Montage")).toBeVisible();
  await expect(lines.getByText("9.520,00 €")).toBeVisible();
  await expect(lines.getByText("1.785,00 €")).toBeVisible();
  const amounts = page.locator('[data-invoice-detail="amounts"]');
  await expect(amounts.locator("div").filter({ hasText: "Netto" }).first()).toContainText("9.500,00 €");
  await expect(amounts.locator("div").filter({ hasText: "Brutto" }).first()).toContainText("11.305,00 €");

  expect(errors, "Browser-Konsole und Page-Errors der Beleg-Grenze").toEqual([]);
});
