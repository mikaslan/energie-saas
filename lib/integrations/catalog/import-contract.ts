import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import Papa from "papaparse";
import { z } from "zod";
import {
  CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
  canonicalizeCatalogJson,
  catalogComponentCreateCommandV1Schema,
  catalogProvenanceV1Schema,
  catalogComponentRevisionV1Schema,
  catalogTechnicalDataV1Schema,
  normalizeCatalogSku,
  validateCatalogComponentRevision,
  type CatalogComponentRevisionV1,
} from "./contract";
import {
  CATALOG_CSV_CANONICAL_FIELDS,
  CATALOG_CSV_MAPPING_VERSION,
  CATALOG_CSV_MAX_BYTES,
  CATALOG_CSV_REQUIRED_COMMON_FIELDS,
  CATALOG_IMPORT_RIGHTS_ATTESTATION_SHA256,
  CATALOG_IMPORT_RIGHTS_ATTESTATION_TEXT,
  CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
  type CatalogCsvCanonicalField,
} from "./import-wire";

export {
  CATALOG_CSV_CANONICAL_FIELDS,
  CATALOG_CSV_MAPPING_VERSION,
  CATALOG_CSV_MAX_BYTES,
  CATALOG_CSV_REQUIRED_COMMON_FIELDS,
  CATALOG_IMPORT_RIGHTS_ATTESTATION_SHA256,
  CATALOG_IMPORT_RIGHTS_ATTESTATION_TEXT,
  CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
} from "./import-wire";
export type { CatalogCsvCanonicalField } from "./import-wire";

export const CATALOG_CSV_IMPORT_CONTRACT_VERSION = "catalog-csv-import.v1" as const;
export const CATALOG_IMPORT_ROW_COMMAND_VERSION = "catalog-import-row-command.v1" as const;
export const CATALOG_IMPORT_PREPARE_VERSION = "catalog-import-prepare.v1" as const;
export const CATALOG_IMPORT_DISPATCH_VERSION = "catalog-import-dispatch.v1" as const;
export const CATALOG_IMPORT_CLEANUP_DISPATCH_VERSION =
  "catalog-import-cleanup-dispatch.v1" as const;
export const CATALOG_CSV_PARSER_VERSION = "papaparse-5.7.0-wmee.v1" as const;
export const CATALOG_CSV_MAX_ROWS = 1_000;
export const CATALOG_CSV_MAX_COLUMNS = 80;
export const CATALOG_CSV_MAX_CELL_CHARS = 4_096;
export const CATALOG_CSV_MAPPING_CANONICAL_MAX_BYTES = 32_768;
export const CATALOG_CSV_PREVIEW_ROW_CANONICAL_MAX_BYTES = 131_072;
export const CATALOG_IMPORT_SOURCE_COMMAND_CANONICAL_MAX_BYTES = 65_536;
export const CATALOG_IMPORT_TARGET_CANONICAL_MAX_BYTES = 65_536;
export const CATALOG_IMPORT_ROW_COMMAND_CANONICAL_MAX_BYTES = 262_144;

const catalogCsvPostgresDateSchema = z.iso.date().regex(/^(?!0000-)/u);
const catalogImportUuidSchema = z.uuid().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
);

export const catalogImportDispatchV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_IMPORT_DISPATCH_VERSION),
  workspaceId: catalogImportUuidSchema,
  importId: catalogImportUuidSchema,
});

export const catalogImportCleanupDispatchV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_IMPORT_CLEANUP_DISPATCH_VERSION),
  workspaceId: catalogImportUuidSchema,
  importId: catalogImportUuidSchema,
});

export type CatalogImportDispatchV1 = z.infer<typeof catalogImportDispatchV1Schema>;
export type CatalogImportCleanupDispatchV1 = z.infer<
  typeof catalogImportCleanupDispatchV1Schema
>;

export function parseCatalogImportDispatchV1(value: unknown): CatalogImportDispatchV1 {
  return catalogImportDispatchV1Schema.parse(value);
}

export function parseCatalogImportCleanupDispatchV1(
  value: unknown,
): CatalogImportCleanupDispatchV1 {
  return catalogImportCleanupDispatchV1Schema.parse(value);
}
const catalogImportSkuSchema = z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/u);
const catalogCsvFilenameSchema = z.string().min(1).max(180)
  .regex(/^(?!\s)(?!.*\s$)(?!.*[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]).+\.[cC][sS][vV]$/u)
  .refine((value) => value === value.normalize("NFKC").trim());

export const CATALOG_CSV_REQUEST_ERROR_CODES = [
  "invalid_file",
  "file_too_large",
  "invalid_encoding",
  "invalid_filename",
  "invalid_headers",
  "too_many_columns",
  "too_many_rows",
  "missing_mapping",
  "mapping_conflict",
  "snapshot_budget_exceeded",
  "parser_error",
] as const;

export const CATALOG_CSV_PROCESSING_RESULT_CODES = [
  "sku_created_since_preview",
  "revision_drift",
  "status_drift",
  "type_drift",
  "archived_requires_manual_reactivation",
  "catalog_write_conflict",
] as const;

export const CATALOG_CSV_JOB_ERROR_CODES = [
  "actor_revoked",
  "capability_revoked",
  "lease_lost",
  "enqueue_failed",
  "invalid_persisted_input",
  "technical_retry_exhausted",
  "all_rows_conflicted",
  "queue_locator_invalid",
] as const;

// Updated only from the deterministic generated artifact. The generator test
// prevents this constant and the checked-in schema from drifting separately.
export const CATALOG_CSV_IMPORT_SCHEMA_SHA256 =
  "5e1bc0ee180439944953106f17c3de1d551b320fd555c442a14797cac16f9e1b" as const;

function boundedCanonicalBody(value: string, maximum: number, label: string): string {
  const size = Buffer.byteLength(value, "utf8");
  if (size < 2 || size > maximum) {
    throw new TypeError(`${label} liegt ausserhalb der erlaubten Bytegrenze.`);
  }
  return value;
}

const canonicalFields = CATALOG_CSV_CANONICAL_FIELDS;

const canonicalFieldSchema = z.enum(canonicalFields);
const requiredCommonFields = CATALOG_CSV_REQUIRED_COMMON_FIELDS;

const fieldByName = new Set<string>(canonicalFields);
const requiredCommonFieldSet = new Set<string>(requiredCommonFields);
const canonicalFieldOrder = new Map(canonicalFields.map((field, index) => [field, index]));

const columnMappingEntrySchema = z.strictObject({
  field: canonicalFieldSchema,
  sourceHeader: z.string().min(1).max(240),
});

export const catalogCsvColumnMappingV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_CSV_MAPPING_VERSION),
  columns: z.array(columnMappingEntrySchema).min(1).max(canonicalFields.length),
}).superRefine((value, context) => {
  const fields = new Set<string>();
  const headers = new Set<string>();
  for (const [index, entry] of value.columns.entries()) {
    if (fields.has(entry.field)) {
      context.addIssue({
        code: "custom",
        path: ["columns", index, "field"],
        message: "Kanonisches Feld ist mehrfach zugeordnet.",
      });
    }
    if (headers.has(entry.sourceHeader)) {
      context.addIssue({
        code: "custom",
        path: ["columns", index, "sourceHeader"],
        message: "Quellspalte ist mehrfach zugeordnet.",
      });
    }
    fields.add(entry.field);
    headers.add(entry.sourceHeader);
  }
});

export type CatalogCsvColumnMappingV1 = z.infer<typeof catalogCsvColumnMappingV1Schema>;

export const catalogCsvRowErrorCodeSchema = z.enum([
  "empty_row",
  "missing_mapping",
  "missing_value",
  "invalid_value",
  "invalid_money",
  "invalid_date",
  "invalid_enum",
  "invalid_sha256",
  "invalid_technical_shape",
  "duplicate_sku_in_file",
  "sku_type_conflict",
  "archived_requires_manual_reactivation",
  "mapping_conflict",
  "row_too_large",
  "parser_error",
]);

export type CatalogCsvRowErrorCode = z.infer<typeof catalogCsvRowErrorCodeSchema>;

const CATALOG_CSV_ROW_ERROR_MESSAGES = {
  empty_row: "Die Datenzeile ist leer.",
  missing_mapping: "Die benoetigte Spalte ist nicht zugeordnet.",
  missing_value: "Ein benoetigter Wert fehlt.",
  invalid_value: "Der Wert entspricht nicht dem Importvertrag.",
  invalid_money: "Der Nettopreis ist nicht eindeutig lesbar.",
  invalid_date: "Das Datum muss YYYY-MM-DD entsprechen.",
  invalid_enum: "Der Wert ist fuer dieses Feld nicht erlaubt.",
  invalid_sha256: "Der Dokumenthash muss leer oder ein SHA-256 in Kleinbuchstaben sein.",
  invalid_technical_shape: "Die technischen Werte passen nicht zum Produkttyp.",
  duplicate_sku_in_file: "Die normalisierte SKU kommt in der Datei mehrfach vor.",
  sku_type_conflict: "Die SKU kollidiert mit einem anderen Produkttyp.",
  archived_requires_manual_reactivation:
    "Archivierte Produkte brauchen eine manuelle Reaktivierung.",
  mapping_conflict: "Die Spaltenzuordnung ist nicht eindeutig.",
  row_too_large: "Mindestens eine Zelle ueberschreitet das Zeichenlimit.",
  parser_error: "Die CSV-Zeile konnte nicht sicher gelesen werden.",
} as const satisfies Record<CatalogCsvRowErrorCode, string>;

export const catalogCsvProcessingResultCodeSchema = z.enum(
  CATALOG_CSV_PROCESSING_RESULT_CODES,
);
export type CatalogCsvProcessingResultCode = z.infer<
  typeof catalogCsvProcessingResultCodeSchema
>;

export const catalogCsvJobErrorCodeSchema = z.enum(CATALOG_CSV_JOB_ERROR_CODES);
export type CatalogCsvJobErrorCode = z.infer<typeof catalogCsvJobErrorCodeSchema>;

export const catalogCsvRequestErrorCodeSchema = z.enum(CATALOG_CSV_REQUEST_ERROR_CODES);
export type CatalogCsvRequestErrorCode = z.infer<typeof catalogCsvRequestErrorCodeSchema>;

function catalogCsvRowErrorVariant<const Code extends CatalogCsvRowErrorCode>(
  code: Code,
) {
  return z.strictObject({
    field: canonicalFieldSchema.nullable(),
    sourceHeader: z.string().min(1).max(240).nullable(),
    code: z.literal(code),
    message: z.literal(CATALOG_CSV_ROW_ERROR_MESSAGES[code]),
  });
}

export const catalogCsvRowErrorV1Schema = z.discriminatedUnion("code", [
  catalogCsvRowErrorVariant("empty_row"),
  catalogCsvRowErrorVariant("missing_mapping"),
  catalogCsvRowErrorVariant("missing_value"),
  catalogCsvRowErrorVariant("invalid_value"),
  catalogCsvRowErrorVariant("invalid_money"),
  catalogCsvRowErrorVariant("invalid_date"),
  catalogCsvRowErrorVariant("invalid_enum"),
  catalogCsvRowErrorVariant("invalid_sha256"),
  catalogCsvRowErrorVariant("invalid_technical_shape"),
  catalogCsvRowErrorVariant("duplicate_sku_in_file"),
  catalogCsvRowErrorVariant("sku_type_conflict"),
  catalogCsvRowErrorVariant("archived_requires_manual_reactivation"),
  catalogCsvRowErrorVariant("mapping_conflict"),
  catalogCsvRowErrorVariant("row_too_large"),
  catalogCsvRowErrorVariant("parser_error"),
]);

export type CatalogCsvRowErrorV1 = z.infer<typeof catalogCsvRowErrorV1Schema>;

const persistedFileSchema = z.strictObject({
  filename: catalogCsvFilenameSchema,
  sizeBytes: z.int().safe().min(1).max(CATALOG_CSV_MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  encoding: z.enum(["utf-8", "windows-1252"]),
  delimiter: z.enum([";", ","]),
  parserVersion: z.literal(CATALOG_CSV_PARSER_VERSION),
  rowCount: z.int().safe().min(1).max(CATALOG_CSV_MAX_ROWS),
});

const inspectionSchema = persistedFileSchema.extend({
  headers: z.array(z.string().min(1).max(240)).min(1).max(CATALOG_CSV_MAX_COLUMNS),
});

const catalogCsvProvenanceV1Schema = catalogProvenanceV1Schema.extend({
  observedOn: catalogCsvPostgresDateSchema,
});

const catalogCsvCommercialV1Schema = catalogComponentCreateCommandV1Schema
  .shape.commercial.unwrap().extend({
    purchaseProvenance: catalogCsvProvenanceV1Schema,
    salesProvenance: catalogCsvProvenanceV1Schema,
  });

const catalogCsvPresentationV1Schema = catalogComponentCreateCommandV1Schema
  .shape.presentation.extend({
    image: z.null(),
    datasheet: z.null(),
  });

const catalogCsvPiecePresentationV1Schema = catalogCsvPresentationV1Schema.extend({
  unit: z.literal("piece"),
});

const catalogCsvSourceCommandSharedShape = {
  internalSku: catalogImportSkuSchema,
  commercial: catalogCsvCommercialV1Schema,
  technicalProvenance: catalogCsvProvenanceV1Schema,
} as const;

const catalogCsvSourceCommandV1Schema = z.discriminatedUnion("componentType", [
  catalogComponentCreateCommandV1Schema.extend({
    ...catalogCsvSourceCommandSharedShape,
    componentType: z.literal("module"),
    presentation: catalogCsvPiecePresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[0],
  }),
  catalogComponentCreateCommandV1Schema.extend({
    ...catalogCsvSourceCommandSharedShape,
    componentType: z.literal("inverter"),
    presentation: catalogCsvPiecePresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[1],
  }),
  catalogComponentCreateCommandV1Schema.extend({
    ...catalogCsvSourceCommandSharedShape,
    componentType: z.literal("battery"),
    presentation: catalogCsvPiecePresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[2],
  }),
  catalogComponentCreateCommandV1Schema.extend({
    ...catalogCsvSourceCommandSharedShape,
    componentType: z.literal("wallbox"),
    presentation: catalogCsvPiecePresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[3],
  }),
  catalogComponentCreateCommandV1Schema.extend({
    ...catalogCsvSourceCommandSharedShape,
    componentType: z.literal("heat_pump"),
    presentation: catalogCsvPiecePresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[4],
  }),
  catalogComponentCreateCommandV1Schema.extend({
    ...catalogCsvSourceCommandSharedShape,
    componentType: z.literal("mounting"),
    presentation: catalogCsvPresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[5],
  }),
  catalogComponentCreateCommandV1Schema.extend({
    ...catalogCsvSourceCommandSharedShape,
    componentType: z.literal("other"),
    presentation: catalogCsvPresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[6],
  }),
]);

export type CatalogImportSourceCommandV1 = z.infer<
  typeof catalogCsvSourceCommandV1Schema
>;

export function parseCatalogImportSourceCommand(
  value: unknown,
): CatalogImportSourceCommandV1 {
  const parsed = catalogCsvSourceCommandV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError("Ungueltiger persistierter Import-Quellcommand.");
  }
  return parsed.data;
}

const validRowSchema = z.strictObject({
  status: z.literal("valid"),
  rowNumber: z.int().safe().min(2).max(CATALOG_CSV_MAX_ROWS + 1),
  rowSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  normalizedSku: catalogImportSkuSchema,
  commandSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  command: catalogCsvSourceCommandV1Schema,
});

const invalidRowSchema = z.strictObject({
  status: z.literal("invalid"),
  rowNumber: z.int().safe().min(2).max(CATALOG_CSV_MAX_ROWS + 1),
  rowSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  normalizedSku: catalogImportSkuSchema.nullable(),
  errors: z.array(catalogCsvRowErrorV1Schema).min(1).max(20),
});

const previewRowSchema = z.discriminatedUnion("status", [
  validRowSchema,
  invalidRowSchema,
]);

export const catalogCsvPreviewV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_CSV_IMPORT_CONTRACT_VERSION),
  file: persistedFileSchema,
  mapping: catalogCsvColumnMappingV1Schema,
  mappingSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  counts: z.strictObject({
    total: z.int().safe().min(1).max(CATALOG_CSV_MAX_ROWS),
    valid: z.int().safe().min(0).max(CATALOG_CSV_MAX_ROWS),
    invalid: z.int().safe().min(0).max(CATALOG_CSV_MAX_ROWS),
  }),
  rows: z.array(previewRowSchema)
    .min(1).max(CATALOG_CSV_MAX_ROWS),
}).superRefine((value, context) => {
  if (
    value.counts.total !== value.rows.length
    || value.counts.valid !== value.rows.filter((row) => row.status === "valid").length
    || value.counts.invalid !== value.rows.filter((row) => row.status === "invalid").length
    || value.counts.total !== value.counts.valid + value.counts.invalid
    || value.file.rowCount !== value.rows.length
  ) {
    context.addIssue({ code: "custom", path: ["counts"], message: "Zeilenzaehler driften." });
  }
  const normalizedMapping = normalizeCatalogCsvMapping(value.mapping);
  if (canonicalizeCatalogJson(value.mapping) !== canonicalizeCatalogJson(normalizedMapping)) {
    context.addIssue({ code: "custom", path: ["mapping"], message: "Mapping ist nicht kanonisch sortiert." });
  }
  if (sha256(canonicalizeCatalogJson(normalizedMapping)) !== value.mappingSha256) {
    context.addIssue({ code: "custom", path: ["mappingSha256"], message: "Mappinghash driftet." });
  }
  value.rows.forEach((row, index) => {
    if (row.rowNumber !== index + 2) {
      context.addIssue({ code: "custom", path: ["rows", index, "rowNumber"], message: "Zeilenfolge driftet." });
    }
    if (previewRowSha256(row) !== row.rowSha256) {
      context.addIssue({ code: "custom", path: ["rows", index, "rowSha256"], message: "Zeilenhash driftet." });
    }
    if (row.status === "valid") {
      if (row.normalizedSku !== row.command.internalSku) {
        context.addIssue({ code: "custom", path: ["rows", index, "normalizedSku"], message: "SKU-Bindung driftet." });
      }
      if (sha256(canonicalizeCatalogJson(row.command)) !== row.commandSha256) {
        context.addIssue({ code: "custom", path: ["rows", index, "commandSha256"], message: "Commandhash driftet." });
      }
    }
  });
});

export type CatalogCsvPreviewV1 = z.infer<typeof catalogCsvPreviewV1Schema>;
export type CatalogCsvPreviewRowV1 = CatalogCsvPreviewV1["rows"][number];

export type CatalogCsvCatalogConflictCode = Extract<
  CatalogCsvRowErrorCode,
  "sku_type_conflict" | "archived_requires_manual_reactivation"
>;

export type CatalogCsvCatalogConflict = Readonly<{
  rowNumber: number;
  code: CatalogCsvCatalogConflictCode;
}>;

export type CatalogCsvInspection = z.infer<typeof inspectionSchema>;

export type CatalogCsvImportFailureCode = CatalogCsvRequestErrorCode;

export class CatalogCsvImportError extends Error {
  constructor(
    public readonly code: CatalogCsvImportFailureCode,
    public readonly field?: CatalogCsvCanonicalField,
  ) {
    super("catalog CSV input is invalid");
    this.name = "CatalogCsvImportError";
  }
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function decodeCsv(bytes: Uint8Array): {
  text: string;
  encoding: "utf-8" | "windows-1252";
} {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
    throw new CatalogCsvImportError("invalid_file");
  }
  if (bytes.byteLength > CATALOG_CSV_MAX_BYTES) {
    throw new CatalogCsvImportError("file_too_large");
  }
  let text: string;
  let encoding: "utf-8" | "windows-1252" = "utf-8";
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    encoding = "windows-1252";
    try {
      text = new TextDecoder("windows-1252", { fatal: true }).decode(bytes);
    } catch {
      throw new CatalogCsvImportError("invalid_encoding");
    }
  }
  text = text.replace(/^\uFEFF/u, "");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(text)) {
    throw new CatalogCsvImportError("invalid_encoding");
  }
  return { text, encoding };
}

function parseRows(text: string, delimiter: ";" | ",", preview?: number): {
  rows: string[][];
  errors: Papa.ParseError[];
} {
  const parsed = Papa.parse<string[]>(text, {
    delimiter,
    skipEmptyLines: false,
    ...(preview === undefined ? {} : { preview }),
  });
  const rows = parsed.data.map((row) => row.map((cell) => String(cell)));
  return { rows, errors: parsed.errors };
}

function isEmptyParsedRow(row: string[]): boolean {
  return row.every((cell) => cell.trim() === "");
}

function plausibleDelimiter(text: string, delimiter: ";" | ","): boolean {
  const parsed = parseRows(text, delimiter);
  if (parsed.errors.length > 0) return false;
  while (parsed.rows.length > 1 && isEmptyParsedRow(parsed.rows.at(-1) ?? [])) {
    parsed.rows.pop();
  }
  const headerWidth = parsed.rows[0]?.length ?? 0;
  return headerWidth >= 2
    && parsed.rows.length >= 2
    && parsed.rows.slice(1).every((row) => isEmptyParsedRow(row) || row.length === headerWidth);
}

function detectDelimiter(text: string): ";" | "," {
  const semicolon = plausibleDelimiter(text, ";");
  const comma = plausibleDelimiter(text, ",");
  if (semicolon === comma) throw new CatalogCsvImportError("parser_error");
  return semicolon ? ";" : ",";
}

function normalizeHeader(value: string): string {
  return value.normalize("NFKC").trim();
}

function parsedFile(input: { filename: string; bytes: Uint8Array }): {
  inspection: CatalogCsvInspection;
  rows: string[][];
} {
  const filename = input.filename.normalize("NFKC").trim();
  if (
    filename.length < 1
    || filename.length > 180
    || !filename.toLowerCase().endsWith(".csv")
    || /[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(filename)
  ) {
    throw new CatalogCsvImportError("invalid_filename");
  }
  const decoded = decodeCsv(input.bytes);
  const delimiter = detectDelimiter(decoded.text);
  const parsed = parseRows(decoded.text, delimiter);
  if (parsed.errors.length > 0 || parsed.rows.length < 2) {
    throw new CatalogCsvImportError("parser_error");
  }
  while (
    parsed.rows.length > 1
    && parsed.rows.at(-1)?.every((cell) => cell.trim() === "")
  ) parsed.rows.pop();
  const header = parsed.rows[0]?.map(normalizeHeader) ?? [];
  if (
    header.length < 1
    || header.some((entry) => entry.length < 1 || entry.length > 240)
    || new Set(header).size !== header.length
  ) throw new CatalogCsvImportError("invalid_headers");
  if (header.length > CATALOG_CSV_MAX_COLUMNS) {
    throw new CatalogCsvImportError("too_many_columns");
  }
  const dataRows = parsed.rows.slice(1);
  if (dataRows.length < 1) throw new CatalogCsvImportError("parser_error");
  if (dataRows.length > CATALOG_CSV_MAX_ROWS) {
    throw new CatalogCsvImportError("too_many_rows");
  }
  if (dataRows.some((row) => !isEmptyParsedRow(row) && row.length !== header.length)) {
    throw new CatalogCsvImportError("parser_error");
  }
  return {
    inspection: inspectionSchema.parse({
      filename,
      sizeBytes: input.bytes.byteLength,
      sha256: sha256(input.bytes),
      encoding: decoded.encoding,
      delimiter,
      parserVersion: CATALOG_CSV_PARSER_VERSION,
      headers: header,
      rowCount: dataRows.length,
    }),
    rows: dataRows,
  };
}

export function inspectCatalogCsvFile(input: {
  filename: string;
  bytes: Uint8Array;
}): CatalogCsvInspection {
  return parsedFile(input).inspection;
}

export function autoMapCatalogCsvHeaders(headers: string[]): CatalogCsvColumnMappingV1 {
  const normalized = headers.map(normalizeHeader);
  if (new Set(normalized).size !== normalized.length) {
    throw new CatalogCsvImportError("invalid_headers");
  }
  const columns = normalized
    .filter((header): header is CatalogCsvCanonicalField => fieldByName.has(header))
    .map((field) => ({ field, sourceHeader: field }));
  if (columns.length === 0) throw new CatalogCsvImportError("missing_mapping");
  return normalizeCatalogCsvMapping({
    schemaVersion: CATALOG_CSV_MAPPING_VERSION,
    columns,
  });
}

export function normalizeCatalogCsvMapping(
  mapping: CatalogCsvColumnMappingV1,
): CatalogCsvColumnMappingV1 {
  const parsed = catalogCsvColumnMappingV1Schema.safeParse(mapping);
  if (!parsed.success) throw new CatalogCsvImportError("mapping_conflict");
  const normalized = parsed.data.columns.map((entry) => ({
    field: entry.field,
    sourceHeader: normalizeHeader(entry.sourceHeader),
  })).sort((left, right) => (
    (canonicalFieldOrder.get(left.field) ?? Number.MAX_SAFE_INTEGER)
    - (canonicalFieldOrder.get(right.field) ?? Number.MAX_SAFE_INTEGER)
  ));
  const result = catalogCsvColumnMappingV1Schema.safeParse({
    schemaVersion: CATALOG_CSV_MAPPING_VERSION,
    columns: normalized,
  });
  if (!result.success) throw new CatalogCsvImportError("mapping_conflict");
  return result.data;
}

export function catalogCsvMappingPersistenceEnvelope(
  mapping: CatalogCsvColumnMappingV1,
): {
  snapshot: CatalogCsvColumnMappingV1;
  bodyCanonical: string;
  sha256: string;
} {
  const snapshot = normalizeCatalogCsvMapping(mapping);
  const bodyCanonical = boundedCanonicalBody(
    canonicalizeCatalogJson(snapshot),
    CATALOG_CSV_MAPPING_CANONICAL_MAX_BYTES,
    "Import-Mappingbody",
  );
  return { snapshot, bodyCanonical, sha256: sha256(bodyCanonical) };
}

function mappingIndex(
  mapping: CatalogCsvColumnMappingV1,
  headers: string[],
): Map<CatalogCsvCanonicalField, { header: string; index: number }> {
  const parsed = normalizeCatalogCsvMapping(mapping);
  const headerIndex = new Map(headers.map((header, index) => [header, index]));
  const index = new Map<CatalogCsvCanonicalField, { header: string; index: number }>();
  for (const entry of parsed.columns) {
    const sourceIndex = headerIndex.get(entry.sourceHeader);
    if (sourceIndex === undefined) throw new CatalogCsvImportError("mapping_conflict");
    index.set(entry.field, { header: entry.sourceHeader, index: sourceIndex });
  }
  for (const field of requiredCommonFieldSet) {
    if (!index.has(field as CatalogCsvCanonicalField)) {
      throw new CatalogCsvImportError("missing_mapping", field as CatalogCsvCanonicalField);
    }
  }
  return index;
}

function rowError(
  code: CatalogCsvRowErrorCode,
  field: CatalogCsvCanonicalField | null,
  sourceHeader: string | null,
): CatalogCsvRowErrorV1 {
  return catalogCsvRowErrorV1Schema.parse({
    field,
    sourceHeader,
    code,
    message: CATALOG_CSV_ROW_ERROR_MESSAGES[code],
  });
}

function exactInteger(value: string, min: number, max: number): number | null {
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function decimalHundredths(value: string, min: number, max: number): number | null {
  const match = /^(0|[1-9]\d*)(?:[.,](\d{1,2}))?$/u.exec(value);
  if (!match) return null;
  const parsed = BigInt(match[1]!) * BigInt(100)
    + BigInt((match[2] ?? "").padEnd(2, "0"));
  return parsed >= BigInt(min) && parsed <= BigInt(max) ? Number(parsed) : null;
}

function moneyCents(value: string): number | null {
  let whole: string;
  let fraction: string;
  const german = /^(0|[1-9]\d{0,2}(?:\.\d{3})*|[1-9]\d*),(\d{1,2})$/u.exec(value);
  const canonical = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/u.exec(value);
  if (german) {
    whole = german[1]!.replaceAll(".", "");
    fraction = german[2]!;
  } else if (canonical) {
    whole = canonical[1]!;
    fraction = canonical[2] ?? "";
  } else {
    return null;
  }
  const cents = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  return cents <= BigInt("9000000000000000") ? Number(cents) : null;
}

function strictPipeList(value: string): string[] | null {
  const entries = value.split("|").map((entry) => entry.trim());
  return entries.length > 0 && entries.every((entry) => entry.length > 0)
    ? entries
    : null;
}

function isWellFormedUnicode(value: string): boolean {
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

function mappedValues(
  cells: string[],
  index: Map<CatalogCsvCanonicalField, { header: string; index: number }>,
): Partial<Record<CatalogCsvCanonicalField, string>> {
  const values: Partial<Record<CatalogCsvCanonicalField, string>> = {};
  for (const [field, mapping] of index) {
    values[field] = (cells[mapping.index] ?? "").normalize("NFKC").trim();
  }
  return values;
}

function requiredValue(
  values: Partial<Record<CatalogCsvCanonicalField, string>>,
  index: Map<CatalogCsvCanonicalField, { header: string; index: number }>,
  field: CatalogCsvCanonicalField,
  errors: CatalogCsvRowErrorV1[],
): string | null {
  const mapping = index.get(field);
  if (!mapping) {
    errors.push(rowError("missing_mapping", field, null));
    return null;
  }
  const value = values[field] ?? "";
  if (value.length === 0) {
    errors.push(rowError("missing_value", field, mapping.header));
    return null;
  }
  return value;
}

function optionalSha(
  value: string | undefined,
  field: CatalogCsvCanonicalField,
  index: Map<CatalogCsvCanonicalField, { header: string; index: number }>,
  errors: CatalogCsvRowErrorV1[],
): string | null {
  if (!value) return null;
  if (!/^[0-9a-f]{64}$/u.test(value)) {
    errors.push(rowError("invalid_sha256", field, index.get(field)?.header ?? null));
    return null;
  }
  return value;
}

function provenance(
  prefix: "technical" | "purchase" | "sales",
  values: Partial<Record<CatalogCsvCanonicalField, string>>,
  index: Map<CatalogCsvCanonicalField, { header: string; index: number }>,
  errors: CatalogCsvRowErrorV1[],
) {
  const sourceKindField = `${prefix}SourceKind` as CatalogCsvCanonicalField;
  const referenceField = `${prefix}Reference` as CatalogCsvCanonicalField;
  const observedOnField = `${prefix}ObservedOn` as CatalogCsvCanonicalField;
  const rightsBasisField = `${prefix}RightsBasis` as CatalogCsvCanonicalField;
  const documentField = `${prefix}DocumentSha256` as CatalogCsvCanonicalField;
  const sourceKind = requiredValue(values, index, sourceKindField, errors);
  const reference = requiredValue(values, index, referenceField, errors);
  const observedOn = requiredValue(values, index, observedOnField, errors);
  const rightsBasis = requiredValue(values, index, rightsBasisField, errors);
  if (reference !== null && [...reference].length > 240) {
    errors.push(rowError("invalid_value", referenceField, index.get(referenceField)?.header ?? null));
  }
  if (observedOn && !catalogCsvPostgresDateSchema.safeParse(observedOn).success) {
    errors.push(rowError("invalid_date", observedOnField, index.get(observedOnField)?.header ?? null));
  }
  const allowedSourceKinds = [
    "manufacturer_datasheet",
    "supplier_price_list",
    "supplier_quote",
    "workspace_pricing",
    "workspace_manual",
    "csv_import",
    "customer_provided",
  ];
  if (sourceKind !== null && !allowedSourceKinds.includes(sourceKind)) {
    errors.push(rowError("invalid_enum", sourceKindField, index.get(sourceKindField)?.header ?? null));
  }
  const allowedRightsBases = [
    "manufacturer_published",
    "supplier_authorized",
    "workspace_owned",
    "customer_provided",
  ];
  if (rightsBasis !== null && !allowedRightsBases.includes(rightsBasis)) {
    errors.push(rowError("invalid_enum", rightsBasisField, index.get(rightsBasisField)?.header ?? null));
  }
  return {
    sourceKind,
    reference,
    observedOn,
    rightsBasis,
    sourceDocumentSha256: optionalSha(values[documentField], documentField, index, errors),
  };
}

function technicalData(
  componentType: string,
  values: Partial<Record<CatalogCsvCanonicalField, string>>,
  index: Map<CatalogCsvCanonicalField, { header: string; index: number }>,
  errors: CatalogCsvRowErrorV1[],
): Record<string, unknown> | null {
  const integer = (field: CatalogCsvCanonicalField, min: number, max: number) => {
    const raw = requiredValue(values, index, field, errors);
    const parsed = raw === null ? null : exactInteger(raw, min, max);
    if (raw !== null && parsed === null) {
      errors.push(rowError("invalid_value", field, index.get(field)?.header ?? null));
    }
    return parsed;
  };
  if (componentType === "module") {
    const nominalPowerWatts = integer("nominalPowerWatts", 1, 10_000);
    return nominalPowerWatts === null ? null : { schemaVersion: "module.v1", nominalPowerWatts };
  }
  if (componentType === "inverter") {
    const nominalAcPowerWatts = integer("nominalAcPowerWatts", 1, 10_000_000);
    const phaseCount = integer("phaseCount", 1, 3);
    const mpptTrackerCount = integer("mpptTrackerCount", 1, 100);
    if (phaseCount !== null && ![1, 3].includes(phaseCount)) {
      errors.push(rowError("invalid_enum", "phaseCount", index.get("phaseCount")?.header ?? null));
    }
    if (nominalAcPowerWatts === null || ![1, 3].includes(phaseCount ?? 0) || mpptTrackerCount === null) return null;
    return { schemaVersion: "inverter.v1", nominalAcPowerWatts, phaseCount, mpptTrackerCount };
  }
  if (componentType === "battery") {
    const nominalCapacityWh = integer("nominalCapacityWh", 1, 100_000_000);
    const usableCapacityWh = integer("usableCapacityWh", 1, 100_000_000);
    const maxContinuousPowerWatts = integer("maxContinuousPowerWatts", 1, 100_000_000);
    const efficiency = requiredValue(values, index, "roundTripEfficiencyPercent", errors);
    const roundTripEfficiencyBasisPoints = efficiency === null
      ? null : decimalHundredths(efficiency, 1, 10_000);
    if (efficiency !== null && roundTripEfficiencyBasisPoints === null) {
      errors.push(rowError("invalid_value", "roundTripEfficiencyPercent", index.get("roundTripEfficiencyPercent")?.header ?? null));
    }
    const backupCapability = requiredValue(values, index, "backupCapability", errors);
    if (
      backupCapability !== null
      && !["known_supported", "known_unsupported", "unknown"].includes(backupCapability)
    ) {
      errors.push(rowError("invalid_enum", "backupCapability", index.get("backupCapability")?.header ?? null));
    }
    if (
      nominalCapacityWh === null || usableCapacityWh === null
      || maxContinuousPowerWatts === null || roundTripEfficiencyBasisPoints === null
      || !["known_supported", "known_unsupported", "unknown"].includes(backupCapability ?? "")
    ) return null;
    return {
      schemaVersion: "battery.v1",
      nominalCapacityWh,
      usableCapacityWh,
      maxContinuousPowerWatts,
      roundTripEfficiencyBasisPoints,
      backupCapability,
    };
  }
  if (componentType === "wallbox") {
    const maxChargingPowerWatts = integer("maxChargingPowerWatts", 1, 1_000_000);
    const phaseCount = integer("phaseCount", 1, 3);
    const connector = requiredValue(values, index, "connector", errors);
    const bidirectionalCapability = requiredValue(values, index, "bidirectionalCapability", errors);
    if (phaseCount !== null && ![1, 3].includes(phaseCount)) {
      errors.push(rowError("invalid_enum", "phaseCount", index.get("phaseCount")?.header ?? null));
    }
    if (connector !== null && !["type2_socket", "type2_cable", "other"].includes(connector)) {
      errors.push(rowError("invalid_enum", "connector", index.get("connector")?.header ?? null));
    }
    if (
      bidirectionalCapability !== null
      && !["known_supported", "known_unsupported", "unknown"].includes(bidirectionalCapability)
    ) {
      errors.push(rowError(
        "invalid_enum",
        "bidirectionalCapability",
        index.get("bidirectionalCapability")?.header ?? null,
      ));
    }
    if (
      maxChargingPowerWatts === null || ![1, 3].includes(phaseCount ?? 0)
      || !["type2_socket", "type2_cable", "other"].includes(connector ?? "")
      || !["known_supported", "known_unsupported", "unknown"].includes(bidirectionalCapability ?? "")
    ) return null;
    return {
      schemaVersion: "wallbox.v1",
      maxChargingPowerWatts,
      phaseCount,
      connector,
      bidirectionalCapability,
    };
  }
  if (componentType === "heat_pump") {
    const nominalHeatingPowerWatts = integer("nominalHeatingPowerWatts", 1, 10_000_000);
    const rawScop = requiredValue(values, index, "scop", errors);
    const scopHundredths = rawScop === null ? null : decimalHundredths(rawScop, 1, 2_000);
    if (rawScop !== null && scopHundredths === null) {
      errors.push(rowError("invalid_value", "scop", index.get("scop")?.header ?? null));
    }
    return nominalHeatingPowerWatts === null || scopHundredths === null
      ? null
      : { schemaVersion: "heat_pump.v1", nominalHeatingPowerWatts, scopHundredths };
  }
  if (componentType === "mounting") {
    const systemName = requiredValue(values, index, "systemName", errors);
    const roofTypesRaw = requiredValue(values, index, "roofTypes", errors);
    const roofTypes = roofTypesRaw === null ? null : strictPipeList(roofTypesRaw);
    if (
      roofTypesRaw !== null
      && (roofTypes === null || roofTypes.some((entry) => (
        !["pitched", "flat", "facade", "ground"].includes(entry)
      )))
    ) {
      errors.push(rowError("invalid_technical_shape", "roofTypes", index.get("roofTypes")?.header ?? null));
      return null;
    }
    return systemName === null || roofTypes === null
      ? null
      : { schemaVersion: "mounting.v1", systemName, roofTypes };
  }
  if (componentType === "other") {
    const attributesRaw = requiredValue(values, index, "attributes", errors);
    if (attributesRaw === null) return null;
    let decoded: unknown;
    try {
      decoded = JSON.parse(attributesRaw);
    } catch {
      decoded = null;
    }
    const attributes = z.array(z.strictObject({
      name: z.string().trim().min(1).max(80),
      value: z.string().trim().min(1).max(240),
    })).max(20).safeParse(decoded);
    if (
      !attributes.success
      || attributes.data.some((entry) => (
        !isWellFormedUnicode(entry.name) || !isWellFormedUnicode(entry.value)
      ))
    ) {
      errors.push(rowError("invalid_technical_shape", "attributes", index.get("attributes")?.header ?? null));
      return null;
    }
    return { schemaVersion: "other.v1", attributes: attributes.data };
  }
  errors.push(rowError("invalid_enum", "componentType", index.get("componentType")?.header ?? null));
  return null;
}

function parseCommand(
  values: Partial<Record<CatalogCsvCanonicalField, string>>,
  index: Map<CatalogCsvCanonicalField, { header: string; index: number }>,
): {
  command: z.infer<typeof catalogCsvSourceCommandV1Schema> | null;
  errors: CatalogCsvRowErrorV1[];
  sku: string | null;
} {
  const errors: CatalogCsvRowErrorV1[] = [];
  const rawSku = requiredValue(values, index, "internalSku", errors);
  let sku: string | null = null;
  if (rawSku !== null) {
    try {
      sku = normalizeCatalogSku(rawSku);
    } catch {
      errors.push(rowError("invalid_value", "internalSku", index.get("internalSku")?.header ?? null));
    }
  }
  const componentType = requiredValue(values, index, "componentType", errors);
  const displayName = requiredValue(values, index, "displayName", errors);
  const manufacturer = requiredValue(values, index, "manufacturer", errors);
  const model = requiredValue(values, index, "model", errors);
  const unit = requiredValue(values, index, "unit", errors);
  if (unit !== null && !["piece", "set", "meter"].includes(unit)) {
    errors.push(rowError("invalid_enum", "unit", index.get("unit")?.header ?? null));
  }
  const purchasePrice = requiredValue(values, index, "purchasePriceNet", errors);
  const salesPrice = requiredValue(values, index, "salesPriceNet", errors);
  const purchasePriceNetCents = purchasePrice === null ? null : moneyCents(purchasePrice);
  const salesPriceNetCents = salesPrice === null ? null : moneyCents(salesPrice);
  if (purchasePrice !== null && purchasePriceNetCents === null) {
    errors.push(rowError("invalid_money", "purchasePriceNet", index.get("purchasePriceNet")?.header ?? null));
  }
  if (salesPrice !== null && salesPriceNetCents === null) {
    errors.push(rowError("invalid_money", "salesPriceNet", index.get("salesPriceNet")?.header ?? null));
  }
  const technical = technicalData(componentType ?? "", values, index, errors);
  const keyPointsRaw = values.keyPoints ?? "";
  const keyPoints = keyPointsRaw.length === 0 ? [] : strictPipeList(keyPointsRaw);
  if (
    keyPoints === null
    || keyPoints.length > 6
    || keyPoints.some((entry) => [...entry].length > 240)
  ) {
    errors.push(rowError("invalid_value", "keyPoints", index.get("keyPoints")?.header ?? null));
  }
  const candidate = {
    schemaVersion: CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
    internalSku: sku,
    componentType,
    presentation: {
      displayName,
      manufacturer,
      model,
      unit,
      keyPoints,
      image: null,
      datasheet: null,
    },
    technicalData: technical,
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents,
      salesPriceNetCents,
      purchaseProvenance: provenance("purchase", values, index, errors),
      salesProvenance: provenance("sales", values, index, errors),
    },
    technicalProvenance: provenance("technical", values, index, errors),
  };
  if (errors.length > 0) return { command: null, errors: errors.slice(0, 20), sku };
  const parsed = catalogCsvSourceCommandV1Schema.safeParse(candidate);
  if (!parsed.success) {
    const fields = new Set(parsed.error.issues.map((issue) => String(issue.path.at(-1) ?? "componentType")));
    for (const fieldName of fields) {
      const field = fieldByName.has(fieldName)
        ? fieldName as CatalogCsvCanonicalField
        : "componentType";
      errors.push(rowError(
        issueCodeForField(field),
        field,
        index.get(field)?.header ?? null,
      ));
    }
    return { command: null, errors: errors.slice(0, 20), sku };
  }
  return { command: parsed.data, errors: [], sku };
}

function issueCodeForField(field: CatalogCsvCanonicalField): CatalogCsvRowErrorCode {
  if (field.endsWith("ObservedOn")) return "invalid_date";
  if (field.endsWith("DocumentSha256")) return "invalid_sha256";
  if (field.includes("PriceNet")) return "invalid_money";
  if (technicalFieldSet.has(field)) return "invalid_technical_shape";
  return "invalid_value";
}

const technicalFieldSet = new Set<CatalogCsvCanonicalField>([
  "nominalPowerWatts",
  "nominalAcPowerWatts",
  "phaseCount",
  "mpptTrackerCount",
  "nominalCapacityWh",
  "usableCapacityWh",
  "maxContinuousPowerWatts",
  "roundTripEfficiencyPercent",
  "backupCapability",
  "maxChargingPowerWatts",
  "connector",
  "bidirectionalCapability",
  "nominalHeatingPowerWatts",
  "scop",
  "systemName",
  "roofTypes",
  "attributes",
]);

function previewRowBody(row: CatalogCsvPreviewRowV1): Record<string, unknown> {
  return row.status === "valid"
    ? {
        status: row.status,
        rowNumber: row.rowNumber,
        normalizedSku: row.normalizedSku,
        commandSha256: row.commandSha256,
        command: row.command,
      }
    : {
        status: row.status,
        rowNumber: row.rowNumber,
        normalizedSku: row.normalizedSku,
        errors: row.errors,
      };
}

function previewRowBodyCanonical(row: CatalogCsvPreviewRowV1): string {
  return boundedCanonicalBody(
    canonicalizeCatalogJson(previewRowBody(row)),
    CATALOG_CSV_PREVIEW_ROW_CANONICAL_MAX_BYTES,
    "Import-Preview-Zeilenbody",
  );
}

function previewRowSha256(row: CatalogCsvPreviewRowV1): string {
  return sha256(previewRowBodyCanonical(row));
}

export function catalogCsvPreviewRowPersistenceEnvelope(value: unknown): {
  row: CatalogCsvPreviewRowV1;
  bodyCanonical: string;
  rowSha256: string;
} {
  const row = previewRowSchema.parse(value);
  const bodyCanonical = previewRowBodyCanonical(row);
  const rowSha256 = sha256(bodyCanonical);
  if (row.rowSha256 !== rowSha256) {
    throw new TypeError("Import-Preview-Zeilenhash driftet.");
  }
  if (
    row.status === "valid"
    && (
      row.normalizedSku !== row.command.internalSku
      || row.commandSha256 !== sha256(canonicalizeCatalogJson(row.command))
    )
  ) {
    throw new TypeError("Import-Preview-Zeilencommand driftet.");
  }
  return { row, bodyCanonical, rowSha256 };
}

function sealPreviewRow(
  row: Omit<z.infer<typeof validRowSchema>, "rowSha256">
    | Omit<z.infer<typeof invalidRowSchema>, "rowSha256">,
): CatalogCsvPreviewRowV1 {
  const candidate = { ...row, rowSha256: "0".repeat(64) } as CatalogCsvPreviewRowV1;
  return { ...candidate, rowSha256: previewRowSha256(candidate) } as CatalogCsvPreviewRowV1;
}

const catalogCsvCatalogConflictSchema = z.strictObject({
  rowNumber: z.int().safe().min(2).max(CATALOG_CSV_MAX_ROWS + 1),
  code: z.enum([
    "sku_type_conflict",
    "archived_requires_manual_reactivation",
  ]),
});

/**
 * Re-seals parser-valid rows that conflict with the current catalog state.
 * The persisted error intentionally contains neither the source command nor
 * any price, technical or provenance value.
 */
export function applyCatalogCsvPreviewCatalogConflicts(
  value: CatalogCsvPreviewV1,
  conflicts: readonly CatalogCsvCatalogConflict[],
): CatalogCsvPreviewV1 {
  const preview = catalogCsvPreviewV1Schema.parse(value);
  const parsedConflicts = z.array(catalogCsvCatalogConflictSchema)
    .max(CATALOG_CSV_MAX_ROWS)
    .parse(conflicts);
  const byRowNumber = new Map<number, CatalogCsvCatalogConflictCode>();
  for (const conflict of parsedConflicts) {
    if (byRowNumber.has(conflict.rowNumber)) {
      throw new TypeError("Katalogkonflikt ist fuer eine Zeile mehrfach angegeben.");
    }
    const row = preview.rows[conflict.rowNumber - 2];
    if (row === undefined || row.rowNumber !== conflict.rowNumber) {
      throw new TypeError("Katalogkonflikt verweist auf eine unbekannte Zeile.");
    }
    if (row.status !== "valid") {
      throw new TypeError("Katalogkonflikt darf nur eine valide Zeile ersetzen.");
    }
    byRowNumber.set(conflict.rowNumber, conflict.code);
  }
  const internalSkuHeader = preview.mapping.columns.find(
    (entry) => entry.field === "internalSku",
  )?.sourceHeader;
  if (internalSkuHeader === undefined) {
    throw new TypeError("Katalogkonflikt besitzt keine SKU-Spaltenbindung.");
  }
  const rows = preview.rows.map((row) => {
    const code = byRowNumber.get(row.rowNumber);
    if (code === undefined) return row;
    if (row.status !== "valid") {
      throw new TypeError("Katalogkonflikt darf nur eine valide Zeile ersetzen.");
    }
    return sealPreviewRow({
      status: "invalid",
      rowNumber: row.rowNumber,
      normalizedSku: row.normalizedSku,
      errors: [rowError(code, "internalSku", internalSkuHeader)],
    });
  });
  const invalid = rows.filter((row) => row.status === "invalid").length;
  return catalogCsvPreviewV1Schema.parse({
    ...preview,
    counts: {
      total: rows.length,
      valid: rows.length - invalid,
      invalid,
    },
    rows,
  });
}

export function parseCatalogCsvPreview(input: {
  filename: string;
  bytes: Uint8Array;
  mapping: CatalogCsvColumnMappingV1;
}): CatalogCsvPreviewV1 {
  const { inspection, rows } = parsedFile(input);
  const normalizedMapping = normalizeCatalogCsvMapping(input.mapping);
  const index = mappingIndex(normalizedMapping, inspection.headers);
  const mappingSha256 = sha256(canonicalizeCatalogJson(normalizedMapping));
  const previewRows: CatalogCsvPreviewRowV1[] = rows.map((cells, dataIndex) => {
    const rowNumber = dataIndex + 2;
    const values = mappedValues(cells, index);
    if (cells.every((cell) => cell.trim() === "")) {
      return sealPreviewRow({
        status: "invalid",
        rowNumber,
        normalizedSku: null,
        errors: [rowError("empty_row", null, null)],
      });
    }
    if (cells.some((cell) => [...cell].length > CATALOG_CSV_MAX_CELL_CHARS)) {
      return sealPreviewRow({
        status: "invalid",
        rowNumber,
        normalizedSku: null,
        errors: [rowError("row_too_large", null, null)],
      });
    }
    const parsed = parseCommand(values, index);
    if (parsed.command === null) {
      return sealPreviewRow({
        status: "invalid",
        rowNumber,
        normalizedSku: parsed.sku,
        errors: parsed.errors,
      });
    }
    return sealPreviewRow({
      status: "valid",
      rowNumber,
      normalizedSku: parsed.command.internalSku,
      commandSha256: sha256(canonicalizeCatalogJson(parsed.command)),
      command: parsed.command,
    });
  });

  const skuRows = new Map<string, number[]>();
  for (const [rowIndex, row] of previewRows.entries()) {
    if (row.normalizedSku === null) continue;
    const indexes = skuRows.get(row.normalizedSku) ?? [];
    indexes.push(rowIndex);
    skuRows.set(row.normalizedSku, indexes);
  }
  for (const indexes of skuRows.values()) {
    if (indexes.length < 2) continue;
    for (const rowIndex of indexes) {
      const row = previewRows[rowIndex]!;
      previewRows[rowIndex] = sealPreviewRow({
        status: "invalid",
        rowNumber: row.rowNumber,
        normalizedSku: row.normalizedSku,
        errors: [rowError("duplicate_sku_in_file", "internalSku", index.get("internalSku")?.header ?? null)],
      });
    }
  }

  const valid = previewRows.filter((row) => row.status === "valid").length;
  const persistedFile = persistedFileSchema.parse({
    filename: inspection.filename,
    sizeBytes: inspection.sizeBytes,
    sha256: inspection.sha256,
    encoding: inspection.encoding,
    delimiter: inspection.delimiter,
    parserVersion: inspection.parserVersion,
    rowCount: inspection.rowCount,
  });
  return catalogCsvPreviewV1Schema.parse({
    schemaVersion: CATALOG_CSV_IMPORT_CONTRACT_VERSION,
    file: persistedFile,
    mapping: normalizedMapping,
    mappingSha256,
    counts: { total: previewRows.length, valid, invalid: previewRows.length - valid },
    rows: previewRows,
  });
}

function catalogCsvErrorReportVariant<const Code extends CatalogCsvRowErrorCode>(
  code: Code,
) {
  return catalogCsvRowErrorVariant(code).extend({
    rowNumber: z.int().safe().min(2).max(CATALOG_CSV_MAX_ROWS + 1),
  });
}

export const catalogCsvErrorReportRowV1Schema = z.discriminatedUnion("code", [
  catalogCsvErrorReportVariant("empty_row"),
  catalogCsvErrorReportVariant("missing_mapping"),
  catalogCsvErrorReportVariant("missing_value"),
  catalogCsvErrorReportVariant("invalid_value"),
  catalogCsvErrorReportVariant("invalid_money"),
  catalogCsvErrorReportVariant("invalid_date"),
  catalogCsvErrorReportVariant("invalid_enum"),
  catalogCsvErrorReportVariant("invalid_sha256"),
  catalogCsvErrorReportVariant("invalid_technical_shape"),
  catalogCsvErrorReportVariant("duplicate_sku_in_file"),
  catalogCsvErrorReportVariant("sku_type_conflict"),
  catalogCsvErrorReportVariant("archived_requires_manual_reactivation"),
  catalogCsvErrorReportVariant("mapping_conflict"),
  catalogCsvErrorReportVariant("row_too_large"),
  catalogCsvErrorReportVariant("parser_error"),
]);

export type CatalogCsvErrorReportRowV1 = z.infer<typeof catalogCsvErrorReportRowV1Schema>;

export function catalogCsvErrorReportRows(
  input: CatalogCsvPreviewV1,
): CatalogCsvErrorReportRowV1[] {
  const preview = catalogCsvPreviewV1Schema.parse(input);
  return preview.rows.flatMap((row) => row.status === "invalid"
    ? row.errors.map((error) => catalogCsvErrorReportRowV1Schema.parse({
        rowNumber: row.rowNumber,
        field: error.field,
        sourceHeader: error.sourceHeader,
        code: error.code,
        message: error.message,
      }))
    : []);
}

function formulaSafeCsvValue(value: string): string {
  return /^[=+\-@\t\r]/u.test(value) ? `'${value}` : value;
}

export function renderCatalogCsvErrorReport(
  input: readonly CatalogCsvErrorReportRowV1[],
): string {
  const rows = z.array(catalogCsvErrorReportRowV1Schema).max(
    CATALOG_CSV_MAX_ROWS * 20,
  ).parse(input);
  const header = ["Zeile", "Feld", "Quellspalte", "Code", "Meldung"];
  const lines = rows.map((row) => [
    String(row.rowNumber),
    row.field ?? "",
    row.sourceHeader ?? "",
    row.code,
    row.message,
  ].map((value) => csvCell(formulaSafeCsvValue(value))).join(";"));
  return `\uFEFF${header.join(";")}\r\n${lines.length > 0 ? `${lines.join("\r\n")}\r\n` : ""}`;
}

const catalogImportExpectedComponentV1Schema = z.strictObject({
  componentId: catalogImportUuidSchema,
  revision: z.int().safe().min(1).max(2_147_483_647),
  status: z.enum(["draft", "active"]),
  snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  internalSku: catalogImportSkuSchema,
  componentType: z.enum([
    "module",
    "inverter",
    "battery",
    "wallbox",
    "heat_pump",
    "mounting",
    "other",
  ]),
});

const catalogImportTargetIdentityV1Schema = catalogComponentRevisionV1Schema.shape.identity.extend({
  workspaceId: catalogImportUuidSchema,
  componentId: catalogImportUuidSchema,
  revision: z.int().safe().min(1).max(2_147_483_647),
  internalSku: catalogImportSkuSchema,
});

const catalogImportTargetSharedShape = {
  commercial: catalogCsvCommercialV1Schema,
  technicalProvenance: catalogCsvProvenanceV1Schema,
} as const;

// Keep these constraints structural. Refinements on the shared component
// contract are intentionally not the only line of defence because JSON Schema
// cannot render those refinements and would otherwise accept impossible
// componentType/technicalData/unit combinations.
const catalogImportTargetRevisionV1Schema = z.union([
  catalogComponentRevisionV1Schema.safeExtend({
    ...catalogImportTargetSharedShape,
    identity: catalogImportTargetIdentityV1Schema.extend({
      componentType: z.literal("module"),
    }),
    presentation: catalogCsvPiecePresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[0],
  }),
  catalogComponentRevisionV1Schema.safeExtend({
    ...catalogImportTargetSharedShape,
    identity: catalogImportTargetIdentityV1Schema.extend({
      componentType: z.literal("inverter"),
    }),
    presentation: catalogCsvPiecePresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[1],
  }),
  catalogComponentRevisionV1Schema.safeExtend({
    ...catalogImportTargetSharedShape,
    identity: catalogImportTargetIdentityV1Schema.extend({
      componentType: z.literal("battery"),
    }),
    presentation: catalogCsvPiecePresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[2],
  }),
  catalogComponentRevisionV1Schema.safeExtend({
    ...catalogImportTargetSharedShape,
    identity: catalogImportTargetIdentityV1Schema.extend({
      componentType: z.literal("wallbox"),
    }),
    presentation: catalogCsvPiecePresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[3],
  }),
  catalogComponentRevisionV1Schema.safeExtend({
    ...catalogImportTargetSharedShape,
    identity: catalogImportTargetIdentityV1Schema.extend({
      componentType: z.literal("heat_pump"),
    }),
    presentation: catalogCsvPiecePresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[4],
  }),
  catalogComponentRevisionV1Schema.safeExtend({
    ...catalogImportTargetSharedShape,
    identity: catalogImportTargetIdentityV1Schema.extend({
      componentType: z.literal("mounting"),
    }),
    presentation: catalogCsvPresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[5],
  }),
  catalogComponentRevisionV1Schema.safeExtend({
    ...catalogImportTargetSharedShape,
    identity: catalogImportTargetIdentityV1Schema.extend({
      componentType: z.literal("other"),
    }),
    presentation: catalogCsvPresentationV1Schema,
    technicalData: catalogTechnicalDataV1Schema.options[6],
  }),
]);

const catalogImportSealedTargetV1Schema = z.strictObject({
  snapshot: catalogImportTargetRevisionV1Schema,
  bodyCanonicalBase64: z.string().min(4).max(1_000_000)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
  snapshotSha256: z.string().regex(/^[0-9a-f]{64}$/u),
});

const catalogImportRowCommandSharedShape = {
  schemaVersion: z.literal(CATALOG_IMPORT_ROW_COMMAND_VERSION),
  source: z.strictObject({
    fileSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    mappingSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    rowNumber: z.int().safe().min(2).max(CATALOG_CSV_MAX_ROWS + 1),
    rowSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    sourceCommandSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  targetComponentId: catalogImportUuidSchema,
  sourceCommand: validRowSchema.shape.command,
} as const;

const catalogImportRowCommandBodyV1Schema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...catalogImportRowCommandSharedShape,
    operation: z.literal("create"),
    expected: z.null(),
    sealedTarget: catalogImportSealedTargetV1Schema,
  }),
  z.strictObject({
    ...catalogImportRowCommandSharedShape,
    operation: z.literal("revise"),
    expected: catalogImportExpectedComponentV1Schema,
    sealedTarget: catalogImportSealedTargetV1Schema,
  }),
  z.strictObject({
    ...catalogImportRowCommandSharedShape,
    operation: z.literal("unchanged"),
    expected: catalogImportExpectedComponentV1Schema,
    sealedTarget: z.null(),
  }),
]);

export const catalogImportRowCommandV1Schema = z.discriminatedUnion("operation", [
  catalogImportRowCommandBodyV1Schema.options[0].extend({
    rowCommandSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  catalogImportRowCommandBodyV1Schema.options[1].extend({
    rowCommandSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  catalogImportRowCommandBodyV1Schema.options[2].extend({
    rowCommandSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
]);

export type CatalogImportExpectedComponentV1 = z.infer<
  typeof catalogImportExpectedComponentV1Schema
>;
export type CatalogImportRowCommandV1 = z.infer<typeof catalogImportRowCommandV1Schema>;
type CatalogCsvValidPreviewRowV1 = z.infer<typeof validRowSchema>;

const catalogImportPreparedValidRowV1Schema = z.strictObject({
  status: z.literal("valid"),
  command: catalogImportRowCommandV1Schema,
});

export const catalogImportPrepareV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_IMPORT_PREPARE_VERSION),
  file: persistedFileSchema,
  mapping: catalogCsvColumnMappingV1Schema,
  rows: z.array(z.union([
    catalogImportPreparedValidRowV1Schema,
    invalidRowSchema,
  ])).min(1).max(CATALOG_CSV_MAX_ROWS),
}).superRefine((value, context) => {
  if (value.file.rowCount !== value.rows.length) {
    context.addIssue({
      code: "custom",
      path: ["file", "rowCount"],
      message: "Prepare-Zeilenzaehler driftet.",
    });
  }
  const normalizedMapping = normalizeCatalogCsvMapping(value.mapping);
  if (canonicalizeCatalogJson(value.mapping) !== canonicalizeCatalogJson(normalizedMapping)) {
    context.addIssue({
      code: "custom",
      path: ["mapping"],
      message: "Prepare-Mapping ist nicht kanonisch sortiert.",
    });
  }
  const mappingSha256 = sha256(canonicalizeCatalogJson(normalizedMapping));
  const validSkus = new Set<string>();
  value.rows.forEach((row, index) => {
    const expectedRowNumber = index + 2;
    const rowNumber = row.status === "valid"
      ? row.command.source.rowNumber
      : row.rowNumber;
    if (rowNumber !== expectedRowNumber) {
      context.addIssue({
        code: "custom",
        path: ["rows", index],
        message: "Prepare-Zeilenfolge driftet.",
      });
    }
    if (row.status !== "valid") return;
    try {
      assertCatalogImportRowCommandSemantics(row.command);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["rows", index, "command"],
        message: "Prepare-Row-Command ist semantisch ungueltig.",
      });
      return;
    }
    if (
      row.command.source.fileSha256 !== value.file.sha256
      || row.command.source.mappingSha256 !== mappingSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["rows", index, "command", "source"],
        message: "Prepare-Datei- oder Mappingbindung driftet.",
      });
    }
    const sku = row.command.sourceCommand.internalSku;
    if (validSkus.has(sku)) {
      context.addIssue({
        code: "custom",
        path: ["rows", index, "command", "sourceCommand", "internalSku"],
        message: "Prepare enthaelt eine doppelte valide SKU.",
      });
    }
    validSkus.add(sku);
  });
});

export type CatalogImportPrepareV1 = z.infer<typeof catalogImportPrepareV1Schema>;

function catalogImportTarget(
  value: CatalogComponentRevisionV1,
): z.infer<typeof catalogImportSealedTargetV1Schema> {
  const validated = validateCatalogComponentRevision(value);
  if (!validated.ok) throw new TypeError("Ungueltiger versiegelter Import-Zielstand.");
  const { snapshotSha256, ...body } = validated.value;
  const canonicalBody = boundedCanonicalBody(
    canonicalizeCatalogJson(body),
    CATALOG_IMPORT_TARGET_CANONICAL_MAX_BYTES,
    "Import-Zielbody",
  );
  if (sha256(canonicalBody) !== snapshotSha256) {
    throw new TypeError("Import-Zielstand und kanonischer Body driften.");
  }
  return catalogImportSealedTargetV1Schema.parse({
    snapshot: validated.value,
    bodyCanonicalBase64: Buffer.from(canonicalBody, "utf8").toString("base64"),
    snapshotSha256,
  });
}

function rowCommandBody(
  value: CatalogImportRowCommandV1,
): z.infer<typeof catalogImportRowCommandBodyV1Schema> {
  return catalogImportRowCommandBodyV1Schema.parse({
    schemaVersion: value.schemaVersion,
    source: value.source,
    operation: value.operation,
    targetComponentId: value.targetComponentId,
    expected: value.expected,
    sourceCommand: value.sourceCommand,
    sealedTarget: value.sealedTarget,
  });
}

function assertCatalogImportRowCommandSemantics(value: CatalogImportRowCommandV1): void {
  const sourceCommandBodyCanonical = boundedCanonicalBody(
    canonicalizeCatalogJson(value.sourceCommand),
    CATALOG_IMPORT_SOURCE_COMMAND_CANONICAL_MAX_BYTES,
    "Import-Quellcommandbody",
  );
  const sourceCommandSha256 = sha256(sourceCommandBodyCanonical);
  if (sourceCommandSha256 !== value.source.sourceCommandSha256) {
    throw new TypeError("Import-Quellcommandhash driftet.");
  }
  const sourceRow = {
    status: "valid" as const,
    rowNumber: value.source.rowNumber,
    rowSha256: value.source.rowSha256,
    normalizedSku: value.sourceCommand.internalSku,
    commandSha256: value.source.sourceCommandSha256,
    command: value.sourceCommand,
  };
  if (previewRowSha256(sourceRow) !== value.source.rowSha256) {
    throw new TypeError("Import-Zeilenbindung driftet.");
  }
  const rowCommandBodyCanonical = boundedCanonicalBody(
    canonicalizeCatalogJson(rowCommandBody(value)),
    CATALOG_IMPORT_ROW_COMMAND_CANONICAL_MAX_BYTES,
    "Import-Row-Commandbody",
  );
  if (sha256(rowCommandBodyCanonical) !== value.rowCommandSha256) {
    throw new TypeError("Import-Row-Commandhash driftet.");
  }

  const expected = value.expected;
  const sealedTarget = value.sealedTarget;
  if (value.operation === "create") {
    if (expected !== null || sealedTarget === null) {
      throw new TypeError("Create braucht genau einen Zielstand ohne Expected-Bindung.");
    }
  } else if (expected === null || expected.componentId !== value.targetComponentId) {
    throw new TypeError("Bestehende Produkte brauchen eine exakte Expected-Bindung.");
  }
  if (value.operation === "unchanged" && sealedTarget !== null) {
    throw new TypeError("Unchanged darf keinen neuen Zielstand enthalten.");
  }
  if (value.operation === "revise" && sealedTarget === null) {
    throw new TypeError("Revise braucht einen versiegelten Zielstand.");
  }
  if (
    expected !== null
    && (
      expected.internalSku !== value.sourceCommand.internalSku
      || expected.componentType !== value.sourceCommand.componentType
    )
  ) {
    throw new TypeError("Expected-Identitaet und Quellcommand driften.");
  }
  if (sealedTarget === null) return;

  const validatedTarget = validateCatalogComponentRevision(sealedTarget.snapshot);
  if (!validatedTarget.ok) throw new TypeError("Import-Zielstand ist nicht versiegelt.");
  const target = validatedTarget.value;
  const { snapshotSha256, ...targetBody } = target;
  const canonicalBody = boundedCanonicalBody(
    canonicalizeCatalogJson(targetBody),
    CATALOG_IMPORT_TARGET_CANONICAL_MAX_BYTES,
    "Import-Zielbody",
  );
  const decodedBody = Buffer.from(sealedTarget.bodyCanonicalBase64, "base64");
  if (
    decodedBody.toString("base64") !== sealedTarget.bodyCanonicalBase64
    || decodedBody.toString("utf8") !== canonicalBody
    || sha256(decodedBody) !== snapshotSha256
    || sealedTarget.snapshotSha256 !== snapshotSha256
  ) {
    throw new TypeError("Import-Zielbody und Zielhash driften.");
  }
  if (
    target.identity.componentId !== value.targetComponentId
    || target.identity.internalSku !== value.sourceCommand.internalSku
    || target.identity.componentType !== value.sourceCommand.componentType
  ) {
    throw new TypeError("Import-Zielidentitaet driftet.");
  }
  const sourcePayload = canonicalizeCatalogJson({
    presentation: value.sourceCommand.presentation,
    technicalData: value.sourceCommand.technicalData,
    commercial: value.sourceCommand.commercial,
    technicalProvenance: value.sourceCommand.technicalProvenance,
  });
  const targetPayload = canonicalizeCatalogJson({
    presentation: target.presentation,
    technicalData: target.technicalData,
    commercial: target.commercial,
    technicalProvenance: target.technicalProvenance,
  });
  if (sourcePayload !== targetPayload) {
    throw new TypeError("Import-Zielnutzdaten und Quellcommand driften.");
  }
  if (value.operation === "create" && target.identity.revision !== 1) {
    throw new TypeError("Create muss Revision 1 versiegeln.");
  }
  if (
    value.operation === "revise"
    && (expected === null || target.identity.revision !== expected.revision + 1)
  ) {
    throw new TypeError("Revise muss exakt die Folgerevision versiegeln.");
  }
}

export function sealCatalogImportRowCommand(input: {
  fileSha256: string;
  mappingSha256: string;
  sourceRow: CatalogCsvValidPreviewRowV1;
  operation: "create" | "revise" | "unchanged";
  targetComponentId: string;
  expected: CatalogImportExpectedComponentV1 | null;
  sealedTarget: CatalogComponentRevisionV1 | null;
}): CatalogImportRowCommandV1 {
  const sourceRow = validRowSchema.parse(input.sourceRow);
  if (
    sourceRow.normalizedSku !== sourceRow.command.internalSku
    || sourceRow.commandSha256 !== sha256(canonicalizeCatalogJson(sourceRow.command))
    || sourceRow.rowSha256 !== previewRowSha256(sourceRow)
  ) {
    throw new TypeError("Ungueltige Preview-Zeilenbindung.");
  }
  const body = catalogImportRowCommandBodyV1Schema.parse({
    schemaVersion: CATALOG_IMPORT_ROW_COMMAND_VERSION,
    source: {
      fileSha256: input.fileSha256,
      mappingSha256: input.mappingSha256,
      rowNumber: sourceRow.rowNumber,
      rowSha256: sourceRow.rowSha256,
      sourceCommandSha256: sourceRow.commandSha256,
    },
    operation: input.operation,
    targetComponentId: input.targetComponentId,
    expected: input.expected,
    sourceCommand: sourceRow.command,
    sealedTarget: input.sealedTarget === null ? null : catalogImportTarget(input.sealedTarget),
  });
  return parseCatalogImportRowCommand({
    ...body,
    rowCommandSha256: sha256(canonicalizeCatalogJson(body)),
  });
}

export function parseCatalogImportRowCommand(value: unknown): CatalogImportRowCommandV1 {
  const parsed = catalogImportRowCommandV1Schema.safeParse(value);
  if (!parsed.success) throw new TypeError("Ungueltiger persistierter Import-Row-Command.");
  assertCatalogImportRowCommandSemantics(parsed.data);
  return parsed.data;
}

export function parseCatalogImportPrepareV1(
  value: unknown,
  context: { workspaceId: string },
): CatalogImportPrepareV1 {
  const workspaceId = catalogImportUuidSchema.parse(context.workspaceId);
  const prepared = catalogImportPrepareV1Schema.parse(value);
  prepared.rows.forEach((row) => {
    if (
      row.status === "valid"
      && row.command.sealedTarget !== null
      && row.command.sealedTarget.snapshot.identity.workspaceId !== workspaceId
    ) {
      throw new TypeError("Prepare-Zielstand gehoert zu einem anderen Workspace.");
    }
  });
  return prepared;
}

export function sealCatalogImportPrepareV1(input: {
  workspaceId: string;
  preview: unknown;
  rows: readonly unknown[];
}): CatalogImportPrepareV1 {
  const preview = catalogCsvPreviewV1Schema.parse(input.preview);
  if (input.rows.length !== preview.rows.length) {
    throw new TypeError("Prepare und Preview besitzen unterschiedliche Zeilenzahlen.");
  }
  const rows = input.rows.map((candidate, index) => {
    const previewRow = preview.rows[index];
    if (!previewRow) throw new TypeError("Prepare-Zeile fehlt.");
    if (previewRow.status === "invalid") {
      const invalid = invalidRowSchema.parse(candidate);
      if (canonicalizeCatalogJson(invalid) !== canonicalizeCatalogJson(previewRow)) {
        throw new TypeError("Prepare-Fehlerzeile driftet von der Preview.");
      }
      return invalid;
    }
    const valid = catalogImportPreparedValidRowV1Schema.parse(candidate);
    if (
      valid.command.source.rowNumber !== previewRow.rowNumber
      || valid.command.source.rowSha256 !== previewRow.rowSha256
      || valid.command.source.sourceCommandSha256 !== previewRow.commandSha256
      || canonicalizeCatalogJson(valid.command.sourceCommand)
        !== canonicalizeCatalogJson(previewRow.command)
    ) {
      throw new TypeError("Prepare-Command driftet von der Preview.");
    }
    return valid;
  });
  return parseCatalogImportPrepareV1({
    schemaVersion: CATALOG_IMPORT_PREPARE_VERSION,
    file: preview.file,
    mapping: normalizeCatalogCsvMapping(preview.mapping),
    rows,
  }, { workspaceId: input.workspaceId });
}

export function catalogImportReservationSha256(input: {
  intentId: string;
  preview: Pick<CatalogCsvPreviewV1, "file" | "mapping">;
}): string {
  const intentId = catalogImportUuidSchema.parse(input.intentId);
  const file = persistedFileSchema.parse(input.preview.file);
  const mapping = normalizeCatalogCsvMapping(input.preview.mapping);
  return sha256(canonicalizeCatalogJson({
    intentId,
    contractVersion: CATALOG_CSV_IMPORT_CONTRACT_VERSION,
    fileSha256: file.sha256,
    encoding: file.encoding,
    delimiter: file.delimiter,
    mapping,
  }));
}

export function catalogImportRowPersistenceEnvelope(value: unknown): {
  command: CatalogImportRowCommandV1;
  previewRowBodyCanonical: string;
  sourceCommandBodyCanonical: string;
  sourceCommandSha256: string;
  rowCommandBodyCanonical: string;
  rowCommandSha256: string;
  sealedTargetBodyCanonical: string | null;
  targetSnapshotSha256: string;
} {
  const command = parseCatalogImportRowCommand(value);
  const previewRowBodyCanonical = catalogCsvPreviewRowPersistenceEnvelope({
    status: "valid",
    rowNumber: command.source.rowNumber,
    rowSha256: command.source.rowSha256,
    normalizedSku: command.sourceCommand.internalSku,
    commandSha256: command.source.sourceCommandSha256,
    command: command.sourceCommand,
  }).bodyCanonical;
  const sourceCommandBodyCanonical = boundedCanonicalBody(
    canonicalizeCatalogJson(command.sourceCommand),
    CATALOG_IMPORT_SOURCE_COMMAND_CANONICAL_MAX_BYTES,
    "Import-Quellcommandbody",
  );
  const rowCommandBodyCanonical = boundedCanonicalBody(
    canonicalizeCatalogJson(rowCommandBody(command)),
    CATALOG_IMPORT_ROW_COMMAND_CANONICAL_MAX_BYTES,
    "Import-Row-Commandbody",
  );
  const sealedTargetBodyCanonical = command.sealedTarget === null
    ? null
    : Buffer.from(command.sealedTarget.bodyCanonicalBase64, "base64").toString("utf8");
  const targetSnapshotSha256 = command.sealedTarget?.snapshotSha256
    ?? command.expected?.snapshotSha256;
  if (targetSnapshotSha256 === undefined) {
    throw new TypeError("Import-Row-Command besitzt keinen Zielhash.");
  }
  return {
    command,
    previewRowBodyCanonical,
    sourceCommandBodyCanonical,
    sourceCommandSha256: command.source.sourceCommandSha256,
    rowCommandBodyCanonical,
    rowCommandSha256: command.rowCommandSha256,
    sealedTargetBodyCanonical,
    targetSnapshotSha256,
  };
}

function csvCell(value: string): string {
  return /[;"\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function catalogCsvTemplate(): string {
  const example: Partial<Record<CatalogCsvCanonicalField, string>> = {
    internalSku: "BEISPIEL-PV-440",
    componentType: "module",
    displayName: "Synthetisches Beispielmodul",
    manufacturer: "Eigener Herstellerwert",
    model: "Beispiel 440",
    unit: "piece",
    keyPoints: "eigene Daten|vor Import pruefen",
    technicalSourceKind: "manufacturer_datasheet",
    technicalReference: "Eigene autorisierte Quelle",
    technicalObservedOn: "2026-08-31",
    technicalRightsBasis: "manufacturer_published",
    purchasePriceNet: "79,00",
    purchaseSourceKind: "supplier_price_list",
    purchaseReference: "Eigene autorisierte Preisliste",
    purchaseObservedOn: "2026-08-31",
    purchaseRightsBasis: "supplier_authorized",
    salesPriceNet: "129,00",
    salesSourceKind: "workspace_pricing",
    salesReference: "Eigene Kalkulation",
    salesObservedOn: "2026-08-31",
    salesRightsBasis: "workspace_owned",
    nominalPowerWatts: "440",
  };
  return `\uFEFF${canonicalFields.join(";")}\r\n${canonicalFields.map((field) => (
    csvCell(example[field] ?? "")
  )).join(";")}\r\n`;
}

function rewriteEmbeddedJsonSchemaRefs(
  value: unknown,
  definitionName: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteEmbeddedJsonSchemaRefs(entry, definitionName));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (key === "$ref" && typeof entry === "string" && entry.startsWith("#/$defs/")) {
      return [key, `#/$defs/${definitionName}/$defs/${entry.slice("#/$defs/".length)}`];
    }
    return [key, rewriteEmbeddedJsonSchemaRefs(entry, definitionName)];
  }));
}

function jsonSchemaFor(
  definitionName: string,
  schema: z.ZodType,
): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    cycles: "ref",
    reused: "ref",
  }) as Record<string, unknown>;
  const body = { ...generated };
  delete body.$schema;
  return rewriteEmbeddedJsonSchemaRefs(body, definitionName) as Record<string, unknown>;
}

export function renderCatalogCsvImportJsonSchema(): string {
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://contracts.wmee.internal/catalog-csv-import.v1.schema.json",
    title: "WMEE Catalog CSV Import v1",
    "x-rights-attestation": {
      version: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
      text: CATALOG_IMPORT_RIGHTS_ATTESTATION_TEXT,
      sha256: CATALOG_IMPORT_RIGHTS_ATTESTATION_SHA256,
    },
    oneOf: [
      { $ref: "#/$defs/mapping" },
      { $ref: "#/$defs/preview" },
      { $ref: "#/$defs/rowError" },
      { $ref: "#/$defs/errorReportRow" },
      { $ref: "#/$defs/rowCommand" },
      { $ref: "#/$defs/requestErrorCode" },
      { $ref: "#/$defs/processingResultCode" },
      { $ref: "#/$defs/jobErrorCode" },
    ],
    $defs: {
      mapping: jsonSchemaFor("mapping", catalogCsvColumnMappingV1Schema),
      preview: jsonSchemaFor("preview", catalogCsvPreviewV1Schema),
      rowError: jsonSchemaFor("rowError", catalogCsvRowErrorV1Schema),
      errorReportRow: jsonSchemaFor(
        "errorReportRow",
        catalogCsvErrorReportRowV1Schema,
      ),
      rowCommand: jsonSchemaFor("rowCommand", catalogImportRowCommandV1Schema),
      requestErrorCode: jsonSchemaFor(
        "requestErrorCode",
        catalogCsvRequestErrorCodeSchema,
      ),
      processingResultCode: jsonSchemaFor(
        "processingResultCode",
        catalogCsvProcessingResultCodeSchema,
      ),
      jobErrorCode: jsonSchemaFor("jobErrorCode", catalogCsvJobErrorCodeSchema),
    },
    "x-semantic-invariants": [
      "browser header inspection is advisory; only the server parser and mapping are authoritative",
      "workspace, actor, identifiers, revisions, lifecycle status, assets, and activation are never CSV fields",
      "money is parsed as a decimal string and converted exactly to safe integer EUR/net cents",
      "roundTripEfficiencyPercent and scop accept at most two decimals and are converted without rounding to basis points or hundredths",
      "other.attributes is exclusively an RFC 8259 JSON array of strict name/value objects",
      "invalid rows contain only row number, canonical field, source header, stable code, and fixed message; never raw row values",
      "duplicate normalized SKUs invalidate every duplicate row before persistence",
      "file, canonical mapping, sanitized row, and source command SHA-256 values bind the persisted preview",
      "a transient valid preview row contains exactly a catalog-component-create-command.v1 and creates no catalog mutation",
      "a persisted catalog-import-row-command.v1 binds every operation to immutable source; revise and unchanged also bind expected state; only create and revise bind canonical sealed target bytes, while unchanged requires no sealed target",
    ],
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
