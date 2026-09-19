import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { sql } from "drizzle-orm";
import { expect, test, type Download, type Page } from "playwright/test";
import {
  claimDraftPdfRenderJob,
  finalizeDraftPdfRenderSuccess,
} from "../../worker/draft-pdf-database";
import type { TenantTx } from "../../lib/db/types";
import { withTenantOn } from "../../lib/db/tenant";
import { DRAFT_PDF_TEMPLATE_VERSION } from "../../lib/integrations/invoicing/pdf-contract";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F8-24c Draft-Vorschau ENTWURF — Chromium-E2E (F824-E2E-01, Spiegel
 * F818-E2E-01/M3-02d-Abschluss).
 * Rechnungs-Entwurf per SQL seeden → Detail-Panel „Entwurfsvorschau
 * erzeugen" → Auftrag angenommen → synthetischer Worker-Abschluss →
 * Download `<name>-entwurf.pdf` mit ENTWURF-Bytes (Byte-Identitaet).
 *
 * Bewusst kein echtes Worker-Render: Der E2E-Worker laeuft mit
 * WORKER_E2E_CATALOG_IMPORT_ONLY (nur Katalog-Queues), und das
 * Draft-Renderer-Rezept ist auf linux/x64 gepinnt (F824C-UT-14). Das
 * echte Chromium-Render incl. Wasserzeichen pruefen die Renderer-
 * Tests; hier werden Browser-, Worker-DB- und Downloadvertrag
 * isoliert.
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

const DRAFT_NAME = "F824C-E2E-Draft";

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
    throw new Error("Der private F8-24c-E2E-State ist unvollständig.");
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

async function seedDraftInvoice(): Promise<void> {
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
      `delete from commercial_document_render_job
        where workspace_id = $1::uuid
          and document_id in (
            select id from commercial_document
             where workspace_id = $1::uuid and name = $2
          )`,
      [data.workspaceId, DRAFT_NAME],
    );
    await client.query(
      `delete from commercial_document_line
        where workspace_id = $1::uuid
          and document_id in (
            select id from commercial_document
             where workspace_id = $1::uuid and name = $2
          )`,
      [data.workspaceId, DRAFT_NAME],
    );
    await client.query(
      `delete from commercial_document
        where workspace_id = $1::uuid and name = $2 and status = 'draft'`,
      [data.workspaceId, DRAFT_NAME],
    );
    await client.query(
      `insert into workspace_invoicing_settings (
         workspace_id, company_name, company_email,
         company_address_line1, company_postal_code, company_city,
         company_country, payment_account_holder, payment_iban,
         payment_bic, created_by
       ) values (
         $1::uuid, 'F824C GmbH', 'office@f824c.example',
         'Strasse 1', '10115', 'Berlin', 'DE',
         'F824C GmbH', 'DE89370400440532013000', 'MARKDEF1100',
         (select id from user_identity where email = $2 limit 1)
       )
       on conflict (workspace_id) do update set
         company_name = excluded.company_name,
         updated_at = statement_timestamp()`,
      [data.workspaceId, data.editorEmail],
    );
    await client.query(
      `insert into contact (
         workspace_id, display_name, first_name, last_name,
         email_primary, email_normalized,
         address_street, address_house_number, address_postal_code,
         address_city, address_country
       )
       select $1::uuid, 'E2E Muster GmbH', 'E2E', 'Muster',
              'e2e@f824c.test', 'e2e@f824c.test',
              'Musterstrasse', '7', '10115', 'Berlin', 'DE'
       where not exists (
         select 1 from contact
          where workspace_id = $1::uuid and email_normalized = 'e2e@f824c.test'
       )`,
      [data.workspaceId],
    );
    await client.query(
      `insert into commercial_document (
         workspace_id, type, status, name, contact_id, created_by,
         currency, net_cents, tax_cents, gross_cents,
         payment_status, paid_cents, due_date
       ) values (
         $1::uuid, 'invoice', 'draft', $2,
         (select id from contact
           where workspace_id = $1::uuid and email_normalized = 'e2e@f824c.test' limit 1),
         (select id from user_identity where email = $3 limit 1),
         'EUR', 100000, 19000, 119000,
         'unpaid', 0,
         '2026-11-30'::date
       )`,
      [data.workspaceId, DRAFT_NAME, data.editorEmail],
    );
    await client.query(
      `insert into commercial_document_line (
         workspace_id, document_id, position, name, quantity_milli, unit,
         net_cents, tax_cents, gross_cents, tax_rate_bps, tax_treatment
       )
       select $1::uuid, doc.id, 1, 'E2E-Position', 1000, 'piece',
              100000, 19000, 119000, 1900, 'standard_19'
         from commercial_document doc
        where doc.workspace_id = $1::uuid and doc.name = $2`,
      [data.workspaceId, DRAFT_NAME],
    );
    await client.query("commit");
  } finally {
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

function invoicesPath(): string {
  return `/w/${state().workspaceId}/rechnungen/invoice`;
}

type RequestedDraftJob = {
  jobId: string;
  status: string;
};

async function withDraftDatabase<T>(
  callback: (tx: TenantTx) => Promise<T>,
): Promise<T> {
  const data = state();
  const pool = createDrainTrackedPool({ connectionString: data.databaseUrl, max: 1 });
  try {
    return await withTenantOn(pool, data.workspaceId, (tx) => callback(tx));
  } finally {
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function readSeededDocumentId(): Promise<string> {
  return withDraftDatabase(async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      select id
        from commercial_document
       where workspace_id = ${state().workspaceId}::uuid
         and name = ${DRAFT_NAME}
       order by created_at desc, id desc
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Der geseedete F824-E2E-Entwurf fehlt.");
    return row.id;
  });
}

async function readRequestedDraftJob(documentId: string): Promise<RequestedDraftJob> {
  return withDraftDatabase(async (tx) => {
    const result = await tx.execute<RequestedDraftJob & { [key: string]: unknown }>(sql`
      select id as "jobId", status
        from commercial_document_render_job
       where workspace_id = ${state().workspaceId}::uuid
         and document_id = ${documentId}::uuid
         and template_version = ${DRAFT_PDF_TEMPLATE_VERSION}
       order by created_at desc, id desc
       limit 1
    `);
    const job = result.rows[0];
    if (!job) throw new Error("Der angeforderte F824-E2E-Entwurfsauftrag fehlt.");
    return job;
  });
}

function syntheticDraftArtifact(): {
  mimeType: "application/pdf";
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
} {
  // Bewusst kein Produktionsrenderer-Beleg: Das formal gültige,
  // deterministische PDF isoliert hier ausschließlich Browser-,
  // Worker-DB- und Downloadvertrag (Spiegel F818-E2E-01). Der
  // ENTWURF-Marker steht stellvertretend für das Wasserzeichen des
  // echten Renderers (F824C-UT-01) und wird per Byte-Identität
  // geprüft.
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.from("ENTWURF-VORSCHAU\n", "latin1"),
    Buffer.alloc(116, 0x45),
    Buffer.from("\n%%EOF", "latin1"),
  ]);
  return {
    mimeType: "application/pdf",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
}

async function bytesFromDownload(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error("Der F824-E2E-Download hat keinen Pfad.");
  return readFileSync(path);
}

test("F824-E2E-01: Draft → Vorschau anfordern → Download mit ENTWURF-Bytes", async ({ page }) => {
  test.setTimeout(240_000);
  const data = state();
  const errors = trackBrowserErrors(page);

  await grantInvoicingCapability();
  await seedDraftInvoice();

  await page.goto(invoicesPath());
  await loginWithRealOtp(page, data.editorEmail, invoicesPath());

  const row = page.getByRole("row").filter({ hasText: DRAFT_NAME });
  await row.getByRole("link", { name: DRAFT_NAME }).click();

  const panel = page.getByTestId("draft-pdf-panel");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("ENTWURF");
  await panel.getByRole("button", { name: "Entwurfsvorschau erzeugen" }).click();

  const success = page.getByTestId("draft-pdf-success");
  await expect(success).toContainText("Vorschau-Auftrag für den Entwurf wurde angenommen");

  // Synthetischer Worker-Abschluss (Spiegel F818-E2E-01): Der E2E-Worker
  // bedient keine Render-Queues; Claim + synthetische Fertigstellung
  // pruefen den Worker-DB-Vertrag direkt.
  const documentId = await readSeededDocumentId();
  const requested = await readRequestedDraftJob(documentId);
  expect(requested.status).toBe("requested");

  const leaseToken = randomUUID();
  const claim = await withDraftDatabase((tx) => claimDraftPdfRenderJob(tx, {
    workspaceId: data.workspaceId,
    jobId: requested.jobId,
    leaseToken,
  }));
  if (claim === null) throw new Error("Der requested F824-E2E-Auftrag war nicht claimbar.");
  expect(claim).toMatchObject({
    workspaceId: data.workspaceId,
    jobId: requested.jobId,
    leaseToken,
    attemptCount: 1,
  });

  const artifact = syntheticDraftArtifact();
  const completion = await withDraftDatabase((tx) =>
    finalizeDraftPdfRenderSuccess(tx, {
      workspaceId: data.workspaceId,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      attemptCount: claim.attemptCount,
      artifact,
    }));
  expect(completion).toEqual({ state: "succeeded", attemptCount: 1, replayed: false });

  await page.reload();
  await expect(panel.getByText("Entwurfsvorschau ist bereit", { exact: true })).toBeVisible();
  const downloadLink = panel.getByRole("link", { name: "Entwurf laden" });
  await expect(downloadLink).toBeVisible();

  const [downloadResponse, download] = await Promise.all([
    page.waitForResponse((response) =>
      response.request().method() === "GET"
      && new URL(response.url()).pathname.endsWith(`/pdf/${claim.jobId}`)),
    page.waitForEvent("download", { timeout: 30_000 }),
    downloadLink.click(),
  ]);
  expect(await download.failure()).toBeNull();
  expect(downloadResponse.status()).toBe(200);
  expect(downloadResponse.headers()["content-type"]).toBe("application/pdf");
  expect(download.suggestedFilename()).toBe(`${DRAFT_NAME}-entwurf.pdf`);
  const bytes = await bytesFromDownload(download);
  expect(bytes.equals(artifact.bytes)).toBe(true);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256);
  expect(bytes.length).toBeGreaterThan(100);
  expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  expect(bytes.subarray(Math.max(0, bytes.length - 1_024)).toString("latin1")).toContain("%%EOF");
  expect(bytes.toString("latin1")).toContain("ENTWURF");

  expect(errors, "Browser-Konsole und Page-Errors der Beleg-Grenze").toEqual([]);
});
