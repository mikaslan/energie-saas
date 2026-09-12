import "server-only";

import { sql } from "drizzle-orm";

import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  INVOICING_DATEV_BATCH_VERSION,
  invoicingDatevBatchV1Schema,
  invoicingDatevCommandV1Schema,
  type DatevSkr,
  type InvoicingDatevCommandV1,
  type InvoicingDatevBatchV1,
} from "@/lib/integrations/invoicing/contract";
import {
  buildDatevBatchCsv,
  datevBatchFileName,
  DatevExportError,
  type DatevBookingInput,
} from "@/lib/integrations/invoicing/datev-export";
import { InvoicingValidationError } from "./errors";
import { requireInvoicingRead } from "./service";

type DatevDocumentRow = {
  id: string;
  type: string;
  number: string | null;
  currency: string;
  issued_date: string | null;
  contact_name: string | null;
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
};

type DatevLineRow = {
  document_id: string;
  tax_rate_bps: number;
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
};

function fail(): never {
  throw new InvoicingValidationError();
}

/**
 * F8-11 DATEV-EXTF Buchungsstapel. Reiner Read-Pfad (`invoicing.read`,
 * keine neue Permission, keine Migration): alle im Monat (Berlin)
 * ausgestellten Geldbelege werden in den EXTF-Builder projiziert.
 * Nicht exportierbare Belege (Typ/Währung/Nummer/0-%) verweigern
 * fail-closed mit Belegnennung (kein stiller Teil-Stapel).
 */
export async function exportDatevBatch(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: InvoicingDatevCommandV1,
): Promise<InvoicingDatevBatchV1> {
  requireInvoicingRead(ctx);
  const parsed = invoicingDatevCommandV1Schema.safeParse(input);
  if (!parsed.success) fail();
  const { month, skr } = parsed.data;
  const monthStart = `${month}-01`;
  const [year, monthPart] = month.split("-").map(Number);
  const absolute = year * 12 + (monthPart - 1) + 1;
  const nextMonth = `${String(Math.floor(absolute / 12)).padStart(4, "0")}-${String((absolute % 12) + 1).padStart(2, "0")}-01`;

  const documents = await tx.execute<DatevDocumentRow>(sql`
    select doc.id, doc.type, doc.number, doc.currency,
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

  const lines = documents.rows.length === 0
    ? []
    : (await tx.execute<DatevLineRow>(sql`
      select document_id, tax_rate_bps, net_cents, tax_cents, gross_cents
        from commercial_document_line
       where workspace_id = ${ctx.workspaceId}::uuid
         and document_id in (${sql.join(
           documents.rows.map((row) => sql`${row.id}::uuid`),
           sql`, `,
         )})
       order by document_id asc, position asc
    `)).rows;

  const linesByDocument = new Map<string, DatevLineRow[]>();
  for (const line of lines) {
    const bucket = linesByDocument.get(line.document_id) ?? [];
    bucket.push(line);
    linesByDocument.set(line.document_id, bucket);
  }

  const bookings: DatevBookingInput[] = documents.rows.map((row) => {
    const netCents = Number(row.net_cents);
    const taxCents = Number(row.tax_cents);
    const grossCents = Number(row.gross_cents);
    let lines = (linesByDocument.get(row.id) ?? []).map((line) => ({
      taxRateBps: Number(line.tax_rate_bps),
      netCents: Number(line.net_cents),
      taxCents: Number(line.tax_cents),
      grossCents: Number(line.gross_cents),
    }));
    if (lines.length === 0) {
      // Kopf-only-Belege sind produkt-legal (issue verlangt keine Zeilen).
      // Exakt-19-%-Kopf (ganzzahliger Quotient) wird als EINE 19-%-Zeile
      // aus Kopfbeträgen gebucht (ESTIMATE-Ableitung, Spec §F8-11);
      // alles andere verweigert der Builder fail-closed mit Belegnummer.
      const ratioExact = netCents > 0 && taxCents * 100 === 19 * netCents;
      if (ratioExact) {
        lines = [{ taxRateBps: 1900, netCents, taxCents, grossCents }];
      }
    }
    return {
      kind: row.type as "invoice" | "credit_note",
      number: row.number ?? "",
      issueDate: row.issued_date ?? "",
      contactName: row.contact_name ?? "",
      currency: row.currency,
      lines,
      netCents,
      taxCents,
      grossCents,
    };
  });

  let content: string;
  try {
    content = buildDatevBatchCsv({ month, skr: skr as DatevSkr, bookings });
  } catch (error) {
    if (error instanceof DatevExportError) fail();
    throw error;
  }

  return invoicingDatevBatchV1Schema.parse({
    schemaVersion: INVOICING_DATEV_BATCH_VERSION,
    month,
    skr,
    fileName: datevBatchFileName(month, skr as DatevSkr),
    contentType: "text/csv; charset=utf-8",
    content,
  });
}
