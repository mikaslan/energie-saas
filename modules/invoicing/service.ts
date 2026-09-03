import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { createHash } from "node:crypto";
import {
  COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_GROUP_VERSION,
  COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_LINE_VERSION,
  COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION,
  COMMERCIAL_DOCUMENT_NUMBER_SERIES_DEFAULTS,
  COMMERCIAL_DOCUMENT_VERSION,
  GOEBD_SNAPSHOT_CANONICALIZATION_VERSION,
  GOEBD_SNAPSHOT_SCHEMA_VERSION,
  DOCUMENT_NUMBER_FORMAT_DEFAULTS,
  commercialDocumentGroupCommandV1Schema,
  commercialDocumentCommandV1Schema,
  commercialDocumentIssueCommandV1Schema,
  commercialDocumentV1Schema,
  commercialDocumentGroupV1Schema,
  commercialDocumentLineCommandV1Schema,
  commercialDocumentLineV1Schema,
  invoicingSettingsCommandV1Schema,
  invoicingSettingsV1Schema,
  numberFormatCommandV1Schema,
  numberFormatListV1Schema,
  WORKSPACE_DOCUMENT_NUMBER_FORMAT_LIST_VERSION,
  WORKSPACE_INVOICING_SETTINGS_VERSION,
  type CommercialDocumentCommandV1,
  type CommercialDocumentGroupCommandV1,
  type CommercialDocumentIssueCommandV1,
  type CommercialDocumentV1,
  type CommercialDocumentGroupV1,
  type CommercialDocumentLineCommandV1,
  type CommercialDocumentLineV1,
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
  // Das Idempotenz-Seeding schreibt Defaults. Unter FORCE-RLS ist der
  // INSERT durch die restriktive Actor-Policy nur fuer Schreiber erlaubt —
  // Leser (Viewer) duerfen den Read-Pfad nicht mit Schreibzugriff belasten.
  if (can(ctx, "invoicing.write")) {
    await seedNumberFormats(tx, ctx.workspaceId);
  }
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

// ═══════════════════════════════════════════════════════════════════════
// M3-01 · Dokument-Kern (F8, ADR 0023). Entwurfs-Anlage, Gruppen-CRUD,
// Zeilen-Anlage und Nummernserien-Seeding. Ausstellen/Versand/Void/Zahlung
// sind Folge-Capabilities (M301-02..05) und hier bewusst nicht enthalten.
// ═══════════════════════════════════════════════════════════════════════

const MAX_DOCUMENT_MONEY_CENTS = 9_000_000_000_000_000;

function roundHalfUpCents(netCents: number, taxRateBps: number): number {
  if (!Number.isSafeInteger(netCents) || netCents < 0
      || netCents > MAX_DOCUMENT_MONEY_CENTS) {
    throw new InvoicingValidationError();
  }
  if (taxRateBps !== 0 && taxRateBps !== 1900) {
    throw new InvoicingValidationError();
  }
  // Kimi-P1-1: netCents * taxRateBps kann 1.7e19 erreichen — jenseits von
  // Number.MAX_SAFE_INTEGER. Rechnung vollständig in BigInt, dann auf den
  // Geldbereich zurueckpruefen.
  const rounded = (BigInt(netCents) * BigInt(taxRateBps) + BigInt(5000)) / BigInt(10000);
  if (rounded > BigInt(MAX_DOCUMENT_MONEY_CENTS)) {
    throw new InvoicingValidationError();
  }
  return Number(rounded);
}

function isLetter(type: DocumentNumberType): boolean {
  return type === "letter";
}

type DocumentRow = {
  id: string;
  type: string;
  status: string;
  group_id: string | null;
  [key: string]: unknown;
};

type IssueDocumentRow = {
  id: string;
  type: string;
  status: string;
  name: string;
  group_id: string | null;
  project_id: string | null;
  contact_id: string | null;
  currency: string;
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  due_date: string | null;
  delivery_date: string | null;
  validity_date: string | null;
  planned_delivery_date: string | null;
  planned_service_date: string | null;
  credit_note_type: string | null;
  recipient_snapshot: unknown;
  created_by: string;
  [key: string]: unknown;
};

type IssueLineRow = {
  position: number;
  name: string;
  quantity_milli: number;
  unit: string;
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  tax_rate_bps: number;
  [key: string]: unknown;
};

type GroupRow = {
  id: string;
  name: string;
  project_id: string | null;
  archived_at: Date | null;
  document_count: number;
  [key: string]: unknown;
};

type LineRow = {
  id: string;
  document_id: string;
  position: number;
  name: string;
  quantity_milli: number;
  unit: string;
  net_cents: number;
  tax_cents: number;
  gross_cents: number;
  tax_rate_bps: number;
  [key: string]: unknown;
};

export async function createDocumentGroup(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CommercialDocumentGroupCommandV1,
): Promise<{ id: string }> {
  requireInvoicingWrite(ctx);
  const parsed = commercialDocumentGroupCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new InvoicingValidationError();
  const groupId = randomUUID();
  try {
    await tx.execute(sql`
      insert into commercial_document_group (
        id, workspace_id, name, created_by
      ) values (
        ${groupId}::uuid, ${ctx.workspaceId}::uuid, ${parsed.data.name}, ${ctx.actor}::uuid
      )
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new InvoicingConflictError();
    if (code === "23514") throw new InvoicingValidationError();
    throw error;
  }
  const evidence = { workspaceId: ctx.workspaceId, groupId, name: parsed.data.name };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "commercial_document_group",
    aggregateId: groupId,
    eventType: "commercial_document_group.created",
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "invoicing.group.write",
    resource: "commercial_document_group",
    allowed: true,
    details: evidence,
  });
  return { id: groupId };
}

export async function renameDocumentGroup(
  tx: TenantTx,
  ctx: ServiceCtx,
  groupId: string,
  input: CommercialDocumentGroupCommandV1,
): Promise<{ id: string }> {
  requireInvoicingWrite(ctx);
  const parsed = commercialDocumentGroupCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new InvoicingValidationError();
  try {
    const updated = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      update commercial_document_group
         set name = ${parsed.data.name}, updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid and id = ${groupId}::uuid
       returning id
    `);
    if (!updated.rows[0]) throw new InvoicingNotFoundError();
  } catch (error) {
    if (error instanceof InvoicingNotFoundError) throw error;
    const code = postgresErrorCode(error);
    if (code === "23505") throw new InvoicingConflictError();
    if (code === "23514") throw new InvoicingValidationError();
    throw error;
  }
  const evidence = { workspaceId: ctx.workspaceId, groupId, name: parsed.data.name };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "commercial_document_group",
    aggregateId: groupId,
    eventType: "commercial_document_group.renamed",
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "invoicing.group.write",
    resource: "commercial_document_group",
    allowed: true,
    details: evidence,
  });
  return { id: groupId };
}

export async function listDocumentGroups(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<CommercialDocumentGroupV1[]> {
  requireInvoicingRead(ctx);
  const result = await tx.execute<GroupRow>(sql`
    select g.id,
           g.name,
           g.project_id,
           g.archived_at,
           count(d.id)::int as document_count
      from commercial_document_group g
      left join commercial_document d
        on d.workspace_id = g.workspace_id and d.group_id = g.id
     where g.workspace_id = ${ctx.workspaceId}::uuid
     group by g.id, g.name, g.project_id, g.archived_at
     order by g.name asc
  `);
  const canWrite = can(ctx, "invoicing.write");
  return result.rows.map((row) =>
    commercialDocumentGroupV1Schema.parse({
      schemaVersion: COMMERCIAL_DOCUMENT_GROUP_VERSION,
      id: row.id,
      name: row.name,
      projectId: row.project_id,
      archivedAt: row.archived_at === null ? null : new Date(row.archived_at).toISOString(),
      documentCount: Number(row.document_count),
      permissions: { canWrite },
    }),
  );
}

export async function seedNumberSeries(tx: TenantTx, workspaceId: string): Promise<void> {
  const seriesYear = await tx.execute<{ year: number }>(sql`
    select extract(year from statement_timestamp())::int as year
  `);
  const year = seriesYear.rows[0]?.year ?? new Date().getFullYear();
  for (const [type, defaults] of Object.entries(COMMERCIAL_DOCUMENT_NUMBER_SERIES_DEFAULTS)) {
    await tx.execute(sql`
      insert into commercial_document_number_series (
        workspace_id, type, series_year, prefix, padding
      ) values (
        ${workspaceId}::uuid, ${type}, ${year}, ${defaults.prefix}, ${defaults.padding}
      ) on conflict (workspace_id, type, series_year) do nothing
    `);
  }
}

export async function createDocument(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CommercialDocumentCommandV1,
): Promise<{ id: string; type: DocumentNumberType; status: "draft" }> {
  requireInvoicingWrite(ctx);
  const parsed = commercialDocumentCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new InvoicingValidationError();
  const command = parsed.data.input;
  const type = command.type;

  // Kimi-P2-7: archivierte Gruppen nehmen keine neuen Dokumente auf.
  if (command.groupId !== null) {
    const group = await tx.execute<{ archived_at: unknown }>(sql`
      select archived_at
        from commercial_document_group
       where workspace_id = ${ctx.workspaceId}::uuid and id = ${command.groupId}::uuid
       limit 1
    `);
    if (group.rows[0] === undefined) throw new InvoicingNotFoundError();
    if (group.rows[0].archived_at !== null) throw new InvoicingConflictError();
  }

  // O4-Precondition: Geld-Dokumente verlangen vollständige Issuing-Details
  // (0045), Briefe nicht.
  if (!isLetter(type)) {
    await assertIssuingDetailsComplete(tx, ctx.workspaceId, type);
  }

  // requireInvoicingWrite hat bereits gegriffen — Seeding läuft damit
  // ausschließlich im Schreibpfad (Kimi-P2-4).
  await seedNumberSeries(tx, ctx.workspaceId);

  const documentId = randomUUID();
  try {
    await tx.execute(sql`
      insert into commercial_document (
        id, workspace_id, type, group_id, project_id, contact_id,
        name, status, currency, net_cents, tax_cents, gross_cents,
        payment_status, paid_cents, due_date, delivery_date, validity_date,
        planned_delivery_date, planned_service_date, credit_note_type,
        created_by
      ) values (
        ${documentId}::uuid, ${ctx.workspaceId}::uuid, ${type},
        ${command.groupId}::uuid, ${command.projectId}::uuid, ${command.contactId}::uuid,
        ${command.name}, 'draft', 'EUR', 0, 0, 0,
        ${isLetter(type) ? null : "unpaid"}, 0,
        ${command.dueDate ? sql`${command.dueDate}::date` : null},
        ${command.deliveryDate ? sql`${command.deliveryDate}::date` : null},
        ${command.validityDate ? sql`${command.validityDate}::date` : null},
        ${command.plannedDeliveryDate ? sql`${command.plannedDeliveryDate}::date` : null},
        ${command.plannedServiceDate ? sql`${command.plannedServiceDate}::date` : null},
        ${command.creditNoteType},
        ${ctx.actor}::uuid
      )
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23514") throw new InvoicingValidationError();
    throw error;
  }
  const evidence = { workspaceId: ctx.workspaceId, documentId, type };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "commercial_document",
    aggregateId: documentId,
    eventType: "commercial_document.created",
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "invoicing.document.write",
    resource: "commercial_document",
    allowed: true,
    details: evidence,
  });
  return { id: documentId, type, status: "draft" };
}


export function canonicalizeDocumentSnapshot(snapshot: unknown): string {
  // Deterministische Byteform für die SHA-Verifikation: Schlüssel in
  // Einfüge-Reihenfolge (der Snapshot wird hier immer gleich aufgebaut).
  return JSON.stringify(snapshot);
}

type AssignedDocumentNumber = {
  number: string;
  numberYear: number;
  numberSequence: number;
};

async function assignDocumentNumber(
  tx: TenantTx,
  ctx: ServiceCtx,
  type: DocumentNumberType,
): Promise<AssignedDocumentNumber> {
  const defaults = COMMERCIAL_DOCUMENT_NUMBER_SERIES_DEFAULTS[type];
  const yearResult = await tx.execute<{ year: number; [key: string]: unknown }>(sql`
    select extract(year from statement_timestamp() at time zone 'Europe/Berlin')::integer as year
  `);
  const year = yearResult.rows[0]?.year;
  if (!year) throw new InvoicingConflictError();
  const allocated = await tx.execute<{
    prefix: string;
    padding: number;
    last_sequence: number;
    [key: string]: unknown;
  }>(sql`
    insert into commercial_document_number_series (
      id, workspace_id, type, series_year, prefix, padding, last_sequence,
      created_at, updated_at
    ) values (
      ${randomUUID()}::uuid, ${ctx.workspaceId}::uuid, ${type}, ${year},
      ${defaults.prefix}, ${defaults.padding}, 1,
      statement_timestamp(), statement_timestamp()
    )
    on conflict (workspace_id, type, series_year)
    do update set last_sequence = commercial_document_number_series.last_sequence + 1,
                  updated_at = clock_timestamp()
      where commercial_document_number_series.last_sequence < 999999
    returning prefix, padding, last_sequence
  `);
  const row = allocated.rows[0];
  if (!row) throw new InvoicingConflictError();
  const number = `${row.prefix}-${year}-${String(row.last_sequence).padStart(row.padding, "0")}`;
  return { number, numberYear: year, numberSequence: Number(row.last_sequence) };
}

export async function issueDocument(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CommercialDocumentIssueCommandV1,
): Promise<CommercialDocumentV1> {
  requireInvoicingWrite(ctx);
  const parsed = commercialDocumentIssueCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new InvoicingValidationError();
  const documentId = parsed.data.documentId;

  const doc = await tx.execute<IssueDocumentRow>(sql`
    select id, type, status, name, group_id, project_id, contact_id,
           currency, net_cents, tax_cents, gross_cents, due_date,
           delivery_date, validity_date, planned_delivery_date,
           planned_service_date, credit_note_type, recipient_snapshot,
           created_by
      from commercial_document
     where workspace_id = ${ctx.workspaceId}::uuid and id = ${documentId}::uuid
     limit 1
     for update
  `);
  const document = doc.rows[0];
  if (!document) throw new InvoicingNotFoundError();
  if (document.status !== "draft") throw new InvoicingConflictError();

  // O4: Geld-Dokumente brauchen vollständige Issuing-Details auch beim
  // Ausstellen (Spec M301-02 „Vorbedingungen: Issuing-Details vorhanden").
  const isLetterDocument = document.type === "letter";
  const documentType = document.type as DocumentNumberType;
  if (!isLetterDocument) {
    await assertIssuingDetailsComplete(tx, ctx.workspaceId, documentType);
  }

  const assigned = await assignDocumentNumber(tx, ctx, documentType);

  // O5/DECIDED: goebd_retention_until = Ausstellungsdatum + Default-Frist
  // (nur modelliert, keine Durchsetzung). Zeitbasis durchgängig Europe/Berlin.
  const nowBerlin = await tx.execute<{ now_iso: string; date: string }>(sql`
    select to_char(statement_timestamp() at time zone 'Europe/Berlin',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now_iso,
           to_char((statement_timestamp() at time zone 'Europe/Berlin')::date,
                   'YYYY-MM-DD') as date
  `);
  const issuedAt = nowBerlin.rows[0]?.now_iso ?? new Date().toISOString();
  const retention = await tx.execute<{ goebd_retention_default_days: number }>(sql`
    select goebd_retention_default_days
      from workspace_invoicing_settings
     where workspace_id = ${ctx.workspaceId}::uuid
     limit 1
  `);
  const retentionDays = retention.rows[0]?.goebd_retention_default_days ?? 3650;
  const retentionUntil = await tx.execute<{ date: string }>(sql`
    select to_char(
      (statement_timestamp() at time zone 'Europe/Berlin')::date + ${retentionDays}::integer,
      'YYYY-MM-DD'
    ) as date
  `);

  const lines = await tx.execute<IssueLineRow>(sql`
    select position, name, quantity_milli, unit, net_cents, tax_cents,
           gross_cents, tax_rate_bps
      from commercial_document_line
     where workspace_id = ${ctx.workspaceId}::uuid and document_id = ${documentId}::uuid
     order by position asc
  `);

  const snapshot = {
    schemaVersion: GOEBD_SNAPSHOT_SCHEMA_VERSION,
    canonicalizationVersion: GOEBD_SNAPSHOT_CANONICALIZATION_VERSION,
    type: document.type,
    number: assigned.number,
    numberYear: assigned.numberYear,
    numberSequence: assigned.numberSequence,
    issuedAt,
    currency: document.currency,
    netCents: Number(document.net_cents),
    taxCents: Number(document.tax_cents),
    grossCents: Number(document.gross_cents),
    dueDate: document.due_date,
    deliveryDate: document.delivery_date,
    validityDate: document.validity_date,
    plannedDeliveryDate: document.planned_delivery_date,
    plannedServiceDate: document.planned_service_date,
    creditNoteType: document.credit_note_type,
    name: document.name,
    recipientSnapshot: document.recipient_snapshot,
    lines: lines.rows.map((line) => ({
      position: Number(line.position),
      name: line.name,
      quantityMilli: Number(line.quantity_milli),
      unit: line.unit,
      netCents: Number(line.net_cents),
      taxCents: Number(line.tax_cents),
      grossCents: Number(line.gross_cents),
      taxRateBps: Number(line.tax_rate_bps),
    })),
  };
  const canonical = canonicalizeDocumentSnapshot(snapshot);
  const snapshotSha256 = createHash("sha256").update(canonical, "utf8").digest();

  const updated = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    update commercial_document
       set status = 'issued',
           number = ${assigned.number},
           number_year = ${assigned.numberYear},
           number_sequence = ${assigned.numberSequence},
           issued_at = ${issuedAt}::timestamptz,
           issued_by = ${ctx.actor}::uuid,
           issued_snapshot = ${canonical}::jsonb,
           snapshot_sha256 = ${snapshotSha256}::bytea,
           goebd_retention_until = ${retentionUntil.rows[0]?.date}::date,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${documentId}::uuid
       and status = 'draft'
    returning id
  `);
  if (updated.rows.length === 0) throw new InvoicingConflictError();

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "commercial_document",
    aggregateId: documentId,
    eventType: "commercial_document.issued",
    actor: ctx.actor,
    payload: { documentId, number: assigned.number },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "document.issue",
    resource: "commercial_document",
    allowed: true,
    details: { documentId, number: assigned.number },
  });

  const row = await tx.execute<DocumentRow>(sql`
    select id, type, status, name, group_id, project_id, contact_id,
           currency, net_cents, tax_cents, gross_cents, due_date,
           delivery_date, validity_date, planned_delivery_date,
           planned_service_date, credit_note_type, payment_status, number,
           number_year, number_sequence, issued_at, sent_at, voided_at,
           void_reason, paid_cents
      from commercial_document
     where workspace_id = ${ctx.workspaceId}::uuid and id = ${documentId}::uuid
     limit 1
  `);
  const issuedRow = row.rows[0];
  if (!issuedRow) throw new InvoicingNotFoundError();
  return commercialDocumentV1Schema.parse({
    schemaVersion: COMMERCIAL_DOCUMENT_VERSION,
    id: issuedRow.id,
    type: issuedRow.type,
    status: issuedRow.status,
    name: issuedRow.name,
    groupId: issuedRow.group_id,
    projectId: issuedRow.project_id,
    contactId: issuedRow.contact_id,
    archivedAt: null,
    netCents: Number(issuedRow.net_cents),
    taxCents: Number(issuedRow.tax_cents),
    grossCents: Number(issuedRow.gross_cents),
    paymentStatus: issuedRow.payment_status,
    dueDate: issuedRow.due_date,
    deliveryDate: issuedRow.delivery_date,
    validityDate: issuedRow.validity_date,
    plannedDeliveryDate: issuedRow.planned_delivery_date,
    plannedServiceDate: issuedRow.planned_service_date,
    creditNoteType: issuedRow.credit_note_type,
    number: issuedRow.number,
    numberYear: issuedRow.number_year === null ? null : Number(issuedRow.number_year),
    numberSequence: issuedRow.number_sequence === null ? null : Number(issuedRow.number_sequence),
    issuedAt: issuedRow.issued_at,
    sentAt: issuedRow.sent_at,
    voidedAt: issuedRow.voided_at,
    voidReason: issuedRow.void_reason,
    paidCents: issuedRow.paid_cents === null ? null : Number(issuedRow.paid_cents),
    permissions: { canWrite: can(ctx, "invoicing.write") },
  });
}

export async function createDocumentLine(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CommercialDocumentLineCommandV1,
): Promise<CommercialDocumentLineV1> {
  requireInvoicingWrite(ctx);
  const parsed = commercialDocumentLineCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new InvoicingValidationError();
  const command = parsed.data;

  const doc = await tx.execute<DocumentRow>(sql`
    select id, type, status
      from commercial_document
     where workspace_id = ${ctx.workspaceId}::uuid and id = ${command.documentId}::uuid
     limit 1
  `);
  const document = doc.rows[0];
  if (!document) throw new InvoicingNotFoundError();
  if (document.status !== "draft") {
    throw new InvoicingConflictError();
  }
  if (document.type === "letter") {
    throw new InvoicingValidationError();
  }

  const line = command.input;
  const taxCents = roundHalfUpCents(line.netCents, line.taxRateBps);
  const grossCents = line.netCents + taxCents;
  const lineId = randomUUID();
  const lineSnapshot = JSON.stringify({
    schemaVersion: COMMERCIAL_DOCUMENT_LINE_VERSION,
    name: line.name,
    quantityMilli: line.quantityMilli,
    unit: line.unit,
    netCents: line.netCents,
    taxCents,
    grossCents,
    taxRateBps: line.taxRateBps,
  });

  try {
    await tx.execute(sql`
      insert into commercial_document_line (
        id, workspace_id, document_id, position, name, quantity_milli, unit,
        net_cents, tax_cents, gross_cents, tax_rate_bps, line_snapshot
      ) values (
        ${lineId}::uuid, ${ctx.workspaceId}::uuid, ${command.documentId}::uuid,
        ${line.position}, ${line.name}, ${line.quantityMilli}, ${line.unit},
        ${line.netCents}, ${taxCents}, ${grossCents}, ${line.taxRateBps},
        ${lineSnapshot}::jsonb
      )
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new InvoicingConflictError();
    if (code === "23514") throw new InvoicingValidationError();
    throw error;
  }

  try {
    await tx.execute(sql`
      update commercial_document
         set net_cents = (
               select coalesce(sum(line_row.net_cents), 0)
                 from commercial_document_line line_row
                where line_row.workspace_id = commercial_document.workspace_id
                  and line_row.document_id = commercial_document.id
             ),
             tax_cents = (
               select coalesce(sum(line_row.tax_cents), 0)
                 from commercial_document_line line_row
                where line_row.workspace_id = commercial_document.workspace_id
                  and line_row.document_id = commercial_document.id
             ),
             gross_cents = (
               select coalesce(sum(line_row.gross_cents), 0)
               from commercial_document_line line_row
              where line_row.workspace_id = commercial_document.workspace_id
                and line_row.document_id = commercial_document.id
           ),
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid and id = ${command.documentId}::uuid
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23514") throw new InvoicingValidationError();
    throw error;
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "commercial_document",
    aggregateId: command.documentId,
    eventType: "commercial_document_line.created",
    actor: ctx.actor,
    payload: { documentId: command.documentId, lineId, netCents: line.netCents, taxCents, grossCents },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "document.line.write",
    resource: "commercial_document_line",
    allowed: true,
    details: { documentId: command.documentId, lineId },
  });

  return commercialDocumentLineV1Schema.parse({
    schemaVersion: COMMERCIAL_DOCUMENT_LINE_VERSION,
    id: lineId,
    documentId: command.documentId,
    position: line.position,
    name: line.name,
    quantityMilli: line.quantityMilli,
    unit: line.unit,
    netCents: line.netCents,
    taxCents,
    grossCents,
    taxRateBps: line.taxRateBps,
  });
}
