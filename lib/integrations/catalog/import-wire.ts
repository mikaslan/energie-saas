export const CATALOG_CSV_PREVIEW_MEDIA_TYPE =
  "application/vnd.wmee.catalog-csv-preview.v1" as const;
export const CATALOG_CSV_PREVIEW_WIRE_VERSION =
  "catalog-csv-preview-wire.v1" as const;
export const CATALOG_CSV_WIRE_MAX_METADATA_BYTES = 32 * 1024;
export const CATALOG_CSV_MAPPING_VERSION = "catalog-csv-column-mapping.v1" as const;
export const CATALOG_CSV_MAX_BYTES = 1_048_576;
export const CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION =
  "catalog-import-rights-attestation.v1" as const;
export const CATALOG_IMPORT_RIGHTS_ATTESTATION_TEXT =
  "Ich bestätige, dass dieser Workspace zur Verarbeitung und Nutzung der in dieser CSV enthaltenen Produkt-, Preis- und Provenienzdaten berechtigt ist." as const;
export const CATALOG_IMPORT_RIGHTS_ATTESTATION_SHA256 =
  "4511413a407acc4c073184ecbb127b449b13c72db28fe8b1682ba17cced1b4f8" as const;

export const CATALOG_IMPORT_JOB_STATES = [
  "ready_for_review",
  "queued",
  "running",
  "retry_wait",
  "succeeded",
  "partial",
  "failed_final",
  "cancelled_before_start",
] as const;

export type CatalogImportJobState = typeof CATALOG_IMPORT_JOB_STATES[number];

export const CATALOG_CSV_CANONICAL_FIELDS = [
  "internalSku",
  "componentType",
  "displayName",
  "manufacturer",
  "model",
  "unit",
  "keyPoints",
  "technicalSourceKind",
  "technicalReference",
  "technicalObservedOn",
  "technicalRightsBasis",
  "technicalDocumentSha256",
  "purchasePriceNet",
  "purchaseSourceKind",
  "purchaseReference",
  "purchaseObservedOn",
  "purchaseRightsBasis",
  "purchaseDocumentSha256",
  "salesPriceNet",
  "salesSourceKind",
  "salesReference",
  "salesObservedOn",
  "salesRightsBasis",
  "salesDocumentSha256",
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
] as const;

export type CatalogCsvCanonicalField = typeof CATALOG_CSV_CANONICAL_FIELDS[number];

export const CATALOG_CSV_REQUIRED_COMMON_FIELDS = [
  "internalSku",
  "componentType",
  "displayName",
  "manufacturer",
  "model",
  "unit",
  "technicalSourceKind",
  "technicalReference",
  "technicalObservedOn",
  "technicalRightsBasis",
  "purchasePriceNet",
  "purchaseSourceKind",
  "purchaseReference",
  "purchaseObservedOn",
  "purchaseRightsBasis",
  "salesPriceNet",
  "salesSourceKind",
  "salesReference",
  "salesObservedOn",
  "salesRightsBasis",
] as const satisfies readonly CatalogCsvCanonicalField[];

export type CatalogCsvWireMapping = Readonly<{
  schemaVersion: typeof CATALOG_CSV_MAPPING_VERSION;
  columns: readonly Readonly<{
    field: CatalogCsvCanonicalField;
    sourceHeader: string;
  }>[];
}>;

export type CatalogCsvWireMetadata =
  | Readonly<{
      schemaVersion: typeof CATALOG_CSV_PREVIEW_WIRE_VERSION;
      mode: "inspect";
      intentId: string;
      filename: string;
    }>
  | Readonly<{
      schemaVersion: typeof CATALOG_CSV_PREVIEW_WIRE_VERSION;
      mode: "preview";
      intentId: string;
      filename: string;
      mapping: CatalogCsvWireMapping;
    }>;

export function encodeCatalogCsvPreviewEnvelope(
  metadata: CatalogCsvWireMetadata,
  fileBytes: Uint8Array,
): Uint8Array {
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (
    metadataBytes.byteLength < 1
    || metadataBytes.byteLength > CATALOG_CSV_WIRE_MAX_METADATA_BYTES
  ) throw new RangeError("catalog CSV wire metadata exceeds its byte limit");
  if (fileBytes.byteLength < 1 || fileBytes.byteLength > CATALOG_CSV_MAX_BYTES) {
    throw new RangeError("catalog CSV file exceeds its byte limit");
  }
  const body = new Uint8Array(4 + metadataBytes.byteLength + fileBytes.byteLength);
  new DataView(body.buffer).setUint32(0, metadataBytes.byteLength, false);
  body.set(metadataBytes, 4);
  body.set(fileBytes, 4 + metadataBytes.byteLength);
  return body;
}
