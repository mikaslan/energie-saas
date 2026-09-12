import "server-only";

import { sql } from "drizzle-orm";

import type { TenantTx } from "@/lib/db/types";
import type { ServiceCtx } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_CII_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_CII_VERSION,
  COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
  commercialDocumentCiiCommandV1Schema,
  commercialDocumentCiiV1Schema,
  type CommercialDocumentCiiCommandV1,
  type CommercialDocumentCiiV1,
} from "@/lib/integrations/invoicing/contract";
import {
  buildCiiXml,
  CiiExportError,
  type CiiExportInput,
} from "@/lib/integrations/invoicing/cii-export";
import { InvoicingValidationError } from "./errors";
import { getDocumentDetail, requireInvoicingRead } from "./service";

type SettingsRow = {
  company_name: string;
  company_address_line1: string;
  company_address_line2: string | null;
  company_postal_code: string;
  company_city: string;
  company_country: string;
  company_tax_id: string | null;
  payment_iban: string | null;
};

type ContactRow = {
  display_name: string;
  address_street: string | null;
  address_house_number: string | null;
  address_postal_code: string | null;
  address_city: string | null;
  address_country: string | null;
};

type DocumentMetaRow = {
  currency: string;
  created_at: Date | string;
};

function fail(): never {
  throw new InvoicingValidationError();
}

function datePart(value: string): string {
  return value.slice(0, 10);
}

function fileNameFor(number: string): string {
  const safe = number.replace(/[^A-Za-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 80);
  return `erechnung-${safe === "" ? "beleg" : safe}.xml`;
}

/**
 * F8-10 E-Rechnung CII-Export. Reiner Read-Pfad (`invoicing.read`, keine
 * neue Permission, keine Migration): Belegdetail + Stammdaten werden in
 * den CII-Builder projiziert. Unvollständige Exportdaten verweigern
 * fail-closed (kein Leer-XML, keine Platzhalter).
 */
export async function exportDocumentCii(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CommercialDocumentCiiCommandV1,
): Promise<CommercialDocumentCiiV1> {
  requireInvoicingRead(ctx);
  const parsed = commercialDocumentCiiCommandV1Schema.safeParse(input);
  if (!parsed.success) fail();
  const command = parsed.data;

  // NotFound bleibt NotFound (Route mappt 404); nur Export-Probleme
  // werden ValidationError.
  const detail = await getDocumentDetail(tx, ctx, {
    schemaVersion: COMMERCIAL_DOCUMENT_DETAIL_COMMAND_VERSION,
    type: command.type,
    documentId: command.documentId,
  });
  const document = detail.document;
  if (document.type !== "invoice" && document.type !== "credit_note") fail();
  if (document.number === null || document.voidedAt !== null) fail();
  if (document.contactId === null) fail();

  const meta = await tx.execute<DocumentMetaRow>(sql`
    select currency, created_at
      from commercial_document
     where workspace_id = ${ctx.workspaceId}::uuid and id = ${command.documentId}::uuid
     limit 1
  `);
  const metaRow = meta.rows[0];
  if (!metaRow || metaRow.currency !== "EUR") fail();
  const createdAt = metaRow.created_at instanceof Date
    ? metaRow.created_at.toISOString()
    : String(metaRow.created_at);

  const settings = await tx.execute<SettingsRow>(sql`
    select company_name, company_address_line1, company_address_line2,
           company_postal_code, company_city, company_country,
           company_tax_id, payment_iban
      from workspace_invoicing_settings
     where workspace_id = ${ctx.workspaceId}::uuid
     limit 1
  `);
  const seller = settings.rows[0];
  if (!seller) fail();

  const contact = await tx.execute<ContactRow>(sql`
    select display_name, address_street, address_house_number,
           address_postal_code, address_city, address_country
      from contact
     where workspace_id = ${ctx.workspaceId}::uuid and id = ${document.contactId}::uuid
     limit 1
  `);
  const buyer = contact.rows[0];
  if (!buyer) fail();

  const buyerStreet = [buyer.address_street, buyer.address_house_number]
    .filter((part) => part !== null && part.trim() !== "")
    .join(" ");

  const builderInput: CiiExportInput = {
    kind: document.type as "invoice" | "credit_note",
    number: document.number,
    issueDate: datePart(document.issuedAt ?? createdAt),
    deliveryDate: datePart(document.deliveryDate ?? document.issuedAt ?? createdAt),
    currency: "EUR",
    seller: {
      name: seller.company_name,
      line1: seller.company_address_line1,
      line2: seller.company_address_line2,
      postalCode: seller.company_postal_code,
      city: seller.company_city,
      country: seller.company_country,
      taxId: seller.company_tax_id,
    },
    buyer: {
      name: buyer.display_name,
      line1: buyerStreet,
      postalCode: buyer.address_postal_code ?? "",
      city: buyer.address_city ?? "",
      country: buyer.address_country ?? "",
    },
    lines: detail.lines.map((line) => ({
      position: line.position,
      name: line.name,
      quantityMilli: line.quantityMilli,
      unit: line.unit,
      netCents: line.netCents,
      taxCents: line.taxCents,
      grossCents: line.grossCents,
      taxRateBps: line.taxRateBps,
    })),
    netCents: document.netCents,
    taxCents: document.taxCents,
    grossCents: document.grossCents,
    paymentIban: seller.payment_iban,
  };

  let content: string;
  try {
    content = buildCiiXml(builderInput);
  } catch (error) {
    if (error instanceof CiiExportError) fail();
    throw error;
  }

  return commercialDocumentCiiV1Schema.parse({
    schemaVersion: COMMERCIAL_DOCUMENT_CII_VERSION,
    fileName: fileNameFor(document.number),
    contentType: "application/xml",
    content,
  });
}
