import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { workspace } from "./core";

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
