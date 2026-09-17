import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";

import type { TenantTx } from "@/lib/db/types";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION,
} from "@/lib/integrations/invoicing/contract";
import {
  buildInvoicePdfInput,
  hashInvoicePdfInput,
  INVOICE_PDF_RENDERER_RECIPE_VERSION,
  INVOICE_PDF_TEMPLATE_VERSION,
} from "@/lib/integrations/invoicing/pdf-contract";
import {
  InvoicingIntegrityError,
  InvoicingNotFoundError,
  InvoicingValidationError,
} from "./errors";

const renderCommandSchema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_RENDER_COMMAND_VERSION),
  documentId: z.string().uuid(),
});

export type RequestInvoicePdfInputCommand = z.infer<typeof renderCommandSchema>;

export interface RequestInvoicePdfInputResult {
  jobId: string;
  inputSha256Hex: string;
  status: "requested";
}

function requireInvoicingWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "invoicing.write")) {
    throw new PermissionDeniedError(
      "invoicing.write",
      "commercial_document_render_job",
      undefined,
      ctx.actor,
    );
  }
}

function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

type DocumentRow = {
  id: string;
  type: string;
  status: string;
  number: string | null;
  number_year: number | null;
  number_sequence: number | null;
  issued_at: Date | string | null;
  invoice_kind: string | null;
  credit_note_type: string | null;
  // Roh-SQL liefert bigint als String (Probe 2026-09-17); Coercion unten.
  net_cents: number | string;
  tax_cents: number | string;
  gross_cents: number | string;
  due_date: string | null;
  delivery_date: string | null;
  planned_service_date: string | null;
  skonto_percent_bps: number | null;
  skonto_days: number | null;
  recipient_snapshot: unknown;
};

type LineRow = {
  position: number;
  name: string;
  quantity_milli: number;
  unit: string;
  net_cents: number | string;
  tax_cents: number | string;
  gross_cents: number | string;
  tax_rate_bps: number;
};

type SettingsRow = {
  company_name: string;
  company_email: string;
  company_authority: string | null;
  company_register_number: string | null;
  company_tax_id: string | null;
  company_address_line1: string;
  company_address_line2: string | null;
  company_postal_code: string;
  company_city: string;
  company_country: string;
  payment_account_holder: string | null;
  payment_iban: string | null;
  payment_bic: string | null;
  revision: number;
};

function asIsoUtc(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  if (!Number.isFinite(time)) throw new InvoicingIntegrityError();
  return new Date(time).toISOString();
}

function asMoneyCents(value: number | string): number {
  const coerced = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(coerced) || coerced < 0) throw new InvoicingIntegrityError();
  return coerced;
}

export async function requestInvoicePdfInput(
  tx: TenantTx,
  ctx: ServiceCtx,
  command: RequestInvoicePdfInputCommand,
): Promise<RequestInvoicePdfInputResult> {
  requireInvoicingWrite(ctx);
  const parsed = renderCommandSchema.safeParse(command);
  if (!parsed.success) {
    throw new InvoicingValidationError();
  }
  const { documentId } = parsed.data;

  const documentRows = await tx.execute<DocumentRow>(sql`
    select id, type, status, number, number_year, number_sequence,
           issued_at, invoice_kind, credit_note_type,
           net_cents, tax_cents, gross_cents,
           due_date::text as due_date,
           delivery_date::text as delivery_date,
           planned_service_date::text as planned_service_date,
           skonto_percent_bps, skonto_days, recipient_snapshot
      from commercial_document
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${documentId}::uuid
  `);
  const document = documentRows.rows[0];
  if (!document) throw new InvoicingNotFoundError();
  if (
    (document.type !== "invoice" && document.type !== "credit_note")
    || document.status !== "issued"
    || document.number === null
    || document.number_year === null
    || document.number_sequence === null
    || document.issued_at === null
    || document.recipient_snapshot === null
  ) {
    throw new InvoicingValidationError();
  }

  const lineRows = await tx.execute<LineRow>(sql`
    select position, name, quantity_milli, unit,
           net_cents, tax_cents, gross_cents, tax_rate_bps
      from commercial_document_line
     where workspace_id = ${ctx.workspaceId}::uuid
       and document_id = ${documentId}::uuid
     order by position asc
  `);
  if (lineRows.rows.length === 0) {
    throw new InvoicingValidationError();
  }

  const settingsRows = await tx.execute<SettingsRow>(sql`
    select company_name, company_email, company_authority,
           company_register_number, company_tax_id,
           company_address_line1, company_address_line2,
           company_postal_code, company_city, company_country,
           payment_account_holder, payment_iban, payment_bic, revision
      from workspace_invoicing_settings
     where workspace_id = ${ctx.workspaceId}::uuid
  `);
  const settings = settingsRows.rows[0];
  if (!settings) {
    throw new InvoicingValidationError();
  }

  const preparedRows = await tx.execute<{ now: Date }>(sql`
    select pg_catalog.transaction_timestamp() as now
  `);
  const preparedNow = preparedRows.rows[0]?.now;
  if (!preparedNow) throw new InvoicingIntegrityError();
  const preparedAt = asIsoUtc(preparedNow);

  const built = buildInvoicePdfInput({
    document: {
      type: document.type,
      invoiceKind: document.invoice_kind,
      creditNoteType: document.credit_note_type,
      number: document.number,
      numberYear: document.number_year,
      numberSequence: document.number_sequence,
      issuedAt: asIsoUtc(document.issued_at),
      dueDate: document.due_date,
      // Leistungsdatum: Ist-Datum, sonst geplantes Leistungsdatum.
      serviceDate: document.delivery_date ?? document.planned_service_date,
      skontoPercentBps: document.skonto_percent_bps,
      skontoDays: document.skonto_days,
    },
    recipient: document.recipient_snapshot,
    sender: {
      companyName: settings.company_name,
      companyEmail: settings.company_email,
      companyAuthority: settings.company_authority,
      companyRegisterNumber: settings.company_register_number,
      companyTaxId: settings.company_tax_id,
      companyAddressLine1: settings.company_address_line1,
      companyAddressLine2: settings.company_address_line2,
      companyPostalCode: settings.company_postal_code,
      companyCity: settings.company_city,
      companyCountry: settings.company_country,
      paymentAccountHolder: settings.payment_account_holder,
      paymentIban: settings.payment_iban,
      paymentBic: settings.payment_bic,
      settingsRevision: settings.revision,
    },
    lines: lineRows.rows.map((line) => ({
      position: line.position,
      title: line.name,
      quantityMilli: line.quantity_milli,
      unit: line.unit,
      netCents: asMoneyCents(line.net_cents),
      taxCents: asMoneyCents(line.tax_cents),
      grossCents: asMoneyCents(line.gross_cents),
      taxRateBps: line.tax_rate_bps,
    })),
    headTotals: {
      netCents: asMoneyCents(document.net_cents),
      taxCents: asMoneyCents(document.tax_cents),
      grossCents: asMoneyCents(document.gross_cents),
    },
    preparedAt,
  });
  if (!built.ok) {
    throw new InvoicingValidationError();
  }
  const input = built.value;
  let inputSha256Hex: string;
  try {
    inputSha256Hex = hashInvoicePdfInput(input);
  } catch {
    throw new InvoicingIntegrityError();
  }

  const jobId = randomUUID();
  try {
    const inserted = await tx.execute<{ id: string }>(sql`
      insert into commercial_document_render_job (
        id, workspace_id, document_id, input_json, input_sha256,
        template_version, renderer_recipe, status, created_by
      ) values (
        ${jobId}::uuid, ${ctx.workspaceId}::uuid, ${documentId}::uuid,
        ${JSON.stringify(input)}::jsonb, decode(${inputSha256Hex}, 'hex'),
        ${INVOICE_PDF_TEMPLATE_VERSION}, ${INVOICE_PDF_RENDERER_RECIPE_VERSION},
        'requested', ${ctx.actor}::uuid
      )
      on conflict (workspace_id, document_id, template_version, renderer_recipe)
      do nothing
      returning id
    `);
    const row = inserted.rows[0];
    if (row) {
      return { jobId: row.id, inputSha256Hex, status: "requested" };
    }
  } catch (error) {
    if (postgresErrorCode(error) === "23505") {
      // Race unterhalb der WITH-CHECK-Sichtbarkeit: Replay lesen.
    } else {
      throw error;
    }
  }
  // Replay: existierenden versiegelten Job lesen + Hash rueckpruefen.
  const existing = await tx.execute<{ id: string; input_json: unknown; hex: string }>(sql`
    select id, input_json, encode(input_sha256, 'hex') as hex
      from commercial_document_render_job
     where workspace_id = ${ctx.workspaceId}::uuid
       and document_id = ${documentId}::uuid
       and template_version = ${INVOICE_PDF_TEMPLATE_VERSION}
       and renderer_recipe = ${INVOICE_PDF_RENDERER_RECIPE_VERSION}
  `);
  const found = existing.rows[0];
  if (!found) {
    throw new InvoicingIntegrityError();
  }
  let replayHash: string;
  try {
    replayHash = hashInvoicePdfInput(found.input_json);
  } catch {
    throw new InvoicingIntegrityError();
  }
  if (replayHash !== found.hex) {
    throw new InvoicingIntegrityError();
  }
  return { jobId: found.id, inputSha256Hex: found.hex, status: "requested" };
}
