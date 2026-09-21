import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { sql } from "drizzle-orm";
import { expect, test, type Page } from "playwright/test";
import {
  claimInvoicePdfRenderJob,
  finalizeInvoicePdfRenderSuccess,
} from "../../worker/invoice-pdf-database";
import type { TenantTx } from "../../lib/db/types";
import { withTenantOn } from "../../lib/db/tenant";
import {
  buildInvoicePdfInput,
  hashInvoicePdfInput,
  INVOICE_PDF_RENDERER_RECIPE_VERSION,
  INVOICE_PDF_TEMPLATE_VERSION,
} from "../../lib/integrations/invoicing/pdf-contract";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F8-23b Versandbereit-Ansicht (Chromium):
 * Rechnung mit succeeded-PDF-Job → ?versandbereit=true zeigt nur sie,
 * mit Badge + Detail-Link. Job-Request per Browser-Kette (F819-Spiegel),
 * Abschluss per Worker-Import mit synthetischem Artefakt.
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

const READY_NAME = "F823B-Bereit";
const NOJOB_NAME = "F823B-KeinJob";

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
    throw new Error("Der private F823B-E2E-State ist unvollständig.");
  }
  return parsed as E2EState;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function otpFromPrivateDevMailLog(logPath: string, email: string, byteOffset: number): Promise<string> {
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
  await page.getByRole("button", { name: "Anmelden" }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => url.pathname === expectedPath);
}

function seedSequenceFor(name: string): number {
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return 900000 + (Math.abs(hash) % 99000) + 1;
}

async function seedInvoice(name: string): Promise<string> {
  const data = state();
  const seq = seedSequenceFor(name);
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
    const existing = await client.query(
      `select id from commercial_document where workspace_id = $1::uuid and name = $2 limit 1`,
      [data.workspaceId, name],
    );
    if (existing.rows[0]) {
      await client.query(
        `delete from commercial_document_render_job where workspace_id = $1::uuid and document_id = $2::uuid`,
        [data.workspaceId, existing.rows[0].id],
      );
      await client.query(
        `update commercial_document set sent_at = null where id = $1::uuid`,
        [existing.rows[0].id],
      );
      await client.query("commit");
      return existing.rows[0].id as string;
    }
    const inserted = await client.query(
      `insert into commercial_document (
         id, workspace_id, type, status, name, created_by, issued_at,
         issued_snapshot, snapshot_sha256, issued_by, goebd_retention_until,
         number, number_year, number_sequence, net_cents, tax_cents,
         gross_cents, payment_status, paid_cents, due_date
       ) values (
         gen_random_uuid(), $1::uuid, 'invoice', 'issued', $2,
         (select id from user_identity where email = $3 limit 1),
         (date_trunc('month', now() at time zone 'Europe/Berlin') + interval '1 day 12 hours') at time zone 'Europe/Berlin',
         '{"schemaVersion":"document-snapshot.v1"}'::jsonb,
         decode($4, 'hex'),
         (select id from user_identity where email = $3 limit 1),
         '2036-12-31'::date,
         'Rechnung-F823B-' || $5, extract(year from now() at time zone 'Europe/Berlin')::int,
         $5::int, 10000, 1900, 11900, 'unpaid', 0, (now()::date + 14)
       )
       returning id`,
      [data.workspaceId, name, data.editorEmail, "00".repeat(32), seq],
    );
    await client.query("commit");
    return inserted.rows[0].id as string;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function withJobDatabase<T>(callback: (tx: TenantTx) => Promise<T>): Promise<T> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    return await withTenantOn(pool, data.workspaceId, (tx) => callback(tx));
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function seedInvoiceJob(documentId: string): Promise<string> {
  // F819-Spiegel (Payment-Seed): Job-Zeile per SQL, Abschluss per
  // Worker-Import. Input schema-gültig (claimResult validiert).
  const built = buildInvoicePdfInput({
    document: {
      type: "invoice", invoiceKind: null, creditNoteType: null,
      number: "Rechnung-F823B-1", numberYear: 2026, numberSequence: 1,
      issuedAt: new Date().toISOString(), dueDate: "2026-10-01",
      serviceDate: null, skontoPercentBps: null, skontoDays: null,
    },
    recipient: {
      displayName: "F823B Kundin", street: null, houseNumber: null,
      postalCode: null, city: null, country: null,
    },
    sender: {
      companyName: "F823B GmbH", companyEmail: "office@f823b.example",
      companyAuthority: null, companyRegisterNumber: null, companyTaxId: null,
      companyAddressLine1: "Strasse 1", companyAddressLine2: null,
      companyPostalCode: "10115", companyCity: "Berlin", companyCountry: "DE",
      paymentAccountHolder: null, paymentIban: null, paymentBic: null,
      settingsRevision: 1,
    },
    lines: [{
      position: 1, title: "PV-Module", quantityMilli: 1000, unit: "piece",
      netCents: 10000, taxCents: 1900, grossCents: 11900, taxRateBps: 1900,
    }],
    headTotals: { netCents: 10000, taxCents: 1900, grossCents: 11900 },
    preparedAt: new Date().toISOString(),
  });
  if (!built.ok) throw new Error(`F823B-E2E: Render-Input ungueltig (${built.error}).`);
  const inputJson = JSON.stringify(built.value);
  const inputSha = hashInvoicePdfInput(built.value);
  return withJobDatabase(async (tx) => {
    const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      insert into commercial_document_render_job (
        id, workspace_id, document_id, input_json, input_sha256,
        template_version, renderer_recipe, created_by
      ) values (
        gen_random_uuid(), ${state().workspaceId}::uuid, ${documentId}::uuid,
        ${inputJson}::jsonb, decode(${inputSha}, 'hex'),
        ${INVOICE_PDF_TEMPLATE_VERSION}, ${INVOICE_PDF_RENDERER_RECIPE_VERSION},
        (select id from user_identity where email = ${state().editorEmail} limit 1)
      )
      returning id
    `);
    const job = result.rows[0];
    if (!job) throw new Error("F823B-E2E: Job-Seed fehlt.");
    return job.id;
  });
}

async function finalizeJob(jobId: string): Promise<void> {
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.alloc(116, 0x62),
    Buffer.from("\n%%EOF", "latin1"),
  ]);
  const leaseToken = randomUUID();
  const claim = await withJobDatabase((tx) => claimInvoicePdfRenderJob(tx, {
    workspaceId: state().workspaceId,
    jobId,
    leaseToken,
  }));
  if (claim === null) throw new Error(`F823B-E2E: Job ${jobId} nicht claimbar.`);
  const completion = await withJobDatabase((tx) => finalizeInvoicePdfRenderSuccess(tx, {
    workspaceId: state().workspaceId,
    jobId: claim.jobId,
    leaseToken: claim.leaseToken,
    attemptCount: claim.attemptCount,
    artifact: {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.length,
      mimeType: "application/pdf",
    },
  }));
  expect(completion.state).toBe("succeeded");
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

test("F823B-E2E-01: Versandbereit-Preset + Badge + Detail-Link", async ({ page }) => {
  test.setTimeout(180_000);
  await grantInvoicingCapability();
  const readyId = await seedInvoice(READY_NAME);
  await seedInvoice(NOJOB_NAME);
  const data = state();
  const detailPath = `/w/${data.workspaceId}/rechnungen/invoice/${readyId}`;
  const listPath = `/w/${data.workspaceId}/rechnungen/invoice`;

  const jobId = await seedInvoiceJob(readyId);
  await finalizeJob(jobId);

  await page.goto(listPath);
  await loginWithRealOtp(page, data.editorEmail, listPath);
  await page.goto(`${listPath}?versandbereit=true`);
  const readyRow = page.getByRole("row").filter({ hasText: READY_NAME });
  await expect(readyRow).toBeVisible();
  await expect(readyRow.getByTestId("document-ready-badge")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: NOJOB_NAME })).toHaveCount(0);
  await readyRow.getByTestId("document-ready-badge").click();
  await page.waitForURL((url) => url.pathname === detailPath);
});
