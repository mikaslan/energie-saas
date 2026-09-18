import { createHash } from "node:crypto";
import { z } from "zod";
import { isValidIban, validateEpcPayload } from "./epc-contract";
import {
  commercialRecipientSnapshotV1Schema,
  companyCountries,
  INVOICING_SETTINGS_MAX_REVISION,
  MAX_DOCUMENT_LINE_POSITION,
  MAX_DOCUMENT_MONEY_CENTS,
  MAX_DOCUMENT_QUANTITY_MILLI,
  type CommercialRecipientSnapshotV1,
} from "./contract";

// M3-02b: Render-Input-Vertrag Rechnungs-PDF (Spiegel M2-02).
export const INVOICE_PDF_INPUT_VERSION = "invoice-pdf-input.v1" as const;
export const INVOICE_PDF_TEMPLATE_VERSION = "invoice-pdf-template.v1" as const;
// Eigene Kanonisierungs-Version (kein GoBD-Import): ein GoBD-Bump darf
// versiegelte PDF-Inputs nicht still re-versionieren.
export const INVOICE_PDF_CANONICALIZATION_VERSION = "invoice-pdf-jcs.v1" as const;
// ESTIMATE: Rezept-Name gepinnt; Container-Digest-Pinning folgt in M3-02c
// mit dem echten Renderer-Rezept (kein fabrizierter Digest).
export const INVOICE_PDF_RENDERER_RECIPE_VERSION =
  "invoice-pdf-renderer-recipe.v1" as const;

const moneyCentsSchema = z.number().int().min(0).max(MAX_DOCUMENT_MONEY_CENTS);
const linePositionSchema = z.number().int().min(1).max(MAX_DOCUMENT_LINE_POSITION);
const settingsRevisionSchema = z.number().int().min(1).max(INVOICING_SETTINGS_MAX_REVISION);

function hasWellFormedUnicode(value: string): boolean {
  if (value.includes("\u0000")) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

// M3-02a-Semantik: NFC + Space-Trim (kein Voll-Trim), Codepoint-Zaehung.
function snapshotNormalize(value: string): string {
  return value.normalize("NFC").replace(/^ +| +$/gu, "");
}

function snapshotCodePoints(value: string): number {
  return Array.from(value).length;
}

function normalizedRequiredText(maxLength: number) {
  return z.string().superRefine((value, context) => {
    if (!hasWellFormedUnicode(value)) {
      context.addIssue({ code: "custom", message: "Text enthaelt ungueltiges Unicode." });
      return;
    }
    const normalized = snapshotNormalize(value);
    const length = snapshotCodePoints(normalized);
    if (length < 1 || length > maxLength) {
      context.addIssue({
        code: "custom",
        message: `Text muss 1 bis ${maxLength} Zeichen lang sein.`,
      });
    }
  }).transform((value) => snapshotNormalize(value));
}

// M3-02a-Semantik: leere/whitespace-only Texte koerzieren zu null
// (kein False-Reject), sonst NFC + Space-Trim wie required.
function normalizedOptionalText(maxLength: number) {
  return z.string().nullable().superRefine((value, context) => {
    if (value === null) return;
    if (!hasWellFormedUnicode(value)) {
      context.addIssue({ code: "custom", message: "Text enthaelt ungueltiges Unicode." });
      return;
    }
    if (snapshotCodePoints(snapshotNormalize(value)) > maxLength) {
      context.addIssue({
        code: "custom",
        message: `Text muss hoechstens ${maxLength} Zeichen lang sein.`,
      });
    }
  }).transform((value) => {
    if (value === null) return null;
    const normalized = snapshotNormalize(value);
    return normalized.length === 0 ? null : normalized;
  });
}

const utcDateTimeSchema = z.iso.datetime({ offset: true }).regex(/Z$/u);
const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const unitSchema = z.enum(["piece", "set", "meter"]);
const invoiceKindSchema = z.enum(["anzahlung", "abschlag", "teilrechnung", "schlussrechnung"]);
const creditNoteTypeSchema = z.enum(["minderleistung", "empfehlungspraemie"]);

const pdfLineSchema = z.strictObject({
  position: linePositionSchema,
  title: normalizedRequiredText(300),
  quantityMilli: z.number().int().min(1).max(MAX_DOCUMENT_QUANTITY_MILLI),
  unit: unitSchema,
  netCents: moneyCentsSchema,
  taxCents: moneyCentsSchema,
  grossCents: moneyCentsSchema,
  taxRateBps: z.union([z.literal(0), z.literal(1900)]),
}).superRefine((line, context) => {
  if (BigInt(line.netCents) + BigInt(line.taxCents) !== BigInt(line.grossCents)) {
    context.addIssue({
      code: "custom",
      path: ["grossCents"],
      message: "Brutto muss der Summe aus Netto und Steuer entsprechen.",
    });
  }
});

const pdfDocumentSchema = z.strictObject({
  type: z.enum(["invoice", "credit_note"]),
  invoiceKind: invoiceKindSchema.nullable(),
  creditNoteType: creditNoteTypeSchema.nullable(),
  number: normalizedRequiredText(64),
  numberYear: z.number().int().min(2000).max(2100),
  numberSequence: z.number().int().min(1),
  issuedAt: utcDateTimeSchema,
  dueDate: isoDateSchema.nullable(),
  serviceDate: isoDateSchema.nullable(),
  skontoPercentBps: z.number().int().min(0).max(10_000).nullable(),
  skontoDays: z.number().int().min(0).max(365).nullable(),
}).superRefine((document, context) => {
  if (document.type === "invoice" && document.creditNoteType !== null) {
    context.addIssue({
      code: "custom",
      path: ["creditNoteType"],
      message: "Gutschrift-Typ nur bei credit_note.",
    });
  }
  if (document.type === "credit_note" && document.invoiceKind !== null) {
    context.addIssue({
      code: "custom",
      path: ["invoiceKind"],
      message: "Rechnungsart-Kennung nur bei invoice.",
    });
  }
});

const pdfSenderSchema = z.strictObject({
  companyName: normalizedRequiredText(160),
  companyEmail: normalizedRequiredText(254),
  companyAuthority: normalizedOptionalText(80),
  companyRegisterNumber: normalizedOptionalText(64),
  companyTaxId: normalizedOptionalText(64),
  companyAddressLine1: normalizedRequiredText(160),
  companyAddressLine2: normalizedOptionalText(160),
  companyPostalCode: normalizedRequiredText(20),
  companyCity: normalizedRequiredText(120),
  companyCountry: z.enum(companyCountries),
  paymentAccountHolder: normalizedOptionalText(160),
  paymentIban: normalizedOptionalText(34),
  paymentBic: normalizedOptionalText(11),
  settingsRevision: settingsRevisionSchema,
}).superRefine((sender, context) => {
  const payment = [sender.paymentAccountHolder, sender.paymentIban, sender.paymentBic];
  const filled = payment.filter((field) => field !== null).length;
  if (filled !== 0 && filled !== 3) {
    context.addIssue({
      code: "custom",
      path: ["paymentAccountHolder"],
      message: "Zahlungsverbindung gemeinsam null oder vollstaendig.",
    });
  }
});

const pdfTotalsSchema = z.strictObject({
  netCents: moneyCentsSchema,
  taxCents: moneyCentsSchema,
  grossCents: moneyCentsSchema,
}).superRefine((totals, context) => {
  if (BigInt(totals.netCents) + BigInt(totals.taxCents) !== BigInt(totals.grossCents)) {
    context.addIssue({
      code: "custom",
      path: ["grossCents"],
      message: "Brutto muss der Summe aus Netto und Steuer entsprechen.",
    });
  }
});

export const invoicePdfInputV1Schema = z.strictObject({
  schemaVersion: z.literal(INVOICE_PDF_INPUT_VERSION),
  canonicalizationVersion: z.literal(INVOICE_PDF_CANONICALIZATION_VERSION),
  templateVersion: z.literal(INVOICE_PDF_TEMPLATE_VERSION),
  rendererRecipeVersion: z.literal(INVOICE_PDF_RENDERER_RECIPE_VERSION),
  preparedAt: utcDateTimeSchema,
  document: pdfDocumentSchema,
  recipient: commercialRecipientSnapshotV1Schema,
  sender: pdfSenderSchema,
  lines: z.array(pdfLineSchema).min(1).max(MAX_DOCUMENT_LINE_POSITION),
  totals: pdfTotalsSchema,
}).superRefine((input, context) => {
  for (const [index, line] of input.lines.entries()) {
    if (line.position !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["lines", index, "position"],
        message: "Positionen muessen lueckenlos ab 1 sortiert sein.",
      });
    }
  }
  let net = BigInt(0);
  let tax = BigInt(0);
  let gross = BigInt(0);
  for (const line of input.lines) {
    net += BigInt(line.netCents);
    tax += BigInt(line.taxCents);
    gross += BigInt(line.grossCents);
  }
  if (
    net !== BigInt(input.totals.netCents)
    || tax !== BigInt(input.totals.taxCents)
    || gross !== BigInt(input.totals.grossCents)
  ) {
    context.addIssue({
      code: "custom",
      path: ["totals"],
      message: "Kopf-Summen muessen der Zeilensumme entsprechen.",
    });
  }
});

export type InvoicePdfInputV1 = z.infer<typeof invoicePdfInputV1Schema>;

export type InvoicePdfContractResult =
  | { ok: true; value: InvoicePdfInputV1 }
  | { ok: false; error: string };

export interface BuildInvoicePdfInputOptions {
  document: unknown;
  recipient: unknown;
  sender: unknown;
  lines: unknown;
  headTotals: { netCents: number; taxCents: number; grossCents: number };
  preparedAt: string;
}

export function validateInvoicePdfInput(value: unknown): InvoicePdfContractResult {
  const parsed = invoicePdfInputV1Schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Ungueltiger Render-Input." };
  }
  return { ok: true, value: parsed.data };
}

export function buildInvoicePdfInput(options: BuildInvoicePdfInputOptions): InvoicePdfContractResult {
  // Strikte Allowlist: nur bekannte Bau-Schluessel, keine Leak-Weitergabe.
  const allowed = new Set([
    "document", "recipient", "sender", "lines", "headTotals", "preparedAt",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      return { ok: false, error: `Unbekanntes Bau-Feld: ${key}.` };
    }
  }
  return validateInvoicePdfInput({
    schemaVersion: INVOICE_PDF_INPUT_VERSION,
    canonicalizationVersion: INVOICE_PDF_CANONICALIZATION_VERSION,
    templateVersion: INVOICE_PDF_TEMPLATE_VERSION,
    rendererRecipeVersion: INVOICE_PDF_RENDERER_RECIPE_VERSION,
    preparedAt: options.preparedAt,
    document: options.document,
    recipient: options.recipient,
    sender: options.sender,
    lines: options.lines,
    totals: options.headTotals,
  });
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function normalizeCanonicalValue(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Invoice-JSON erlaubt nur sichere Ganzzahlen.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (!hasWellFormedUnicode(value)) {
      throw new TypeError("Ungepaartes Unicode-Surrogat im Invoice-JSON.");
    }
    return value.normalize("NFC");
  }
  if (typeof value !== "object") {
    throw new TypeError("Nicht persistierbarer Wert im Invoice-JSON.");
  }
  if (seen.has(value)) throw new TypeError("Zyklus im Invoice-JSON.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeCanonicalValue(entry, seen));
    }
    const result: Record<string, JsonValue> = {};
    for (const [rawKey, entry] of Object.entries(value)) {
      if (!hasWellFormedUnicode(rawKey)) {
        throw new TypeError("Ungepaartes Unicode-Surrogat im Invoice-JSON-Schluessel.");
      }
      const key = rawKey.normalize("NFC");
      if (Object.hasOwn(result, key)) {
        throw new TypeError("Kollidierende normalisierte Invoice-JSON-Schluessel.");
      }
      result[key] = normalizeCanonicalValue(entry, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** Gepinnte RFC-8785/JCS-Teilmenge fuer sichere Ganzzahlen plus NFC (M2-02-Spiegel). */
export function canonicalizeInvoiceJson(value: unknown): string {
  const normalized = normalizeCanonicalValue(value, new Set());
  const serialize = (current: JsonValue): string => {
    if (current === null || typeof current !== "object") {
      return JSON.stringify(current);
    }
    if (Array.isArray(current)) {
      return `[${current.map(serialize).join(",")}]`;
    }
    const keys = Object.keys(current).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(current[key]!)}`).join(",")}}`;
  };
  return serialize(normalized);
}

export function hashInvoicePdfInput(value: unknown): string {
  const parsed = invoicePdfInputV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError("Nur valide Render-Inputs sind hashbar.");
  }
  return createHash("sha256").update(canonicalizeInvoiceJson(parsed.data), "utf8").digest("hex");
}

// F8-17: Zahlungsbeleg-Input (zweite Template-Spur, gleiche Kanonisierung).
export const INVOICE_PAYMENT_INPUT_VERSION = "invoice-payment-input.v1" as const;
export const INVOICE_PAYMENT_TEMPLATE_VERSION = "invoice-payment-template.v1" as const;
export const INVOICE_PAYMENT_RENDERER_RECIPE_VERSION =
  "invoice-payment-renderer-recipe.v1" as const;

const paymentCreditorSchema = z.strictObject({
  name: z.string().min(1).max(70),
  iban: z.string().refine(isValidIban, "IBAN-Pruefziffern ungueltig"),
  bic: z.string().refine(
    (bic) => bic === "" || /^[A-Z0-9]{8}([A-Z0-9]{3})?$/u.test(bic),
    "BIC-Format ungueltig",
  ),
});

const paymentReferenceSchema = z.string().regex(/^RF[0-9]{2}[A-Z0-9]{1,21}$/u);

export const invoicePaymentInputV1Schema = z.strictObject({
  schemaVersion: z.literal(INVOICE_PAYMENT_INPUT_VERSION),
  canonicalizationVersion: z.literal(INVOICE_PDF_CANONICALIZATION_VERSION),
  templateVersion: z.literal(INVOICE_PAYMENT_TEMPLATE_VERSION),
  rendererRecipeVersion: z.literal(INVOICE_PAYMENT_RENDERER_RECIPE_VERSION),
  preparedAt: utcDateTimeSchema,
  creditor: paymentCreditorSchema,
  amountCents: z.number().int().min(1).max(99999999999),
  currency: z.literal("EUR"),
  reference: paymentReferenceSchema,
  documentNumber: z.string().min(1).max(64),
  epcPayload: z.string().min(1),
}).superRefine((input, context) => {
  // Versiegelte Konsistenz: eingebetteter EPC-Payload muss exakt zu den
  // Feldern passen (kein Drift zwischen Anzeige und QR).
  const validated = validateEpcPayload(input.epcPayload);
  if (!validated.ok) {
    context.addIssue({ code: "custom", path: ["epcPayload"], message: "EPC-Payload ungueltig." });
    return;
  }
  const lines = validated.value.split("\n");
  const [, , , , bic, name, iban, amount, , reference] = lines;
  const euros = Math.floor(input.amountCents / 100);
  const cents = String(input.amountCents % 100).padStart(2, "0");
  if (
    bic !== input.creditor.bic
    || name !== input.creditor.name
    || iban !== input.creditor.iban
    || amount !== `EUR${euros}.${cents}`
    || reference !== input.reference
  ) {
    context.addIssue({
      code: "custom",
      path: ["epcPayload"],
      message: "EPC-Payload stimmt nicht mit den Zahlungsfeldern ueberein.",
    });
  }
});

export type InvoicePaymentInputV1 = z.infer<typeof invoicePaymentInputV1Schema>;

export type InvoicePaymentContractResult =
  | { ok: true; value: InvoicePaymentInputV1 }
  | { ok: false; error: string };

export interface BuildInvoicePaymentInputOptions {
  creditor: unknown;
  amountCents: number;
  reference: string;
  documentNumber: string;
  epcPayload: string;
  preparedAt: string;
}

export function validateInvoicePaymentInput(value: unknown): InvoicePaymentContractResult {
  const parsed = invoicePaymentInputV1Schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Ungueltiger Payment-Input." };
  }
  return { ok: true, value: parsed.data };
}

export function buildInvoicePaymentInput(
  options: BuildInvoicePaymentInputOptions,
): InvoicePaymentContractResult {
  const allowed = new Set([
    "creditor", "amountCents", "reference", "documentNumber", "epcPayload", "preparedAt",
  ]);
  for (const key of Object.keys(options)) {
    if (!allowed.has(key)) {
      return { ok: false, error: `Unbekanntes Bau-Feld: ${key}.` };
    }
  }
  return validateInvoicePaymentInput({
    schemaVersion: INVOICE_PAYMENT_INPUT_VERSION,
    canonicalizationVersion: INVOICE_PDF_CANONICALIZATION_VERSION,
    templateVersion: INVOICE_PAYMENT_TEMPLATE_VERSION,
    rendererRecipeVersion: INVOICE_PAYMENT_RENDERER_RECIPE_VERSION,
    preparedAt: options.preparedAt,
    creditor: options.creditor,
    amountCents: options.amountCents,
    currency: "EUR",
    reference: options.reference,
    documentNumber: options.documentNumber,
    epcPayload: options.epcPayload,
  });
}

export function hashInvoicePaymentInput(value: unknown): string {
  const parsed = invoicePaymentInputV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError("Nur valide Payment-Inputs sind hashbar.");
  }
  return createHash("sha256").update(canonicalizeInvoiceJson(parsed.data), "utf8").digest("hex");
}

export type { CommercialRecipientSnapshotV1 };
