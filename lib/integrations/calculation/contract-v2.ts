/**
 * F4.1 v2-Vertragskette (Spec F4-01, Stand SPECIFIED): Request- und
 * Result-Schemas fuer planning-calculation.v2. Additiv neben contract.ts;
 * v1-Schemas bleiben unberuehrt. Alle Tupelwerte stammen aus versions-v2.ts.
 */
import { z } from "zod";

import {
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_MODEL_ID,
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_RESULT_CONTRACT_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
} from "./versions-v2";

const finite = () => z.number().finite();
const nonNegative = (max: number) => finite().min(0).max(max);
const positiveRevision = z.int().safe().min(1);
const uuid = () => z.uuid();
const dateSchema = z.iso.date();
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * Slice B: Bestands-Kontext im Request (nur Bestand-Branch; Neuanlage
 * laesst den Schluessel weg -> Hash-stabil). Kapazitaet des vorhandenen
 * Speichers; 0 bei bekannter Abwesenheit.
 */
const existingInstallationRequestV2Schema = z.strictObject({
  systemPeakPowerKwp: finite().gt(0).max(1_000),
  storageCapacityKwh: nonNegative(100_000),
});

const storageParamsV2Schema = z.strictObject({
  capacityKwh: nonNegative(10_000),
  socMinKwh: nonNegative(10_000),
  socMaxKwh: nonNegative(10_000),
  chargeKw: nonNegative(1_000),
  dischargeKw: nonNegative(1_000),
  etaCharge: finite().gt(0).max(1),
  etaDischarge: finite().gt(0).max(1),
}).refine(
  (storage) => storage.socMinKwh <= storage.socMaxKwh
    && storage.socMaxKwh <= storage.capacityKwh,
  { message: "socMinKwh <= socMaxKwh <= capacityKwh verletzt" },
);

export const planningCalculationRequestV2Schema = z.strictObject({
  contractVersion: z.literal(CALCULATION_V2_CONTRACT_VERSION),
  canonicalizationVersion: z.literal("planning-jcs.v1"),
  branch: z.enum(["new_installation", "existing_installation"]),
  asOfDate: dateSchema,
  commissioningDate: dateSchema,
  bindings: z.strictObject({
    workspaceId: uuid(),
    projectId: uuid(),
    siteId: uuid(),
    addressRevision: positiveRevision,
    pinConfirmedAddressRevision: positiveRevision,
    energyProfileId: uuid(),
    energyProfileRevision: positiveRevision,
    confirmedEnergyProfileRevision: positiveRevision,
    confirmedEnergyProfileAddressRevision: positiveRevision,
    projectRequirementId: uuid(),
    projectRequirementRevision: positiveRevision,
    sourceCalculatorSnapshotId: uuid().nullable(),
  }),
  site: z.strictObject({
    countryCode: z.literal("DE"),
    latitude: finite().min(-90).max(90),
    longitude: finite().min(-180).max(180),
  }),
  axis: z.strictObject({
    slots: z.literal(35_040),
    resolution: z.literal("quarter_hour"),
  }),
  storage: storageParamsV2Schema,
  // Slice B: nur Bestand-Branch (Neuanlage laesst den Schluessel weg).
  existingInstallation: existingInstallationRequestV2Schema.optional(),
});

const annualEnergyResultV2Schema = z.strictObject({
  generationKwh: nonNegative(10_000_000),
  consumptionKwh: nonNegative(10_000_000),
  directConsumptionKwh: nonNegative(10_000_000),
  fromStorageKwh: nonNegative(10_000_000),
  selfConsumptionKwh: nonNegative(10_000_000),
  feedInKwh: nonNegative(10_000_000),
  gridImportKwh: nonNegative(10_000_000),
  storageLossKwh: nonNegative(10_000_000),
  selfConsumptionRate: finite().min(0).max(1),
  autonomyRate: finite().min(0).max(1),
  storageFullCycles: nonNegative(100_000),
});

const monthlyEnergyResultV2Schema = z.array(z.strictObject({
  month: z.int().min(1).max(12),
  generationKwh: nonNegative(10_000_000),
  selfConsumptionKwh: nonNegative(10_000_000),
  gridImportKwh: nonNegative(10_000_000),
  feedInKwh: nonNegative(10_000_000),
})).length(12);

/**
 * Slice B: Bestands-Ergebnis (nur Bestand-Branch; v1-Port
 * baseline/geplant/Delta). Top-level annual/monthly tragen den
 * geplanten Zustand (Angebotszustand, wie v1-planned).
 */
const existingInstallationResultV2Schema = z.strictObject({
  existingSystemPeakPowerKwp: finite().gt(0).max(1_000),
  existingStorageCapacityKwh: nonNegative(100_000),
  addedStorageCapacityKwh: nonNegative(100_000),
  baseline: z.strictObject({
    annual: annualEnergyResultV2Schema,
    monthly: monthlyEnergyResultV2Schema,
  }),
  delta: z.strictObject({
    additionalSelfConsumptionKwh: finite().min(-10_000_000).max(10_000_000),
    autonomyRatePercentagePoints: finite().min(-100).max(100),
  }),
});

const warningsV2Schema = z.array(z.strictObject({
  code: z.enum([
    "provider_estimate",
    "unknown_profile_field",
    "existing_installation_limited",
    "bidirectional_charging_not_modeled",
    "backup_power_not_modeled",
  ]),
  severity: z.enum(["info", "warning"]),
})).max(20);

export const planningCalculationResultV2Schema = z.strictObject({
  contractVersion: z.literal(CALCULATION_V2_RESULT_CONTRACT_VERSION),
  canonicalizationVersion: z.literal("planning-jcs.v1"),
  model: z.strictObject({
    id: z.literal(CALCULATION_V2_MODEL_ID),
    version: z.literal(CALCULATION_V2_MODEL_VERSION),
    sourceRevision: z.literal(CALCULATION_V2_SOURCE_REVISION),
  }),
  inputSha256: sha256Schema,
  quality: z.literal("server_reproduced_public_reference"),
  validationStatus: z.literal("f4_public_reference_validated"),
  temporalResolution: z.literal("quarter_hour_35040"),
  roundingVersion: z.literal("wmee-energy-rounding.v1"),
  annual: annualEnergyResultV2Schema,
  monthly: monthlyEnergyResultV2Schema,
  warnings: warningsV2Schema,
  // Slice B: nur Bestand-Branch (Neuanlage laesst den Schluessel weg).
  existingInstallation: existingInstallationResultV2Schema.optional(),
});

export type PlanningCalculationRequestV2 = z.infer<
  typeof planningCalculationRequestV2Schema
>;
export type PlanningCalculationResultV2 = z.infer<
  typeof planningCalculationResultV2Schema
>;
export const PlanningCalculationRequestV2Schema = planningCalculationRequestV2Schema;
export const PlanningCalculationResultV2Schema = planningCalculationResultV2Schema;

function jsonSchemaForV2(schema: z.ZodType): Record<string, unknown> {
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

/**
 * Rendert das bytegepinnte JSON-Schema-Dokument fuer
 * planning-calculation.v2 (Spec F4-01). Struktur wie v1
 * (`renderPlanningCalculationJsonSchema`): $defs request/result plus
 * maschinenpruefbare semantische Invarianten als Freitext-Anker.
 */
export function renderPlanningCalculationJsonSchemaV2(): string {
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://contracts.wmee.internal/planning-calculation.v2.schema.json",
    title: "WMEE planning calculation v2",
    oneOf: [
      { $ref: "#/$defs/request" },
      { $ref: "#/$defs/result" },
    ],
    $defs: {
      request: jsonSchemaForV2(planningCalculationRequestV2Schema),
      result: jsonSchemaForV2(planningCalculationResultV2Schema),
    },
    "x-semantic-invariants": [
      "axis is exactly 35040 quarter-hour slots of weather year 2020 without Feb 29",
      "pvKwh and loadKwh are 35040 finite non-negative kWh values per slot",
      "inputSha256 uses planning-jcs.v1 over the request",
      "storage window is ground-based like v1: socMinKwh is 0, socMaxKwh is usable capacity",
      "charge and discharge power are symmetric; etaCharge and etaDischarge split roundtrip symmetrically",
      "dispatch is load-first with cyclic state of charge; null storage is a no-op branch",
      "result contractVersion is planning-calculation-result.v2; the result carries no resultSha256 field",
      "quality is server_reproduced_public_reference and validationStatus is f4_public_reference_validated",
      "monthly rows are January through December; monthly sums cover the year exactly",
      "warnings carry provider_estimate only when the provider series are estimated",
    ],
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
