// F8-21 Accounting-Sync: vendor-neutrale Export-Payload v1 + JCS/SHA-Seal +
// Per-Vendor-Mapper (lexoffice/sevdesk/bexio) + Sync-State-Machine.
// Reine Funktionen, kein IO, keine Secrets (Muster buildDatevBatchCsv).

import { createHash } from "node:crypto";
import { z } from "zod";

export const ACCOUNTING_EXPORT_VERSION = "accounting-export.v1" as const;
export const ACCOUNTING_CANONICALIZATION_VERSION = "accounting-jcs.v1" as const;
export const ACCOUNTING_SYNC_COMMAND_VERSION = "accounting-sync-command.v1" as const;
export const ACCOUNTING_SYNC_VERSION = "accounting-sync.v1" as const;
export const ACCOUNTING_SYNC_LIST_VERSION = "accounting-sync-list.v1" as const;

export const accountingVendors = ["lexoffice", "sevdesk", "bexio"] as const;
export type AccountingVendor = (typeof accountingVendors)[number];

export const accountingSyncStates = ["queued", "exported", "acknowledged", "failed"] as const;
export type AccountingSyncState = (typeof accountingSyncStates)[number];

export const accountingDocumentKinds = ["invoice", "credit_note"] as const;
export type AccountingDocumentKind = (typeof accountingDocumentKinds)[number];

export type AccountingExportErrorCode = "scope" | "booking" | "sums" | "payload" | "vendor";

export class AccountingExportError extends Error {
  readonly code: AccountingExportErrorCode;
  constructor(code: AccountingExportErrorCode, detail: string) {
    super(`accounting-export:${code}: ${detail}`);
    this.name = "AccountingExportError";
    this.code = code;
  }
}

export class AccountingSyncTransitionError extends Error {
  readonly from: AccountingSyncState;
  readonly to: AccountingSyncState;
  constructor(from: AccountingSyncState, to: AccountingSyncState) {
    super(`accounting-sync: illegaler Uebergang ${from} -> ${to}`);
    this.name = "AccountingSyncTransitionError";
    this.from = from;
    this.to = to;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

// Produkt-legal sind nur 0 % und 19 % (Spiegel service.ts-Steuersätze);
// alles andere verweigert fail-closed statt krummer Vendor-Payloads.
const ALLOWED_TAX_RATES_BPS = new Set([0, 1900]);

export type AccountingDocumentLineInput = {
  taxRateBps: number;
  netCents: number;
  taxCents: number;
  grossCents: number;
};

// Absichtlich weite Eingabetypen (string statt Literal): Scope-Verstöße
// (Entwurf, Fremdwährung, Fremdtyp) sind Laufzeitfälle und werden
// fail-closed validiert, nicht per Typ ausgeschlossen.
export type AccountingDocumentInput = {
  kind: string;
  status: string;
  number: string;
  issueDate: string;
  contactName: string;
  currency: string;
  lines: AccountingDocumentLineInput[];
  netCents: number;
  taxCents: number;
  grossCents: number;
};

function fail(code: AccountingExportErrorCode, detail: string): never {
  throw new AccountingExportError(code, detail);
}

const moneyCentsSchema = z.number().int().min(0);

const accountingExportLineSchema = z.strictObject({
  position: z.number().int().min(1),
  taxRateBps: z.union([z.literal(0), z.literal(1900)]),
  // 0-%-Zeilen sind erlaubt (DECIDED) und explizit markiert.
  zeroRated: z.boolean(),
  netCents: moneyCentsSchema,
  taxCents: moneyCentsSchema,
  grossCents: moneyCentsSchema,
}).superRefine((line, context) => {
  if (line.zeroRated !== (line.taxRateBps === 0)) {
    context.addIssue({
      code: "custom",
      path: ["zeroRated"],
      message: "zeroRated muss taxRateBps 0 entsprechen.",
    });
  }
  if (line.grossCents !== line.netCents + line.taxCents) {
    context.addIssue({
      code: "custom",
      path: ["grossCents"],
      message: "Brutto muss der Summe aus Netto und Steuer entsprechen.",
    });
  }
});

const accountingExportTotalsSchema = z.strictObject({
  netCents: moneyCentsSchema,
  taxCents: moneyCentsSchema,
  grossCents: moneyCentsSchema,
}).superRefine((totals, context) => {
  if (totals.grossCents !== totals.netCents + totals.taxCents) {
    context.addIssue({
      code: "custom",
      path: ["grossCents"],
      message: "Brutto muss der Summe aus Netto und Steuer entsprechen.",
    });
  }
});

export const accountingExportPayloadV1Schema = z.strictObject({
  schemaVersion: z.literal(ACCOUNTING_EXPORT_VERSION),
  canonicalizationVersion: z.literal(ACCOUNTING_CANONICALIZATION_VERSION),
  kind: z.enum(accountingDocumentKinds),
  number: z.string().min(1).max(64),
  issueDate: z.string().regex(ISO_DATE),
  // "" = kontaktloser Beleg (Muster F8-11-Buchungstext); Belegnummer
  // bleibt die eindeutige Referenz.
  contactName: z.string().max(200),
  currency: z.literal("EUR"),
  lines: z.array(accountingExportLineSchema).min(1),
  totals: accountingExportTotalsSchema,
}).superRefine((payload, context) => {
  for (const [index, line] of payload.lines.entries()) {
    if (line.position !== index + 1) {
      context.addIssue({
        code: "custom",
        path: ["lines", index, "position"],
        message: "Positionen muessen lueckenlos ab 1 sortiert sein.",
      });
    }
  }
  const net = payload.lines.reduce((sum, line) => sum + line.netCents, 0);
  const tax = payload.lines.reduce((sum, line) => sum + line.taxCents, 0);
  if (net !== payload.totals.netCents || tax !== payload.totals.taxCents) {
    context.addIssue({
      code: "custom",
      path: ["totals"],
      message: "Kopf-Summen muessen der Zeilensumme entsprechen.",
    });
  }
});

export type AccountingExportPayload = z.infer<typeof accountingExportPayloadV1Schema>;

function normalizeContactName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").slice(0, 200);
}

export function buildAccountingExportPayload(
  doc: AccountingDocumentInput,
): AccountingExportPayload {
  const label = doc.number.trim() === "" ? "Beleg ohne Nummer" : `Beleg ${doc.number.trim()}`;
  if (doc.kind !== "invoice" && doc.kind !== "credit_note") {
    fail("scope", `${label}: nur invoice/credit_note werden exportiert`);
  }
  if (doc.status !== "issued") {
    fail("scope", `${label}: nur ausgestellte Belege (issued) werden exportiert`);
  }
  if (doc.currency !== "EUR") {
    fail("scope", `${label}: nur EUR wird exportiert`);
  }
  if (doc.number.trim() === "") fail("booking", "Belegnummer fehlt");
  if (!ISO_DATE.test(doc.issueDate)) fail("booking", `${label}: Ausstelldatum fehlt`);

  let lines = doc.lines;
  if (lines.length === 0) {
    // Kopf-only-Belege wie F8-11: exakt-19-%-Kopf (ganzzahliger Quotient)
    // wird als EINE 19-%-Zeile exportiert, alles andere fail-closed.
    const ratioExact = doc.netCents > 0 && doc.taxCents * 100 === 19 * doc.netCents;
    if (!ratioExact) {
      fail("booking", `${label}: keine Positionen und kein exakt-19-%-Kopf`);
    }
    lines = [{
      taxRateBps: 1900,
      netCents: doc.netCents,
      taxCents: doc.taxCents,
      grossCents: doc.grossCents,
    }];
  }

  for (const line of lines) {
    if (!ALLOWED_TAX_RATES_BPS.has(line.taxRateBps)) {
      fail("booking", `${label}: nur 0-%/19-%-Zeilen werden exportiert`);
    }
    for (const [field, value] of [
      ["net", line.netCents],
      ["tax", line.taxCents],
      ["gross", line.grossCents],
    ] as const) {
      if (!Number.isInteger(value) || value < 0) {
        fail("booking", `${label}: ${field} ungueltig`);
      }
    }
    if (line.grossCents !== line.netCents + line.taxCents) {
      fail("sums", `${label}: Zeilensumme krumm`);
    }
  }

  const net = lines.reduce((sum, line) => sum + line.netCents, 0);
  const tax = lines.reduce((sum, line) => sum + line.taxCents, 0);
  if (net !== doc.netCents || tax !== doc.taxCents) {
    fail("sums", `${label}: Kopf-Netto/Steuer passt nicht zu den Zeilen`);
  }
  if (doc.grossCents !== doc.netCents + doc.taxCents) {
    fail("sums", `${label}: Brutto ungleich Netto + Steuer`);
  }

  const parsed = accountingExportPayloadV1Schema.safeParse({
    schemaVersion: ACCOUNTING_EXPORT_VERSION,
    canonicalizationVersion: ACCOUNTING_CANONICALIZATION_VERSION,
    kind: doc.kind,
    number: doc.number.trim(),
    issueDate: doc.issueDate,
    contactName: normalizeContactName(doc.contactName),
    currency: "EUR",
    lines: lines.map((line, index) => ({
      position: index + 1,
      taxRateBps: line.taxRateBps,
      zeroRated: line.taxRateBps === 0,
      netCents: line.netCents,
      taxCents: line.taxCents,
      grossCents: line.grossCents,
    })),
    totals: { netCents: doc.netCents, taxCents: doc.taxCents, grossCents: doc.grossCents },
  });
  if (!parsed.success) {
    fail("booking", `${label}: ${parsed.error.issues[0]?.message ?? "ungueltig"}`);
  }
  return parsed.data;
}

// ── JCS/SHA-Seal (M3-02b-Spiegel: sichere Ganzzahlen, NFC, sortierte Keys) ──

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

function hasWellFormedUnicode(value: string): boolean {
  if (value.includes("\0")) return false;
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

function normalizeCanonicalValue(value: unknown, seen: Set<object>): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new TypeError("Accounting-JSON erlaubt nur sichere Ganzzahlen.");
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") {
    if (!hasWellFormedUnicode(value)) {
      throw new TypeError("Ungepaartes Unicode-Surrogat im Accounting-JSON.");
    }
    return value.normalize("NFC");
  }
  if (typeof value !== "object") {
    throw new TypeError("Nicht persistierbarer Wert im Accounting-JSON.");
  }
  if (seen.has(value)) throw new TypeError("Zyklus im Accounting-JSON.");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => normalizeCanonicalValue(entry, seen));
    }
    const result: Record<string, JsonValue> = {};
    for (const [rawKey, entry] of Object.entries(value)) {
      if (!hasWellFormedUnicode(rawKey)) {
        throw new TypeError("Ungepaartes Unicode-Surrogat im Accounting-JSON-Schluessel.");
      }
      const key = rawKey.normalize("NFC");
      if (Object.hasOwn(result, key)) {
        throw new TypeError("Kollidierende normalisierte Accounting-JSON-Schluessel.");
      }
      result[key] = normalizeCanonicalValue(entry, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function canonicalizeAccountingJson(value: unknown): string {
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

export function hashAccountingExportPayload(payload: unknown): string {
  const parsed = accountingExportPayloadV1Schema.safeParse(payload);
  if (!parsed.success) {
    throw new TypeError("Nur valide Accounting-Payloads sind hashbar.");
  }
  return createHash("sha256").update(canonicalizeAccountingJson(parsed.data), "utf8").digest("hex");
}

// Replay-/Drift-Check: true, wenn der aktuelle Belegstand vom
// versiegelten Sync-Satz abweicht.
export function isAccountingPayloadDrifted(storedSha256: string, payload: unknown): boolean {
  return hashAccountingExportPayload(payload) !== storedSha256;
}

// ── Vendor-Mapper (ESTIMATE-Feldprofile, rein, ohne Netzwerk/Secrets) ──

function requireValidPayload(payload: unknown): AccountingExportPayload {
  const parsed = accountingExportPayloadV1Schema.safeParse(payload);
  if (!parsed.success) {
    fail("payload", "Vendor-Mapping nur aus valider Neutral-Payload");
  }
  return parsed.data;
}

// Beträge in Dezimal-Euro (2 Stellen) + parallel Cent-Integer
// (Toleranz gegen Rundungsprofile der Vendor-APIs).
export type AccountingVendorAmount = { cents: number; euros: string };

function vendorAmount(cents: number): AccountingVendorAmount {
  return { cents, euros: (cents / 100).toFixed(2) };
}

function taxRatePercent(taxRateBps: number): 0 | 19 {
  return taxRateBps === 0 ? 0 : 19;
}

export type LexofficeVoucher = {
  vendorApi: "lexoffice-estimate.v1";
  voucherType: "salesinvoice" | "salescreditnote";
  voucherNumber: string;
  voucherDate: string;
  contactName: string;
  currency: "EUR";
  lineItems: Array<{
    position: number;
    name: string;
    quantity: number;
    unitName: string;
    taxRatePercent: 0 | 19;
    net: AccountingVendorAmount;
    tax: AccountingVendorAmount;
    gross: AccountingVendorAmount;
  }>;
  totalNet: AccountingVendorAmount;
  totalTax: AccountingVendorAmount;
  totalGross: AccountingVendorAmount;
};

export function toLexofficeVoucher(payload: unknown): LexofficeVoucher {
  const valid = requireValidPayload(payload);
  return {
    vendorApi: "lexoffice-estimate.v1",
    voucherType: valid.kind === "invoice" ? "salesinvoice" : "salescreditnote",
    voucherNumber: valid.number,
    voucherDate: valid.issueDate,
    contactName: valid.contactName,
    currency: "EUR",
    lineItems: valid.lines.map((line) => ({
      position: line.position,
      name: `Belegposition ${line.position}`,
      quantity: 1,
      unitName: "Stueck",
      taxRatePercent: taxRatePercent(line.taxRateBps),
      net: vendorAmount(line.netCents),
      tax: vendorAmount(line.taxCents),
      gross: vendorAmount(line.grossCents),
    })),
    totalNet: vendorAmount(valid.totals.netCents),
    totalTax: vendorAmount(valid.totals.taxCents),
    totalGross: vendorAmount(valid.totals.grossCents),
  };
}

export type SevDeskVoucher = {
  vendorApi: "sevdesk-estimate.v1";
  objectName: "Invoice";
  invoiceType: "RE" | "CN";
  invoiceNumber: string;
  invoiceDate: string;
  contactName: string;
  currency: "EUR";
  positions: Array<{
    position: number;
    text: string;
    quantity: number;
    taxRatePercent: 0 | 19;
    net: AccountingVendorAmount;
    tax: AccountingVendorAmount;
    gross: AccountingVendorAmount;
  }>;
  totalNet: AccountingVendorAmount;
  totalTax: AccountingVendorAmount;
  totalGross: AccountingVendorAmount;
};

export function toSevDeskVoucher(payload: unknown): SevDeskVoucher {
  const valid = requireValidPayload(payload);
  return {
    vendorApi: "sevdesk-estimate.v1",
    objectName: "Invoice",
    invoiceType: valid.kind === "invoice" ? "RE" : "CN",
    invoiceNumber: valid.number,
    invoiceDate: valid.issueDate,
    contactName: valid.contactName,
    currency: "EUR",
    positions: valid.lines.map((line) => ({
      position: line.position,
      text: `Belegposition ${line.position}`,
      quantity: 1,
      taxRatePercent: taxRatePercent(line.taxRateBps),
      net: vendorAmount(line.netCents),
      tax: vendorAmount(line.taxCents),
      gross: vendorAmount(line.grossCents),
    })),
    totalNet: vendorAmount(valid.totals.netCents),
    totalTax: vendorAmount(valid.totals.taxCents),
    totalGross: vendorAmount(valid.totals.grossCents),
  };
}

export type BexioEntry = {
  vendorApi: "bexio-estimate.v1";
  title: string;
  contactName: string;
  currency: "EUR";
  documentNumber: string;
  documentDate: string;
  positions: Array<{
    position: number;
    text: string;
    amount: number;
    taxRatePercent: 0 | 19;
    net: AccountingVendorAmount;
    tax: AccountingVendorAmount;
    gross: AccountingVendorAmount;
  }>;
  totalNet: AccountingVendorAmount;
  totalTax: AccountingVendorAmount;
  totalGross: AccountingVendorAmount;
};

export function toBexioEntry(payload: unknown): BexioEntry {
  const valid = requireValidPayload(payload);
  const label = valid.kind === "invoice" ? "Rechnung" : "Gutschrift";
  return {
    vendorApi: "bexio-estimate.v1",
    title: `${label} ${valid.number}`,
    contactName: valid.contactName,
    currency: "EUR",
    documentNumber: valid.number,
    documentDate: valid.issueDate,
    positions: valid.lines.map((line) => ({
      position: line.position,
      text: `Belegposition ${line.position}`,
      amount: 1,
      taxRatePercent: taxRatePercent(line.taxRateBps),
      net: vendorAmount(line.netCents),
      tax: vendorAmount(line.taxCents),
      gross: vendorAmount(line.grossCents),
    })),
    totalNet: vendorAmount(valid.totals.netCents),
    totalTax: vendorAmount(valid.totals.taxCents),
    totalGross: vendorAmount(valid.totals.grossCents),
  };
}

export type AccountingVendorPayload = LexofficeVoucher | SevDeskVoucher | BexioEntry;

export function toVendorPayload(vendor: string, payload: unknown): AccountingVendorPayload {
  if (vendor === "lexoffice") return toLexofficeVoucher(payload);
  if (vendor === "sevdesk") return toSevDeskVoucher(payload);
  if (vendor === "bexio") return toBexioEntry(payload);
  fail("vendor", `unbekannter Vendor: ${vendor}`);
}

// ── Sync-State-Machine: queued → exported → acknowledged, Fehler → failed ──

export const ACCOUNTING_SYNC_TRANSITIONS: Record<
  AccountingSyncState,
  readonly AccountingSyncState[]
> = {
  queued: ["exported", "failed"],
  exported: ["acknowledged", "failed"],
  // Retry nur über Re-Queue; acknowledged ist terminal.
  failed: ["queued"],
  acknowledged: [],
};

export function assertAccountingSyncTransition(
  from: AccountingSyncState,
  to: AccountingSyncState,
): void {
  if (!ACCOUNTING_SYNC_TRANSITIONS[from].includes(to)) {
    throw new AccountingSyncTransitionError(from, to);
  }
}

// ── Sync-Satz-DTOs (nur Vendor + external_id, nie Secrets) ──

export const accountingSyncV1Schema = z.strictObject({
  schemaVersion: z.literal(ACCOUNTING_SYNC_VERSION),
  documentId: z.string().uuid(),
  vendor: z.enum(accountingVendors),
  state: z.enum(accountingSyncStates),
  payloadSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  externalId: z.string().max(200).nullable(),
  attempts: z.number().int().min(0),
  lastError: z.string().max(500).nullable(),
  updatedAt: z.iso.datetime({ offset: true }),
});
export type AccountingSyncV1 = z.infer<typeof accountingSyncV1Schema>;

export const accountingSyncCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(ACCOUNTING_SYNC_COMMAND_VERSION),
  documentId: z.string().uuid(),
  vendor: z.enum(accountingVendors),
});
export type AccountingSyncCommandV1 = z.infer<typeof accountingSyncCommandV1Schema>;

export const accountingSyncListV1Schema = z.strictObject({
  schemaVersion: z.literal(ACCOUNTING_SYNC_LIST_VERSION),
  syncs: z.array(accountingSyncV1Schema),
});
export type AccountingSyncListV1 = z.infer<typeof accountingSyncListV1Schema>;
