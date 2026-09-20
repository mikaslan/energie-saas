// F8-20 Monats-ZIP: summary.csv + Rechnungs-PDFs (reiner, deterministischer Builder).
// Muster: datev-export.ts (cell-Guard/Quoting, Sortierung, Byte-Determinismus),
// Beträge maschinenlesbar mit Punkt-Dezimal wie die Berichte-CSV.

import { unzipSync, zipSync } from "fflate";

export type MonthSummaryKind = "invoice" | "credit_note";

export type MonthSummaryRowInput = {
  docId: string;
  kind: MonthSummaryKind;
  number: string;
  issueDate: string;
  contactName: string;
  netCents: number;
  taxCents: number;
  grossCents: number;
  // Leere Strings bei fehlendem/korruptem PDF (ehrlich partiell, kein Abbruch).
  pdfFile: string;
  pdfSha256: string;
};

export type MonatsZipPdfInput = {
  fileName: string;
  bytes: Uint8Array;
};

export type MonatsZipInput = {
  month: string;
  summary: string;
  pdfs: MonatsZipPdfInput[];
};

export const MONATS_ZIP_CONTENT_TYPE = "application/zip" as const;
export const MONATS_ZIP_MAX_DOCUMENTS = 500 as const;
export const MONATS_ZIP_MAX_UNCOMPRESSED_BYTES = 67_108_864 as const;

export const MONTH_SUMMARY_HEADER = [
  "typ",
  "nummer",
  "ausstellungsdatum",
  "kontakt",
  "netto",
  "steuer",
  "brutto",
  "pdf_datei",
  "pdf_sha256",
] as const;

export type MonatsZipErrorCode = "scope" | "row" | "limit" | "zip";

export class MonatsZipError extends Error {
  readonly code: MonatsZipErrorCode;
  constructor(code: MonatsZipErrorCode, detail: string) {
    super(`monats-zip:${code}: ${detail}`);
    this.name = "MonatsZipError";
    this.code = code;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SAFE_PDF_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.pdf$/u;

function fail(code: MonatsZipErrorCode, detail: string): never {
  throw new MonatsZipError(code, detail);
}

// EXTF-Spiegel (datev-export.ts cell()): Formula-Guard + RFC-4180-Quoting.
function cell(value: string): string {
  const guarded = /^[=+\-@]/u.test(value) ? `'${value}` : value;
  if (/[";\r\n]/u.test(guarded)) {
    return `"${guarded.replace(/"/gu, '""')}"`;
  }
  return guarded;
}

// Berichte-CSV-Konvention: Punkt-Dezimal, 2 Stellen, maschinenlesbar.
function euros(cents: number): string {
  return (cents / 100).toFixed(2);
}

function checkRow(row: MonthSummaryRowInput): void {
  if (row.kind !== "invoice" && row.kind !== "credit_note") {
    fail("row", `Beleg ${row.docId}: Typ ungültig`);
  }
  if (!ISO_DATE.test(row.issueDate)) {
    fail("row", `Beleg ${row.docId}: Ausstelldatum ungültig`);
  }
  for (const [field, value] of [
    ["netto", row.netCents],
    ["steuer", row.taxCents],
    ["brutto", row.grossCents],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail("row", `Beleg ${row.docId}: ${field} ungültig`);
    }
  }
  // Keine Steuer-Validierung (Spec Nicht-Umfang): der ZIP stellt nur aus,
  // was `issued` ist — Summen werden nicht gegengeprüft.
  if (row.pdfFile === "" || row.pdfSha256 === "") {
    if (row.pdfFile !== "" || row.pdfSha256 !== "") {
      fail("row", `Beleg ${row.docId}: pdf_datei/pdf_sha256 nur gemeinsam`);
    }
  } else {
    if (!SAFE_PDF_FILE.test(row.pdfFile)) {
      fail("row", `Beleg ${row.docId}: pdf_datei unsicher`);
    }
    if (!SHA256_HEX.test(row.pdfSha256)) {
      fail("row", `Beleg ${row.docId}: pdf_sha256 ungültig`);
    }
  }
}

function summaryRow(row: MonthSummaryRowInput): string {
  return [
    row.kind,
    row.number,
    row.issueDate,
    row.contactName,
    euros(row.netCents),
    euros(row.taxCents),
    euros(row.grossCents),
    row.pdfFile,
    row.pdfSha256,
  ].map(cell).join(";");
}

export function buildMonthSummaryCsv(rows: MonthSummaryRowInput[]): string {
  if (rows.length > MONATS_ZIP_MAX_DOCUMENTS) {
    fail("limit", `mehr als ${MONATS_ZIP_MAX_DOCUMENTS} Belege`);
  }
  for (const row of rows) checkRow(row);
  const ordered = [...rows].sort((a, b) =>
    a.issueDate < b.issueDate ? -1 : a.issueDate > b.issueDate ? 1 : a.docId < b.docId ? -1 : 1,
  );
  const lines = [MONTH_SUMMARY_HEADER.join(";")];
  for (const row of ordered) lines.push(summaryRow(row));
  return `${lines.join("\r\n")}\r\n`;
}

export function monatsZipFileName(month: string): string {
  if (!MONTH.test(month)) fail("scope", "Monat ungültig");
  return `monatsunterlagen-${month}.zip`;
}

export function buildMonatsZip(input: MonatsZipInput): Buffer {
  if (!MONTH.test(input.month)) fail("scope", "Monat ungültig");
  if (input.pdfs.length > MONATS_ZIP_MAX_DOCUMENTS) {
    fail("limit", `mehr als ${MONATS_ZIP_MAX_DOCUMENTS} PDFs`);
  }
  const seen = new Set<string>();
  for (const pdf of input.pdfs) {
    if (!SAFE_PDF_FILE.test(pdf.fileName)) fail("zip", `PDF-Dateiname unsicher: ${pdf.fileName}`);
    if (seen.has(pdf.fileName)) fail("zip", `PDF-Dateiname doppelt: ${pdf.fileName}`);
    seen.add(pdf.fileName);
  }
  const summaryBytes = Buffer.from(input.summary, "utf8");
  let uncompressed = summaryBytes.byteLength;
  for (const pdf of input.pdfs) uncompressed += pdf.bytes.byteLength;
  if (uncompressed > MONATS_ZIP_MAX_UNCOMPRESSED_BYTES) {
    fail("limit", "ZIP größer als 64 MB unkomprimiert");
  }

  // Feste mtime (Monatserster, UTC) für Byte-Determinismus; stabile
  // Eintragsreihenfolge: summary.csv zuerst, dann PDFs nach Dateiname.
  const [year, monthPart] = input.month.split("-").map(Number);
  const mtime = new Date(Date.UTC(year, monthPart - 1, 1, 0, 0, 0));
  const ordered = [...input.pdfs].sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
  const files: Record<string, Uint8Array> = {
    "summary.csv": summaryBytes,
  };
  for (const pdf of ordered) files[`pdfs/${pdf.fileName}`] = pdf.bytes;
  return Buffer.from(zipSync(files, { mtime }));
}

export function parseMonatsZip(bytes: Uint8Array): Record<string, Uint8Array> {
  const entries = unzipSync(bytes);
  const out: Record<string, Uint8Array> = {};
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    out[name] = data as Uint8Array;
  }
  return out;
}
