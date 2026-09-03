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
