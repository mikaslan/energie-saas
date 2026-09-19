import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";

import type { TenantTx } from "@/lib/db/types";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type ServiceCtx,
} from "@/lib/permissions";
import {
  INVOICING_MONATS_ZIP_BATCH_VERSION,
  INVOICING_MONATS_ZIP_COMMAND_VERSION,
  monatsZipCommandV1Schema,
  type MonatsZipCommandV1,
} from "@/lib/integrations/invoicing/contract";
import { INVOICE_PDF_TEMPLATE_VERSION } from "@/lib/integrations/invoicing/pdf-contract";
import {
  buildMonatsZip,
  buildMonthSummaryCsv,
  MONATS_ZIP_CONTENT_TYPE,
  MONATS_ZIP_MAX_DOCUMENTS,
  MONATS_ZIP_MAX_UNCOMPRESSED_BYTES,
  monatsZipFileName,
  MonatsZipError,
  type MonthSummaryRowInput,
} from "@/lib/integrations/invoicing/monats-zip";
import { InvoicingValidationError } from "./errors";

export {
  INVOICING_MONATS_ZIP_BATCH_VERSION,
  INVOICING_MONATS_ZIP_COMMAND_VERSION,
  monatsZipCommandV1Schema,
  type MonatsZipCommandV1,
};

export type MonatsZipBatchV1 = {
  schemaVersion: typeof INVOICING_MONATS_ZIP_BATCH_VERSION;
  month: string;
  fileName: string;
  contentType: typeof MONATS_ZIP_CONTENT_TYPE;
  bytes: Buffer;
  documentCount: number;
  pdfCount: number;
};

type MonthZipDocumentRow = {
  id: string;
  type: string;
  number: string | null;
  issued_date: string | null;
  contact_name: string | null;
  net_cents: number | string;
  tax_cents: number | string;
  gross_cents: number | string;
};

type MonthZipJobRow = {
  document_id: string;
  artifact_mime_type: string | null;
  artifact_sha256_hex: string | null;
  artifact_size_bytes: number | null;
  artifact_bytes: unknown;
};

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
// M3-02d-Safe-Pattern (pdf-service.ts-Spiegel): nur dateinamenfähige Nummern
// bekommen einen PDF-Eintrag, sonst ehrlich leere pdf_*-Spalten.
const DOCUMENT_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_PDF_ARTIFACT_BYTES = 8 * 1024 * 1024;

function requireMonatsZipAccess(ctx: ServiceCtx): void {
  if (!can(ctx, "invoicing.issuing_details.write")) {
    throw new PermissionDeniedError(
      "invoicing.issuing_details.write",
      "invoicing_monats_zip",
      undefined,
      ctx.actor,
    );
  }
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      "invoicing.issuing_details.write",
      "invoicing_monats_zip",
      "external_only_without_assignment",
      ctx.actor,
    );
  }
}

function asMoneyCents(value: number | string, docId: string): number {
  const coerced = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(coerced) || coerced < 0) {
    throw new InvoicingValidationError();
  }
  void docId;
  return coerced;
}

type VerifiedPdf = { fileName: string; sha256: string; bytes: Buffer };

// Integritäts-Spiegel von readInvoicePdfArtifact (MIME/SHA256/Size +
// timingSafeEqual-Hashabgleich). Jede Abweichung liefert null statt zu
// werfen: fehlende/korrupte PDFs brechen den ZIP nie ab (Spec DECIDED).
function verifyPdfArtifact(number: string | null, row: MonthZipJobRow | undefined): VerifiedPdf | null {
  if (!row) return null;
  if (typeof number !== "string" || !DOCUMENT_NUMBER_PATTERN.test(number)) return null;
  if (
    row.artifact_mime_type !== "application/pdf"
    || typeof row.artifact_sha256_hex !== "string"
    || !SHA256_PATTERN.test(row.artifact_sha256_hex)
    || !Number.isSafeInteger(row.artifact_size_bytes)
    || (row.artifact_size_bytes as number) < 100
    || (row.artifact_size_bytes as number) > MAX_PDF_ARTIFACT_BYTES
    || !Buffer.isBuffer(row.artifact_bytes)
    || row.artifact_bytes.length !== row.artifact_size_bytes
  ) return null;
  const actual = createHash("sha256").update(row.artifact_bytes).digest();
  const expected = Buffer.from(row.artifact_sha256_hex, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  return {
    fileName: `${number}.pdf`,
    sha256: row.artifact_sha256_hex,
    bytes: Buffer.from(row.artifact_bytes),
  };
}

/**
 * F8-20 Monats-ZIP. Reiner Read-Pfad unter `invoicing.issuing_details.write`
 * (PDF-Bytes verlassen das System, M3-02d-Schranke): alle im Monat (Berlin)
 * ausgestellten Geldbelege plus deren jüngstes `succeeded`-Invoice-PDF.
 * Belege ohne (integeres) PDF bleiben mit leeren pdf_*-Spalten in der
 * Summary — ehrlich partiell, nie still vollständig.
 */
export async function exportMonatsZip(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: MonatsZipCommandV1,
): Promise<MonatsZipBatchV1> {
  requireMonatsZipAccess(ctx);
  const parsed = monatsZipCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new InvoicingValidationError();
  const { month } = parsed.data;
  const monthStart = `${month}-01`;
  const [year, monthPart] = month.split("-").map(Number);
  const absolute = year * 12 + (monthPart - 1) + 1;
  const nextMonth = `${String(Math.floor(absolute / 12)).padStart(4, "0")}-${String((absolute % 12) + 1).padStart(2, "0")}-01`;

  const documents = await tx.execute<MonthZipDocumentRow>(sql`
    select doc.id, doc.type, doc.number,
           (doc.issued_at at time zone 'Europe/Berlin')::date as issued_date,
           contact.display_name as contact_name,
           doc.net_cents, doc.tax_cents, doc.gross_cents
      from commercial_document as doc
      left join contact
        on contact.workspace_id = doc.workspace_id
       and contact.id = doc.contact_id
     where doc.workspace_id = ${ctx.workspaceId}::uuid
       and doc.status = 'issued'
       and doc.type in ('invoice', 'credit_note')
       and (doc.issued_at at time zone 'Europe/Berlin')::date >= ${monthStart}::date
       and (doc.issued_at at time zone 'Europe/Berlin')::date < ${nextMonth}::date
     order by doc.issued_at asc, doc.id asc
  `);

  if (documents.rows.length > MONATS_ZIP_MAX_DOCUMENTS) {
    throw new InvoicingValidationError();
  }

  const jobs = documents.rows.length === 0
    ? []
    : (await tx.execute<MonthZipJobRow>(sql`
      select distinct on (job.document_id)
             job.document_id, job.artifact_mime_type,
             encode(job.artifact_sha256, 'hex') as artifact_sha256_hex,
             job.artifact_size_bytes, job.artifact_bytes
        from commercial_document_render_job as job
       where job.workspace_id = ${ctx.workspaceId}::uuid
         and job.document_id in (${sql.join(
           documents.rows.map((row) => sql`${row.id}::uuid`),
           sql`, `,
         )})
         and job.status = 'succeeded'
         and job.template_version = ${INVOICE_PDF_TEMPLATE_VERSION}
       order by job.document_id asc, job.created_at desc, job.id desc
    `)).rows;

  const jobsByDocument = new Map<string, MonthZipJobRow>();
  for (const job of jobs) jobsByDocument.set(job.document_id, job);

  const summaryRows: MonthSummaryRowInput[] = [];
  const pdfs: Array<{ fileName: string; bytes: Buffer }> = [];
  for (const row of documents.rows) {
    const verified = verifyPdfArtifact(row.number, jobsByDocument.get(row.id));
    if (verified) pdfs.push({ fileName: verified.fileName, bytes: verified.bytes });
    summaryRows.push({
      docId: row.id,
      kind: row.type as "invoice" | "credit_note",
      number: row.number ?? "",
      issueDate: row.issued_date ?? "",
      contactName: row.contact_name ?? "",
      netCents: asMoneyCents(row.net_cents, row.id),
      taxCents: asMoneyCents(row.tax_cents, row.id),
      grossCents: asMoneyCents(row.gross_cents, row.id),
      pdfFile: verified?.fileName ?? "",
      pdfSha256: verified?.sha256 ?? "",
    });
  }

  let summary: string;
  try {
    summary = buildMonthSummaryCsv(summaryRows);
  } catch (error) {
    if (error instanceof MonatsZipError) throw new InvoicingValidationError();
    throw error;
  }

  let uncompressed = Buffer.byteLength(summary, "utf8");
  for (const pdf of pdfs) uncompressed += pdf.bytes.byteLength;
  if (uncompressed > MONATS_ZIP_MAX_UNCOMPRESSED_BYTES) {
    throw new InvoicingValidationError();
  }

  let bytes: Buffer;
  try {
    bytes = buildMonatsZip({ month, summary, pdfs });
  } catch (error) {
    if (error instanceof MonatsZipError) throw new InvoicingValidationError();
    throw error;
  }

  return {
    schemaVersion: INVOICING_MONATS_ZIP_BATCH_VERSION,
    month,
    fileName: monatsZipFileName(month),
    contentType: MONATS_ZIP_CONTENT_TYPE,
    bytes,
    documentCount: summaryRows.length,
    pdfCount: pdfs.length,
  };
}
