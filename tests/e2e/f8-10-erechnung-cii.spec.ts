import AxeBuilder from "@axe-core/playwright";
import { readFileSync, statSync } from "node:fs";
import { expect, test, type Page } from "playwright/test";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F8-10 E-Rechnung CII-Export — Chromium-E2E.
 * Rechnungs-Entwurf (2 Positionen, 19 %) per SQL seeden → über die
 * Listenaktion „Ausstellen" (echter Service-Pfad mit Nummer/Snapshot)
 * → Detail-Panel „E-Rechnung" → Download enthält Belegnummer +
 * `CrossIndustryInvoice`; Axe sauber; keine Konsolenfehler.
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

const INVOICE_NAME = "F810-Rechnung";

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
    throw new Error("Der private F8-10-E2E-State ist unvollständig.");
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

async function seedDraftInvoice(): Promise<string> {
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
             where workspace_id = $1::uuid and name = $2
          )`,
      [data.workspaceId, INVOICE_NAME],
    );
    await client.query(
      `delete from commercial_document
        where workspace_id = $1::uuid and name = $2`,
      [data.workspaceId, INVOICE_NAME],
    );
    await client.query(
      `insert into workspace_invoicing_settings (
         workspace_id, company_name, company_email, company_tax_id,
         company_address_line1, company_postal_code, company_city,
         company_country, payment_account_holder, payment_iban,
         payment_bic, created_by
       ) values (
         $1::uuid, 'F810 GmbH', 'office@f810.example', 'DE123456789',
         'Strasse 1', '10115', 'Berlin', 'DE',
         'F810 GmbH', 'DE89370400440532013000', 'MARKDEF1100',
         (select id from user_identity where email = $2 limit 1)
       )
       on conflict (workspace_id) do update set
         company_tax_id = excluded.company_tax_id,
         updated_at = statement_timestamp()`,
      [data.workspaceId, data.editorEmail],
    );
    await client.query(
      `insert into contact (
         workspace_id, display_name, first_name, last_name,
         email_primary, email_normalized,
         address_street, address_house_number, address_postal_code,
         address_city, address_country
       ) values (
         $1::uuid, 'F810 Kundin', 'Fixture', 'Contact',
         'kundin@f810.example', 'kundin@f810.example',
         'Pruefweg', '7', '10115', 'Berlin', 'DE'
       )
       on conflict do nothing`,
      [data.workspaceId],
    );
    const inserted = await client.query(
      `insert into commercial_document (
         workspace_id, type, status, name, created_by,
         contact_id, currency, net_cents, tax_cents, gross_cents,
         payment_status, paid_cents, due_date, delivery_date
       ) values (
         $1::uuid, 'invoice', 'draft', $2,
         (select id from user_identity where email = $3 limit 1),
         (select id from contact
           where workspace_id = $1::uuid and email_normalized = 'kundin@f810.example'
           limit 1),
         'EUR', 950000, 180500, 1130500,
         'unpaid', 0, '2026-12-31'::date, '2026-11-15'::date
       )
       returning id`,
      [data.workspaceId, INVOICE_NAME, data.editorEmail],
    );
    const documentId = inserted.rows[0]?.id as string;
    await client.query(
      `insert into commercial_document_line (
         workspace_id, document_id, position, name, quantity_milli, unit,
         net_cents, tax_cents, gross_cents, tax_rate_bps
       ) values
         ($1::uuid, $2::uuid, 1, 'PV-Module', 20000, 'piece', 800000, 152000, 952000, 1900),
         ($1::uuid, $2::uuid, 2, 'Montage', 1000, 'set', 150000, 28500, 178500, 1900)`,
      [data.workspaceId, documentId],
    );
    await client.query("commit");
    return documentId;
  } finally {
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

test("F8-10-E2E-01: E-Rechnung herunterladen → CII-XML mit Belegnummer", async ({ page }) => {
  test.setTimeout(180_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  await grantInvoicingCapability();
  await seedDraftInvoice();
  const listPath = `/w/${data.workspaceId}/rechnungen/invoice`;

  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);

  // Echter Pfad: Entwurf über die Listenaktion ausstellen (Nummer,
  // Snapshot und GoBD-Frist vergibt der Service, kein SQL-Issued-Fake).
  const row = page.getByRole("row").filter({ hasText: INVOICE_NAME });
  await row.getByRole("button", { name: "Ausstellen" }).click();
  await expect(row.getByText("Ausgestellt")).toBeVisible();
  await row.getByRole("link", { name: INVOICE_NAME }).click();
  await expect(page).toHaveURL(/\/rechnungen\/invoice\/[0-9a-f-]+$/u);

  const panel = page.locator('[data-invoice-detail="cii"]');
  await expect(panel).toBeVisible();
  const downloadLink = panel.getByTestId("cii-export-download");
  await expect(downloadLink).toHaveText("E-Rechnung herunterladen");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    downloadLink.click(),
  ]);
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const content = readFileSync(downloadPath as string, "utf8");
  expect(content).toContain("CrossIndustryInvoice");
  const suggested = download.suggestedFilename();
  expect(suggested).toContain("erechnung-");
  // Dateiname trägt die vergebene Belegnummer — dieselbe Nummer steht im XML.
  const fileCore = suggested.replace(/^erechnung-/, "").replace(/\.xml$/, "");
  expect(fileCore.length).toBeGreaterThan(0);
  expect(content).toContain(fileCore);

  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(axe.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    targets: violation.nodes.flatMap((node) => node.target),
  }))).toEqual([]);

  expect(errors, "Browser-Konsole und Page-Errors der Beleg-Grenze").toEqual([]);
});
