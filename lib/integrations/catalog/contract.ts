import { createHash } from "node:crypto";
import { z } from "zod";
import { deriveCatalogSelectionPreview } from "./selection";

export const CATALOG_COMPONENT_CONTRACT_VERSION =
  "catalog-component-revision.v1" as const;
export const PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION =
  "project-catalog-resolution.v1" as const;
export const CATALOG_CANONICALIZATION_VERSION = "catalog-jcs.v1" as const;
export const CATALOG_COMPONENT_CREATE_COMMAND_VERSION =
  "catalog-component-create-command.v1" as const;
export const CATALOG_COMPONENT_DETAILS_COMMAND_VERSION =
  "catalog-component-details-command.v1" as const;
export const CATALOG_COMPONENT_PRICING_COMMAND_VERSION =
  "catalog-component-pricing-command.v1" as const;
export const RESOLVE_PROJECT_CATALOG_COMMAND_VERSION =
  "resolve-project-catalog-command.v1" as const;

// Runtime und gespeicherte Artefakte pinnen den bytegenauen, aus den
// Runtime-Schemas erzeugten Vertrag. Aenderungen brauchen einen bewussten Review.
export const CATALOG_SCHEMA_SHA256 =
  "00fe8d765d635f6a53962a841a3bcba51e9588ed8d111aca5e1179b00493fd9c" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const uuidSchema = z.uuid();
const positiveRevisionSchema = z.int().safe().min(1);
const positiveQuantitySchema = z.int().safe().min(1).max(100_000);
const moneyCentsSchema = z.int().safe().min(0).max(9_000_000_000_000_000);
const dateSchema = z.iso.date();
const utcDateTimeSchema = z.iso.datetime({ offset: true }).regex(/Z$/u);
const boundedTextSchema = z.string().trim().min(1).max(200);

export const catalogComponentTypeSchema = z.enum([
  "module",
  "inverter",
  "battery",
  "wallbox",
  "heat_pump",
  "mounting",
  "other",
]);
export type CatalogComponentType = z.infer<typeof catalogComponentTypeSchema>;

export const catalogComponentStatusSchema = z.enum(["draft", "active", "archived"]);
export type CatalogComponentStatus = z.infer<typeof catalogComponentStatusSchema>;

export function normalizeCatalogSku(value: string): string {
  if (typeof value !== "string") throw new TypeError("SKU muss Text sein.");
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,63}$/u.test(normalized)) {
    throw new TypeError("SKU enthaelt unzulaessige Zeichen.");
  }
  return normalized;
}

const internalSkuSchema = z.string().superRefine((value, context) => {
  try {
    if (normalizeCatalogSku(value) !== value) {
      context.addIssue({ code: "custom", message: "SKU ist nicht normalisiert." });
    }
  } catch {
    context.addIssue({ code: "custom", message: "SKU ist ungueltig." });
  }
});

const provenanceSchema = z.strictObject({
  sourceKind: z.enum([
    "manufacturer_datasheet",
    "supplier_price_list",
    "supplier_quote",
    "workspace_pricing",
    "workspace_manual",
    "csv_import",
    "customer_provided",
  ]),
  reference: z.string().trim().min(1).max(240),
  observedOn: dateSchema,
  rightsBasis: z.enum([
    "manufacturer_published",
    "supplier_authorized",
    "workspace_owned",
    "customer_provided",
  ]),
  sourceDocumentSha256: sha256Schema.nullable(),
});
export const catalogProvenanceV1Schema = provenanceSchema;
export type CatalogProvenanceV1 = z.infer<typeof provenanceSchema>;

const catalogAssetSchema = z.strictObject({
  role: z.enum(["image", "datasheet"]),
  objectKey: z.string().min(1).max(360),
  sha256: sha256Schema,
  mediaType: z.enum([
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]),
  originalFilename: z.string().trim().min(1).max(180),
});
export const catalogAssetV1Schema = catalogAssetSchema;
export type CatalogAssetV1 = z.infer<typeof catalogAssetSchema>;

const capabilitySchema = z.enum([
  "known_supported",
  "known_unsupported",
  "unknown",
]);

const moduleTechnicalDataSchema = z.strictObject({
  schemaVersion: z.literal("module.v1"),
  nominalPowerWatts: z.int().safe().min(1).max(10_000),
});

const inverterTechnicalDataSchema = z.strictObject({
  schemaVersion: z.literal("inverter.v1"),
  nominalAcPowerWatts: z.int().safe().min(1).max(10_000_000),
  phaseCount: z.union([z.literal(1), z.literal(3)]),
  mpptTrackerCount: z.int().safe().min(1).max(100),
});

const batteryTechnicalDataSchema = z.strictObject({
  schemaVersion: z.literal("battery.v1"),
  nominalCapacityWh: z.int().safe().min(1).max(100_000_000),
  usableCapacityWh: z.int().safe().min(1).max(100_000_000),
  maxContinuousPowerWatts: z.int().safe().min(1).max(100_000_000),
  roundTripEfficiencyBasisPoints: z.int().safe().min(1).max(10_000),
  backupCapability: capabilitySchema,
}).superRefine((value, context) => {
  if (value.usableCapacityWh > value.nominalCapacityWh) {
    context.addIssue({
      code: "custom",
      path: ["usableCapacityWh"],
      message: "Nutzbare Kapazitaet darf die nominale Kapazitaet nicht uebersteigen.",
    });
  }
});

const wallboxTechnicalDataSchema = z.strictObject({
  schemaVersion: z.literal("wallbox.v1"),
  maxChargingPowerWatts: z.int().safe().min(1).max(1_000_000),
  phaseCount: z.union([z.literal(1), z.literal(3)]),
  connector: z.enum(["type2_socket", "type2_cable", "other"]),
  bidirectionalCapability: capabilitySchema,
});

const heatPumpTechnicalDataSchema = z.strictObject({
  schemaVersion: z.literal("heat_pump.v1"),
  nominalHeatingPowerWatts: z.int().safe().min(1).max(10_000_000),
  scopHundredths: z.int().safe().min(1).max(2_000),
});

const mountingTechnicalDataSchema = z.strictObject({
  schemaVersion: z.literal("mounting.v1"),
  systemName: boundedTextSchema,
  roofTypes: z.array(z.enum(["pitched", "flat", "facade", "ground"])).min(1).max(4),
});

const otherTechnicalDataSchema = z.strictObject({
  schemaVersion: z.literal("other.v1"),
  attributes: z.array(z.strictObject({
    name: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(240),
  })).max(20),
});

export const catalogTechnicalDataV1Schema = z.discriminatedUnion("schemaVersion", [
  moduleTechnicalDataSchema,
  inverterTechnicalDataSchema,
  batteryTechnicalDataSchema,
  wallboxTechnicalDataSchema,
  heatPumpTechnicalDataSchema,
  mountingTechnicalDataSchema,
  otherTechnicalDataSchema,
]);
export type CatalogTechnicalDataV1 = z.infer<typeof catalogTechnicalDataV1Schema>;

const commercialSchema = z.strictObject({
  currency: z.literal("EUR"),
  basis: z.literal("net"),
  purchasePriceNetCents: moneyCentsSchema,
  salesPriceNetCents: moneyCentsSchema,
  purchaseProvenance: provenanceSchema,
  salesProvenance: provenanceSchema,
});
export type CatalogCommercialV1 = z.infer<typeof commercialSchema>;

const catalogIdentitySchema = z.strictObject({
  workspaceId: uuidSchema,
  componentId: uuidSchema,
  revision: positiveRevisionSchema,
  internalSku: internalSkuSchema,
  componentType: catalogComponentTypeSchema,
});

const catalogPresentationSchema = z.strictObject({
  displayName: boundedTextSchema,
  manufacturer: boundedTextSchema,
  model: boundedTextSchema,
  unit: z.enum(["piece", "set", "meter"]),
  keyPoints: z.array(z.string().trim().min(1).max(240)).max(6),
  image: catalogAssetSchema.nullable(),
  datasheet: catalogAssetSchema.nullable(),
});

const componentRevisionBaseSchema = z.strictObject({
  schemaVersion: z.literal(CATALOG_COMPONENT_CONTRACT_VERSION),
  canonicalizationVersion: z.literal(CATALOG_CANONICALIZATION_VERSION),
  identity: catalogIdentitySchema,
  presentation: catalogPresentationSchema,
  technicalData: catalogTechnicalDataV1Schema,
  commercial: commercialSchema.nullable(),
  technicalProvenance: provenanceSchema,
  snapshotSha256: sha256Schema,
});

const technicalTypeBySchemaVersion: Record<CatalogTechnicalDataV1["schemaVersion"], CatalogComponentType> = {
  "module.v1": "module",
  "inverter.v1": "inverter",
  "battery.v1": "battery",
  "wallbox.v1": "wallbox",
  "heat_pump.v1": "heat_pump",
  "mounting.v1": "mounting",
  "other.v1": "other",
};

type ComponentRevisionBody = Omit<z.infer<typeof componentRevisionBaseSchema>, "snapshotSha256">;

function componentSemanticIssues(
  value: ComponentRevisionBody | z.infer<typeof componentRevisionBaseSchema>,
  context: z.RefinementCtx,
): void {
  const expectedType = technicalTypeBySchemaVersion[value.technicalData.schemaVersion];
  if (value.identity.componentType !== expectedType) {
    context.addIssue({
      code: "custom",
      path: ["technicalData", "schemaVersion"],
      message: "Technisches Schema und Komponententyp stimmen nicht ueberein.",
    });
  }
  if (
    value.identity.componentType !== "mounting"
    && value.identity.componentType !== "other"
    && value.presentation.unit !== "piece"
  ) {
    context.addIssue({
      code: "custom",
      path: ["presentation", "unit"],
      message: "Dieser Komponententyp wird in v1 stueckweise gefuehrt.",
    });
  }
  for (const field of ["image", "datasheet"] as const) {
    const asset = value.presentation[field];
    if (asset === null) continue;
    const extension = asset.role === "datasheet"
      ? "pdf"
      : asset.mediaType === "image/jpeg" ? "jpg"
        : asset.mediaType === "image/png" ? "png" : "webp";
    const expectedKey = [
      "catalog",
      value.identity.workspaceId,
      value.identity.componentId,
      `${asset.sha256}.${extension}`,
    ].join("/");
    const roleMatchesField = asset.role === field;
    const mediaMatchesRole = asset.role === "datasheet"
      ? asset.mediaType === "application/pdf"
      : asset.mediaType.startsWith("image/");
    if (asset.objectKey !== expectedKey || !roleMatchesField || !mediaMatchesRole) {
      context.addIssue({
        code: "custom",
        path: ["presentation", field],
        message: "Assetreferenz ist nicht revisionssicher an Workspace und Produkt gebunden.",
      });
    }
  }
}

const catalogComponentRevisionBodySchema = componentRevisionBaseSchema
  .omit({ snapshotSha256: true })
  .superRefine(componentSemanticIssues);

export const catalogComponentRevisionV1Schema = componentRevisionBaseSchema
  .superRefine(componentSemanticIssues);
export type CatalogComponentRevisionV1 = z.infer<typeof catalogComponentRevisionV1Schema>;

export const catalogComponentCreateCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_COMPONENT_CREATE_COMMAND_VERSION),
  internalSku: internalSkuSchema,
  componentType: catalogComponentTypeSchema,
  presentation: catalogPresentationSchema,
  technicalData: catalogTechnicalDataV1Schema,
  commercial: commercialSchema.nullable(),
  technicalProvenance: provenanceSchema,
});
export type CatalogComponentCreateCommandV1 = z.infer<
  typeof catalogComponentCreateCommandV1Schema
>;

export const catalogComponentDetailsCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_COMPONENT_DETAILS_COMMAND_VERSION),
  componentId: uuidSchema,
  expectedRevision: positiveRevisionSchema,
  presentation: catalogPresentationSchema,
  technicalData: catalogTechnicalDataV1Schema,
  technicalProvenance: provenanceSchema,
});
export type CatalogComponentDetailsCommandV1 = z.infer<
  typeof catalogComponentDetailsCommandV1Schema
>;

export const catalogComponentPricingCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(CATALOG_COMPONENT_PRICING_COMMAND_VERSION),
  componentId: uuidSchema,
  expectedRevision: positiveRevisionSchema,
  commercial: commercialSchema.nullable(),
});
export type CatalogComponentPricingCommandV1 = z.infer<
  typeof catalogComponentPricingCommandV1Schema
>;

const catalogComponentViewCommercialSchema = z.strictObject({
  currency: z.literal("EUR"),
  basis: z.literal("net"),
  salesPriceNetCents: moneyCentsSchema,
  salesProvenance: provenanceSchema,
  purchasePriceNetCents: moneyCentsSchema.optional(),
  purchaseProvenance: provenanceSchema.optional(),
}).superRefine((value, context) => {
  if ((value.purchasePriceNetCents === undefined) !== (value.purchaseProvenance === undefined)) {
    context.addIssue({
      code: "custom",
      path: ["purchasePriceNetCents"],
      message: "EK und EK-Provenienz muessen gemeinsam vorhanden oder redigiert sein.",
    });
  }
});

export const catalogComponentViewV1Schema = z.strictObject({
  schemaVersion: z.literal("catalog-component-view.v1"),
  identity: catalogIdentitySchema,
  presentation: catalogPresentationSchema,
  technicalData: catalogTechnicalDataV1Schema,
  commercial: catalogComponentViewCommercialSchema.nullable(),
  technicalProvenance: provenanceSchema,
  sourceSnapshotSha256: sha256Schema.optional(),
});
export type CatalogComponentViewV1 = z.infer<typeof catalogComponentViewV1Schema>;

export function toCatalogComponentView(
  value: unknown,
  options: { canReadPurchasePrice: boolean },
): CatalogComponentViewV1 {
  const validated = validateCatalogComponentRevision(value);
  if (!validated.ok) {
    throw new TypeError(`Ungueltige Katalogrevision: ${validated.paths.join(", ")}`);
  }
  const snapshot = validated.value;
  const commercial = snapshot.commercial === null
    ? null
    : options.canReadPurchasePrice
      ? {
          currency: snapshot.commercial.currency,
          basis: snapshot.commercial.basis,
          salesPriceNetCents: snapshot.commercial.salesPriceNetCents,
          salesProvenance: snapshot.commercial.salesProvenance,
          purchasePriceNetCents: snapshot.commercial.purchasePriceNetCents,
          purchaseProvenance: snapshot.commercial.purchaseProvenance,
        }
      : {
          currency: snapshot.commercial.currency,
          basis: snapshot.commercial.basis,
          salesPriceNetCents: snapshot.commercial.salesPriceNetCents,
          salesProvenance: snapshot.commercial.salesProvenance,
        };
  return catalogComponentViewV1Schema.parse({
    schemaVersion: "catalog-component-view.v1",
    identity: snapshot.identity,
    presentation: snapshot.presentation,
    technicalData: snapshot.technicalData,
    commercial,
    technicalProvenance: snapshot.technicalProvenance,
    ...(options.canReadPurchasePrice
      ? { sourceSnapshotSha256: snapshot.snapshotSha256 }
      : {}),
  });
}

const requirementKeySchema = z.enum([
  "pv_generation",
  "storage_capacity",
  "wallbox",
  "backup_power",
  "bidirectional_charging",
]);

const projectCatalogResolutionLineV1Schema = z.strictObject({
  lineId: uuidSchema,
  position: z.int().safe().min(1).max(10_000),
  quantity: positiveQuantitySchema,
  coversRequirementKeys: z.array(requirementKeySchema).max(5),
  catalogComponentId: uuidSchema,
  catalogComponentRevision: positiveRevisionSchema,
  componentSnapshotSha256: sha256Schema,
  componentSnapshot: catalogComponentRevisionV1Schema,
});
export type ProjectCatalogResolutionLineV1 = z.infer<
  typeof projectCatalogResolutionLineV1Schema
>;

const requestedCatalogCoverageSchema = z.strictObject({
  branch: z.enum(["new_installation", "existing_installation"]),
  pvPeakPowerWatts: z.int().safe().min(0).max(1_000_000_000),
  storageCapacityWh: z.int().safe().min(0).max(1_000_000_000),
  wallbox: z.boolean(),
  backupPower: z.boolean(),
  bidirectionalCharging: z.boolean(),
});
export type RequestedCatalogCoverageV1 = z.infer<typeof requestedCatalogCoverageSchema>;

const acknowledgementCodeSchema = z.enum([
  "pv_capacity_differs",
  "storage_capacity_differs",
  "backup_compatibility_unverified",
  "bidirectional_compatibility_unverified",
  "cross_component_compatibility_unverified",
]);
export type ProjectCatalogAcknowledgementCode = z.infer<typeof acknowledgementCodeSchema>;

export const resolveProjectCatalogCommandV1Schema = z.strictObject({
  schemaVersion: z.literal(RESOLVE_PROJECT_CATALOG_COMMAND_VERSION),
  projectId: uuidSchema,
  expectedResolutionRevision: z.int().safe().min(0),
  expectedRequirementRevision: positiveRevisionSchema,
  expectedCalculationRevision: positiveRevisionSchema,
  selections: z.array(z.strictObject({
    componentId: uuidSchema,
    expectedComponentRevision: positiveRevisionSchema,
    quantity: positiveQuantitySchema,
  })).min(1).max(500),
  acknowledgements: z.array(acknowledgementCodeSchema).max(5),
});
export type ResolveProjectCatalogCommandV1 = z.infer<
  typeof resolveProjectCatalogCommandV1Schema
>;

const selectedCatalogCoverageSchema = z.strictObject({
  moduleCount: z.int().safe().min(0),
  inverterCount: z.int().safe().min(0),
  batteryCount: z.int().safe().min(0),
  wallboxCount: z.int().safe().min(0),
  pvModulePowerWatts: z.int().safe().min(0),
  storageUsableCapacityWh: z.int().safe().min(0),
});

const coverageSchema = z.strictObject({
  status: z.enum(["matched", "manual_override"]),
  requested: requestedCatalogCoverageSchema,
  selected: selectedCatalogCoverageSchema,
});

const catalogTotalsSchema = z.strictObject({
  currency: z.literal("EUR"),
  basis: z.literal("net"),
  purchasePriceNetCents: moneyCentsSchema,
  salesPriceNetCents: moneyCentsSchema,
});

const resolutionWarningSchema = z.enum([
  "calculation_not_sku_specific",
  "pv_capacity_differs",
  "storage_capacity_differs",
  "backup_compatibility_unverified",
  "bidirectional_compatibility_unverified",
  "cross_component_compatibility_unverified",
]);

const resolutionBindingsSchema = z.strictObject({
  workspaceId: uuidSchema,
  projectId: uuidSchema,
  siteId: uuidSchema,
  requirementId: uuidSchema,
  requirementRevision: positiveRevisionSchema,
  calculationRevisionId: uuidSchema,
  calculationRevision: positiveRevisionSchema,
  calculationInputSha256: sha256Schema,
  calculationResultSha256: sha256Schema,
  calculationQuality: z.literal("server_reproduced_estimate"),
  calculationValidationStatus: z.literal("not_f4_reference_validated"),
});

const projectCatalogResolutionInputSchema = z.strictObject({
  schemaVersion: z.literal(PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION),
  canonicalizationVersion: z.literal(CATALOG_CANONICALIZATION_VERSION),
  revision: positiveRevisionSchema,
  bindings: resolutionBindingsSchema,
  lines: z.array(projectCatalogResolutionLineV1Schema).min(1).max(500),
  requested: requestedCatalogCoverageSchema,
  acknowledgements: z.array(acknowledgementCodeSchema).max(5),
  confirmedBy: uuidSchema,
  confirmedAt: utcDateTimeSchema,
});

const projectCatalogResolutionBaseSchema = projectCatalogResolutionInputSchema.extend({
  coverage: coverageSchema,
  totals: catalogTotalsSchema,
  warnings: z.array(resolutionWarningSchema).min(1).max(6),
  resolutionSha256: sha256Schema,
});
export const projectCatalogResolutionV1Schema = projectCatalogResolutionBaseSchema;
export type ProjectCatalogResolutionV1 = z.infer<typeof projectCatalogResolutionV1Schema>;

const projectCatalogResolutionViewLineSchema = z.strictObject({
  lineId: uuidSchema,
  position: z.int().safe().min(1).max(10_000),
  quantity: positiveQuantitySchema,
  coversRequirementKeys: z.array(requirementKeySchema).max(5),
  catalogComponentId: uuidSchema,
  catalogComponentRevision: positiveRevisionSchema,
  componentSnapshotSha256: sha256Schema.optional(),
  componentSnapshot: catalogComponentViewV1Schema,
});

const projectCatalogResolutionViewTotalsSchema = z.strictObject({
  currency: z.literal("EUR"),
  basis: z.literal("net"),
  salesPriceNetCents: moneyCentsSchema,
  purchasePriceNetCents: moneyCentsSchema.optional(),
});

export const projectCatalogResolutionViewV1Schema = z.strictObject({
  schemaVersion: z.literal("project-catalog-resolution-view.v1"),
  revision: positiveRevisionSchema,
  bindings: resolutionBindingsSchema,
  lines: z.array(projectCatalogResolutionViewLineSchema).min(1).max(500),
  requested: requestedCatalogCoverageSchema,
  acknowledgements: z.array(acknowledgementCodeSchema).max(5),
  coverage: coverageSchema,
  totals: projectCatalogResolutionViewTotalsSchema,
  warnings: z.array(resolutionWarningSchema).min(1).max(6),
  confirmedBy: uuidSchema,
  confirmedAt: utcDateTimeSchema,
  sourceResolutionSha256: sha256Schema.optional(),
});
export type ProjectCatalogResolutionViewV1 = z.infer<
  typeof projectCatalogResolutionViewV1Schema
>;

export type CatalogContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; paths: string[] };

function validationPaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => {
    if (issue.path.length === 0) return "/";
    return `/${issue.path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}`;
  }))].slice(0, 20);
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Ungepaartes Unicode-Surrogat im Katalog-JSON.");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Ungepaartes Unicode-Surrogat im Katalog-JSON.");
    }
  }
}

/** Gepinnte RFC-8785/JCS-Teilmenge fuer sichere JSON-Ganzzahlen. */
export function canonicalizeCatalogJson(value: unknown): string {
  const seen = new Set<object>();
  const serialize = (current: unknown): string => {
    if (current === null) return "null";
    if (typeof current === "boolean") return JSON.stringify(current);
    if (typeof current === "string") {
      assertWellFormedUnicode(current);
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isSafeInteger(current)) {
        throw new TypeError("Nur sichere Ganzzahlen sind im Katalog-JSON erlaubt.");
      }
      return JSON.stringify(Object.is(current, -0) ? 0 : current);
    }
    if (typeof current !== "object") {
      throw new TypeError("Nicht persistierbarer Wert im Katalog-JSON.");
    }
    if (seen.has(current)) throw new TypeError("Zyklus im Katalog-JSON.");
    seen.add(current);
    try {
      if (Array.isArray(current)) {
        return `[${current.map((entry) => serialize(entry)).join(",")}]`;
      }
      const record = current as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      keys.forEach(assertWellFormedUnicode);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`).join(",")}}`;
    } finally {
      seen.delete(current);
    }
  };
  return serialize(value as JsonValue);
}

function hashCanonical(value: unknown): string {
  return createHash("sha256").update(canonicalizeCatalogJson(value), "utf8").digest("hex");
}

function withoutKey(value: unknown, key: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Katalogvertrag muss ein Objekt sein.");
  }
  const body = { ...(value as Record<string, unknown>) };
  delete body[key];
  return body;
}

export function hashCatalogComponentRevision(value: unknown): string {
  const parsed = catalogComponentRevisionBodySchema.safeParse(withoutKey(value, "snapshotSha256"));
  if (!parsed.success) {
    throw new TypeError(`Ungueltige Katalogrevision: ${validationPaths(parsed.error).join(", ")}`);
  }
  return hashCanonical(parsed.data);
}

export function sealCatalogComponentRevision(value: unknown): CatalogComponentRevisionV1 {
  const parsed = catalogComponentRevisionBodySchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Ungueltige Katalogrevision: ${validationPaths(parsed.error).join(", ")}`);
  }
  return catalogComponentRevisionV1Schema.parse({
    ...parsed.data,
    snapshotSha256: hashCanonical(parsed.data),
  });
}

export function validateCatalogComponentRevision(
  value: unknown,
): CatalogContractResult<CatalogComponentRevisionV1> {
  const parsed = catalogComponentRevisionV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, paths: validationPaths(parsed.error) };
  let expectedHash: string;
  try {
    expectedHash = hashCatalogComponentRevision(parsed.data);
  } catch {
    return { ok: false, paths: ["/snapshotSha256"] };
  }
  if (expectedHash !== parsed.data.snapshotSha256) {
    return { ok: false, paths: ["/snapshotSha256"] };
  }
  return { ok: true, value: parsed.data };
}

function checkedAdd(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`${label} ueberschreitet den sicheren Ganzzahlbereich.`);
  }
  return result;
}

function checkedMultiply(left: number, right: number, label: string): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError(`${label} ueberschreitet den sicheren Ganzzahlbereich.`);
  }
  return result;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function uniqueArray<T>(value: readonly T[]): boolean {
  return new Set(value).size === value.length;
}

export function deriveProjectCatalogResolutionSummary(
  linesValue: unknown,
  requestedValue: unknown,
): {
  coverage: z.infer<typeof coverageSchema>;
  requiredAcknowledgements: ProjectCatalogAcknowledgementCode[];
  totals: z.infer<typeof catalogTotalsSchema>;
  warnings: z.infer<typeof resolutionWarningSchema>[];
} {
  const lines = z.array(projectCatalogResolutionLineV1Schema).min(1).max(500).parse(linesValue);
  const requested = requestedCatalogCoverageSchema.parse(requestedValue);
  if (!uniqueArray(lines.map((line) => line.lineId))) {
    throw new TypeError("Katalogzeilen-IDs muessen eindeutig sein.");
  }

  let purchasePriceNetCents = 0;

  for (const line of lines) {
    const snapshotValidation = validateCatalogComponentRevision(line.componentSnapshot);
    if (!snapshotValidation.ok) {
      throw new TypeError(`Ungueltiger Produktsnapshot: ${snapshotValidation.paths.join(", ")}`);
    }
    const snapshot = snapshotValidation.value;
    if (
      line.catalogComponentId !== snapshot.identity.componentId
      || line.catalogComponentRevision !== snapshot.identity.revision
      || line.componentSnapshotSha256 !== snapshot.snapshotSha256
    ) {
      throw new TypeError("Katalogzeile ist nicht an die kopierte Produktrevision gebunden.");
    }
    if (!uniqueArray(line.coversRequirementKeys)) {
      throw new TypeError("Requirement-Zuordnungen einer Katalogzeile muessen eindeutig sein.");
    }
    const allowedRequirementKeys: Record<CatalogComponentType, readonly z.infer<typeof requirementKeySchema>[]> = {
      module: ["pv_generation"],
      inverter: ["pv_generation"],
      battery: ["storage_capacity", "backup_power"],
      wallbox: ["wallbox", "bidirectional_charging"],
      heat_pump: [],
      mounting: ["pv_generation"],
      other: [],
    };
    if (line.coversRequirementKeys.some((key) => (
      !allowedRequirementKeys[snapshot.identity.componentType].includes(key)
    ))) {
      throw new TypeError("Produktklasse und Requirement-Zuordnung stimmen nicht ueberein.");
    }
    if (snapshot.commercial === null) {
      throw new TypeError("Projektaufloesung verlangt einen vollstaendigen commercial Preisstand.");
    }
    purchasePriceNetCents = checkedAdd(
      purchasePriceNetCents,
      checkedMultiply(snapshot.commercial.purchasePriceNetCents, line.quantity, "EK-Summe"),
      "EK-Summe",
    );
  }

  const preview = deriveCatalogSelectionPreview(lines.map((line) => ({
    componentId: line.catalogComponentId,
    componentType: line.componentSnapshot.identity.componentType,
    quantity: line.quantity,
    salesPriceNetCents: line.componentSnapshot.commercial?.salesPriceNetCents ?? null,
    technicalData: line.componentSnapshot.technicalData,
  })), requested);
  if (preview.blockers.length > 0) {
    throw new TypeError(`Katalogauswahl ist blockiert: ${preview.blockers.join(", ")}.`);
  }
  if (lines.some((line, index) => line.position !== index + 1)) {
    throw new TypeError("Katalogzeilen muessen lueckenlos ab Position 1 sortiert sein.");
  }
  const selected = preview.selected;
  const requiredAcknowledgements: ProjectCatalogAcknowledgementCode[] =
    preview.requiredAcknowledgements;
  const coverage = {
    status: requiredAcknowledgements.some((code) => (
      code === "pv_capacity_differs" || code === "storage_capacity_differs"
    )) ? "manual_override" as const : "matched" as const,
    requested,
    selected,
  };
  const totals = {
    currency: "EUR" as const,
    basis: "net" as const,
    purchasePriceNetCents,
    salesPriceNetCents: preview.salesPriceNetCents,
  };
  const warnings: z.infer<typeof resolutionWarningSchema>[] = [
    "calculation_not_sku_specific",
    ...requiredAcknowledgements,
  ];
  return { coverage, requiredAcknowledgements, totals, warnings };
}

function exactCanonicalMatch(left: unknown, right: unknown): boolean {
  return canonicalizeCatalogJson(left) === canonicalizeCatalogJson(right);
}

export function hashProjectCatalogResolution(value: unknown): string {
  const body = withoutKey(value, "resolutionSha256");
  const parsed = projectCatalogResolutionBaseSchema
    .omit({ resolutionSha256: true })
    .safeParse(body);
  if (!parsed.success) {
    throw new TypeError(`Ungueltige Projektaufloesung: ${validationPaths(parsed.error).join(", ")}`);
  }
  return hashCanonical(parsed.data);
}

export function sealProjectCatalogResolution(value: unknown): ProjectCatalogResolutionV1 {
  const parsed = projectCatalogResolutionInputSchema.safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Ungueltige Projektaufloesung: ${validationPaths(parsed.error).join(", ")}`);
  }
  for (const [index, line] of parsed.data.lines.entries()) {
    if (line.componentSnapshot.identity.workspaceId !== parsed.data.bindings.workspaceId) {
      throw new TypeError(`Katalogzeile ${index + 1} stammt aus einem fremden Workspace.`);
    }
  }
  const summary = deriveProjectCatalogResolutionSummary(parsed.data.lines, parsed.data.requested);
  if (!arraysEqual(parsed.data.acknowledgements, summary.requiredAcknowledgements)) {
    throw new TypeError("acknowledgements muessen exakt den abgeleiteten Bestaetigungen entsprechen.");
  }
  const body = {
    ...parsed.data,
    coverage: summary.coverage,
    totals: summary.totals,
    warnings: summary.warnings,
  };
  return projectCatalogResolutionV1Schema.parse({
    ...body,
    resolutionSha256: hashCanonical(body),
  });
}

export function validateProjectCatalogResolution(
  value: unknown,
): CatalogContractResult<ProjectCatalogResolutionV1> {
  const parsed = projectCatalogResolutionV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, paths: validationPaths(parsed.error) };
  const paths: string[] = [];
  for (const [index, line] of parsed.data.lines.entries()) {
    if (line.componentSnapshot.identity.workspaceId !== parsed.data.bindings.workspaceId) {
      paths.push(`/lines/${index}/componentSnapshot/identity/workspaceId`);
    }
  }
  try {
    const summary = deriveProjectCatalogResolutionSummary(parsed.data.lines, parsed.data.requested);
    if (!arraysEqual(parsed.data.acknowledgements, summary.requiredAcknowledgements)) {
      paths.push("/acknowledgements");
    }
    if (!exactCanonicalMatch(parsed.data.coverage, summary.coverage)) paths.push("/coverage");
    if (!exactCanonicalMatch(parsed.data.totals, summary.totals)) paths.push("/totals");
    if (!arraysEqual(parsed.data.warnings, summary.warnings)) paths.push("/warnings");
  } catch {
    paths.push("/lines");
  }
  try {
    if (hashProjectCatalogResolution(parsed.data) !== parsed.data.resolutionSha256) {
      paths.push("/resolutionSha256");
    }
  } catch {
    paths.push("/resolutionSha256");
  }
  return paths.length === 0
    ? { ok: true, value: parsed.data }
    : { ok: false, paths: [...new Set(paths)].slice(0, 20) };
}

export function toProjectCatalogResolutionView(
  value: unknown,
  options: { canReadPurchasePrice: boolean },
): ProjectCatalogResolutionViewV1 {
  const validated = validateProjectCatalogResolution(value);
  if (!validated.ok) {
    throw new TypeError(`Ungueltige Projektaufloesung: ${validated.paths.join(", ")}`);
  }
  const resolution = validated.value;
  return projectCatalogResolutionViewV1Schema.parse({
    schemaVersion: "project-catalog-resolution-view.v1",
    revision: resolution.revision,
    bindings: resolution.bindings,
    lines: resolution.lines.map((line) => ({
      lineId: line.lineId,
      position: line.position,
      quantity: line.quantity,
      coversRequirementKeys: line.coversRequirementKeys,
      catalogComponentId: line.catalogComponentId,
      catalogComponentRevision: line.catalogComponentRevision,
      ...(options.canReadPurchasePrice
        ? { componentSnapshotSha256: line.componentSnapshotSha256 }
        : {}),
      componentSnapshot: toCatalogComponentView(line.componentSnapshot, options),
    })),
    requested: resolution.requested,
    acknowledgements: resolution.acknowledgements,
    coverage: resolution.coverage,
    totals: options.canReadPurchasePrice
      ? resolution.totals
      : {
          currency: resolution.totals.currency,
          basis: resolution.totals.basis,
          salesPriceNetCents: resolution.totals.salesPriceNetCents,
        },
    warnings: resolution.warnings,
    confirmedBy: resolution.confirmedBy,
    confirmedAt: resolution.confirmedAt,
    ...(options.canReadPurchasePrice
      ? { sourceResolutionSha256: resolution.resolutionSha256 }
      : {}),
  });
}

function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  const generated = z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    cycles: "ref",
    reused: "ref",
  }) as Record<string, unknown>;
  const body = { ...generated };
  delete body.$schema;
  return body;
}

export function renderCatalogJsonSchema(): string {
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://contracts.wmee.internal/catalog.v1.schema.json",
    title: "WMEE catalog and project resolution v1",
    oneOf: [
      { $ref: "#/$defs/componentRevision" },
      { $ref: "#/$defs/projectResolution" },
      { $ref: "#/$defs/componentCreateCommand" },
      { $ref: "#/$defs/componentDetailsCommand" },
      { $ref: "#/$defs/componentPricingCommand" },
      { $ref: "#/$defs/resolveProjectCommand" },
      { $ref: "#/$defs/componentView" },
      { $ref: "#/$defs/projectResolutionView" },
    ],
    $defs: {
      componentRevision: jsonSchemaFor(catalogComponentRevisionV1Schema),
      projectResolution: jsonSchemaFor(projectCatalogResolutionV1Schema),
      componentCreateCommand: jsonSchemaFor(catalogComponentCreateCommandV1Schema),
      componentDetailsCommand: jsonSchemaFor(catalogComponentDetailsCommandV1Schema),
      componentPricingCommand: jsonSchemaFor(catalogComponentPricingCommandV1Schema),
      resolveProjectCommand: jsonSchemaFor(resolveProjectCatalogCommandV1Schema),
      componentView: jsonSchemaFor(catalogComponentViewV1Schema),
      projectResolutionView: jsonSchemaFor(projectCatalogResolutionViewV1Schema),
    },
    "x-semantic-invariants": [
      "internalSku is NFKC-normalized uppercase and contains only A-Z, digits, dot, underscore, and hyphen",
      "componentType equals the technicalData schema family and never changes for a component identity",
      "battery usableCapacityWh does not exceed nominalCapacityWh",
      "asset objectKey equals catalog/{workspaceId}/{componentId}/{sha256}.{role extension}",
      "snapshotSha256 uses catalog-jcs.v1 over the strict component revision without snapshotSha256",
      "project lines copy hash-valid component revisions from the bound workspace and bind their identity, revision, and hash",
      "browser commands contain untrusted identifiers, expected revisions, quantities, and acknowledgements but never workspace, actor, timestamps, snapshots, or prices",
      "catalog and project views structurally omit purchase prices, purchase provenance, and hashes of purchase-bearing source snapshots unless the server grants price.read_purchase",
      "new installations with positive PV require at least one module and inverter; requested storage and wallbox capabilities require their product classes",
      "coverage, exact capacity, feature, and cross-component compatibility acknowledgements, warnings, and safe integer EUR/net totals are derived from copied revisions",
      "calculation quality remains server_reproduced_estimate and not_f4_reference_validated",
      "resolutionSha256 uses catalog-jcs.v1 over the strict resolution without resolutionSha256",
    ],
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
