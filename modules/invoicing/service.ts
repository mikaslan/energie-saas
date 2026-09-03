import "server-only";

import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  DOCUMENT_NUMBER_FORMAT_DEFAULTS,
  invoicingSettingsCommandV1Schema,
  invoicingSettingsV1Schema,
  numberFormatCommandV1Schema,
  numberFormatListV1Schema,
  WORKSPACE_DOCUMENT_NUMBER_FORMAT_LIST_VERSION,
  WORKSPACE_INVOICING_SETTINGS_VERSION,
  type DocumentNumberType,
  type InvoicingSettingsCommandV1,
  type InvoicingSettingsV1,
  type NumberFormatCommandV1,
  type NumberFormatListV1,
} from "@/lib/integrations/invoicing/contract";
import {
  InvoicingConflictError,
  InvoicingNotFoundError,
  InvoicingPreconditionConflictError,
  InvoicingValidationError,
} from "./errors";

function requireInvoicingRead(ctx: ServiceCtx): void {
  if (!can(ctx, "invoicing.read")) {
    throw new PermissionDeniedError("invoicing.read", "workspace_invoicing_settings", undefined, ctx.actor);
  }
}

function requireInvoicingWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "invoicing.write")) {
    throw new PermissionDeniedError("invoicing.write", "workspace_invoicing_settings", undefined, ctx.actor);
  }
}

function requireIssuingDetailsWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "invoicing.issuing_details.write")) {
    throw new PermissionDeniedError("invoicing.issuing_details.write", "workspace_invoicing_settings", undefined, ctx.actor);
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

function normalizeIban(value: string | null): string | null {
  if (value === null) return null;
  return value.replace(/[\s]/gu, "").toUpperCase();
}

function normalizeBic(value: string | null): string | null {
  if (value === null) return null;
  return value.toUpperCase();
}

type SettingsRow = {
  revision: number;
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
  accounting_method: string;
  payment_account_holder: string | null;
  payment_iban: string | null;
  payment_bic: string | null;
  goebd_retention_default_days: number;
  [key: string]: unknown;
};

type NumberFormatRow = {
  type: string;
  format_template: string;
  counter: number;
  [key: string]: unknown;
};

export async function getInvoicingSettings(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<InvoicingSettingsV1 | null> {
  requireInvoicingRead(ctx);
  const result = await tx.execute<SettingsRow>(sql`
    select revision,
           company_name,
           company_email,
           company_authority,
           company_register_number,
           company_tax_id,
           company_address_line1,
           company_address_line2,
           company_postal_code,
           company_city,
           company_country,
           accounting_method,
           payment_account_holder,
           payment_iban,
           payment_bic,
           goebd_retention_default_days
      from workspace_invoicing_settings
     where workspace_id = ${ctx.workspaceId}::uuid
     limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;

  const canWriteIssuingDetails = can(ctx, "invoicing.issuing_details.write");
  return invoicingSettingsV1Schema.parse({
    schemaVersion: WORKSPACE_INVOICING_SETTINGS_VERSION,
    revision: row.revision,
    companyName: row.company_name,
    companyEmail: row.company_email,
    companyAuthority: row.company_authority,
    companyRegisterNumber: row.company_register_number,
    companyTaxId: canWriteIssuingDetails ? row.company_tax_id : null,
    companyAddressLine1: row.company_address_line1,
    companyAddressLine2: row.company_address_line2,
    companyPostalCode: row.company_postal_code,
    companyCity: row.company_city,
    companyCountry: row.company_country,
    accountingMethod: row.accounting_method,
    paymentAccountHolder: row.payment_account_holder,
    paymentIban: canWriteIssuingDetails ? row.payment_iban : null,
    paymentBic: row.payment_bic,
    goebdRetentionDefaultDays: row.goebd_retention_default_days,
    permissions: {
      canWrite: can(ctx, "invoicing.write"),
      canWriteIssuingDetails,
    },
  });
}

export async function upsertInvoicingSettings(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: InvoicingSettingsCommandV1,
): Promise<{ revision: number; created: boolean }> {
  requireInvoicingWrite(ctx);
  requireIssuingDetailsWrite(ctx);
  const parsed = invoicingSettingsCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new InvoicingValidationError();
  const command = parsed.data;
  const value = command.input;

  if (command.baseRevision === 0) {
    try {
      await tx.execute(sql`
        insert into workspace_invoicing_settings (
          workspace_id, company_name, company_email, company_authority,
          company_register_number, company_tax_id, company_address_line1,
          company_address_line2, company_postal_code, company_city,
          company_country, accounting_method, payment_account_holder,
          payment_iban, payment_bic, goebd_retention_default_days,
          revision, created_by
        ) values (
          ${ctx.workspaceId}::uuid,
          ${value.companyName},
          ${value.companyEmail},
          ${value.companyAuthority},
          ${value.companyRegisterNumber},
          ${value.companyTaxId},
          ${value.companyAddressLine1},
          ${value.companyAddressLine2},
          ${value.companyPostalCode},
          ${value.companyCity},
          ${value.companyCountry},
          ${value.accountingMethod},
          ${value.paymentAccountHolder},
          ${normalizeIban(value.paymentIban)},
          ${normalizeBic(value.paymentBic)},
          ${value.goebdRetentionDefaultDays},
          1, ${ctx.actor}::uuid
        )
      `);
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === "23505") throw new InvoicingConflictError();
      if (code === "23514") throw new InvoicingValidationError();
      throw error;
    }
    await emitSettingsEvidence(tx, ctx, 1, "workspace_invoicing_settings.created");
    return { revision: 1, created: true };
  }

  const updated = await tx.execute<{ revision: number; [key: string]: unknown }>(sql`
    update workspace_invoicing_settings
       set company_name = ${value.companyName},
           company_email = ${value.companyEmail},
           company_authority = ${value.companyAuthority},
           company_register_number = ${value.companyRegisterNumber},
           company_tax_id = ${value.companyTaxId},
           company_address_line1 = ${value.companyAddressLine1},
           company_address_line2 = ${value.companyAddressLine2},
           company_postal_code = ${value.companyPostalCode},
           company_city = ${value.companyCity},
           company_country = ${value.companyCountry},
           accounting_method = ${value.accountingMethod},
           payment_account_holder = ${value.paymentAccountHolder},
           payment_iban = ${normalizeIban(value.paymentIban)},
           payment_bic = ${normalizeBic(value.paymentBic)},
           goebd_retention_default_days = ${value.goebdRetentionDefaultDays},
           revision = revision + 1,
           updated_by = ${ctx.actor}::uuid,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and revision = ${command.baseRevision}
     returning revision
  `);
  const nextRevision = updated.rows[0]?.revision;
  if (!nextRevision) throw new InvoicingConflictError();
  await emitSettingsEvidence(tx, ctx, nextRevision, "workspace_invoicing_settings.updated");
  return { revision: nextRevision, created: false };
}

async function emitSettingsEvidence(
  tx: TenantTx,
  ctx: ServiceCtx,
  revision: number,
  eventType: string,
): Promise<void> {
  const evidence = { workspaceId: ctx.workspaceId, revision };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "workspace_invoicing_settings",
    aggregateId: ctx.workspaceId,
    eventType,
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "invoicing.settings.write",
    resource: "workspace_invoicing_settings",
    allowed: true,
    details: evidence,
  });
}

export async function getNumberFormats(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<NumberFormatListV1> {
  requireInvoicingRead(ctx);
  await seedNumberFormats(tx, ctx.workspaceId);
  const result = await tx.execute<NumberFormatRow>(sql`
    select type, format_template, counter
      from workspace_document_number_format
     where workspace_id = ${ctx.workspaceId}::uuid
     order by type asc
  `);
  return numberFormatListV1Schema.parse({
    schemaVersion: WORKSPACE_DOCUMENT_NUMBER_FORMAT_LIST_VERSION,
    formats: result.rows.map((row) => ({
      type: row.type,
      formatTemplate: row.format_template,
      counter: Number(row.counter),
    })),
    permissions: { canWrite: can(ctx, "invoicing.write") },
  });
}

async function seedNumberFormats(tx: TenantTx, workspaceId: string): Promise<void> {
  for (const [type, formatTemplate] of Object.entries(DOCUMENT_NUMBER_FORMAT_DEFAULTS)) {
    await tx.execute(sql`
      insert into workspace_document_number_format (
        workspace_id, type, format_template
      ) values (
        ${workspaceId}::uuid, ${type}, ${formatTemplate}
      ) on conflict (workspace_id, type) do nothing
    `);
  }
}

export async function upsertNumberFormat(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: NumberFormatCommandV1,
): Promise<{ type: DocumentNumberType; counter: number }> {
  requireInvoicingWrite(ctx);
  const parsed = numberFormatCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new InvoicingValidationError();
  const command = parsed.data;

  const updated = await tx.execute<{ type: string; counter: number; [key: string]: unknown }>(sql`
    update workspace_document_number_format
       set format_template = ${command.formatTemplate},
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and type = ${command.type}
     returning type, counter
  `);
  const row = updated.rows[0];
  if (!row) throw new InvoicingNotFoundError();

  const evidence = { workspaceId: ctx.workspaceId, type: command.type, counter: Number(row.counter) };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "workspace_document_number_format",
    aggregateId: ctx.workspaceId,
    eventType: "workspace_document_number_format.updated",
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "invoicing.number_format.write",
    resource: "workspace_document_number_format",
    allowed: true,
    details: evidence,
  });
  return { type: command.type, counter: Number(row.counter) };
}

export async function assertIssuingDetailsComplete(
  tx: TenantTx,
  workspaceId: string,
  documentType: DocumentNumberType,
): Promise<void> {
  const result = await tx.execute<{ payment_iban: string | null; company_country: string }>(sql`
    select payment_iban, company_country
      from workspace_invoicing_settings
     where workspace_id = ${workspaceId}::uuid
     limit 1
  `);
  const row = result.rows[0];
  const requiresPayment = documentType !== "letter";
  const reason: string | null = row === undefined
    ? "issuing details are missing"
    : requiresPayment && row.payment_iban === null
      ? "payment details are missing"
      : requiresPayment && row.company_country !== "DE"
        ? `country ${row.company_country} is not supported for money documents`
        : null;

  if (reason !== null) {
    await writeAudit(tx, {
      workspaceId,
      actor: "system",
      action: "document.issue.precondition",
      resource: "document.issue",
      allowed: false,
      details: { workspaceId, documentType, reason },
    });
    throw new InvoicingPreconditionConflictError(reason);
  }
}
