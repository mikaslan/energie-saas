import { z } from "zod";

export const WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION =
  "workspace-invoicing-settings-command.v1" as const;
export const WORKSPACE_INVOICING_SETTINGS_VERSION =
  "workspace-invoicing-settings.v1" as const;
export const WORKSPACE_DOCUMENT_NUMBER_FORMAT_COMMAND_VERSION =
  "workspace-document-number-format-command.v1" as const;
export const WORKSPACE_DOCUMENT_NUMBER_FORMAT_LIST_VERSION =
  "workspace-document-number-format-list.v1" as const;
export const INVOICING_SETTINGS_MAX_REVISION = 2_147_483_647 as const;
export const GOEBD_RETENTION_DEFAULT_DAYS = 3650 as const;

export const companyCountries = ["DE", "AT", "CH", "FR", "UK", "JE"] as const;
export type CompanyCountry = (typeof companyCountries)[number];

export const accountingMethods = ["accrual", "cash"] as const;
export type AccountingMethod = (typeof accountingMethods)[number];

export const documentNumberTypes = [
  "invoice",
  "credit_note",
  "order_confirmation",
  "purchase_order",
  "delivery_note",
  "letter",
] as const;
export type DocumentNumberType = (typeof documentNumberTypes)[number];

// OBSERVED-Defaults (Spec §4 / DECIDED 4): funktionale Platzhalter-Schemata mit
// generischen Fachbegriffen, keine Reonic-Textübernahme. Idempotentes Seeding
// beim ersten Zugriff (Spec §4, Kimi-P1-3).
export const DOCUMENT_NUMBER_FORMAT_DEFAULTS: Record<DocumentNumberType, string> = {
  invoice: "Rechnung-{YEAR}-{MONTH}-{NUMBER}",
  credit_note: "CRN-{YEAR}-{MONTH}-{DAY}-{NUMBER}",
  order_confirmation: "OFC-{YEAR}-{MONTH}-{DAY}-{NUMBER}",
  purchase_order: "PO-{YEAR}-{MONTH}-{DAY}-{NUMBER}",
  delivery_note: "DN-{YEAR}-{MONTH}-{DAY}-{NUMBER}",
  letter: "LE-{YEAR}-{MONTH}-{DAY}-{NUMBER}",
};

const revisionSchema = z.number().int().min(0).max(INVOICING_SETTINGS_MAX_REVISION);
const positiveRevisionSchema = z.number().int().min(1).max(INVOICING_SETTINGS_MAX_REVISION);

const companyNameSchema = z.string().trim().min(1).max(160).refine(
  (value) => value.trim().length >= 1,
  "company name must not be blank",
);
const companyEmailSchema = z.string().trim().min(3).max(254).superRefine((value, ctx) => {
  if (!/^[^@\s]+@[^@\s]+$/u.test(value)) {
    ctx.addIssue({ code: "custom", message: "company email has invalid form" });
  }
});
const optionalText = (max: number) =>
  z.string().trim().min(1).max(max).nullable();
const requiredText = (max: number) =>
  z.string().trim().min(1).max(max);
const companyCountrySchema = z.enum(companyCountries);
const accountingMethodSchema = z.enum(accountingMethods);
const documentNumberTypeSchema = z.enum(documentNumberTypes);

// MOD-97-Prüfung (Spec §3, DECIDED): nur die Prüfsumme, die länderspezifische
// Länge (15–34) wird zusätzlich über die DB-CHECK-Grenze abgesichert.
function isValidIbanChecksum(value: string): boolean {
  const normalized = value.replace(/[\s]/gu, "").toUpperCase();
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$/u.test(normalized)) return false;
  const rearranged = normalized.slice(4) + normalized.slice(0, 4);
  const digits = rearranged.replace(/[A-Z]/gu, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (let index = 0; index < digits.length; index += 1) {
    remainder = (remainder * 10 + Number(digits[index])) % 97;
  }
  return remainder === 1;
}

const paymentIbanSchema = z.string().trim().min(15).max(34).superRefine((value, ctx) => {
  if (!isValidIbanChecksum(value)) {
    ctx.addIssue({ code: "custom", message: "IBAN checksum is invalid" });
  }
});
const paymentBicSchema = z.string().trim().min(8).max(11).refine(
  (value) => value.length === 8 || value.length === 11,
  "BIC must be 8 or 11 characters",
);

// Zahlungsdaten gemeinsam null oder vollständig (Spec §4 CHECK). Der Zod-Test
// spiegelt den DB-CHECK wider und meldet Verletzungen als invalid.
const paymentFields = {
  paymentAccountHolder: optionalText(160),
  paymentIban: paymentIbanSchema.nullable(),
  paymentBic: paymentBicSchema.nullable(),
} as const;

const settingsEditableFields = {
  companyName: companyNameSchema,
  companyEmail: companyEmailSchema,
  companyAuthority: optionalText(80),
  companyRegisterNumber: optionalText(64),
  companyTaxId: optionalText(64),
  companyAddressLine1: requiredText(160),
  companyAddressLine2: optionalText(160),
  companyPostalCode: requiredText(20),
  companyCity: requiredText(120),
  companyCountry: companyCountrySchema,
  accountingMethod: accountingMethodSchema,
  ...paymentFields,
  goebdRetentionDefaultDays: z.number().int().min(1).max(36500),
} as const;

export const invoicingSettingsInputV1Schema = z.strictObject(settingsEditableFields).superRefine(
  (value, ctx) => {
    const paymentPresent = [
      value.paymentAccountHolder,
      value.paymentIban,
      value.paymentBic,
    ];
    const nullCount = paymentPresent.filter((field) => field === null).length;
    if (nullCount !== 0 && nullCount !== 3) {
      ctx.addIssue({
        code: "custom",
        path: ["paymentIban"],
        message: "payment fields must be complete or all null",
      });
    }
  },
);

export type InvoicingSettingsInputV1 = z.infer<typeof invoicingSettingsInputV1Schema>;

export const invoicingSettingsCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION),
  // 0 = Insert erwartet (keine Zeile); >= 1 = CAS-Update gegen baseRevision.
  baseRevision: revisionSchema,
  input: invoicingSettingsInputV1Schema,
});
export type InvoicingSettingsCommandV1 = z.infer<typeof invoicingSettingsCommandV1Schema>;

// DTO-Minimierung (Spec §5/DECIDED 6): companyTaxId und paymentIban werden
// nur bei invoicing.issuing_details.write ausgeliefert, sonst null.
export const invoicingSettingsV1Schema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_INVOICING_SETTINGS_VERSION),
  revision: positiveRevisionSchema,
  companyName: companyNameSchema,
  companyEmail: companyEmailSchema,
  companyAuthority: optionalText(80),
  companyRegisterNumber: optionalText(64),
  companyTaxId: optionalText(64),
  companyAddressLine1: z.string().min(1).max(160),
  companyAddressLine2: optionalText(160),
  companyPostalCode: z.string().min(1).max(20),
  companyCity: z.string().min(1).max(120),
  companyCountry: companyCountrySchema,
  accountingMethod: accountingMethodSchema,
  paymentAccountHolder: optionalText(160),
  paymentIban: paymentIbanSchema.nullable(),
  paymentBic: paymentBicSchema.nullable(),
  goebdRetentionDefaultDays: z.number().int().min(1).max(36500),
  permissions: z.strictObject({
    canWrite: z.boolean(),
    canWriteIssuingDetails: z.boolean(),
  }),
});
export type InvoicingSettingsV1 = z.infer<typeof invoicingSettingsV1Schema>;

// Format-Template: {NUMBER} Pflicht, Datums-Platzhalter höchstens einmal,
// keine unbekannten {…}-Token (Spec §3 M300-02).
export const numberFormatTemplateSchema = z.string().min(1).max(120).superRefine(
  (value, ctx) => {
    const placeholders: string[] = value.match(/\{[^}]*\}/gu) ?? [];
    const allowed = new Set(["{YEAR}", "{MONTH}", "{DAY}", "{NUMBER}"]);
    for (const placeholder of placeholders) {
      if (!allowed.has(placeholder)) {
        ctx.addIssue({ code: "custom", message: `unknown placeholder ${placeholder}` });
      }
    }
    if (!placeholders.includes("{NUMBER}")) {
      ctx.addIssue({ code: "custom", message: "{NUMBER} is required" });
    }
    for (const placeholder of ["{YEAR}", "{MONTH}", "{DAY}"]) {
      if (placeholders.filter((value) => value === placeholder).length > 1) {
        ctx.addIssue({ code: "custom", message: `duplicate ${placeholder}` });
      }
    }
  },
);

export const numberFormatCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_DOCUMENT_NUMBER_FORMAT_COMMAND_VERSION),
  type: documentNumberTypeSchema,
  formatTemplate: numberFormatTemplateSchema,
});
export type NumberFormatCommandV1 = z.infer<typeof numberFormatCommandV1Schema>;

export const numberFormatItemV1Schema = z.strictObject({
  type: documentNumberTypeSchema,
  formatTemplate: z.string().min(1).max(120),
  counter: z.number().int().nonnegative(),
});
export type NumberFormatItemV1 = z.infer<typeof numberFormatItemV1Schema>;

export const numberFormatListV1Schema = z.strictObject({
  schemaVersion: z.literal(WORKSPACE_DOCUMENT_NUMBER_FORMAT_LIST_VERSION),
  formats: z.array(numberFormatItemV1Schema),
  permissions: z.strictObject({ canWrite: z.boolean() }),
});
export type NumberFormatListV1 = z.infer<typeof numberFormatListV1Schema>;

export const invoicingErrorCodeSchema = z.enum([
  "invalid",
  "not_found",
  "conflict",
  "precondition_conflict",
  "denied",
  "unauthenticated",
]);

// ═══════════════════════════════════════════════════════════════════════
// M3-01 · Rechnungs-/Dokument-Kern (F8, ADR 0023). Additiv zum M3-00-Vertrag.
// ═══════════════════════════════════════════════════════════════════════

export const COMMERCIAL_DOCUMENT_GROUP_VERSION =
  "commercial-document-group.v1" as const;
export const COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION =
  "commercial-document-group-command.v1" as const;
export const COMMERCIAL_DOCUMENT_COMMAND_VERSION =
  "commercial-document-command.v1" as const;
export const COMMERCIAL_DOCUMENT_SENT_COMMAND_VERSION =
  "commercial-document-sent-command.v1" as const;
export const COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION =
  "commercial-document-void-command.v1" as const;
export const COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION =
  "commercial-document-payment-command.v1" as const;
export const COMMERCIAL_DOCUMENT_PAYMENT_STATUS_COMMAND_VERSION =
  "commercial-document-payment-status-command.v1" as const;
export const COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION =
  "commercial-document-issue-command.v1" as const;
export const COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION =
  "commercial-document-line-command.v1" as const;
export const COMMERCIAL_DOCUMENT_VERSION = "commercial-document.v1" as const;
export const COMMERCIAL_DOCUMENT_LINE_VERSION = "commercial-document-line.v1" as const;
export const COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION =
  "commercial-document-list-command.v1" as const;
export const COMMERCIAL_DOCUMENT_LIST_VERSION =
  "commercial-document-list.v1" as const;
export const INVOICING_REPORT_COMMAND_VERSION = "invoicing-report-command.v1" as const;
export const INVOICING_REPORT_VERSION = "invoicing-report.v1" as const;
export const INVOICING_REPORT_CSV_VERSION = "invoicing-report-csv.v1" as const;

export const MAX_DOCUMENT_MONEY_CENTS = 9_000_000_000_000_000 as const;
export const MAX_DOCUMENT_QUANTITY_MILLI = 100_000_000 as const;
export const MAX_DOCUMENT_LINE_POSITION = 500 as const;
export const DOCUMENT_LIST_DEFAULT_LIMIT = 25 as const;
export const DOCUMENT_LIST_MAX_LIMIT = 100 as const;
export const INVOICING_REPORT_LATEST_DOCUMENTS = 10 as const;
export const GOEBD_SNAPSHOT_SCHEMA_VERSION = "document-snapshot.v1" as const;
export const GOEBD_SNAPSHOT_CANONICALIZATION_VERSION = "document-jcs.v1" as const;

// 6 Dokumenttypen (Spec §2/§4, ADR 0023). Der Diskriminator ist genau dieser
// Sechsersatz; die Gruppen-Übersicht ist kein eigener Typ.
export const commercialDocumentTypes = documentNumberTypes;
export type CommercialDocumentType = DocumentNumberType;

// DECIDED (Spec M301-03): „sent" ist eine BOOLESCHE ACHSE (sent_at), kein
// vierter Status. Status-Enum bleibt draft/issued/voided; void erfasst
// versendete Dokumente über status='issued' + sent_at gesetzt (Kimi-P1-1).
// DECIDED (Spec M301-04, Kimi-P1-2): Void ist unabhängig vom Zahlungsstatus
// erlaubt (Nummer bleibt verbrannt, Content eingefroren); eine bezahlte
// Rechnung wird NICHT durch Void rückabgewickelt — dafür ist die Gutschrift
// getrennt (Spec: „Gutschrift ist getrennt, nicht Teil von Void").
export const commercialDocumentStatuses = ["draft", "issued", "voided"] as const;
export type CommercialDocumentStatus = (typeof commercialDocumentStatuses)[number];

export const commercialPaymentStatuses = [
  "unpaid",
  "partially_paid",
  "paid",
  "overdue",
  "uncollectable",
] as const;
export type CommercialPaymentStatus = (typeof commercialPaymentStatuses)[number];

// Void-Grund-Festliste (M301-04, DECIDED eigene Werte; exakte Reonic-Liste UNKNOWN).
export const commercialVoidReasons = [
  "created_in_error",
  "duplicate",
  "superseded",
  "cancelled",
  "other",
] as const;
export type CommercialVoidReason = (typeof commercialVoidReasons)[number];

export const commercialLineUnits = ["piece", "set", "meter"] as const;
export type CommercialLineUnit = (typeof commercialLineUnits)[number];

// OBSERVED-Enum (M3-UNKNOWN-RECON §2): Minderleistung | Empfehlungsprämie.
export const commercialCreditNoteTypes = [
  "minderleistung",
  "empfehlungspraemie",
] as const;
export type CommercialCreditNoteType = (typeof commercialCreditNoteTypes)[number];

// Nummernserien-Defaults je Typ (Spec §6, OBSERVED-Templates). prefix/padding
// modellieren nur den {NUMBER}-Anteil; die vollständigen Datums-Platzhalter
// ({YEAR}/{MONTH}/{DAY}) liegen im M3-00-Format-Template.
export const COMMERCIAL_DOCUMENT_NUMBER_SERIES_DEFAULTS: Record<
  CommercialDocumentType,
  { prefix: string; padding: number }
> = {
  // Spec §6 DECIDED: <PREFIX>-<JJJJ>-<NNNNNN>, Padding 6; exakte Reonic-
  // Präfixe UNKNOWN — diese sind die spezifizierten Vorschlags-Präfixe.
  invoice: { prefix: "RE", padding: 6 },
  credit_note: { prefix: "GU", padding: 6 },
  order_confirmation: { prefix: "AB", padding: 6 },
  purchase_order: { prefix: "BE", padding: 6 },
  delivery_note: { prefix: "LS", padding: 6 },
  letter: { prefix: "BR", padding: 6 },
};

const commercialDocumentTypeSchema = z.enum(commercialDocumentTypes);
const commercialDocumentStatusSchema = z.enum(commercialDocumentStatuses);
const commercialPaymentStatusSchema = z.enum(commercialPaymentStatuses);
const commercialVoidReasonSchema = z.enum(commercialVoidReasons);
const commercialLineUnitSchema = z.enum(commercialLineUnits);
const commercialCreditNoteTypeSchema = z.enum(commercialCreditNoteTypes);

const groupNameSchema = z.string().trim().min(1).max(120).refine(
  (value) => value.trim().length >= 1,
  "group name must not be blank",
);

const documentNameSchema = z.string().trim().min(1).max(160).refine(
  (value) => value.trim().length >= 1,
  "document name must not be blank",
);

const moneyCentsSchema = z.number().int().min(0).max(MAX_DOCUMENT_MONEY_CENTS);
const quantityMilliSchema = z.number().int().min(1).max(MAX_DOCUMENT_QUANTITY_MILLI);
const taxRateBpsSchema = z.union([z.literal(0), z.literal(1900)]);
const optionalUuid = z.string().uuid().nullable();
const optionalDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable();

const documentDraftInputFields = {
  type: commercialDocumentTypeSchema,
  name: documentNameSchema,
  groupId: optionalUuid,
  projectId: optionalUuid,
  contactId: optionalUuid,
  dueDate: optionalDate,
  deliveryDate: optionalDate,
  validityDate: optionalDate,
  plannedDeliveryDate: optionalDate,
  plannedServiceDate: optionalDate,
  creditNoteType: commercialCreditNoteTypeSchema.nullable(),
} as const;

// Typ-bedingte Pflicht-Datumfelder (Spec §4/M301-01): je Typ die Spalten aus
// §7. Brief bleibt ohne Betrag und ohne Zahlungsachse, braucht aber Gültigkeit.
export const commercialDocumentDraftInputV1Schema = z
  .strictObject(documentDraftInputFields)
  .superRefine((value, ctx) => {
    const missing = (field: string) =>
      ctx.addIssue({
        code: "custom",
        path: [field],
        message: `${field} is required for type ${value.type}`,
      });
    switch (value.type) {
      case "invoice":
        if (value.dueDate === null) missing("dueDate");
        break;
      case "credit_note":
        if (value.deliveryDate === null) missing("deliveryDate");
        if (value.creditNoteType === null) missing("creditNoteType");
        break;
      case "order_confirmation":
        if (value.plannedDeliveryDate === null) missing("plannedDeliveryDate");
        if (value.plannedServiceDate === null) missing("plannedServiceDate");
        break;
      case "purchase_order":
        if (value.validityDate === null) missing("validityDate");
        break;
      case "delivery_note":
        if (value.deliveryDate === null) missing("deliveryDate");
        break;
      case "letter":
        if (value.validityDate === null) missing("validityDate");
        break;
    }
    if (value.creditNoteType !== null && value.type !== "credit_note") {
      ctx.addIssue({
        code: "custom",
        path: ["creditNoteType"],
        message: "creditNoteType is only valid for credit_note",
      });
    }
  });
export type CommercialDocumentDraftInputV1 = z.infer<
  typeof commercialDocumentDraftInputV1Schema
>;

export const commercialDocumentCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_COMMAND_VERSION),
  input: commercialDocumentDraftInputV1Schema,
});
export type CommercialDocumentCommandV1 = z.infer<typeof commercialDocumentCommandV1Schema>;

export const commercialDocumentSentCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_SENT_COMMAND_VERSION),
  documentId: z.string().uuid(),
});
export type CommercialDocumentSentCommandV1 = z.infer<
  typeof commercialDocumentSentCommandV1Schema
>;

export const commercialDocumentVoidCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_VOID_COMMAND_VERSION),
  documentId: z.string().uuid(),
  reason: commercialVoidReasonSchema,
});
export type CommercialDocumentVoidCommandV1 = z.infer<
  typeof commercialDocumentVoidCommandV1Schema
>;

export const commercialDocumentPaymentCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_PAYMENT_COMMAND_VERSION),
  documentId: z.string().uuid(),
  paidCents: moneyCentsSchema,
});
export type CommercialDocumentPaymentCommandV1 = z.infer<
  typeof commercialDocumentPaymentCommandV1Schema
>;

// DECIDED: setPaymentStatus darf nur die nicht ableitbaren Zustände setzen
// (overdue/uncollectable); paid/unpaid/partially_paid entstehen ausschließlich
// über recordPayment aus paid_cents (Ableitungsregel M301-05).
export const commercialDocumentPaymentStatusCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_PAYMENT_STATUS_COMMAND_VERSION),
  documentId: z.string().uuid(),
  status: z.enum(["overdue", "uncollectable"]),
});
export type CommercialDocumentPaymentStatusCommandV1 = z.infer<
  typeof commercialDocumentPaymentStatusCommandV1Schema
>;

// DECIDED (Kimi-P2-5): kein baseRevision im Issue-Kommando — die
// Nebenläufigkeitskontrolle ist das CAS `where status = 'draft'` auf der
// Dokumentzeile selbst (Transition ist idempotent-frei, genau ein Gewinner).
export const commercialDocumentIssueCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_ISSUE_COMMAND_VERSION),
  documentId: z.string().uuid(),
});
export type CommercialDocumentIssueCommandV1 = z.infer<
  typeof commercialDocumentIssueCommandV1Schema
>;

export const commercialDocumentGroupCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_GROUP_COMMAND_VERSION),
  name: groupNameSchema,
});
export type CommercialDocumentGroupCommandV1 = z.infer<
  typeof commercialDocumentGroupCommandV1Schema
>;

const lineInputFields = {
  position: z.number().int().min(1).max(MAX_DOCUMENT_LINE_POSITION),
  name: z.string().trim().min(1).max(300),
  quantityMilli: quantityMilliSchema,
  unit: commercialLineUnitSchema,
  netCents: moneyCentsSchema,
  taxRateBps: taxRateBpsSchema,
} as const;

export const commercialDocumentLineInputV1Schema = z.strictObject(lineInputFields);
export type CommercialDocumentLineInputV1 = z.infer<
  typeof commercialDocumentLineInputV1Schema
>;

export const commercialDocumentLineCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_LINE_COMMAND_VERSION),
  documentId: z.string().uuid(),
  input: commercialDocumentLineInputV1Schema,
});
export type CommercialDocumentLineCommandV1 = z.infer<
  typeof commercialDocumentLineCommandV1Schema
>;

export const commercialDocumentGroupV1Schema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_GROUP_VERSION),
  id: z.string().uuid(),
  name: groupNameSchema,
  projectId: optionalUuid,
  archivedAt: z.string().nullable(),
  documentCount: z.number().int().nonnegative(),
  permissions: z.strictObject({ canWrite: z.boolean() }),
});
export type CommercialDocumentGroupV1 = z.infer<typeof commercialDocumentGroupV1Schema>;

export const commercialDocumentLineV1Schema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_LINE_VERSION),
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  position: z.number().int().min(1).max(MAX_DOCUMENT_LINE_POSITION),
  name: z.string().min(1).max(300),
  quantityMilli: quantityMilliSchema,
  unit: commercialLineUnitSchema,
  netCents: moneyCentsSchema,
  taxCents: moneyCentsSchema,
  grossCents: moneyCentsSchema,
  taxRateBps: taxRateBpsSchema,
});
export type CommercialDocumentLineV1 = z.infer<typeof commercialDocumentLineV1Schema>;

export const commercialDocumentV1Schema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_VERSION),
  id: z.string().uuid(),
  type: commercialDocumentTypeSchema,
  status: commercialDocumentStatusSchema,
  name: documentNameSchema,
  groupId: optionalUuid,
  projectId: optionalUuid,
  contactId: optionalUuid,
  archivedAt: z.string().nullable(),
  netCents: moneyCentsSchema,
  taxCents: moneyCentsSchema,
  grossCents: moneyCentsSchema,
  paymentStatus: commercialPaymentStatusSchema.nullable(),
  dueDate: z.string().nullable(),
  deliveryDate: z.string().nullable(),
  validityDate: z.string().nullable(),
  plannedDeliveryDate: z.string().nullable(),
  plannedServiceDate: z.string().nullable(),
  creditNoteType: commercialCreditNoteTypeSchema.nullable(),
  number: z.string().nullable(),
  numberYear: z.number().int().nullable(),
  numberSequence: z.number().int().nullable(),
  issuedAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  voidedAt: z.string().nullable(),
  voidReason: commercialVoidReasonSchema.nullable(),
  paidCents: moneyCentsSchema.nullable(),
  permissions: z.strictObject({ canWrite: z.boolean() }),
});
export type CommercialDocumentV1 = z.infer<typeof commercialDocumentV1Schema>;

// ═══════════════════════════════════════════════════════════════════════
// M301-06 · Liste + Filter je Typ (Spec §7). Keyset-Cursor, Archiv-Achse,
// typ-gebundene Datums-/Zahlungs-/Gutschrift-Filter.
// ═══════════════════════════════════════════════════════════════════════

// Kimi-P2-1: nicht nur Form, sondern echtes Kalenderdatum — sonst liefe
// "2026-02-30" bis in den ::date-Cast und scheiterte dort mit rohem PG-Fehler.
const isoDateOnlySchema = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((value) => {
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
      && date.getUTCMonth() === month - 1
      && date.getUTCDate() === day;
  }, "must be a real calendar date");

export const commercialDocumentListFiltersV1Schema = z
  .strictObject({
    status: commercialDocumentStatusSchema.optional(),
    paymentStatus: z
      .enum(["unpaid", "partially_paid", "paid", "overdue", "uncollectable"])
      .optional(),
    issuedFrom: isoDateOnlySchema.optional(),
    issuedTo: isoDateOnlySchema.optional(),
    // Typ-gebundenes Datumsfeld: invoice → dueDate, credit_note → deliveryDate
    // (Spec §7 filtert nur diese beiden Typen über ihr Fach-Datum).
    typeDateFrom: isoDateOnlySchema.optional(),
    typeDateTo: isoDateOnlySchema.optional(),
    creditNoteType: commercialCreditNoteTypeSchema.optional(),
    archived: z.enum(["active", "archived", "all"]).optional(),
    search: z.string().trim().min(1).max(160).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.issuedFrom !== undefined && value.issuedTo !== undefined
      && value.issuedFrom > value.issuedTo) {
      ctx.addIssue({ code: "custom", path: ["issuedTo"], message: "issuedTo must be >= issuedFrom" });
    }
    if (value.typeDateFrom !== undefined && value.typeDateTo !== undefined
      && value.typeDateFrom > value.typeDateTo) {
      ctx.addIssue({ code: "custom", path: ["typeDateTo"], message: "typeDateTo must be >= typeDateFrom" });
    }
  });
export type CommercialDocumentListFiltersV1 = z.infer<
  typeof commercialDocumentListFiltersV1Schema
>;

export const commercialDocumentListCommandV1Schema = z
  .strictObject({
    schemaVersion: z.literal(COMMERCIAL_DOCUMENT_LIST_COMMAND_VERSION),
    type: commercialDocumentTypeSchema,
    filters: commercialDocumentListFiltersV1Schema.optional(),
    cursor: z.string().min(1).max(256).optional(),
    limit: z.number().int().min(1).max(DOCUMENT_LIST_MAX_LIMIT).optional(),
  })
  .superRefine((value, ctx) => {
    const filters = value.filters ?? {};
    const issue = (field: string, message: string) =>
      ctx.addIssue({ code: "custom", path: ["filters", field], message });
    // Typ-Scopes (Spec §7): Zahlungsachse nur Geld-Typen, Gutschrift-Typ nur
    // credit_note, Fach-Datumsfilter nur invoice/credit_note.
    if (filters.paymentStatus !== undefined && value.type === "letter") {
      issue("paymentStatus", "paymentStatus is only valid for money document types");
    }
    if (filters.creditNoteType !== undefined && value.type !== "credit_note") {
      issue("creditNoteType", "creditNoteType is only valid for credit_note");
    }
    if ((filters.typeDateFrom !== undefined || filters.typeDateTo !== undefined)
      && value.type !== "invoice" && value.type !== "credit_note") {
      issue("typeDateFrom", "typeDate is only valid for invoice and credit_note");
    }
  });
export type CommercialDocumentListCommandV1 = z.infer<
  typeof commercialDocumentListCommandV1Schema
>;

export const commercialDocumentListV1Schema = z.strictObject({
  schemaVersion: z.literal(COMMERCIAL_DOCUMENT_LIST_VERSION),
  type: commercialDocumentTypeSchema,
  items: z.array(commercialDocumentV1Schema),
  totalCount: z.number().int().nonnegative(),
  nextCursor: z.string().min(1).max(256).nullable(),
  permissions: z.strictObject({ canWrite: z.boolean() }),
});
export type CommercialDocumentListV1 = z.infer<typeof commercialDocumentListV1Schema>;

// ═══════════════════════════════════════════════════════════════════════
// M301-07 · Berichte (Spec §8). Kalendermonat Europe/Berlin; DECIDED-KPIs.
// ═══════════════════════════════════════════════════════════════════════

// Kalendermonat "YYYY-MM" im Wertebereich 2000-01 … 2099-12 (DECIDED).
export const invoicingReportMonthSchema = z
  .string()
  .trim()
  .regex(/^20\d{2}-(0[1-9]|1[0-2])$/u);

export const invoicingReportCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(INVOICING_REPORT_COMMAND_VERSION),
  month: invoicingReportMonthSchema,
});
export type InvoicingReportCommandV1 = z.infer<typeof invoicingReportCommandV1Schema>;

export const invoicingReportV1Schema = z.strictObject({
  schemaVersion: z.literal(INVOICING_REPORT_VERSION),
  month: invoicingReportMonthSchema,
  monthStart: isoDateOnlySchema,
  monthEnd: isoDateOnlySchema,
  revenueThisMonthCents: moneyCentsSchema,
  cashflowThisMonthCents: moneyCentsSchema,
  outstandingCents: moneyCentsSchema,
  overdueCents: moneyCentsSchema,
  // DECIDED: Vormonatsvergleich nur für die beiden Fluss-KPIs (Einnahmen,
  // Cashflow). Bestands-KPIs (ausstehend/überfällig) haben ohne Zahlungs-
  // Ledger keine historische Momentaufnahme → previous null = „Kein
  // Vormonat" (OBSERVED-Indikator, exakte Reonic-Semantik UNKNOWN).
  // Kimi-P2-2: previousMonth.month ist bewusst NICHT gegen die 20xx-Grenze
  // geprüft — für month = "2000-01" ist der Vormonat "1999-12".
  previousMonth: z.strictObject({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
    revenueCents: moneyCentsSchema,
    cashflowCents: moneyCentsSchema,
    outstandingCents: moneyCentsSchema.nullable(),
    overdueCents: moneyCentsSchema.nullable(),
  }),
  latestDocuments: z.array(commercialDocumentV1Schema).max(INVOICING_REPORT_LATEST_DOCUMENTS),
  // DECIDED (Spec §8, ESTIMATE): 5 disjunkte Lebenszyklus-Buckets, Partition
  // aller Dokumente: draft | voided | paid | overdue | sent(=issued, offen).
  // uncollectable fällt in keinen Bucket (exakte Reonic-Gruppierung UNKNOWN).
  revenueByStatus: z.strictObject({
    draftCents: moneyCentsSchema,
    sentCents: moneyCentsSchema,
    paidCents: moneyCentsSchema,
    overdueCents: moneyCentsSchema,
    voidedCents: moneyCentsSchema,
    draftCount: z.number().int().nonnegative(),
    sentCount: z.number().int().nonnegative(),
    paidCount: z.number().int().nonnegative(),
    overdueCount: z.number().int().nonnegative(),
    voidedCount: z.number().int().nonnegative(),
  }),
  // Überfälligkeitsreport: disjunkte Buckets nach Tagen seit Fälligkeit
  // (Europe/Berlin-Heute), kumulierte offene Beträge je Bucket;
  // totalOutstanding = „Insgesamt ausstehend" (alle offenen Dokumente).
  overdueBuckets: z.strictObject({
    days0To30Cents: moneyCentsSchema,
    days31To60Cents: moneyCentsSchema,
    days61To90Cents: moneyCentsSchema,
    over90Cents: moneyCentsSchema,
    totalOutstandingCents: moneyCentsSchema,
  }),
  permissions: z.strictObject({ canWrite: z.boolean() }),
});
export type InvoicingReportV1 = z.infer<typeof invoicingReportV1Schema>;

// CSV-Export (DECIDED §8): UTF-8, ";"-getrennt, ISO-8601-Daten, Euro-Dezimal
// mit 2 Nachkommastellen aus Cent, CRLF, RFC-4180-Quoting.
export const invoicingReportCsvV1Schema = z.strictObject({
  schemaVersion: z.literal(INVOICING_REPORT_CSV_VERSION),
  month: invoicingReportMonthSchema,
  fileName: z.string().min(1).max(120),
  contentType: z.literal("text/csv; charset=utf-8"),
  content: z.string(),
});
export type InvoicingReportCsvV1 = z.infer<typeof invoicingReportCsvV1Schema>;
