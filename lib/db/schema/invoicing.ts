import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { membership, workspace } from "./core";
import { contact } from "./crm";
import { project } from "./project";
import { bytea } from "./types";

// M3-00 · Workspace-Stammdaten „Ausstellungsdetails" (F8.2, ADR 0024).
// Singleton je Workspace (workspace_id = PK); revision-CAS wie M1-13/M1-14.
export const workspaceInvoicingSettings = pgTable(
  "workspace_invoicing_settings",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").primaryKey(),
    companyName: text("company_name").notNull(),
    companyEmail: text("company_email").notNull(),
    companyAuthority: text("company_authority"),
    companyRegisterNumber: text("company_register_number"),
    companyTaxId: text("company_tax_id"),
    companyAddressLine1: text("company_address_line1").notNull(),
    companyAddressLine2: text("company_address_line2"),
    companyPostalCode: text("company_postal_code").notNull(),
    companyCity: text("company_city").notNull(),
    companyCountry: text("company_country").notNull(),
    accountingMethod: text("accounting_method").notNull().default("accrual"),
    paymentAccountHolder: text("payment_account_holder"),
    paymentIban: text("payment_iban"),
    paymentBic: text("payment_bic"),
    goebdRetentionDefaultDays: integer("goebd_retention_default_days").notNull().default(3650),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("workspace_invoicing_settings_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "workspace_invoicing_settings_workspace_id_fk",
    }),
    check(
      "workspace_invoicing_settings_company_name_ck",
      sql`length(btrim(${t.companyName})) between 1 and 160`,
    ),
    check(
      "workspace_invoicing_settings_company_email_ck",
      sql`length(btrim(${t.companyEmail})) between 3 and 254
        and ${t.companyEmail} ~ '^[^@[:space:]]+@[^@[:space:]]+$'`,
    ),
    check(
      "workspace_invoicing_settings_company_authority_ck",
      sql`${t.companyAuthority} is null or length(btrim(${t.companyAuthority})) between 1 and 80`,
    ),
    check(
      "workspace_invoicing_settings_company_register_number_ck",
      sql`${t.companyRegisterNumber} is null or length(btrim(${t.companyRegisterNumber})) between 1 and 64`,
    ),
    check(
      "workspace_invoicing_settings_company_tax_id_ck",
      sql`${t.companyTaxId} is null or length(btrim(${t.companyTaxId})) between 1 and 64`,
    ),
    check(
      "workspace_invoicing_settings_company_address_line1_ck",
      sql`length(btrim(${t.companyAddressLine1})) between 1 and 160`,
    ),
    check(
      "workspace_invoicing_settings_company_address_line2_ck",
      sql`${t.companyAddressLine2} is null or length(btrim(${t.companyAddressLine2})) between 1 and 160`,
    ),
    check(
      "workspace_invoicing_settings_company_postal_code_ck",
      sql`length(btrim(${t.companyPostalCode})) between 1 and 20`,
    ),
    check(
      "workspace_invoicing_settings_company_city_ck",
      sql`length(btrim(${t.companyCity})) between 1 and 120`,
    ),
    check(
      "workspace_invoicing_settings_company_country_ck",
      sql`${t.companyCountry} in ('DE', 'AT', 'CH', 'FR', 'UK', 'JE')`,
    ),
    check(
      "workspace_invoicing_settings_accounting_method_ck",
      sql`${t.accountingMethod} in ('accrual', 'cash')`,
    ),
    check(
      "workspace_invoicing_settings_payment_account_holder_ck",
      sql`${t.paymentAccountHolder} is null or length(btrim(${t.paymentAccountHolder})) between 1 and 160`,
    ),
    check(
      "workspace_invoicing_settings_payment_iban_ck",
      sql`${t.paymentIban} is null or char_length(btrim(${t.paymentIban})) between 15 and 34`,
    ),
    check(
      "workspace_invoicing_settings_payment_bic_ck",
      sql`${t.paymentBic} is null or char_length(btrim(${t.paymentBic})) in (8, 11)`,
    ),
    // Zahlungsdaten gemeinsam null oder vollständig (Spec §4 / ADR 0024).
    check(
      "workspace_invoicing_settings_payment_complete_ck",
      sql`(
        ${t.paymentAccountHolder} is null
        and ${t.paymentIban} is null
        and ${t.paymentBic} is null
      ) or (
        ${t.paymentAccountHolder} is not null
        and ${t.paymentIban} is not null
        and ${t.paymentBic} is not null
      )`,
    ),
    check(
      "workspace_invoicing_settings_goebd_days_ck",
      sql`${t.goebdRetentionDefaultDays} between 1 and 36500`,
    ),
    check(
      "workspace_invoicing_settings_revision_ck",
      sql`${t.revision} between 1 and 2147483647`,
    ),
    check(
      "workspace_invoicing_settings_timestamps_ck",
      sql`${t.updatedAt} >= ${t.createdAt}
        and isfinite(${t.createdAt})
        and isfinite(${t.updatedAt})`,
    ),
  ],
);

// Kind-Tabelle je (workspaceId, type). Ohne revision: Last-Write-Wins ist
// explizit DECIDED (Spec §4). counter ist global monoton je (workspace,type)
// und wird ausschließlich von M3-01 inkrementiert (M3-00 setzt/liest).
export const workspaceDocumentNumberFormat = pgTable(
  "workspace_document_number_format",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    type: text("type").notNull(),
    formatTemplate: text("format_template").notNull(),
    counter: bigint("counter", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.type] }),
    unique("workspace_document_number_format_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "workspace_document_number_format_workspace_id_fk",
    }),
    check(
      "workspace_document_number_format_type_ck",
      sql`${t.type} in ('invoice', 'credit_note', 'order_confirmation', 'purchase_order', 'delivery_note', 'letter')`,
    ),
    check(
      "workspace_document_number_format_template_ck",
      sql`length(btrim(${t.formatTemplate})) between 1 and 120
        and ${t.formatTemplate} like '%{NUMBER}%'
        and ${t.formatTemplate} ~ '^([^{}]|\\{YEAR\\}|\\{MONTH\\}|\\{DAY\\}|\\{NUMBER\\})*$'`,
    ),
    check(
      "workspace_document_number_format_counter_ck",
      sql`${t.counter} >= 0`,
    ),
    check(
      "workspace_document_number_format_updated_at_ck",
      sql`isfinite(${t.updatedAt})`,
    ),
  ],
);

// ═══════════════════════════════════════════════════════════════════════
// M3-01 · Rechnungs-/Dokument-Kern (F8, ADR 0023). Generisches
// commercial_document-Aggregat mit Typ-Diskriminator statt einer Tabelle je
// Dokumenttyp. Additiv zur M3-00-Stammdaten-Tabelle.
// ═══════════════════════════════════════════════════════════════════════

const moneyCheck = (column: AnyPgColumn) =>
  sql`${column} between 0 and 9000000000000000`;

const COMMERCIAL_DOCUMENT_TYPES = sql`(
  'invoice', 'credit_note', 'order_confirmation', 'purchase_order', 'delivery_note', 'letter'
)`;

export const commercialDocumentGroup = pgTable(
  "commercial_document_group",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id"),
    name: text("name").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("commercial_document_group_ws_id_uq").on(t.workspaceId, t.id),
    unique("commercial_document_group_ws_name_uq").on(t.workspaceId, t.name),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "commercial_document_group_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "commercial_document_group_project_fk",
    }),
    check(
      "commercial_document_group_name_ck",
      sql`length(btrim(${t.name})) between 1 and 120`,
    ),
    check(
      "commercial_document_group_archive_ck",
      sql`${t.archivedAt} is null or isfinite(${t.archivedAt})`,
    ),
    check(
      "commercial_document_group_timestamps_ck",
      sql`isfinite(${t.createdAt}) and isfinite(${t.updatedAt})
        and ${t.updatedAt} >= ${t.createdAt}`,
    ),
  ],
);

export const commercialDocumentNumberSeries = pgTable(
  "commercial_document_number_series",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    type: text("type").notNull(),
    seriesYear: integer("series_year").notNull(),
    prefix: text("prefix").notNull(),
    padding: integer("padding").notNull(),
    lastSequence: integer("last_sequence").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("commercial_document_number_series_ws_id_uq").on(t.workspaceId, t.id),
    unique("commercial_document_number_series_ws_type_year_uq").on(
      t.workspaceId,
      t.type,
      t.seriesYear,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "commercial_document_number_series_workspace_id_fk",
    }),
    check(
      "commercial_document_number_series_type_ck",
      sql`${t.type} in ${COMMERCIAL_DOCUMENT_TYPES}`,
    ),
    check(
      "commercial_document_number_series_year_ck",
      sql`${t.seriesYear} between 2000 and 9999`,
    ),
    check(
      "commercial_document_number_series_prefix_ck",
      sql`length(btrim(${t.prefix})) between 1 and 40`,
    ),
    check(
      "commercial_document_number_series_padding_ck",
      sql`${t.padding} between 1 and 12`,
    ),
    check(
      "commercial_document_number_series_sequence_ck",
      sql`${t.lastSequence} between 0 and 999999`,
    ),
  ],
);

export const commercialDocument = pgTable(
  "commercial_document",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    type: text("type").notNull(),
    groupId: uuid("group_id"),
    projectId: uuid("project_id"),
    contactId: uuid("contact_id"),
    status: text("status").notNull().default("draft"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    name: text("name").notNull(),
    number: text("number"),
    numberYear: integer("number_year"),
    numberSequence: integer("number_sequence"),
    issuedAt: timestamp("issued_at", { withTimezone: true }),
    creditNoteType: text("credit_note_type"),
    // F8-16 · Teilrechnungstypen-Kennung (nur invoice, sonst null).
    invoiceKind: text("invoice_kind"),
    goebdRetentionUntil: date("goebd_retention_until"),
    currency: text("currency").notNull().default("EUR"),
    netCents: bigint("net_cents", { mode: "number" }).notNull().default(0),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull().default(0),
    grossCents: bigint("gross_cents", { mode: "number" }).notNull().default(0),
    paymentStatus: text("payment_status"),
    paidCents: bigint("paid_cents", { mode: "number" }).notNull().default(0),
    paymentUpdatedAt: timestamp("payment_updated_at", { withTimezone: true }),
    dueDate: date("due_date"),
    skontoPercentBps: integer("skonto_percent_bps"),
    skontoDays: integer("skonto_days"),
    deliveryDate: date("delivery_date"),
    validityDate: date("validity_date"),
    plannedDeliveryDate: date("planned_delivery_date"),
    plannedServiceDate: date("planned_service_date"),
    recipientSnapshot: jsonb("recipient_snapshot"),
    issuedSnapshot: jsonb("issued_snapshot"),
    snapshotSha256: bytea("snapshot_sha256"),
    issuedBy: uuid("issued_by"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("commercial_document_ws_id_uq").on(t.workspaceId, t.id),
    unique("commercial_document_ws_number_uq").on(
      t.workspaceId,
      t.type,
      t.numberYear,
      t.numberSequence,
    ),
    index("commercial_document_ws_list_idx").on(
      t.workspaceId,
      t.type,
      t.status,
      t.updatedAt,
      t.id,
    ),
    index("commercial_document_ws_type_issued_idx").on(
      t.workspaceId,
      t.type,
      t.issuedAt,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "commercial_document_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.groupId],
      foreignColumns: [commercialDocumentGroup.workspaceId, commercialDocumentGroup.id],
      name: "commercial_document_group_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "commercial_document_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.contactId],
      foreignColumns: [contact.workspaceId, contact.id],
      name: "commercial_document_contact_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "commercial_document_created_by_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.issuedBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "commercial_document_issued_by_fk",
    }),
    check(
      "commercial_document_type_ck",
      sql`${t.type} in ${COMMERCIAL_DOCUMENT_TYPES}`,
    ),
    check(
      "commercial_document_status_ck",
      sql`${t.status} in ('draft', 'issued', 'voided')`,
    ),
    check(
      "commercial_document_name_ck",
      sql`length(btrim(${t.name})) between 1 and 160`,
    ),
    check("commercial_document_currency_ck", sql`${t.currency} = 'EUR'`),
    check(
      "commercial_document_money_ck",
      sql`${moneyCheck(t.netCents)}
        and ${moneyCheck(t.taxCents)}
        and ${moneyCheck(t.grossCents)}
        and ${moneyCheck(t.paidCents)}
        and ${t.grossCents} = ${t.netCents} + ${t.taxCents}`,
    ),
    check(
      "commercial_document_credit_note_type_ck",
      sql`${t.creditNoteType} is null
        or ${t.creditNoteType} in ('minderleistung', 'empfehlungspraemie')`,
    ),
    check(
      "commercial_document_credit_note_type_scope_ck",
      sql`${t.creditNoteType} is null or ${t.type} = 'credit_note'`,
    ),
    check(
      "commercial_document_invoice_kind_ck",
      sql`${t.invoiceKind} is null
        or ${t.invoiceKind} in ('anzahlung', 'abschlag', 'teilrechnung', 'schlussrechnung')`,
    ),
    check(
      "commercial_document_invoice_kind_scope_ck",
      sql`${t.invoiceKind} is null or ${t.type} = 'invoice'`,
    ),
    check(
      "commercial_document_letter_ck",
      sql`${t.type} <> 'letter' or (
        ${t.netCents} = 0 and ${t.taxCents} = 0 and ${t.grossCents} = 0
        and ${t.paymentStatus} is null and ${t.paidCents} = 0
      )`,
    ),
    check(
      "commercial_document_payment_status_ck",
      sql`${t.type} = 'letter' or ${t.paymentStatus} in (
        'unpaid', 'partially_paid', 'paid', 'overdue', 'uncollectable'
      )`,
    ),
    check(
      "commercial_document_partial_paid_ck",
      sql`${t.paymentStatus} is distinct from 'partially_paid'
        or (${t.paidCents} > 0 and ${t.paidCents} < ${t.grossCents})`,
    ),
    check(
      "commercial_document_paid_ck",
      sql`${t.paymentStatus} is distinct from 'paid'
        or ${t.paidCents} >= ${t.grossCents}`,
    ),
    check(
      "commercial_document_unpaid_ck",
      sql`${t.paymentStatus} is distinct from 'unpaid' or ${t.paidCents} = 0`,
    ),
    check(
      "commercial_document_void_ck",
      sql`(${t.status} = 'voided')
        = (${t.voidReason} is not null and ${t.voidedAt} is not null)`,
    ),
    check(
      "commercial_document_void_reason_ck",
      sql`${t.voidReason} is null or ${t.voidReason} in (
        'created_in_error', 'duplicate', 'superseded', 'cancelled', 'other'
      )`,
    ),
    check(
      "commercial_document_sent_ck",
      sql`${t.sentAt} is null or ${t.status} <> 'draft'`,
    ),
    check(
      "commercial_document_issued_gate_ck",
      sql`${t.status} <> 'issued' or (
        ${t.number} is not null
        and ${t.numberYear} is not null
        and ${t.numberSequence} is not null
        and ${t.issuedAt} is not null
        and ${t.issuedSnapshot} is not null
        and ${t.snapshotSha256} is not null
        and ${t.goebdRetentionUntil} is not null
        and ${t.issuedBy} is not null
      )`,
    ),
    check(
      "commercial_document_snapshot_hash_ck",
      sql`${t.snapshotSha256} is null or octet_length(${t.snapshotSha256}) = 32`,
    ),
    check(
      "commercial_document_issued_snapshot_ck",
      sql`${t.issuedSnapshot} is null or jsonb_typeof(${t.issuedSnapshot}) = 'object'`,
    ),
    check(
      "commercial_document_recipient_snapshot_ck",
      sql`${t.recipientSnapshot} is null or jsonb_typeof(${t.recipientSnapshot}) = 'object'`,
    ),
    check(
      "commercial_document_dates_ck",
      sql`case ${t.type}
        when 'invoice' then ${t.dueDate} is not null
        when 'credit_note' then ${t.deliveryDate} is not null
        when 'order_confirmation' then ${t.plannedDeliveryDate} is not null
          and ${t.plannedServiceDate} is not null
        when 'purchase_order' then ${t.validityDate} is not null
        when 'delivery_note' then ${t.deliveryDate} is not null
        when 'letter' then ${t.validityDate} is not null
        else true
      end`,
    ),
    check(
      "commercial_document_timestamps_ck",
      sql`isfinite(${t.createdAt}) and isfinite(${t.updatedAt})
        and ${t.updatedAt} >= ${t.createdAt}`,
    ),
    check(
      "commercial_document_payment_updated_ck",
      sql`${t.paymentUpdatedAt} is null or isfinite(${t.paymentUpdatedAt})`,
    ),
  ],
);

export const commercialDocumentLine = pgTable(
  "commercial_document_line",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    documentId: uuid("document_id").notNull(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    quantityMilli: integer("quantity_milli").notNull(),
    unit: text("unit").notNull(),
    netCents: bigint("net_cents", { mode: "number" }).notNull(),
    taxCents: bigint("tax_cents", { mode: "number" }).notNull(),
    grossCents: bigint("gross_cents", { mode: "number" }).notNull(),
    taxRateBps: integer("tax_rate_bps").notNull(),
    taxTreatment: text("tax_treatment").notNull(),
    lineSnapshot: jsonb("line_snapshot"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("commercial_document_line_ws_id_uq").on(t.workspaceId, t.id),
    unique("commercial_document_line_ws_doc_pos_uq").on(
      t.workspaceId,
      t.documentId,
      t.position,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "commercial_document_line_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [commercialDocument.workspaceId, commercialDocument.id],
      name: "commercial_document_line_document_fk",
    }),
    check(
      "commercial_document_line_position_ck",
      sql`${t.position} between 1 and 500`,
    ),
    check(
      "commercial_document_line_name_ck",
      sql`length(btrim(${t.name})) between 1 and 300`,
    ),
    check(
      "commercial_document_line_quantity_ck",
      sql`${t.quantityMilli} between 1 and 100000000`,
    ),
    check(
      "commercial_document_line_unit_ck",
      sql`${t.unit} in ('piece', 'set', 'meter')`,
    ),
    check(
      "commercial_document_line_money_ck",
      sql`${moneyCheck(t.netCents)} and ${moneyCheck(t.taxCents)}
        and ${moneyCheck(t.grossCents)}
        and ${t.grossCents} = ${t.netCents} + ${t.taxCents}`,
    ),
    check(
      "commercial_document_line_tax_rate_ck",
      sql`${t.taxRateBps} in (0, 1900)`,
    ),
    check(
      "commercial_document_line_snapshot_ck",
      sql`${t.lineSnapshot} is null or jsonb_typeof(${t.lineSnapshot}) = 'object'`,
    ),
    check(
      "commercial_document_line_tax_treatment_ck",
      sql`(${t.taxRateBps} = 1900 and ${t.taxTreatment} = 'standard_19') or (${t.taxRateBps} = 0 and ${t.taxTreatment} in ('zero_12_3', 'reverse_13b'))`,
    ),
  ],
);

// F8-01 · Anzahlung → Schlussrechnung (Anrechnung als Link, genau eine
// Stufe). Beide Seiten bleiben normale `invoice`-Dokumente; Ketten,
// Selbst-Links und Doppel-Verlinkungen verweigert der Service, UNIQUE
// und Selbst-Link-CHECK sichern die Tabellen-Invarianten.
// F8-02 · `appliedCents`: angerechneter Teilbetrag (Default-Pfad =
// volles Brutto); CHECK sichert das Geld-Intervall.
export const commercialDocumentLink = pgTable(
  "commercial_document_link",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    finalId: uuid("final_id").notNull(),
    depositId: uuid("deposit_id").notNull(),
    appliedCents: bigint("applied_cents", { mode: "number" }).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("commercial_document_link_ws_id_uq").on(t.workspaceId, t.id),
    unique("commercial_document_link_ws_pair_uq").on(
      t.workspaceId,
      t.finalId,
      t.depositId,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "commercial_document_link_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.finalId],
      foreignColumns: [commercialDocument.workspaceId, commercialDocument.id],
      name: "commercial_document_link_final_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.depositId],
      foreignColumns: [commercialDocument.workspaceId, commercialDocument.id],
      name: "commercial_document_link_deposit_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "commercial_document_link_created_by_fk",
    }),
    check(
      "commercial_document_link_no_self_ck",
      sql`${t.finalId} <> ${t.depositId}`,
    ),
    check(
      "commercial_document_link_applied_ck",
      sql`${t.appliedCents} between 0 and 9000000000000000`,
    ),
    index("commercial_document_link_ws_final_idx").on(
      t.workspaceId,
      t.finalId,
      t.createdAt,
      t.id,
    ),
  ],
);

// F8-05 · Teilrechnungskette: AB (order_confirmation) → Teilrechnung
// (invoice, gleiche Nummernserie). Modus `percent` = EINE Sammellinie mit
// X % des AB-Netto (nur einheitlicher Steuersatz, v1-Grenze); Modus
// `lines` = ganze übernommene AB-Positionen (verbrauchte IDs in
// commercial_document_partial_line, kein Positions-Split, v1-Grenze).
// Stornierte Teilrechnungen zählen für Caps/Verbrauch nicht (Budget frei).
export const commercialDocumentPartial = pgTable(
  "commercial_document_partial",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceOrderId: uuid("source_order_id").notNull(),
    partialInvoiceId: uuid("partial_invoice_id").notNull(),
    mode: text("mode").$type<"percent" | "lines" | "scheme" | "closing" | "remainder" | "amount">().notNull(),
    percentBps: integer("percent_bps"),
    ordinal: integer("ordinal").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("commercial_document_partial_ws_id_uq").on(t.workspaceId, t.id),
    unique("commercial_document_partial_ws_invoice_uq").on(t.workspaceId, t.partialInvoiceId),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "commercial_document_partial_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.sourceOrderId],
      foreignColumns: [commercialDocument.workspaceId, commercialDocument.id],
      name: "commercial_document_partial_source_order_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.partialInvoiceId],
      foreignColumns: [commercialDocument.workspaceId, commercialDocument.id],
      name: "commercial_document_partial_invoice_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "commercial_document_partial_created_by_fk",
    }),
    check(
      "commercial_document_partial_mode_ck",
      sql`${t.mode} in ('percent', 'lines')`,
    ),
    check(
      "commercial_document_partial_percent_ck",
      sql`(
        (${t.mode} = 'percent' and ${t.percentBps} between 1 and 10000)
        or (${t.mode} = 'lines' and ${t.percentBps} is null)
      )`,
    ),
    check(
      "commercial_document_partial_ordinal_ck",
      sql`${t.ordinal} > 0`,
    ),
    check(
      "commercial_document_partial_no_self_ck",
      sql`${t.sourceOrderId} <> ${t.partialInvoiceId}`,
    ),
    index("commercial_document_partial_ws_order_idx").on(
      t.workspaceId,
      t.sourceOrderId,
      t.ordinal,
      t.id,
    ),
  ],
);

export const commercialDocumentPartialLine = pgTable(
  "commercial_document_partial_line",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    partialId: uuid("partial_id").notNull(),
    sourceLineId: uuid("source_line_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("commercial_document_partial_line_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "commercial_document_partial_line_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.partialId],
      foreignColumns: [commercialDocumentPartial.workspaceId, commercialDocumentPartial.id],
      name: "commercial_document_partial_line_partial_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.sourceLineId],
      foreignColumns: [commercialDocumentLine.workspaceId, commercialDocumentLine.id],
      name: "commercial_document_partial_line_source_line_fk",
    }),
    index("commercial_document_partial_line_ws_partial_idx").on(
      t.workspaceId,
      t.partialId,
      t.sourceLineId,
    ),
    index("commercial_document_partial_line_ws_source_idx").on(
      t.workspaceId,
      t.sourceLineId,
    ),
  ],
);

// M3-02b · Render-Job-Zeile: versiegelter invoice-pdf-input.v1 je
// (Workspace, Dokument, Template, Rezept). Replay-idempotent per UNIQUE;
// Input ist nach Insert immutable (kein Update-Pfad in M3-02b).
// M3-02c · Worker-Lebenszyklus: requested → queued → running →
// retry_wait / succeeded / failed_final; Lease-Claim, Fehler, Artefakt.
export const commercialDocumentRenderJob = pgTable(
  "commercial_document_render_job",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    documentId: uuid("document_id").notNull(),
    inputJson: jsonb("input_json").notNull(),
    inputSha256: bytea("input_sha256").notNull(),
    templateVersion: text("template_version").notNull(),
    rendererRecipe: text("renderer_recipe").notNull(),
    status: text("status").notNull().default("requested"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorRetryable: boolean("error_retryable"),
    artifactMimeType: text("artifact_mime_type"),
    artifactSha256: bytea("artifact_sha256"),
    artifactSizeBytes: integer("artifact_size_bytes"),
    artifactBytes: bytea("artifact_bytes"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("commercial_document_render_job_ws_id_uq").on(t.workspaceId, t.id),
    unique("commercial_document_render_job_ws_doc_tpl_uq").on(
      t.workspaceId,
      t.documentId,
      t.templateVersion,
      t.rendererRecipe,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "commercial_document_render_job_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [commercialDocument.workspaceId, commercialDocument.id],
      name: "commercial_document_render_job_document_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "commercial_document_render_job_created_by_fk",
    }),
    index("commercial_document_render_job_ws_doc_idx").on(
      t.workspaceId,
      t.documentId,
    ),
    check(
      "commercial_document_render_job_status_ck",
      sql`${t.status} in (
        'requested', 'queued', 'running', 'retry_wait', 'succeeded', 'failed_final'
      )`,
    ),
    check(
      "commercial_document_render_job_attempt_ck",
      sql`${t.attemptCount} between 0 and 3`,
    ),
    check(
      "commercial_document_render_job_error_ck",
      sql`(
        ${t.errorCode} is null and ${t.errorRetryable} is null
      ) or (
        ${t.errorCode} ~ '^[a-z][a-z0-9_]{0,79}$' and ${t.errorRetryable} is not null
      )`,
    ),
    check(
      "commercial_document_render_job_artifact_ck",
      sql`(
        ${t.artifactMimeType} is null
        and ${t.artifactSha256} is null
        and ${t.artifactSizeBytes} is null
        and ${t.artifactBytes} is null
      ) or (
        ${t.artifactMimeType} = 'application/pdf'
        and octet_length(${t.artifactSha256}) = 32
        and ${t.artifactSizeBytes} between 100 and 8388608
        and octet_length(${t.artifactBytes}) = ${t.artifactSizeBytes}
        and ${t.artifactSha256} = pg_catalog.sha256(${t.artifactBytes})
      )`,
    ),
    check(
      "commercial_document_render_job_shape_ck",
      sql`case ${t.status}
        when 'requested' then
          ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
          and ${t.finishedAt} is null and ${t.errorCode} is null
          and ${t.errorRetryable} is null and ${t.artifactBytes} is null
        when 'queued' then
          ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
          and ${t.finishedAt} is null and ${t.errorCode} is null
          and ${t.errorRetryable} is null and ${t.artifactBytes} is null
        when 'running' then
          ${t.leaseToken} is not null and ${t.leaseExpiresAt} is not null
          and ${t.startedAt} is not null and ${t.finishedAt} is null
          and ${t.errorCode} is null and ${t.errorRetryable} is null
          and ${t.artifactBytes} is null
        when 'retry_wait' then
          ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
          and ${t.startedAt} is not null and ${t.finishedAt} is null
          and ${t.errorCode} is not null and ${t.errorRetryable} = true
          and ${t.artifactBytes} is null
        when 'succeeded' then
          ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
          and ${t.startedAt} is not null and ${t.finishedAt} is not null
          and ${t.errorCode} is null and ${t.errorRetryable} is null
          and ${t.artifactBytes} is not null
        when 'failed_final' then
          ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
          and ${t.startedAt} is not null and ${t.finishedAt} is not null
          and ${t.errorCode} is not null and ${t.errorRetryable} = false
          and ${t.artifactBytes} is null
        else false end`,
    ),
    check(
      "commercial_document_render_job_template_ck",
      sql`${t.templateVersion} in ('invoice-pdf-template.v1', 'invoice-payment-template.v1', 'draft-pdf-template.v1')`,
    ),
    check(
      "commercial_document_render_job_recipe_ck",
      sql`${t.rendererRecipe} in ('invoice-pdf-renderer-recipe.v1', 'invoice-payment-renderer-recipe.v1', 'draft-pdf-renderer-recipe.v1')`,
    ),
    check(
      "commercial_document_render_job_pair_ck",
      sql`((${t.templateVersion} = 'invoice-pdf-template.v1') and (${t.rendererRecipe} = 'invoice-pdf-renderer-recipe.v1')) or ((${t.templateVersion} = 'invoice-payment-template.v1') and (${t.rendererRecipe} = 'invoice-payment-renderer-recipe.v1')) or ((${t.templateVersion} = 'draft-pdf-template.v1') and (${t.rendererRecipe} = 'draft-pdf-renderer-recipe.v1'))`,
    ),
    check(
      "commercial_document_render_job_input_ck",
      sql`jsonb_typeof(${t.inputJson}) = 'object'`,
    ),
    check(
      "commercial_document_render_job_sha_ck",
      sql`octet_length(${t.inputSha256}) = 32`,
    ),
  ],
);

// F8-19 · Versand-Nachweis: welche versiegelten PDF-Bytes (Invoice,
// optional Payment) wurden versendet. Append-only (kein Update-Pfad
// im Service, UNIQUE faengt parallele Versuche als conflict).
export const commercialDocumentDelivery = pgTable(
  "commercial_document_delivery",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    documentId: uuid("document_id").notNull(),
    channel: text("channel").notNull(),
    invoiceJobId: uuid("invoice_job_id").notNull(),
    invoiceArtifactSha256: bytea("invoice_artifact_sha256").notNull(),
    paymentJobId: uuid("payment_job_id"),
    paymentArtifactSha256: bytea("payment_artifact_sha256"),
    sentBy: uuid("sent_by").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("commercial_document_delivery_ws_id_uq").on(t.workspaceId, t.id),
    unique("commercial_document_delivery_ws_doc_uq").on(
      t.workspaceId,
      t.documentId,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "commercial_document_delivery_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [commercialDocument.workspaceId, commercialDocument.id],
      name: "commercial_document_delivery_document_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.invoiceJobId],
      foreignColumns: [
        commercialDocumentRenderJob.workspaceId,
        commercialDocumentRenderJob.id,
      ],
      name: "commercial_document_delivery_invoice_job_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.paymentJobId],
      foreignColumns: [
        commercialDocumentRenderJob.workspaceId,
        commercialDocumentRenderJob.id,
      ],
      name: "commercial_document_delivery_payment_job_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.sentBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "commercial_document_delivery_sent_by_fk",
    }),
    index("commercial_document_delivery_ws_doc_idx").on(
      t.workspaceId,
      t.documentId,
    ),
    check(
      "commercial_document_delivery_channel_ck",
      sql`${t.channel} in ('manual')`,
    ),
    check(
      "commercial_document_delivery_sha_ck",
      sql`octet_length(${t.invoiceArtifactSha256}) = 32 and (${t.paymentArtifactSha256} is null or octet_length(${t.paymentArtifactSha256}) = 32)`,
    ),
    check(
      "commercial_document_delivery_payment_ck",
      sql`(${t.paymentJobId} is null) = (${t.paymentArtifactSha256} is null)`,
    ),
  ],
);

// F8-21 · Accounting-Sync-Satz je (Beleg, Vendor): State-Machine
// queued → exported → acknowledged | failed, Payload-Hash als
// Idempotenz- und Drift-Anker. Keine Secrets in der Zeile.
export const accountingSyncRecord = pgTable(
  "accounting_sync_record",
  {
    id: uuid("id").notNull().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    documentId: uuid("document_id").notNull(),
    vendor: text("vendor").notNull(),
    state: text("state").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    externalId: text("external_id"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("accounting_sync_record_ws_id_uq").on(t.workspaceId, t.id),
    unique("accounting_sync_record_ws_doc_vendor_uq").on(
      t.workspaceId,
      t.documentId,
      t.vendor,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "accounting_sync_record_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.documentId],
      foreignColumns: [commercialDocument.workspaceId, commercialDocument.id],
      name: "accounting_sync_record_document_fk",
    }),
    index("accounting_sync_record_ws_doc_idx").on(
      t.workspaceId,
      t.documentId,
    ),
    check(
      "accounting_sync_record_vendor_ck",
      sql`${t.vendor} in ('lexoffice', 'sevdesk', 'bexio')`,
    ),
    check(
      "accounting_sync_record_state_ck",
      sql`${t.state} in ('queued', 'exported', 'acknowledged', 'failed')`,
    ),
    check(
      "accounting_sync_record_sha_ck",
      sql`${t.payloadSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "accounting_sync_record_external_ck",
      sql`${t.externalId} is null or char_length(${t.externalId}) <= 200`,
    ),
    check(
      "accounting_sync_record_attempts_ck",
      sql`${t.attempts} >= 0`,
    ),
    check(
      "accounting_sync_record_error_ck",
      sql`${t.lastError} is null or char_length(${t.lastError}) <= 500`,
    ),
  ],
);
