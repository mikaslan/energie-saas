// F1-02 Lead-Bulk-Import (F1-17: CSV + xlsx): mehrere manuelle Anfragen
// aus einer Datei anlegen — CSV (Semikolon oder Komma) oder xlsx (erstes
// Blatt) — inkl. Dry-Run-Prüfung. Berechtigung: bestehendes project.write
// (KEIN neuer Key).
//
// Architektur: Modulgrenzen (depcruise) — jede gültige Zeile läuft durch
// createManualLead (Dedupe, Intake-Lane, Audit, Events); die optionale
// Notiz schreibt NICHT dieser Service, sondern der injizierte writeNote-
// Callback der Server Action (gleiche Grenze wie F1-11). Qualifizierte
// Zeilen (residential + 4 Adresszellen) werden danach automatisch
// geocodiert (lead-bulk-geocode, fail-closed je Zeile, sequentiell, kein
// Retry — Commercial nie). Dry-Run legt alle Zeilen in einem SAVEPOINT an
// und rollt zurück: Validierung (inkl. Markdown-Vorabprüfung und
// Quellennamen) ohne Writes, Events, Audit oder Geocode-Calls.
// Nicht-atomar: gültige Zeilen werden angelegt, ungültige landen mit
// stabilen Fehlercodes im Bericht (kein stiller Drop).
import { sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { z } from "zod";
import type { TenantTx } from "@/lib/db/types";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { normalizeLeadSourceName } from "@/modules/lead-sources";
import {
  type BulkGeocodeDeps,
  geocodeBulkLeadSite,
  isBulkGeocodeQualified,
  type ManualLeadBulkGeocodeError,
} from "./lead-bulk-geocode";
import {
  createManualLead,
  ManualLeadLaneError,
  ManualLeadValidationError,
} from "./manual-lead-service";

export const MANUAL_LEAD_BULK_VERSION = 1;
export const MANUAL_LEAD_BULK_REPORT_VERSION = 2;
/** Reversibles ESTIMATE-Limit: max. Datenzeilen pro Datei (CSV + xlsx). */
export const MANUAL_LEAD_BULK_MAX_ROWS = 500;
/** Reversibles ESTIMATE-Limit: max. xlsx-Dateigröße in Bytes. */
export const MANUAL_LEAD_BULK_XLSX_MAX_BYTES = 5 * 1024 * 1024;
/** Reversibles ESTIMATE-Limit: max. xlsx-Spalten (Kopfbreite). */
export const MANUAL_LEAD_BULK_XLSX_MAX_COLUMNS = 10;
/** Reversibles ESTIMATE-Limit: max. Zeichen je xlsx-Kopfzelle. */
export const MANUAL_LEAD_BULK_XLSX_HEADER_MAX_CHARS = 100;
/** Reversibles ESTIMATE-Limit: max. Zeichen je xlsx-Datenzelle. */
export const MANUAL_LEAD_BULK_XLSX_CELL_MAX_CHARS = 2000;

export type ManualLeadBulkFileKind = "csv" | "xlsx";

export class ManualLeadBulkFileError extends Error {
  constructor(
    public readonly code:
      | "empty-file"
      | "no-delimiter"
      | "missing-name-column"
      | "unknown-column"
      | "duplicate-column"
      | "too-many-rows"
      | "too-large"
      | "too-many-columns"
      | "header-too-long"
      | "cell-too-long"
      | "invalid-xlsx",
    public readonly detail?: string,
  ) {
    super(`manual lead bulk file error: ${code}${detail ? ` (${detail})` : ""}`);
    this.name = "ManualLeadBulkFileError";
  }
}

export type ManualLeadBulkRowStatus = "created" | "valid" | "invalid" | "note-failed";

export type ManualLeadBulkRowError =
  | "missing-name"
  | "missing-contact"
  | "invalid-scope"
  | "unknown-source"
  | "invalid-row"
  | "lane-missing"
  | "note-denied"
  | "note-failed";

const manualLeadBulkGeocodeErrorSchema = z.enum([
  "no-candidate",
  "provider-error",
  "collision",
]);

const manualLeadBulkRowSchema = z.strictObject({
  line: z.number().int().positive(),
  displayName: z.string().nullable(),
  status: z.enum(["created", "valid", "invalid", "note-failed"]),
  projectId: z.string().nullable(),
  contactReused: z.boolean().nullable(),
  errors: z.array(
    z.enum([
      "missing-name",
      "missing-contact",
      "invalid-scope",
      "unknown-source",
      "invalid-row",
      "lane-missing",
      "note-denied",
      "note-failed",
    ]),
  ),
  // Report v2 (additiv): null = kein Versuch (Dry-Run, ungültige Zeile,
  // Commercial, unvollständige Adresse).
  geocoded: z.boolean().nullable(),
  geocodeError: manualLeadBulkGeocodeErrorSchema.nullable(),
});

export const manualLeadBulkReportSchema = z.strictObject({
  schemaVersion: z.literal(MANUAL_LEAD_BULK_REPORT_VERSION),
  dryRun: z.boolean(),
  defaultScope: z.enum(["residential", "commercial"]),
  totalRows: z.number().int().nonnegative(),
  createdCount: z.number().int().nonnegative(),
  reusedCount: z.number().int().nonnegative(),
  noteFailedProjectIds: z.array(z.string()),
  geocodedCount: z.number().int().nonnegative(),
  geocodeFailedCount: z.number().int().nonnegative(),
  rows: z.array(manualLeadBulkRowSchema),
});

export type ManualLeadBulkRow = z.infer<typeof manualLeadBulkRowSchema>;
export type ManualLeadBulkReport = z.infer<typeof manualLeadBulkReportSchema>;

function requireManualLeadBulkWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", "project", undefined, ctx.actor);
  }
}

type CanonicalColumn =
  | "displayName"
  | "email"
  | "phone"
  | "street"
  | "houseNumber"
  | "postalCode"
  | "city"
  | "scope"
  | "leadSourceName"
  | "note";

function normalizeHeaderCell(value: string): string {
  return value
    .replace(/^\uFEFF/, "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/gu, "");
}

const HEADER_ALIASES: Record<string, CanonicalColumn> = {
  name: "displayName",
  displayname: "displayName",
  kontaktname: "displayName",
  kundenname: "displayName",
  fullname: "displayName",
  vollername: "displayName",
  email: "email",
  telefon: "phone",
  telefonnummer: "phone",
  tel: "phone",
  phone: "phone",
  mobil: "phone",
  handy: "phone",
  mobile: "phone",
  strasse: "street",
  straße: "street",
  street: "street",
  hausnummer: "houseNumber",
  hausnr: "houseNumber",
  housenumber: "houseNumber",
  plz: "postalCode",
  postleitzahl: "postalCode",
  postalcode: "postalCode",
  ort: "city",
  stadt: "city",
  city: "city",
  bereich: "scope",
  scope: "scope",
  sparte: "scope",
  quelle: "leadSourceName",
  leadquelle: "leadSourceName",
  herkunft: "leadSourceName",
  leadsource: "leadSourceName",
  notiz: "note",
  notizen: "note",
  note: "note",
  bemerkung: "note",
  anmerkung: "note",
};

function detectDelimiter(headerLine: string): string {
  const semicolons = (headerLine.match(/;/g) ?? []).length;
  const commas = (headerLine.match(/,/g) ?? []).length;
  if (semicolons === 0 && commas === 0) {
    // Einspaltige Datei ohne Trennzeichen: nur lesbar, wenn die einzige
    // Kopfzelle ein bekannter Alias ist (z. B. nur „Name“).
    if (HEADER_ALIASES[normalizeHeaderCell(headerLine)] !== undefined) return "\u0000";
    throw new ManualLeadBulkFileError("no-delimiter");
  }
  return semicolons >= commas ? ";" : ",";
}

/**
 * Quote-aware Zeilensplit (RFC-4180-Kern: "..." mit ""-Escape).
 * Gibt null bei unterminiertem Quote zurück.
 */
function splitCsvLine(line: string, delimiter: string): string[] | null {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const char = line[i]!;
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        current += char;
        i += 1;
      }
    } else if (char === '"') {
      inQuotes = true;
      i += 1;
    } else if (char === delimiter) {
      fields.push(current.trim());
      current = "";
      i += 1;
    } else {
      current += char;
      i += 1;
    }
  }
  if (inQuotes) return null;
  fields.push(current.trim());
  return fields;
}

function parseScopeCell(
  raw: string | undefined,
  defaultScope: "residential" | "commercial",
): { scope: "residential" | "commercial" } | { error: ManualLeadBulkRowError } {
  if (raw === undefined || raw.trim() === "") return { scope: defaultScope };
  const normalized = raw.normalize("NFKC").trim().toLowerCase().replace(/[\s._-]+/gu, "");
  if (["residential", "privat", "wohnbau", "b2c", "wohnung"].includes(normalized)) {
    return { scope: "residential" };
  }
  if (["commercial", "gewerbe", "b2b"].includes(normalized)) {
    return { scope: "commercial" };
  }
  return { error: "invalid-scope" };
}

type ParsedBulkFile = {
  fileKind: ManualLeadBulkFileKind;
  columns: CanonicalColumn[];
  rows: Array<{ line: number; cells: Record<CanonicalColumn, string | undefined> }>;
};

function parseBulkCsv(csvText: string): ParsedBulkFile {
  const lines = csvText.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
  const nonEmpty = lines
    .map((text, index) => ({ text, line: index + 1 }))
    .filter(({ text }) => text.trim() !== "");
  if (nonEmpty.length === 0) throw new ManualLeadBulkFileError("empty-file");
  const header = nonEmpty[0]!;
  const delimiter = detectDelimiter(header.text);
  const headerCells = splitCsvLine(header.text, delimiter);
  if (headerCells === null) throw new ManualLeadBulkFileError("no-delimiter", "Kopfzeile");
  const columns = mapHeaderCells(headerCells);
  const rows = nonEmpty.slice(1).map(({ text, line }) => {
    const cells = splitCsvLine(text, delimiter) ?? [];
    const record = {} as Record<CanonicalColumn, string | undefined>;
    for (let index = 0; index < columns.length; index += 1) {
      const value = cells[index]?.trim() ?? "";
      record[columns[index]!] = value === "" ? undefined : value;
    }
    return { line, cells: record };
  });
  if (rows.length > MANUAL_LEAD_BULK_MAX_ROWS) {
    throw new ManualLeadBulkFileError("too-many-rows", `${rows.length}`);
  }
  if (rows.length === 0) throw new ManualLeadBulkFileError("empty-file");
  return { fileKind: "csv", columns, rows };
}

function mapHeaderCells(
  headerCells: string[],
): CanonicalColumn[] {
  const columns: CanonicalColumn[] = [];
  const seen = new Set<CanonicalColumn>();
  for (const cell of headerCells) {
    const normalized = normalizeHeaderCell(cell);
    const canonical = HEADER_ALIASES[normalized];
    if (!canonical) {
      throw new ManualLeadBulkFileError(
        "unknown-column",
        cell.trim() === "" ? "leere Spaltenüberschrift" : cell.trim(),
      );
    }
    if (seen.has(canonical)) {
      throw new ManualLeadBulkFileError("duplicate-column", cell.trim());
    }
    seen.add(canonical);
    columns.push(canonical);
  }
  if (!seen.has("displayName")) throw new ManualLeadBulkFileError("missing-name-column");
  return columns;
}

/**
 * Zelltext ohne Typ-Überraschungen: formatierte Anzeige (`w`) bevorzugen,
 * damit als Zahl gespeicherte Inhalte (Telefon, PLZ) ihre Darstellung
 * behalten; leer oder fehlend → undefined.
 */
function xlsxCellText(cell: XLSX.CellObject | undefined): string | undefined {
  if (!cell) return undefined;
  const raw = typeof cell.w === "string" ? cell.w : cell.v;
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw).trim();
  return text === "" ? undefined : text;
}

function parseBulkXlsx(bytes: Uint8Array): ParsedBulkFile {
  if (bytes.byteLength > MANUAL_LEAD_BULK_XLSX_MAX_BYTES) {
    throw new ManualLeadBulkFileError("too-large", `${bytes.byteLength}`);
  }
  if (bytes.byteLength === 0) throw new ManualLeadBulkFileError("empty-file");
  // xlsx ist ein ZIP-Container: ohne PK-Magie ist es garantiert kein xlsx
  // (der Parser selbst würde Text still als Blatt deuten).
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    throw new ManualLeadBulkFileError("invalid-xlsx");
  }
  let workbook: XLSX.WorkBook;
  try {
    // Nur erstes Blatt, nur lesend; sheetRows deckelt die Parser-Arbeit:
    // Kopf + alle Datenzeilen + eine Zeile Überlauf-Erkennung.
    workbook = XLSX.read(bytes, {
      type: "buffer",
      sheetRows: MANUAL_LEAD_BULK_MAX_ROWS + 2,
    });
  } catch {
    throw new ManualLeadBulkFileError("invalid-xlsx");
  }
  const firstName = workbook.SheetNames[0];
  const sheet = firstName === undefined ? undefined : workbook.Sheets[firstName];
  if (!sheet || typeof sheet["!ref"] !== "string") {
    throw new ManualLeadBulkFileError("empty-file");
  }
  const range = XLSX.utils.decode_range(sheet["!ref"]);

  const rawHeader: Array<string | undefined> = [];
  for (let c = range.s.c; c <= range.e.c; c += 1) {
    rawHeader.push(xlsxCellText(sheet[XLSX.utils.encode_cell({ r: range.s.r, c })]));
  }
  while (rawHeader.length > 0 && rawHeader[rawHeader.length - 1] === undefined) {
    rawHeader.pop();
  }
  if (rawHeader.length > MANUAL_LEAD_BULK_XLSX_MAX_COLUMNS) {
    throw new ManualLeadBulkFileError("too-many-columns", `${rawHeader.length}`);
  }
  const headerCells = rawHeader.map((cell) => {
    const text = cell ?? "";
    if (text.length > MANUAL_LEAD_BULK_XLSX_HEADER_MAX_CHARS) {
      throw new ManualLeadBulkFileError("header-too-long", text.slice(0, 50));
    }
    return text;
  });
  if (headerCells.length === 0) throw new ManualLeadBulkFileError("empty-file");
  const columns = mapHeaderCells(headerCells);

  const rows: ParsedBulkFile["rows"] = [];
  for (let r = range.s.r + 1; r <= range.e.r; r += 1) {
    const record = {} as Record<CanonicalColumn, string | undefined>;
    let hasCell = false;
    for (let index = 0; index < columns.length; index += 1) {
      const text = xlsxCellText(
        sheet[XLSX.utils.encode_cell({ r, c: range.s.c + index })],
      );
      if (text === undefined) continue;
      if (text.length > MANUAL_LEAD_BULK_XLSX_CELL_MAX_CHARS) {
        throw new ManualLeadBulkFileError("cell-too-long", `Zeile ${r + 1}`);
      }
      hasCell = true;
      record[columns[index]!] = text;
    }
    if (hasCell) rows.push({ line: r + 1, cells: record });
  }
  if (rows.length > MANUAL_LEAD_BULK_MAX_ROWS) {
    throw new ManualLeadBulkFileError("too-many-rows", `${rows.length}`);
  }
  if (rows.length === 0) throw new ManualLeadBulkFileError("empty-file");
  return { fileKind: "xlsx", columns, rows };
}

export async function importManualLeadBulk(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    fileKind?: ManualLeadBulkFileKind;
    csvText?: string;
    bytes?: Uint8Array;
    defaultScope: "residential" | "commercial";
    dryRun: boolean;
    writeNote?: (projectId: string, textMarkdown: string) => Promise<void>;
    geocode?: BulkGeocodeDeps;
  },
): Promise<ManualLeadBulkReport> {
  requireManualLeadBulkWrite(ctx);
  const fileKind = input.fileKind
    ?? (input.bytes !== undefined ? "xlsx" : "csv");
  const parsed = fileKind === "xlsx"
    ? parseBulkXlsx(input.bytes ?? new Uint8Array(0))
    : parseBulkCsv(input.csvText ?? "");

  // Quellennamen einmalig auflösen (nur aktive Quellen; Treffer per
  // normalisiertem Namen — gleiche Normalisierung wie F1-08).
  const wantedSourceNames = new Map<string, string>();
  for (const row of parsed.rows) {
    const raw = row.cells.leadSourceName;
    if (raw !== undefined) wantedSourceNames.set(normalizeLeadSourceName(raw), raw);
  }
  const sourceIdByNormalized = new Map<string, string>();
  if (wantedSourceNames.size > 0) {
    const names = [...wantedSourceNames.keys()];
    const found = await tx.execute<{ id: string; name_normalized: string }>(sql`
      select id, name_normalized
        from lead_source
       where workspace_id = ${ctx.workspaceId}::uuid
         and archived_at is null
         and name_normalized in (${sql.join(
           names.map((name) => sql`${name}::text`),
           sql`, `,
         )})
    `);
    for (const row of found.rows) sourceIdByNormalized.set(row.name_normalized, row.id);
  }

  const reportRows: ManualLeadBulkRow[] = [];
  let createdCount = 0;
  let reusedCount = 0;
  let geocodedCount = 0;
  let geocodeFailedCount = 0;
  const noteFailedProjectIds: string[] = [];

  if (input.dryRun) {
    await tx.execute(sql.raw("SAVEPOINT lead_bulk_dry_run"));
  }
  try {
    for (const row of parsed.rows) {
      const displayName = row.cells.displayName;
      if (!displayName) {
        reportRows.push({
          line: row.line, displayName: null, status: "invalid",
          projectId: null, contactReused: null, errors: ["missing-name"],
          geocoded: null, geocodeError: null,
        });
        continue;
      }
      if (row.cells.email === undefined && row.cells.phone === undefined) {
        reportRows.push({
          line: row.line, displayName, status: "invalid",
          projectId: null, contactReused: null, errors: ["missing-contact"],
          geocoded: null, geocodeError: null,
        });
        continue;
      }
      const scopeResult = parseScopeCell(row.cells.scope, input.defaultScope);
      if ("error" in scopeResult) {
        reportRows.push({
          line: row.line, displayName, status: "invalid",
          projectId: null, contactReused: null, errors: [scopeResult.error],
          geocoded: null, geocodeError: null,
        });
        continue;
      }
      let leadSourceId: string | undefined;
      if (row.cells.leadSourceName !== undefined) {
        const resolved = sourceIdByNormalized.get(
          normalizeLeadSourceName(row.cells.leadSourceName),
        );
        if (!resolved) {
          reportRows.push({
            line: row.line, displayName, status: "invalid",
            projectId: null, contactReused: null, errors: ["unknown-source"],
            geocoded: null, geocodeError: null,
          });
          continue;
        }
        leadSourceId = resolved;
      }
      try {
        const created = await createManualLead(tx, ctx, {
          scope: scopeResult.scope,
          displayName,
          email: row.cells.email,
          phone: row.cells.phone,
          street: row.cells.street,
          houseNumber: row.cells.houseNumber,
          postalCode: row.cells.postalCode,
          city: row.cells.city,
          leadSourceId,
          note: row.cells.note,
        });
        if (input.dryRun) {
          reportRows.push({
            line: row.line, displayName, status: "valid",
            projectId: null, contactReused: null, errors: [],
            geocoded: null, geocodeError: null,
          });
        } else {
          createdCount += 1;
          if (created.contactReused) reusedCount += 1;
          // Auto-Geocoding NACH der Anlage, sequentiell, ohne Retry:
          // fail-closed je Zeile (created+legacy + Code), nie Commercial.
          let geocoded: boolean | null = null;
          let geocodeError: ManualLeadBulkGeocodeError | null = null;
          if (isBulkGeocodeQualified(scopeResult.scope, row.cells)) {
            const outcome = await geocodeBulkLeadSite(tx, ctx, {
              projectId: created.projectId,
              siteId: created.siteId,
              contactId: created.contactId,
              street: row.cells.street,
              houseNumber: row.cells.houseNumber,
              postalCode: row.cells.postalCode,
              city: row.cells.city,
            }, input.geocode);
            if (outcome.ok) {
              geocoded = true;
              geocodedCount += 1;
            } else {
              geocoded = false;
              geocodeError = outcome.code;
              geocodeFailedCount += 1;
            }
          }
          if (row.cells.note !== undefined && input.writeNote) {
            try {
              await input.writeNote(created.projectId, row.cells.note);
            } catch {
              noteFailedProjectIds.push(created.projectId);
              reportRows.push({
                line: row.line, displayName, status: "note-failed",
                projectId: created.projectId, contactReused: created.contactReused,
                errors: ["note-failed"],
                geocoded, geocodeError,
              });
              continue;
            }
          }
          reportRows.push({
            line: row.line, displayName, status: "created",
            projectId: created.projectId, contactReused: created.contactReused, errors: [],
            geocoded, geocodeError,
          });
        }
      } catch (error) {
        if (error instanceof ManualLeadValidationError) {
          reportRows.push({
            line: row.line, displayName, status: "invalid",
            projectId: null, contactReused: null, errors: ["invalid-row"],
            geocoded: null, geocodeError: null,
          });
        } else if (error instanceof ManualLeadLaneError) {
          reportRows.push({
            line: row.line, displayName, status: "invalid",
            projectId: null, contactReused: null, errors: ["lane-missing"],
            geocoded: null, geocodeError: null,
          });
        } else if (
          error instanceof PermissionDeniedError && row.cells.note !== undefined
        ) {
          reportRows.push({
            line: row.line, displayName, status: "invalid",
            projectId: null, contactReused: null, errors: ["note-denied"],
            geocoded: null, geocodeError: null,
          });
        } else {
          throw error;
        }
      }
    }
  } finally {
    if (input.dryRun) {
      await tx.execute(sql.raw("ROLLBACK TO SAVEPOINT lead_bulk_dry_run"));
      await tx.execute(sql.raw("RELEASE SAVEPOINT lead_bulk_dry_run"));
    }
  }

  return manualLeadBulkReportSchema.parse({
    schemaVersion: MANUAL_LEAD_BULK_REPORT_VERSION,
    dryRun: input.dryRun,
    defaultScope: input.defaultScope,
    totalRows: parsed.rows.length,
    createdCount,
    reusedCount,
    noteFailedProjectIds,
    geocodedCount,
    geocodeFailedCount,
    rows: reportRows,
  });
}
