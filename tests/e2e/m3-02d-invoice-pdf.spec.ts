import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { sql } from "drizzle-orm";
import { expect, test, type Download, type Page } from "playwright/test";
import {
  claimInvoicePdfRenderJob,
  finalizeInvoicePdfRenderSuccess,
} from "../../worker/invoice-pdf-database";
import type { TenantTx } from "../../lib/db/types";
import { withTenantOn } from "../../lib/db/tenant";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * M3-02d Rechnungs-PDF-Download — Browser-Kette (Chromium, Spiegel
 * m2-02-E2E-Abschluss): ausgestellte Rechnung → PDF anfordern →
 * synthetischer Worker-Abschluss → Status → privater Download mit
 * Byte-/Hash-Pruefung.
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

type RequestedPdfJob = {
  jobId: string;
  status: string;
};

type SyntheticPdfArtifact = {
  mimeType: "application/pdf";
  bytes: Buffer;
  sha256: string;
  sizeBytes: number;
};

const DOCUMENT_NUMBER = "M302D-E2E-000001";
const DOCUMENT_SEQUENCE = 990001;

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
    throw new Error("Der private M3-02d-E2E-State ist unvollständig.");
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
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  expect((await signInResponsePromise).status()).toBe(200);
  await page.waitForURL((url) => `${url.pathname}${url.search}` === expectedPath);
}

async function seedPdfFixture(): Promise<string> {
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
    await client.query(
      `select pg_catalog.set_config('app.actor_id', u.id::text, true)
         from user_identity u where u.email = $1 limit 1`,
      [data.editorEmail],
    );
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
      [data.workspaceId, data.editorEmail],
    );
    const document = await client.query<{ id: string }>(
      `insert into commercial_document (
         id, workspace_id, type, status, name, created_by,
         number, number_year, number_sequence, net_cents, tax_cents,
         gross_cents, payment_status, paid_cents, due_date,
         recipient_snapshot
       ) values (
         gen_random_uuid(), $1::uuid, 'invoice', 'draft', 'M302D-E2E-Rechnung',
         (select id from user_identity where email = $2 limit 1),
         $3,
         extract(year from now() at time zone 'Europe/Berlin')::int, $4::int,
         100000, 19000, 119000, 'unpaid', 0, (now()::date + 14),
         '{"displayName":"E2E Muster GmbH","street":"Musterstrasse","houseNumber":"12a","postalCode":"10115","city":"Berlin","country":"DE"}'::jsonb
       )
       on conflict (workspace_id, type, number_year, number_sequence)
       do update set name = excluded.name
       returning id`,
      [data.workspaceId, data.editorEmail, DOCUMENT_NUMBER, DOCUMENT_SEQUENCE],
    );
    const documentId = document.rows[0]?.id;
    if (!documentId) throw new Error("M302D-E2E-Seed: Dokument fehlt.");
    await client.query(
      `insert into commercial_document_line (
         id, workspace_id, document_id, position, name, quantity_milli,
         unit, net_cents, tax_cents, gross_cents, tax_rate_bps, tax_treatment
       ) select gen_random_uuid(), $1::uuid, $2::uuid, 1, 'E2E-Position', 1000,
         'piece', 100000, 19000, 119000, 1900, 'standard_19'
       where not exists (
         select 1 from commercial_document_line
          where workspace_id = $1::uuid and document_id = $2::uuid
       )`,
      [data.workspaceId, documentId],
    );
    // Zeilen nur am Entwurf (M3-02a-Freeze), danach draft→issued-Kante.
    await client.query(
      `update commercial_document
          set status = 'issued',
              issued_at = now(),
              issued_snapshot = '{"schemaVersion":"document-snapshot.v1"}'::jsonb,
              snapshot_sha256 = decode(repeat('00', 32), 'hex'),
              issued_by = (select id from user_identity where email = $2 limit 1),
              goebd_retention_until = '2036-12-31'::date
        where id = $1::uuid
          and workspace_id = $3::uuid
          and status = 'draft'`,
      [documentId, data.editorEmail, data.workspaceId],
    );
    await client.query("commit");
    return documentId;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.release();
    await endPoolAndWaitForClientRemoval(pool);
  }
}

async function withInvoiceDatabase<T>(
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

async function readRequestedJob(documentId: string): Promise<RequestedPdfJob> {
  return withInvoiceDatabase(async (tx) => {
    const result = await tx.execute<RequestedPdfJob & { [key: string]: unknown }>(sql`
      select id as "jobId", status
        from commercial_document_render_job
       where workspace_id = ${state().workspaceId}::uuid
         and document_id = ${documentId}::uuid
       order by created_at desc, id desc
       limit 1
    `);
    const job = result.rows[0];
    if (!job) throw new Error("Der angeforderte M3-02d-E2E-Auftrag fehlt.");
    return job;
  });
}

function syntheticPdfArtifact(): SyntheticPdfArtifact {
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.alloc(116, 0x44),
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
  if (!path) throw new Error("Der M3-02d-E2E-Download hat keinen Pfad.");
  return readFileSync(path);
}

test.describe("M3-02d Rechnungs-PDF-Download", () => {
  test("M302D-E2E-01: fordert im Browser an und prüft den synthetischen Abschluss bis zum privaten Download", async ({ page }) => {
    test.setTimeout(120_000);
    const data = state();
    const documentId = await seedPdfFixture();
    const detailPath = `/w/${data.workspaceId}/rechnungen/invoice/${documentId}`;
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);

    const pdfPanel = page.locator("aside").filter({
      has: page.getByRole("heading", { name: "Rechnungs-PDF", exact: true }),
    });
    await expect(pdfPanel).toBeVisible();

    const generateResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST"
        && `${url.pathname}${url.search}` === detailPath;
    });
    await pdfPanel.getByRole("button", {
      name: "Rechnungs-PDF erzeugen",
      exact: true,
    }).click();
    expect((await generateResponsePromise).status()).toBe(200);
    await expect(pdfPanel.getByText(
      "Der PDF-Auftrag für das Dokument wurde angenommen.",
      { exact: true },
    )).toBeVisible();
    await expect(pdfPanel.getByText("Angefordert", { exact: true })).toBeVisible();

    const requested = await readRequestedJob(documentId);
    expect(requested.status).toBe("requested");

    const leaseToken = randomUUID();
    const claim = await withInvoiceDatabase((tx) => claimInvoicePdfRenderJob(tx, {
      workspaceId: data.workspaceId,
      jobId: requested.jobId,
      leaseToken,
    }));
    if (claim === null) throw new Error("Der requested M3-02d-E2E-Auftrag war nicht claimbar.");
    expect(claim).toMatchObject({
      workspaceId: data.workspaceId,
      jobId: requested.jobId,
      leaseToken,
      attemptCount: 1,
    });

    // Bewusst kein Produktionsrenderer-Beleg: Das formal gültige, deterministische
    // PDF isoliert hier ausschließlich Browser-, Worker-DB- und Downloadvertrag.
    const artifact = syntheticPdfArtifact();
    const completion = await withInvoiceDatabase((tx) =>
      finalizeInvoicePdfRenderSuccess(tx, {
        workspaceId: data.workspaceId,
        jobId: claim.jobId,
        leaseToken: claim.leaseToken,
        attemptCount: claim.attemptCount,
        artifact,
      }));
    expect(completion).toEqual({ state: "succeeded", attemptCount: 1, replayed: false });

    await page.reload();
    await expect(pdfPanel.getByText(
      "Rechnungs-PDF ist bereit",
      { exact: true },
    )).toBeVisible();
    const downloadLink = pdfPanel.getByRole("link", {
      name: "Rechnungs-PDF laden",
      exact: true,
    });
    await expect(downloadLink).toBeVisible();
    const downloadPath = await downloadLink.getAttribute("href");
    expect(downloadPath).toBe(
      `/w/${data.workspaceId}/rechnungen/invoice/${documentId}/pdf/${requested.jobId}`,
    );

    const [downloadResponse, download] = await Promise.all([
      page.waitForResponse((response) =>
        response.request().method() === "GET"
        && new URL(response.url()).pathname === downloadPath),
      page.waitForEvent("download"),
      downloadLink.click(),
    ]);
    const downloadedBytes = await bytesFromDownload(download);
    expect(await download.failure()).toBeNull();

    const expectedFilename = `${DOCUMENT_NUMBER}.pdf`;
    const expectedDisposition = `attachment; filename="${expectedFilename}"; filename*=UTF-8''${encodeURIComponent(expectedFilename)}`;
    const headers = downloadResponse.headers();
    expect(downloadResponse.status()).toBe(200);
    expect(headers["content-type"]).toBe("application/pdf");
    expect(headers["content-length"]).toBe(String(artifact.sizeBytes));
    expect(headers["content-disposition"]).toBe(expectedDisposition);
    expect(headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(headers["pragma"]).toBe("no-cache");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
    expect(download.suggestedFilename()).toBe(expectedFilename);
    expect(downloadedBytes.equals(artifact.bytes)).toBe(true);
    expect(downloadedBytes).toHaveLength(artifact.sizeBytes);
    expect(createHash("sha256").update(downloadedBytes).digest("hex")).toBe(artifact.sha256);
  });
});
