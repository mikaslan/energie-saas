"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import {
  CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
  CATALOG_COMPONENT_DETAILS_COMMAND_VERSION,
  CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
  RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
  catalogComponentTypeSchema,
  type CatalogComponentType,
  type CatalogProvenanceV1,
  type CatalogTechnicalDataV1,
} from "@/lib/integrations/catalog/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  activateCatalogComponent,
  archiveCatalogComponent,
  CatalogConflictError,
  CatalogInputError,
  CatalogIntegrityError,
  CatalogNotFoundError,
  CatalogPersistenceError,
  CatalogStateError,
  createCatalogComponent,
  ProjectCatalogBlockedError,
  ProjectCatalogConflictError,
  resolveProjectCatalog,
  returnCatalogComponentToDraft,
  reviseCatalogComponentDetails,
  reviseCatalogComponentPricing,
} from "@/modules/catalog";

export type CatalogActionState =
  | { status: "idle" }
  | { status: "success"; componentId: string; revision: number; componentStatus: string }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "state_error"; code: "archived" | "not_archived" | "active_requires_pricing" }
  | { status: "unavailable" };

export type ResolutionActionState =
  | { status: "idle" }
  | { status: "success"; revision: number }
  | {
      status: "invalid";
      field: "form" | "selection" | "quantity" | "acknowledgements";
      selectionIndex?: number;
    }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "conflict" }
  | {
      status: "blocked";
      code:
        | "project_not_found"
        | "missing_requirement"
        | "missing_calculation"
        | "calculation_not_current"
        | "calculation_invalid"
        | "component_not_active";
    }
  | { status: "unavailable" };

const INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const MONEY_PATTERN = /^(?:0|[1-9]\d*)(?:[.,]\d{1,2})?$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const sourceKindSchema = z.enum([
  "manufacturer_datasheet",
  "supplier_price_list",
  "supplier_quote",
  "workspace_pricing",
  "workspace_manual",
  "csv_import",
  "customer_provided",
]);
const rightsBasisSchema = z.enum([
  "manufacturer_published",
  "supplier_authorized",
  "workspace_owned",
  "customer_provided",
]);
const capabilitySchema = z.enum([
  "known_supported",
  "known_unsupported",
  "unknown",
]);

const provenanceFormSchema = z.strictObject({
  sourceKind: sourceKindSchema,
  reference: z.string().refine((value) => value === value.trim()).pipe(
    z.string().min(1).max(240),
  ),
  observedOn: z.iso.date(),
  rightsBasis: rightsBasisSchema,
  sourceDocumentSha256: z.union([
    z.literal("").transform(() => null),
    z.string().regex(SHA256_PATTERN),
  ]),
});

const workspaceSchema = z.uuid();
const componentSchema = z.uuid();
const revisionSchema = z.string().regex(INTEGER_PATTERN).transform(Number).pipe(
  z.number().int().safe().min(1),
);

const sharedDetailFields = [
  "workspaceId",
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
] as const;

const technicalFields: Record<CatalogComponentType, readonly string[]> = {
  module: ["nominalPowerWatts"],
  inverter: ["nominalAcPowerWatts", "phaseCount", "mpptTrackerCount"],
  battery: [
    "nominalCapacityWh",
    "usableCapacityWh",
    "maxContinuousPowerWatts",
    "roundTripEfficiencyPercent",
    "backupCapability",
  ],
  wallbox: [
    "maxChargingPowerWatts",
    "phaseCount",
    "connector",
    "bidirectionalCapability",
  ],
  heat_pump: ["nominalHeatingPowerWatts", "scop"],
  mounting: ["systemName", "roofTypes"],
  other: ["attributes"],
};

function exactFormValue(formData: FormData, name: string): FormDataEntryValue | null {
  const values = formData.getAll(name);
  return values.length === 1 ? values[0]! : null;
}

function hasExactFields(formData: FormData, allowed: ReadonlySet<string>): boolean {
  const seen = new Set<string>();
  for (const name of formData.keys()) {
    if (name.startsWith("$ACTION_")) continue;
    if (!allowed.has(name) || seen.has(name)) return false;
    seen.add(name);
  }
  return seen.size === allowed.size;
}

function stringValue(formData: FormData, name: string): string | null {
  const value = exactFormValue(formData, name);
  return typeof value === "string" ? value : null;
}

function integerValue(value: string | null, min: number, max: number): number | null {
  if (value === null || !INTEGER_PATTERN.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function hundredthsValue(value: string | null, min: number, max: number): number | null {
  if (value === null || !/^(?:0|[1-9]\d*)(?:[.,]\d{1,2})?$/u.test(value)) return null;
  const [whole, fraction = ""] = value.replace(",", ".").split(".");
  const parsed = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function centsValue(value: string | null): number | null {
  if (value === null || !MONEY_PATTERN.test(value)) return null;
  const [whole, fraction = ""] = value.replace(",", ".").split(".");
  const wholeNumber = Number(whole);
  const cents = wholeNumber * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(wholeNumber)
    && Number.isSafeInteger(cents)
    && cents <= 9_000_000_000_000_000
    ? cents
    : null;
}

function keyPointsValue(value: string | null): string[] | null {
  if (value === null) return null;
  const points = value.split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean);
  return points.length <= 6 && points.every((entry) => entry.length <= 240)
    ? points
    : null;
}

function provenanceValue(formData: FormData, prefix: string): CatalogProvenanceV1 | null {
  const parsed = provenanceFormSchema.safeParse({
    sourceKind: stringValue(formData, `${prefix}SourceKind`),
    reference: stringValue(formData, `${prefix}Reference`),
    observedOn: stringValue(formData, `${prefix}ObservedOn`),
    rightsBasis: stringValue(formData, `${prefix}RightsBasis`),
    sourceDocumentSha256: stringValue(formData, `${prefix}DocumentSha256`),
  });
  return parsed.success ? parsed.data : null;
}

function technicalDataValue(
  formData: FormData,
  componentType: CatalogComponentType,
): CatalogTechnicalDataV1 | null {
  if (componentType === "module") {
    const nominalPowerWatts = integerValue(stringValue(formData, "nominalPowerWatts"), 1, 10_000);
    return nominalPowerWatts === null ? null : { schemaVersion: "module.v1", nominalPowerWatts };
  }
  if (componentType === "inverter") {
    const nominalAcPowerWatts = integerValue(
      stringValue(formData, "nominalAcPowerWatts"), 1, 10_000_000,
    );
    const phaseCount = integerValue(stringValue(formData, "phaseCount"), 1, 3);
    const mpptTrackerCount = integerValue(stringValue(formData, "mpptTrackerCount"), 1, 100);
    if (nominalAcPowerWatts === null || ![1, 3].includes(phaseCount ?? 0) || mpptTrackerCount === null) {
      return null;
    }
    return {
      schemaVersion: "inverter.v1",
      nominalAcPowerWatts,
      phaseCount: phaseCount as 1 | 3,
      mpptTrackerCount,
    };
  }
  if (componentType === "battery") {
    const nominalCapacityWh = integerValue(stringValue(formData, "nominalCapacityWh"), 1, 100_000_000);
    const usableCapacityWh = integerValue(stringValue(formData, "usableCapacityWh"), 1, 100_000_000);
    const maxContinuousPowerWatts = integerValue(
      stringValue(formData, "maxContinuousPowerWatts"), 1, 100_000_000,
    );
    const roundTripEfficiencyBasisPoints = hundredthsValue(
      stringValue(formData, "roundTripEfficiencyPercent"), 1, 10_000,
    );
    const backupCapability = capabilitySchema.safeParse(
      stringValue(formData, "backupCapability"),
    );
    if (
      nominalCapacityWh === null || usableCapacityWh === null
      || maxContinuousPowerWatts === null || roundTripEfficiencyBasisPoints === null
      || !backupCapability.success
    ) return null;
    return {
      schemaVersion: "battery.v1",
      nominalCapacityWh,
      usableCapacityWh,
      maxContinuousPowerWatts,
      roundTripEfficiencyBasisPoints,
      backupCapability: backupCapability.data,
    };
  }
  if (componentType === "wallbox") {
    const maxChargingPowerWatts = integerValue(
      stringValue(formData, "maxChargingPowerWatts"), 1, 1_000_000,
    );
    const phaseCount = integerValue(stringValue(formData, "phaseCount"), 1, 3);
    const connector = z.enum(["type2_socket", "type2_cable", "other"]).safeParse(
      stringValue(formData, "connector"),
    );
    const bidirectionalCapability = capabilitySchema.safeParse(
      stringValue(formData, "bidirectionalCapability"),
    );
    if (
      maxChargingPowerWatts === null || ![1, 3].includes(phaseCount ?? 0)
      || !connector.success || !bidirectionalCapability.success
    ) return null;
    return {
      schemaVersion: "wallbox.v1",
      maxChargingPowerWatts,
      phaseCount: phaseCount as 1 | 3,
      connector: connector.data,
      bidirectionalCapability: bidirectionalCapability.data,
    };
  }
  if (componentType === "heat_pump") {
    const nominalHeatingPowerWatts = integerValue(
      stringValue(formData, "nominalHeatingPowerWatts"), 1, 10_000_000,
    );
    const scopHundredths = hundredthsValue(stringValue(formData, "scop"), 1, 2_000);
    return nominalHeatingPowerWatts === null || scopHundredths === null ? null : {
      schemaVersion: "heat_pump.v1",
      nominalHeatingPowerWatts,
      scopHundredths,
    };
  }
  if (componentType === "mounting") {
    const systemName = stringValue(formData, "systemName")?.trim() ?? "";
    const roofTypes = [...new Set((stringValue(formData, "roofTypes") ?? "")
      .split(",").map((entry) => entry.trim()).filter(Boolean))];
    const parsedRoofTypes = z.array(z.enum(["pitched", "flat", "facade", "ground"]))
      .min(1).max(4).safeParse(roofTypes);
    return systemName.length < 1 || systemName.length > 200 || !parsedRoofTypes.success
      ? null
      : { schemaVersion: "mounting.v1", systemName, roofTypes: parsedRoofTypes.data };
  }
  const attributes = (stringValue(formData, "attributes") ?? "")
    .split(/\r?\n/u).map((entry) => entry.trim()).filter(Boolean).map((entry) => {
      const separator = entry.indexOf("=");
      return separator < 1
        ? null
        : { name: entry.slice(0, separator).trim(), value: entry.slice(separator + 1).trim() };
    });
  if (
    attributes.length > 20 || attributes.some((entry) => entry === null)
    || attributes.some((entry) => !entry || entry.name.length < 1 || entry.name.length > 80
      || entry.value.length < 1 || entry.value.length > 240)
  ) return null;
  return { schemaVersion: "other.v1", attributes: attributes as Array<{ name: string; value: string }> };
}

function parseDetailForm(formData: FormData, mode: "create" | "revise") {
  const componentType = catalogComponentTypeSchema.safeParse(
    stringValue(formData, "componentType"),
  );
  if (!componentType.success) return null;
  const allowed = new Set<string>([
    ...sharedDetailFields,
    ...technicalFields[componentType.data],
    ...(mode === "create" ? ["internalSku"] : ["componentId", "expectedRevision"]),
  ]);
  if (!hasExactFields(formData, allowed)) return null;
  const keyPoints = keyPointsValue(stringValue(formData, "keyPoints"));
  const technicalProvenance = provenanceValue(formData, "technical");
  const technicalData = technicalDataValue(formData, componentType.data);
  const presentation = z.strictObject({
    displayName: z.string().trim().min(1).max(200),
    manufacturer: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(200),
    unit: z.enum(["piece", "set", "meter"]),
  }).safeParse({
    displayName: stringValue(formData, "displayName"),
    manufacturer: stringValue(formData, "manufacturer"),
    model: stringValue(formData, "model"),
    unit: stringValue(formData, "unit"),
  });
  if (!presentation.success || keyPoints === null || !technicalProvenance || !technicalData) {
    return null;
  }
  return {
    componentType: componentType.data,
    presentation: {
      ...presentation.data,
      keyPoints,
      image: null,
      datasheet: null,
    },
    technicalData,
    technicalProvenance,
  };
}

function catalogErrorState(error: unknown): CatalogActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof CatalogConflictError) return { status: "conflict" };
  if (error instanceof CatalogNotFoundError) return { status: "not_found" };
  if (error instanceof CatalogStateError) return { status: "state_error", code: error.code };
  if (error instanceof CatalogInputError) return { status: "invalid" };
  if (error instanceof CatalogIntegrityError || error instanceof CatalogPersistenceError) {
    return { status: "unavailable" };
  }
  throw error;
}

function revalidateCatalog(workspaceId: string, componentId?: string): void {
  revalidatePath(`/w/${workspaceId}/katalog`);
  if (componentId) revalidatePath(`/w/${workspaceId}/katalog/${componentId}`);
}

export async function createCatalogComponentAction(
  _previous: CatalogActionState,
  formData: FormData,
): Promise<CatalogActionState> {
  const parsed = parseDetailForm(formData, "create");
  const workspaceId = workspaceSchema.safeParse(stringValue(formData, "workspaceId"));
  const internalSku = z.string().min(1).max(100).safeParse(
    stringValue(formData, "internalSku"),
  );
  if (!parsed || !workspaceId.success || !internalSku.success) return { status: "invalid" };
  try {
    const result = await authorizedAction(
      workspaceId.data,
      "catalog.manage",
      "catalog_component",
      (tx, ctx) => createCatalogComponent(tx, ctx, {
        schemaVersion: CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
        internalSku: internalSku.data,
        componentType: parsed.componentType,
        presentation: parsed.presentation,
        technicalData: parsed.technicalData,
        commercial: null,
        technicalProvenance: parsed.technicalProvenance,
      }),
    );
    revalidateCatalog(workspaceId.data, result.componentId);
    return {
      status: "success",
      componentId: result.componentId,
      revision: result.revision,
      componentStatus: result.status,
    };
  } catch (error) {
    return catalogErrorState(error);
  }
}

export async function reviseCatalogDetailsAction(
  _previous: CatalogActionState,
  formData: FormData,
): Promise<CatalogActionState> {
  const parsed = parseDetailForm(formData, "revise");
  const workspaceId = workspaceSchema.safeParse(stringValue(formData, "workspaceId"));
  const componentId = componentSchema.safeParse(stringValue(formData, "componentId"));
  const expectedRevision = revisionSchema.safeParse(stringValue(formData, "expectedRevision"));
  if (!parsed || !workspaceId.success || !componentId.success || !expectedRevision.success) {
    return { status: "invalid" };
  }
  try {
    const result = await authorizedAction(
      workspaceId.data,
      "catalog.manage",
      "catalog_component",
      (tx, ctx) => reviseCatalogComponentDetails(tx, ctx, {
        schemaVersion: CATALOG_COMPONENT_DETAILS_COMMAND_VERSION,
        componentId: componentId.data,
        expectedRevision: expectedRevision.data,
        presentation: parsed.presentation,
        technicalData: parsed.technicalData,
        technicalProvenance: parsed.technicalProvenance,
      }),
    );
    revalidateCatalog(workspaceId.data, componentId.data);
    return {
      status: "success",
      componentId: result.componentId,
      revision: result.revision,
      componentStatus: result.status,
    };
  } catch (error) {
    return catalogErrorState(error);
  }
}

const pricingFields = new Set([
  "workspaceId", "componentId", "expectedRevision", "pricingMode",
  "purchasePriceEuro", "salesPriceEuro",
  "purchaseSourceKind", "purchaseReference", "purchaseObservedOn",
  "purchaseRightsBasis", "purchaseDocumentSha256",
  "salesSourceKind", "salesReference", "salesObservedOn",
  "salesRightsBasis", "salesDocumentSha256",
]);

export async function reviseCatalogPricingAction(
  _previous: CatalogActionState,
  formData: FormData,
): Promise<CatalogActionState> {
  if (!hasExactFields(formData, pricingFields)) return { status: "invalid" };
  const workspaceId = workspaceSchema.safeParse(stringValue(formData, "workspaceId"));
  const componentId = componentSchema.safeParse(stringValue(formData, "componentId"));
  const expectedRevision = revisionSchema.safeParse(stringValue(formData, "expectedRevision"));
  const pricingMode = z.enum(["complete", "none"]).safeParse(
    stringValue(formData, "pricingMode"),
  );
  if (!workspaceId.success || !componentId.success || !expectedRevision.success || !pricingMode.success) {
    return { status: "invalid" };
  }
  let commercial = null;
  if (pricingMode.data === "complete") {
    const purchase = centsValue(stringValue(formData, "purchasePriceEuro"));
    const sales = centsValue(stringValue(formData, "salesPriceEuro"));
    const purchaseProvenance = provenanceValue(formData, "purchase");
    const salesProvenance = provenanceValue(formData, "sales");
    if (purchase === null || sales === null || !purchaseProvenance || !salesProvenance) {
      return { status: "invalid" };
    }
    commercial = {
      currency: "EUR" as const,
      basis: "net" as const,
      purchasePriceNetCents: purchase,
      salesPriceNetCents: sales,
      purchaseProvenance,
      salesProvenance,
    };
  }
  try {
    const result = await authorizedAction(
      workspaceId.data,
      "catalog.manage",
      "catalog_component_pricing",
      (tx, ctx) => reviseCatalogComponentPricing(tx, ctx, {
        schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
        componentId: componentId.data,
        expectedRevision: expectedRevision.data,
        commercial,
      }),
    );
    revalidateCatalog(workspaceId.data, componentId.data);
    return {
      status: "success",
      componentId: result.componentId,
      revision: result.revision,
      componentStatus: result.status,
    };
  } catch (error) {
    return catalogErrorState(error);
  }
}

const lifecycleFields = new Set([
  "workspaceId", "componentId", "expectedRevision", "expectedStatus", "operation",
]);

export async function changeCatalogLifecycleAction(
  _previous: CatalogActionState,
  formData: FormData,
): Promise<CatalogActionState> {
  if (!hasExactFields(formData, lifecycleFields)) return { status: "invalid" };
  const parsed = z.strictObject({
    workspaceId: z.uuid(),
    componentId: z.uuid(),
    expectedRevision: revisionSchema,
    expectedStatus: z.enum(["draft", "active", "archived"]),
    operation: z.enum(["activate", "archive", "return_to_draft"]),
  }).safeParse({
    workspaceId: stringValue(formData, "workspaceId"),
    componentId: stringValue(formData, "componentId"),
    expectedRevision: stringValue(formData, "expectedRevision"),
    expectedStatus: stringValue(formData, "expectedStatus"),
    operation: stringValue(formData, "operation"),
  });
  if (!parsed.success) return { status: "invalid" };
  const command = {
    componentId: parsed.data.componentId,
    expectedRevision: parsed.data.expectedRevision,
    expectedStatus: parsed.data.expectedStatus,
  };
  try {
    const result = await authorizedAction(
      parsed.data.workspaceId,
      "catalog.manage",
      "catalog_component",
      (tx, ctx) => parsed.data.operation === "activate"
        ? activateCatalogComponent(tx, ctx, command)
        : parsed.data.operation === "archive"
          ? archiveCatalogComponent(tx, ctx, command)
          : returnCatalogComponentToDraft(tx, ctx, command),
    );
    revalidateCatalog(parsed.data.workspaceId, parsed.data.componentId);
    return {
      status: "success",
      componentId: result.componentId,
      revision: result.revision,
      componentStatus: result.status,
    };
  } catch (error) {
    return catalogErrorState(error);
  }
}

const acknowledgementCodes = [
  "pv_capacity_differs",
  "storage_capacity_differs",
  "backup_compatibility_unverified",
  "bidirectional_compatibility_unverified",
  "cross_component_compatibility_unverified",
] as const;

export async function resolveProjectCatalogAction(
  _previous: ResolutionActionState,
  formData: FormData,
): Promise<ResolutionActionState> {
  const selectionCount = integerValue(stringValue(formData, "selectionCount"), 1, 500);
  if (selectionCount === null) return { status: "invalid", field: "form" };
  const allowed = new Set<string>([
    "workspaceId", "projectId", "expectedResolutionRevision",
    "expectedRequirementRevision", "expectedCalculationRevision", "selectionCount",
    ...acknowledgementCodes.map((code) => `ack.${code}`),
  ]);
  for (let index = 0; index < selectionCount; index += 1) {
    allowed.add(`selection.${index}.componentId`);
    allowed.add(`selection.${index}.revision`);
    allowed.add(`selection.${index}.quantity`);
  }
  const seen = new Set<string>();
  for (const name of formData.keys()) {
    if (name.startsWith("$ACTION_")) continue;
    if (!allowed.has(name) || seen.has(name)) {
      return { status: "invalid", field: "form" };
    }
    seen.add(name);
  }
  const requiredAlways = [...allowed].filter((name) => (
    !name.startsWith("ack.")
  ));
  if (requiredAlways.some((name) => !seen.has(name))) {
    return { status: "invalid", field: "form" };
  }

  const base = z.strictObject({
    workspaceId: z.uuid(),
    projectId: z.uuid(),
    expectedResolutionRevision: z.string().regex(INTEGER_PATTERN).transform(Number).pipe(
      z.number().int().safe().min(0),
    ),
    expectedRequirementRevision: revisionSchema,
    expectedCalculationRevision: revisionSchema,
  }).safeParse({
    workspaceId: stringValue(formData, "workspaceId"),
    projectId: stringValue(formData, "projectId"),
    expectedResolutionRevision: stringValue(formData, "expectedResolutionRevision"),
    expectedRequirementRevision: stringValue(formData, "expectedRequirementRevision"),
    expectedCalculationRevision: stringValue(formData, "expectedCalculationRevision"),
  });
  if (!base.success) return { status: "invalid", field: "form" };

  const selections: Array<{
    componentId: string;
    expectedComponentRevision: number;
    quantity: number;
  }> = [];
  const selectedIds = new Set<string>();
  for (let index = 0; index < selectionCount; index += 1) {
    const componentId = componentSchema.safeParse(
      stringValue(formData, `selection.${index}.componentId`),
    );
    const revision = revisionSchema.safeParse(
      stringValue(formData, `selection.${index}.revision`),
    );
    const quantity = integerValue(
      stringValue(formData, `selection.${index}.quantity`), 1, 100_000,
    );
    if (!componentId.success || !revision.success) {
      return { status: "invalid", field: "selection", selectionIndex: index };
    }
    if (selectedIds.has(componentId.data)) {
      return { status: "invalid", field: "selection", selectionIndex: index };
    }
    if (quantity === null) {
      return { status: "invalid", field: "quantity", selectionIndex: index };
    }
    selections.push({
      componentId: componentId.data,
      expectedComponentRevision: revision.data,
      quantity,
    });
    selectedIds.add(componentId.data);
  }
  if (selections.length < 1) return { status: "invalid", field: "selection" };
  const acknowledgements = acknowledgementCodes.filter((code) => (
    stringValue(formData, `ack.${code}`) === "yes"
  ));

  try {
    const result = await authorizedAction(
      base.data.workspaceId,
      "project.write",
      "project_catalog_resolution",
      (tx, ctx) => resolveProjectCatalog(tx, ctx, {
        schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
        projectId: base.data.projectId,
        expectedResolutionRevision: base.data.expectedResolutionRevision,
        expectedRequirementRevision: base.data.expectedRequirementRevision,
        expectedCalculationRevision: base.data.expectedCalculationRevision,
        selections,
        acknowledgements,
      }),
    );
    revalidatePath(`/w/${base.data.workspaceId}/anfragen/${base.data.projectId}`);
    revalidatePath(`/w/${base.data.workspaceId}/anfragen/${base.data.projectId}/produkte`);
    return { status: "success", revision: result.revision };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof ProjectCatalogConflictError) return { status: "conflict" };
    if (error instanceof ProjectCatalogBlockedError) {
      return { status: "blocked", code: error.code };
    }
    if (error instanceof CatalogInputError) {
      const field = error.paths.some((path) => path.startsWith("/acknowledgements"))
        ? "acknowledgements" as const
        : error.paths.some((path) => path.startsWith("/selections"))
          ? "selection" as const
          : "form" as const;
      return { status: "invalid", field };
    }
    if (error instanceof CatalogIntegrityError || error instanceof CatalogPersistenceError) {
      return { status: "unavailable" };
    }
    throw error;
  }
}
