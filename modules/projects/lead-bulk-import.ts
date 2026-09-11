// F1-02 Lead-Bulk-CSV-Import: mehrere manuelle Anfragen aus einer
// CSV-Datei (Semikolon oder Komma) anlegen — inkl. Dry-Run-Prüfung.
// Berechtigung: bestehendes project.write (KEIN neuer Key).
//
// Architektur: Modulgrenzen (depcruise) — jede gültige Zeile läuft durch
// createManualLead (Dedupe, Intake-Lane, Audit, Events); die optionale
// Notiz schreibt NICHT dieser Service, sondern der injizierte writeNote-
// Callback der Server Action (gleiche Grenze wie F1-11). Dry-Run legt alle
// Zeilen in einem SAVEPOINT an und rollt zurück: Validierung (inkl.
// Markdown-Vorabprüfung und Quellennamen) ohne Writes, Events oder Audit.
// Nicht-atomar: gültige Zeilen werden angelegt, ungültige landen mit
// stabilen Fehlercodes im Bericht (kein stiller Drop).
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantTx } from "@/lib/db/types";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { normalizeLeadSourceName } from "@/modules/lead-sources";
import {
  createManualLead,
  ManualLeadLaneError,
  ManualLeadValidationError,
} from "./manual-lead-service";

export const MANUAL_LEAD_BULK_VERSION = 1;
export const MANUAL_LEAD_BULK_REPORT_VERSION = 1;
/** Reversibles ESTIMATE-Limit: max. Datenzeilen pro Datei. */
export const MANUAL_LEAD_BULK_MAX_ROWS = 500;

export class ManualLeadBulkFileError extends Error {
  constructor(
    public readonly code:
      | "empty-file"
      | "no-delimiter"
      | "missing-name-column"
      | "unknown-column"
      | "duplicate-column"
      | "too-many-rows",
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
});

export const manualLeadBulkReportSchema = z.strictObject({
  schemaVersion: z.literal(MANUAL_LEAD_BULK_REPORT_VERSION),
  dryRun: z.boolean(),
  defaultScope: z.enum(["residential", "commercial"]),
  totalRows: z.number().int().nonnegative(),
  createdCount: z.number().int().nonnegative(),
  reusedCount: z.number().int().nonnegative(),
  noteFailedProjectIds: z.array(z.string()),
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
  delimiter: string;
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
  return { delimiter, columns, rows };
}

export async function importManualLeadBulk(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    csvText: string;
    defaultScope: "residential" | "commercial";
    dryRun: boolean;
    writeNote?: (projectId: string, textMarkdown: string) => Promise<void>;
  },
): Promise<ManualLeadBulkReport> {
  requireManualLeadBulkWrite(ctx);
  const parsed = parseBulkCsv(input.csvText);

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
        });
        continue;
      }
      if (row.cells.email === undefined && row.cells.phone === undefined) {
        reportRows.push({
          line: row.line, displayName, status: "invalid",
          projectId: null, contactReused: null, errors: ["missing-contact"],
        });
        continue;
      }
      const scopeResult = parseScopeCell(row.cells.scope, input.defaultScope);
      if ("error" in scopeResult) {
        reportRows.push({
          line: row.line, displayName, status: "invalid",
          projectId: null, contactReused: null, errors: [scopeResult.error],
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
          });
        } else {
          createdCount += 1;
          if (created.contactReused) reusedCount += 1;
          if (row.cells.note !== undefined && input.writeNote) {
            try {
              await input.writeNote(created.projectId, row.cells.note);
            } catch {
              noteFailedProjectIds.push(created.projectId);
              reportRows.push({
                line: row.line, displayName, status: "note-failed",
                projectId: created.projectId, contactReused: created.contactReused,
                errors: ["note-failed"],
              });
              continue;
            }
          }
          reportRows.push({
            line: row.line, displayName, status: "created",
            projectId: created.projectId, contactReused: created.contactReused, errors: [],
          });
        }
      } catch (error) {
        if (error instanceof ManualLeadValidationError) {
          reportRows.push({
            line: row.line, displayName, status: "invalid",
            projectId: null, contactReused: null, errors: ["invalid-row"],
          });
        } else if (error instanceof ManualLeadLaneError) {
          reportRows.push({
            line: row.line, displayName, status: "invalid",
            projectId: null, contactReused: null, errors: ["lane-missing"],
          });
        } else if (
          error instanceof PermissionDeniedError && row.cells.note !== undefined
        ) {
          reportRows.push({
            line: row.line, displayName, status: "invalid",
            projectId: null, contactReused: null, errors: ["note-denied"],
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
    rows: reportRows,
  });
}
