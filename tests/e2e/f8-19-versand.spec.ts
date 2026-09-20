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
import { buildEpcPayload } from "../../lib/integrations/invoicing/epc-contract";
import {
  buildInvoicePaymentInput,
  hashInvoicePaymentInput,
  INVOICE_PAYMENT_RENDERER_RECIPE_VERSION,
  INVOICE_PAYMENT_TEMPLATE_VERSION,
} from "../../lib/integrations/invoicing/pdf-contract";
import {
  createDrainTrackedPool,
  endPoolAndWaitForClientRemoval,
} from "../setup/pg-pool-drain";

/**
 * F8-19 Versand/Sent — Browser-Kette (Chromium, Spiegel M302D-E2E-01):
 * ausgestellte Rechnung → Rechnungs-PDF + Zahlungsbeleg `succeeded` →
 * als versendet markieren → Sent-Badge + Delivery-Record + Download-Bytes
 * stimmen (Hashabgleich wie M302D-E2E-01).
 *
 * Voraussetzungen (Owner): Migration 0195 (`commercial_document_delivery`),
 * Versand-Panel-Verdrahtung auf der Dokument-Detailseite. Der Zahlungsbeleg
 * wird per SQL gesät (F8-17 liefert keine Request-UI); der Abschluss beider
 * Jobs nutzt bewusst synthetische Artefakte statt des Produktionsrenderers.
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

const DOCUMENT_NUMBER = "F819-E2E-000001";
const DOCUMENT_SEQUENCE = 990019;
const OPEN_CENTS = 119_000;

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
    throw new Error("Der private F8-19-E2E-State ist unvollständig.");
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

async function seedDeliveryFixture(): Promise<string> {
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
         gen_random_uuid(), $1::uuid, 'invoice', 'draft', 'F819-E2E-Rechnung',
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
    if (!documentId) throw new Error("F819-E2E-Seed: Dokument fehlt.");
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
    // Rerun-Sicherheit: Nachweis + Jobs zurücksetzen, sent_at lösen.
    await client.query(
      `delete from commercial_document_delivery
        where workspace_id = $1::uuid and document_id = $2::uuid`,
      [data.workspaceId, documentId],
    );
    await client.query(
      `delete from commercial_document_render_job
        where workspace_id = $1::uuid and document_id = $2::uuid`,
      [data.workspaceId, documentId],
    );
    await client.query(
      `update commercial_document
          set sent_at = null, updated_at = now()
        where id = $1::uuid and workspace_id = $2::uuid`,
      [documentId, data.workspaceId],
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

async function withDeliveryDatabase<T>(
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

async function readJobByTemplate(documentId: string, templateVersion: string): Promise<RequestedPdfJob> {
  return withDeliveryDatabase(async (tx) => {
    const result = await tx.execute<RequestedPdfJob & { [key: string]: unknown }>(sql`
      select id as "jobId", status
        from commercial_document_render_job
       where workspace_id = ${state().workspaceId}::uuid
         and document_id = ${documentId}::uuid
         and template_version = ${templateVersion}
       order by created_at desc, id desc
       limit 1
    `);
    const job = result.rows[0];
    if (!job) throw new Error(`Der F8-19-E2E-Auftrag (${templateVersion}) fehlt.`);
    return job;
  });
}

async function seedPaymentJob(documentId: string): Promise<string> {
  const epcPayload = buildEpcPayload({
    creditorName: "Solarwerk E2E GmbH",
    creditorIban: "DE89370400440532013000",
    creditorBic: "MARKDEF1100",
    amountCents: OPEN_CENTS,
    documentNumber: DOCUMENT_NUMBER,
  });
  const built = buildInvoicePaymentInput({
    creditor: {
      name: "Solarwerk E2E GmbH",
      iban: "DE89370400440532013000",
      bic: "MARKDEF1100",
    },
    amountCents: OPEN_CENTS,
    reference: epcPayload.split("\n")[9] ?? "",
    documentNumber: DOCUMENT_NUMBER,
    epcPayload,
    preparedAt: new Date().toISOString(),
  });
  if (!built.ok) throw new Error(`F819-E2E-Seed: Payment-Input ungueltig (${built.error}).`);
  return withDeliveryDatabase(async (tx) => {
    const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      insert into commercial_document_render_job (
        id, workspace_id, document_id, input_json, input_sha256,
        template_version, renderer_recipe, created_by
      ) values (
        gen_random_uuid(), ${state().workspaceId}::uuid, ${documentId}::uuid,
        ${JSON.stringify(built.value)}::jsonb,
        decode(${hashInvoicePaymentInput(built.value)}, 'hex'),
        ${INVOICE_PAYMENT_TEMPLATE_VERSION}, ${INVOICE_PAYMENT_RENDERER_RECIPE_VERSION},
        (select id from user_identity where email = ${state().editorEmail} limit 1)
      )
      returning id
    `);
    const id = result.rows[0]?.id;
    if (!id) throw new Error("F819-E2E-Seed: Payment-Job fehlt.");
    return id;
  });
}

async function finalizeJob(documentId: string, jobId: string, fill: number): Promise<SyntheticPdfArtifact> {
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.alloc(116, fill),
    Buffer.from("\n%%EOF", "latin1"),
  ]);
  const artifact: SyntheticPdfArtifact = {
    mimeType: "application/pdf",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
  };
  const leaseToken = randomUUID();
  const claim = await withDeliveryDatabase((tx) => claimInvoicePdfRenderJob(tx, {
    workspaceId: state().workspaceId,
    jobId,
    leaseToken,
  }));
  if (claim === null) throw new Error(`Der F8-19-E2E-Auftrag ${jobId} war nicht claimbar.`);
  const completion = await withDeliveryDatabase((tx) =>
    finalizeInvoicePdfRenderSuccess(tx, {
      workspaceId: state().workspaceId,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      attemptCount: claim.attemptCount,
      artifact,
    }));
  expect(completion).toEqual({ state: "succeeded", attemptCount: 1, replayed: false });
  expect(documentId).not.toBe("");
  return artifact;
}

async function bytesFromDownload(download: Download): Promise<Buffer> {
  const path = await download.path();
  if (!path) throw new Error("Der F8-19-E2E-Download hat keinen Pfad.");
  return readFileSync(path);
}

test.describe("F8-19 Versand/Sent", () => {
  test("F819-E2E-01: versendet im Browser und prüft Nachweis plus Byte-Identität beider Belege", async ({ page }) => {
    test.setTimeout(180_000);
    const data = state();
    const documentId = await seedDeliveryFixture();
    const detailPath = `/w/${data.workspaceId}/rechnungen/invoice/${documentId}`;
    await page.goto(detailPath);
    await loginWithRealOtp(page, data.editorEmail, detailPath);

    // Rechnungs-PDF über die bestehende Browser-Kette anfordern.
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

    const invoiceJob = await readJobByTemplate(documentId, "invoice-pdf-template.v1");
    expect(invoiceJob.status).toBe("requested");
    const invoiceArtifact = await finalizeJob(documentId, invoiceJob.jobId, 0x44);

    // Zahlungsbeleg: kein Request-UI-Pfad (F8-17) — Seed + synthetischer Abschluss.
    const paymentJobId = await seedPaymentJob(documentId);
    const paymentArtifact = await finalizeJob(documentId, paymentJobId, 0x50);
    expect(paymentArtifact.sha256).not.toBe(invoiceArtifact.sha256);

    await page.reload();
    const versandPanel = page.locator("aside").filter({
      has: page.getByRole("heading", { name: "Versand", exact: true }),
    });
    await expect(versandPanel).toBeVisible();

    const sendResponsePromise = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === "POST"
        && `${url.pathname}${url.search}` === detailPath;
    });
    await versandPanel.getByRole("button", {
      name: "Als versendet markieren",
      exact: true,
    }).click();
    expect((await sendResponsePromise).status()).toBe(200);
    await expect(versandPanel.getByText(
      "Das Dokument wurde als versendet markiert.",
      { exact: true },
    )).toBeVisible();

    // Sent-Badge + Nachweis mit Kanal und SHA-Kurzformen.
    await expect(versandPanel.getByTestId("delivery-sent-badge")).toBeVisible();
    await expect(versandPanel.getByText("Manuell (externer Versand)", { exact: true })).toBeVisible();
    await expect(versandPanel.getByText(`${invoiceArtifact.sha256.slice(0, 12)}…`, { exact: true })).toBeVisible();
    await expect(versandPanel.getByText(`${paymentArtifact.sha256.slice(0, 12)}…`, { exact: true })).toBeVisible();

    // Kein Re-Send: Button nach Versand deaktiviert.
    await expect(versandPanel.getByRole("button", {
      name: "Bereits versendet",
      exact: true,
    })).toBeDisabled();

    // Delivery-Record referenziert beide Jobs mit SHAs.
    const delivery = await withDeliveryDatabase(async (tx) => {
      const result = await tx.execute<{
        channel: string;
        invoice_job_id: string;
        payment_job_id: string | null;
        invoice_sha: string;
        payment_sha: string | null;
        [key: string]: unknown;
      }>(sql`
        select channel,
               invoice_job_id,
               payment_job_id,
               encode(invoice_artifact_sha256, 'hex') as invoice_sha,
               encode(payment_artifact_sha256, 'hex') as payment_sha
          from commercial_document_delivery
         where workspace_id = ${data.workspaceId}::uuid
           and document_id = ${documentId}::uuid
      `);
      return result.rows[0];
    });
    expect(delivery).toMatchObject({
      channel: "manual",
      invoice_job_id: invoiceJob.jobId,
      payment_job_id: paymentJobId,
      invoice_sha: invoiceArtifact.sha256,
      payment_sha: paymentArtifact.sha256,
    });

    // Download-Bytes beider Belege stimmen (Hashabgleich wie M302D-E2E-01).
    // Der Zahlungsbeleg traegt per pdf-service-Konvention `-zahlung` im
    // Dateinamen (DECIDED, Spiegel F818-E2E-01).
    for (const [name, jobId, artifact, expectedFilename] of [
      ["Rechnungs-PDF laden", invoiceJob.jobId, invoiceArtifact, `${DOCUMENT_NUMBER}.pdf`],
      ["Zahlungsbeleg laden", paymentJobId, paymentArtifact, `${DOCUMENT_NUMBER}-zahlung.pdf`],
    ] as const) {
      const link = versandPanel.getByRole("link", { name, exact: true });
      await expect(link).toBeVisible();
      const href = await link.getAttribute("href");
      expect(href).toBe(`/w/${data.workspaceId}/rechnungen/invoice/${documentId}/pdf/${jobId}`);
      const [downloadResponse, download] = await Promise.all([
        page.waitForResponse((response) =>
          response.request().method() === "GET"
          && new URL(response.url()).pathname === href),
        page.waitForEvent("download"),
        link.click(),
      ]);
      const downloadedBytes = await bytesFromDownload(download);
      expect(await download.failure()).toBeNull();
      expect(downloadResponse.status()).toBe(200);
      expect(downloadResponse.headers()["content-type"]).toBe("application/pdf");
      expect(download.suggestedFilename()).toBe(expectedFilename);
      expect(downloadedBytes.equals(artifact.bytes)).toBe(true);
      expect(createHash("sha256").update(downloadedBytes).digest("hex")).toBe(artifact.sha256);
    }
  });
});
