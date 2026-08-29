import { createHash } from "node:crypto";
import { z } from "zod";

import {
  PLANNING_MODEL_ID,
  PLANNING_MODEL_SOURCE_REVISION,
  PLANNING_MODEL_VERSION,
} from "./versions";

export const PLANNING_CALCULATION_CONTRACT_VERSION = "planning-calculation.v1" as const;
export const PLANNING_CALCULATION_RESULT_CONTRACT_VERSION =
  PLANNING_CALCULATION_CONTRACT_VERSION;
export const SITE_ENERGY_PROFILE_SCHEMA_VERSION = "site-energy-profile.v1" as const;
export const CALCULATION_CANONICALIZATION_VERSION = "planning-jcs.v1" as const;

// Provider/Worker pinnen den bytegenauen, aus den Runtime-Schemas erzeugten
// Vertrag. Jede absichtliche Aenderung verlangt einen neuen Review und Hash.
export const PLANNING_CALCULATION_SCHEMA_SHA256 =
  "858dce4cc80af6591deb8a80f8fc7143cd8a74defa3430c906b705eabbf29b39" as const;

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const gitRevisionSchema = z.string().regex(/^[0-9a-f]{40}$/);
const dateSchema = z.iso.date();
const utcDateTimeSchema = z.iso.datetime({ offset: true }).regex(/Z$/);
const finite = () => z.number().finite();
const nonNegative = (max: number) => finite().min(0).max(max);
const positive = (max: number) => finite().gt(0).max(max);
const positiveRevision = z.int().safe().min(1);

export const knownFieldSourceSchema = z.enum([
  "operator_reviewed",
  "rechner_input",
  "customer_metered",
  "customer_input",
]);
export type KnownFieldSource = z.infer<typeof knownFieldSourceSchema>;

const unknownFieldSchema = z.strictObject({
  status: z.literal("unknown"),
  value: z.null(),
  source: z.literal("not_collected"),
});

function knownOrUnknown<T extends z.ZodType>(value: T) {
  return z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("known"),
      value,
      source: knownFieldSourceSchema,
    }),
    unknownFieldSchema,
  ]);
}

const assetSourceSchema = z.enum([
  "operator_reviewed",
  "rechner_input",
  "rechner_branch",
  "rechner_consumption",
]);

const simpleAssetSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("known_present"),
    source: assetSourceSchema,
  }),
  z.strictObject({
    status: z.literal("known_absent"),
    source: assetSourceSchema,
  }),
  z.strictObject({
    status: z.literal("unknown"),
    source: z.literal("not_collected"),
  }),
]);

const pvAssetSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("known_present"),
    source: assetSourceSchema,
    peakPowerKwp: positive(1_000),
    commissioningYear: z.int().min(1900).max(2200),
  }),
  z.strictObject({
    status: z.literal("known_absent"),
    source: assetSourceSchema,
  }),
  z.strictObject({
    status: z.literal("unknown"),
    source: z.literal("not_collected"),
  }),
]);

const storageAssetSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("known_present"),
    source: assetSourceSchema,
    capacityKwh: positive(1_000),
  }),
  z.strictObject({
    status: z.literal("known_absent"),
    source: assetSourceSchema,
  }),
  z.strictObject({
    status: z.literal("unknown"),
    source: z.literal("not_collected"),
  }),
]);

const buildingTypeSchema = z.enum([
  "single_family",
  "two_family",
  "multi_family",
  "commercial",
]);
const roofTypeSchema = z.enum(["pitched", "flat"]);
const shadingSchema = z.enum(["none", "light", "medium", "strong"]);
const chargingPatternSchema = z.enum(["evening", "daytime", "away"]);

export const siteEnergyProfileV1Schema = z.strictObject({
  schemaVersion: z.literal(SITE_ENERGY_PROFILE_SCHEMA_VERSION),
  // property/roomwise/manual erhalten je einen eigenen Contract-Slice. Ein
  // unbekannter oder nur halb implementierter Modus passiert v1 nicht.
  inputMode: z.literal("consumption"),
  building: z.strictObject({
    type: knownOrUnknown(buildingTypeSchema),
    year: knownOrUnknown(z.int().min(1800).max(2200)),
    heatedAreaM2: knownOrUnknown(nonNegative(10_000)),
  }),
  roofs: z.array(z.strictObject({
    id: z.string().trim().min(1).max(64),
    areaM2: positive(2_000),
    azimuthDeg: finite().min(-180).max(180),
    tiltDeg: finite().min(0).max(90),
    type: roofTypeSchema,
    shading: knownOrUnknown(shadingSchema),
    source: z.enum(["lod2", "user_drawn", "osm", "default", "operator_reviewed"]),
  })).min(1).max(4),
  consumption: z.strictObject({
    householdKwhPerYear: knownOrUnknown(nonNegative(100_000)),
    electricityPriceCentsPerKwh: knownOrUnknown(finite().min(1).max(200)),
    annualPriceIncreasePercent: knownOrUnknown(finite().min(-10).max(25)),
    loadProfile: knownOrUnknown(z.enum([
      "wmee_household_hourly.v1",
      "customer_monthly_hourly.v1",
      "commercial_interval.v1",
    ])),
    evKmPerYear: knownOrUnknown(nonNegative(200_000)),
    evChargingPattern: knownOrUnknown(chargingPatternSchema),
    heatPumpKwhPerYear: knownOrUnknown(nonNegative(100_000)),
    coolingKwhPerYear: knownOrUnknown(nonNegative(100_000)),
    heatingAcKwhPerYear: knownOrUnknown(nonNegative(100_000)),
    hotWaterKwhPerYear: knownOrUnknown(nonNegative(20_000)),
  }),
  existingAssets: z.strictObject({
    pv: pvAssetSchema,
    storage: storageAssetSchema,
    wallbox: simpleAssetSchema,
    ev: simpleAssetSchema,
  }),
  provenance: z.strictObject({
    source: z.literal("rechner_snapshot"),
    sourceSchemaVersion: z.literal("wmee-solar-snapshot.v1"),
    sourceEngine: z.literal("wmee-solar.v1"),
    roof: z.enum(["lod2", "user_drawn", "osm", "default"]),
    consumption: z.enum(["metered_kwh", "derived_from_cost", "estimated_people", "default"]),
    electricityPrice: z.enum(["customer", "default"]),
    annualPriceIncrease: z.enum(["customer", "default"]),
  }),
});

const projectRequirementsSchema = z.strictObject({
  schemaVersion: z.literal("project-requirements.rechner.v1"),
  source: z.literal("wmee-rechner-v3"),
  branch: z.enum(["new_installation", "existing_installation"]),
  requestedProducts: z.strictObject({
    targetStorageKwh: nonNegative(40),
    wallbox: z.boolean(),
    bidirectionalCharging: z.boolean(),
    backupPower: z.boolean(),
  }),
});

export const ProjectRequirementsRechnerV1Schema = projectRequirementsSchema;
export type ProjectRequirementsRechnerV1 = z.infer<typeof projectRequirementsSchema>;

const defaultsVersionSchema = z.literal("wmee-planning-defaults.v1");

function resolvedProfileValue<T extends z.ZodType>(
  value: T,
  profileField: string,
  defaultKey?: string,
) {
  const profile = z.strictObject({
    resolution: z.literal("profile_value"),
    value,
    profileField: z.literal(profileField),
  });
  if (defaultKey === undefined) return profile;
  return z.discriminatedUnion("resolution", [
    profile,
    z.strictObject({
      resolution: z.literal("versioned_default"),
      value,
      defaultKey: z.literal(defaultKey),
      defaultsVersion: defaultsVersionSchema,
    }),
  ]);
}

function resolvedRechnerAssumption<T extends z.ZodType>(
  value: T,
  sourceField: string,
  defaultKey: string,
) {
  return z.discriminatedUnion("resolution", [
    z.strictObject({
      resolution: z.literal("rechner_input"),
      value,
      source: z.literal("rechner_snapshot"),
      sourceField: z.literal(sourceField),
    }),
    z.strictObject({
      resolution: z.literal("versioned_default"),
      value,
      defaultKey: z.literal(defaultKey),
      defaultsVersion: defaultsVersionSchema,
    }),
  ]);
}

const effectiveConsumptionSchema = z.strictObject({
  householdKwhPerYear: resolvedProfileValue(
    nonNegative(100_000),
    "/consumption/householdKwhPerYear",
  ),
  loadProfile: resolvedProfileValue(
    z.enum([
      "wmee_household_hourly.v1",
      "customer_monthly_hourly.v1",
      "commercial_interval.v1",
    ]),
    "/consumption/loadProfile",
    "loadProfile",
  ),
  evKmPerYear: resolvedProfileValue(
    nonNegative(200_000),
    "/consumption/evKmPerYear",
    "evKmPerYear",
  ),
  evChargingPattern: resolvedProfileValue(
    chargingPatternSchema,
    "/consumption/evChargingPattern",
    "evChargingPattern",
  ),
  heatPumpKwhPerYear: resolvedProfileValue(
    nonNegative(100_000),
    "/consumption/heatPumpKwhPerYear",
    "heatPumpKwhPerYear",
  ),
  coolingKwhPerYear: resolvedProfileValue(
    nonNegative(100_000),
    "/consumption/coolingKwhPerYear",
    "coolingKwhPerYear",
  ),
  heatingAcKwhPerYear: resolvedProfileValue(
    nonNegative(100_000),
    "/consumption/heatingAcKwhPerYear",
    "heatingAcKwhPerYear",
  ),
  hotWaterKwhPerYear: resolvedProfileValue(
    nonNegative(20_000),
    "/consumption/hotWaterKwhPerYear",
    "hotWaterKwhPerYear",
  ),
});

const effectiveStorageRequestSchema = z.strictObject({
  resolution: z.literal("project_requirement"),
  valueKwh: nonNegative(40),
  requirementField: z.literal("/requestedProducts/targetStorageKwh"),
  meaning: z.enum(["planned_total_capacity", "additional_capacity"]),
});

const yieldSnapshotSchema = z.strictObject({
  roofId: z.string().trim().min(1).max(64),
  provider: z.literal("pvgis"),
  apiVersion: z.literal("5_3"),
  radiationDatabase: z.literal("PVGIS-SARAH3"),
  request: z.strictObject({
    queryContractVersion: z.literal("pvgis-query.v1"),
    coordinateRounding: z.literal("pvgis-coordinate-rounding-3dp.v1"),
    latitude: finite().min(-90).max(90),
    longitude: finite().min(-180).max(180),
    tiltDeg: finite().min(0).max(90),
    azimuthDeg: finite().min(-180).max(180),
    azimuthConvention: z.literal("pvgis_south_zero_east_negative"),
    peakPowerKwp: z.literal(1),
    systemLossPercent: z.literal(14),
    pvCalculation: z.literal(true),
    pvTechnology: z.literal("crystSi"),
    mountingPlace: z.literal("free"),
    useHorizon: z.literal(true),
    trackingType: z.literal(0),
    outputFormat: z.literal("json"),
  }),
  annual: z.strictObject({
    tool: z.literal("PVcalc"),
    fetchedAt: utcDateTimeSchema,
    rawResponseSha256: sha256Schema,
    annualYieldKwhPerKwp: nonNegative(10_000),
    monthlyYieldKwhPerKwp: z.array(nonNegative(2_000)).length(12),
  }),
  hourly: z.strictObject({
    tool: z.literal("seriescalc"),
    weatherYear: z.literal(2020),
    startYear: z.literal(2020),
    endYear: z.literal(2020),
    fetchedAt: utcDateTimeSchema,
    rawResponseSha256: sha256Schema,
    sourceLength: z.literal(8_784),
    sourceTimeBasis: z.literal("utc"),
    sourceTimestampsUtc: z.array(utcDateTimeSchema).length(8_784),
    normalization: z.literal("pvgis_utc_to_europe_berlin_then_drop_feb_29.v1"),
    targetTimeZone: z.literal("Europe/Berlin"),
    normalizedHourConvention: z.literal("local_non_leap_jan01_00.v1"),
    annualScaling: z.literal("scale_hourly_shape_to_pvcalc_annual.v1"),
    hourlyPowerWPerKwp: z.array(nonNegative(10_000)).length(8_760),
    hourlyTemperatureC: z.array(finite().min(-100).max(100)).length(8_760),
  }),
});

export const planningCalculationRequestV1Schema = z.strictObject({
  contractVersion: z.literal(PLANNING_CALCULATION_CONTRACT_VERSION),
  canonicalizationVersion: z.literal(CALCULATION_CANONICALIZATION_VERSION),
  branch: z.enum(["new_installation", "existing_installation"]),
  asOfDate: dateSchema,
  commissioningDate: dateSchema,
  bindings: z.strictObject({
    workspaceId: z.uuid(),
    projectId: z.uuid(),
    siteId: z.uuid(),
    addressRevision: positiveRevision,
    pinConfirmedAddressRevision: positiveRevision,
    energyProfileId: z.uuid(),
    energyProfileRevision: positiveRevision,
    confirmedEnergyProfileRevision: positiveRevision,
    confirmedEnergyProfileAddressRevision: positiveRevision,
    projectRequirementId: z.uuid(),
    projectRequirementRevision: positiveRevision,
    sourceCalculatorSnapshotId: z.uuid().nullable(),
  }),
  site: z.strictObject({
    countryCode: z.literal("DE"),
    latitude: finite().min(-90).max(90),
    longitude: finite().min(-180).max(180),
  }),
  energyProfile: siteEnergyProfileV1Schema,
  projectRequirements: projectRequirementsSchema,
  effectiveConsumption: effectiveConsumptionSchema,
  effectiveStorageRequest: effectiveStorageRequestSchema,
  resolvedAssumptions: z.strictObject({
    systemLossPercent: resolvedRechnerAssumption(
      finite().min(0).max(60),
      "/inputs/assumptions/systemLossPercent",
      "systemLossPercent",
    ),
    storageRoundtripEfficiency: resolvedRechnerAssumption(
      finite().min(0.01).max(1),
      "/inputs/assumptions/storageRoundtripEfficiency",
      "storageRoundtripEfficiency",
    ),
    storageDepthOfDischarge: resolvedRechnerAssumption(
      finite().min(0.01).max(1),
      "/inputs/assumptions/storageDepthOfDischarge",
      "storageDepthOfDischarge",
    ),
    moduleDegradationPerYear: resolvedRechnerAssumption(
      finite().min(0).max(0.2),
      "/inputs/assumptions/moduleDegradationPerYear",
      "moduleDegradationPerYear",
    ),
    horizonYears: resolvedRechnerAssumption(
      z.int().min(1).max(40),
      "/inputs/assumptions/horizonYears",
      "horizonYears",
    ),
    commissioningDate: resolvedRechnerAssumption(
      dateSchema,
      "/inputs/assumptions/plannedCommissioningDate",
      "commissioningDate",
    ),
  }),
  yieldSnapshots: z.array(yieldSnapshotSchema).min(1).max(4),
});

const annualEnergyResultSchema = z.strictObject({
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
  fromVehicleKwh: nonNegative(10_000_000),
});

const monthlyEnergyResultSchema = z.array(z.strictObject({
  month: z.int().min(1).max(12),
  generationKwh: nonNegative(10_000_000),
  selfConsumptionKwh: nonNegative(10_000_000),
  gridImportKwh: nonNegative(10_000_000),
  feedInKwh: nonNegative(10_000_000),
})).length(12);

const warningsSchema = z.array(z.strictObject({
  code: z.enum([
    "not_f4_reference_validated",
    "provider_estimate",
    "unknown_profile_field",
    "existing_installation_limited",
    "bidirectional_charging_not_modeled",
    "backup_power_not_modeled",
  ]),
  severity: z.enum(["info", "warning"]),
})).max(20);

const planningCalculationResultBaseV1Schema = z.strictObject({
  contractVersion: z.literal(PLANNING_CALCULATION_RESULT_CONTRACT_VERSION),
  canonicalizationVersion: z.literal(CALCULATION_CANONICALIZATION_VERSION),
  model: z.strictObject({
    id: z.literal("wmee-solar"),
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9.-]+)?$/),
    sourceRevision: gitRevisionSchema,
  }),
  inputSha256: sha256Schema,
  quality: z.literal("server_reproduced_estimate"),
  validationStatus: z.literal("not_f4_reference_validated"),
  temporalResolution: z.literal("hourly_8760"),
  roundingVersion: z.literal("wmee-energy-rounding.v1"),
  warnings: warningsSchema,
});

const planningCalculationNewResultBodyV1Schema = planningCalculationResultBaseV1Schema.extend({
  branch: z.literal("new_installation"),
  calculation: z.strictObject({
    systemPeakPowerKwp: positive(1_000),
    plannedStorageCapacityKwh: nonNegative(1_000),
    annual: annualEnergyResultSchema,
    monthly: monthlyEnergyResultSchema,
  }),
});

const planningCalculationExistingResultBodyV1Schema =
  planningCalculationResultBaseV1Schema.extend({
    branch: z.literal("existing_installation"),
    calculation: z.strictObject({
      existingSystemPeakPowerKwp: positive(1_000),
      existingStorageCapacityKwh: nonNegative(1_000),
      addedStorageCapacityKwh: nonNegative(1_000),
      baseline: z.strictObject({
        annual: annualEnergyResultSchema,
        monthly: monthlyEnergyResultSchema,
      }),
      planned: z.strictObject({
        annual: annualEnergyResultSchema,
        monthly: monthlyEnergyResultSchema,
      }),
      delta: z.strictObject({
        additionalSelfConsumptionKwh: finite().min(-10_000_000).max(10_000_000),
        autonomyRatePercentagePoints: finite().min(-100).max(100),
      }),
    }),
  });

export const planningCalculationNewResultV1Schema =
  planningCalculationNewResultBodyV1Schema.extend({
    resultSha256: sha256Schema,
  });

export const planningCalculationExistingResultV1Schema =
  planningCalculationExistingResultBodyV1Schema.extend({
    resultSha256: sha256Schema,
  });

export const planningCalculationResultV1Schema = z.discriminatedUnion("branch", [
  planningCalculationNewResultV1Schema,
  planningCalculationExistingResultV1Schema,
]);

const planningCalculationResultBodyV1Schema = z.discriminatedUnion("branch", [
  planningCalculationNewResultBodyV1Schema,
  planningCalculationExistingResultBodyV1Schema,
]);
export const PlanningCalculationResultBodyV1Schema = planningCalculationResultBodyV1Schema;

export type SiteEnergyProfileV1 = z.infer<typeof siteEnergyProfileV1Schema>;
export type PlanningCalculationRequestV1 = z.infer<typeof planningCalculationRequestV1Schema>;
export type PlanningCalculationResultBodyV1 = z.infer<typeof planningCalculationResultBodyV1Schema>;
export type PlanningCalculationResultV1 = z.infer<typeof planningCalculationResultV1Schema>;

export const SiteEnergyProfileV1Schema = siteEnergyProfileV1Schema;
export const PlanningCalculationRequestV1Schema = planningCalculationRequestV1Schema;
export const PlanningCalculationResultV1Schema = planningCalculationResultV1Schema;
export const PlanningCalculationNewResultV1Schema = planningCalculationNewResultV1Schema;
export const PlanningCalculationExistingResultV1Schema =
  planningCalculationExistingResultV1Schema;

export type CalculationContractResult<T> =
  | { ok: true; value: T }
  | { ok: false; paths: string[] };

function issuePath(path: PropertyKey[]): string {
  return path.length === 0 ? "/" : `/${path.map(String).join("/")}`;
}

function validationPaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => issuePath(issue.path)))].slice(0, 20);
}

function roundCoordinate3(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function arraysEqual<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function requestSemanticPaths(value: PlanningCalculationRequestV1): string[] {
  const paths: string[] = [];
  if (value.bindings.addressRevision !== value.bindings.pinConfirmedAddressRevision) {
    paths.push("/bindings/pinConfirmedAddressRevision");
  }
  if (
    value.bindings.addressRevision
    !== value.bindings.confirmedEnergyProfileAddressRevision
  ) {
    paths.push("/bindings/confirmedEnergyProfileAddressRevision");
  }
  if (
    value.bindings.energyProfileRevision
    !== value.bindings.confirmedEnergyProfileRevision
  ) {
    paths.push("/bindings/confirmedEnergyProfileRevision");
  }
  if (value.bindings.sourceCalculatorSnapshotId === null) {
    paths.push("/bindings/sourceCalculatorSnapshotId");
  }
  if (value.branch !== value.projectRequirements.branch) {
    paths.push("/projectRequirements/branch");
  }
  if (
    value.branch === "existing_installation" &&
    value.energyProfile.existingAssets.pv.status !== "known_present"
  ) {
    paths.push("/energyProfile/existingAssets/pv/status");
  }
  if (
    value.branch === "new_installation" &&
    value.energyProfile.existingAssets.pv.status !== "known_absent"
  ) {
    paths.push("/energyProfile/existingAssets/pv/status");
  }
  if (
    value.branch === "existing_installation"
    && value.energyProfile.existingAssets.storage.status === "unknown"
  ) {
    paths.push("/energyProfile/existingAssets/storage/status");
  }
  value.energyProfile.roofs.forEach((roof, index) => {
    if (roof.shading.status === "unknown") {
      paths.push(`/energyProfile/roofs/${index}/shading/status`);
    }
  });
  if (value.energyProfile.roofs.some((roof) => roof.source === "default")) {
    paths.push("/energyProfile/roofs");
  }

  const effectiveMeaning = value.branch === "new_installation"
    ? "planned_total_capacity"
    : "additional_capacity";
  if (
    value.effectiveStorageRequest.valueKwh
      !== value.projectRequirements.requestedProducts.targetStorageKwh
    || value.effectiveStorageRequest.meaning !== effectiveMeaning
  ) {
    paths.push("/effectiveStorageRequest");
  }

  if (value.resolvedAssumptions.commissioningDate.value !== value.commissioningDate) {
    paths.push("/resolvedAssumptions/commissioningDate/value");
  }

  const profileConsumption = value.energyProfile.consumption as unknown as Record<
    string,
    { status: "known" | "unknown"; value: unknown }
  >;
  const effectiveConsumption = value.effectiveConsumption as unknown as Record<
    string,
    { resolution: "profile_value" | "versioned_default"; value: unknown }
  >;
  for (const field of Object.keys(effectiveConsumption)) {
    const profileField = profileConsumption[field];
    const effectiveField = effectiveConsumption[field];
    if (profileField.status === "known") {
      if (
        effectiveField.resolution !== "profile_value"
        || effectiveField.value !== profileField.value
      ) {
        paths.push(`/effectiveConsumption/${field}`);
      }
    } else if (effectiveField.resolution !== "versioned_default") {
      paths.push(`/effectiveConsumption/${field}`);
    }
  }

  const roofIds = value.energyProfile.roofs.map((roof) => roof.id);
  const yieldRoofIds = value.yieldSnapshots.map((snapshot) => snapshot.roofId);
  if (new Set(roofIds).size !== roofIds.length) paths.push("/energyProfile/roofs");
  if (new Set(yieldRoofIds).size !== yieldRoofIds.length) paths.push("/yieldSnapshots");
  if (
    roofIds.length !== yieldRoofIds.length ||
    roofIds.some((roofId) => !yieldRoofIds.includes(roofId))
  ) {
    paths.push("/yieldSnapshots");
  }

  const expectedLatitude = roundCoordinate3(value.site.latitude);
  const expectedLongitude = roundCoordinate3(value.site.longitude);
  let referenceTemperature: number[] | undefined;
  for (let index = 0; index < value.yieldSnapshots.length; index += 1) {
    const snapshot = value.yieldSnapshots[index];
    const roof = value.energyProfile.roofs.find((candidate) => candidate.id === snapshot.roofId);
    if (
      snapshot.request.latitude !== expectedLatitude
      || snapshot.request.longitude !== expectedLongitude
    ) {
      paths.push(`/yieldSnapshots/${index}/request`);
    }
    if (
      roof === undefined
      || snapshot.request.tiltDeg !== roof.tiltDeg
      || snapshot.request.azimuthDeg !== roof.azimuthDeg
    ) {
      paths.push(`/yieldSnapshots/${index}/request`);
    }
    const timestampsAreCanonical = snapshot.hourly.sourceTimestampsUtc.every(
      (timestamp, hour) => timestamp === new Date(Date.UTC(2020, 0, 1, hour)).toISOString(),
    );
    if (!timestampsAreCanonical) {
      paths.push(`/yieldSnapshots/${index}/hourly/sourceTimestampsUtc`);
    }
    const monthlyTotal = snapshot.annual.monthlyYieldKwhPerKwp
      .reduce((sum, current) => sum + current, 0);
    // PVGIS rundet Monats- und Jahreswerte separat auf Centi-kWh/kWp. Der
    // fachlich erlaubte Abstand ist deshalb eine dargestellte Cent-Einheit;
    // ein roher Floatvergleich wuerde 0,0100000000002 faelschlich ablehnen.
    const monthlyTotalCentiKwh = Math.round(monthlyTotal * 100);
    const annualCentiKwh = Math.round(snapshot.annual.annualYieldKwhPerKwp * 100);
    if (Math.abs(monthlyTotalCentiKwh - annualCentiKwh) > 1) {
      paths.push(`/yieldSnapshots/${index}/annual/monthlyYieldKwhPerKwp`);
    }
    if (referenceTemperature === undefined) {
      referenceTemperature = snapshot.hourly.hourlyTemperatureC;
    } else if (!arraysEqual(referenceTemperature, snapshot.hourly.hourlyTemperatureC)) {
      paths.push(`/yieldSnapshots/${index}/hourly/hourlyTemperatureC`);
    }
  }
  return [...new Set(paths)].slice(0, 20);
}

export function validatePlanningCalculationRequest(
  value: unknown,
): CalculationContractResult<PlanningCalculationRequestV1> {
  const parsed = planningCalculationRequestV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, paths: validationPaths(parsed.error) };
  const semanticPaths = requestSemanticPaths(parsed.data);
  if (semanticPaths.length > 0) return { ok: false, paths: semanticPaths };
  return { ok: true, value: parsed.data };
}

const ENERGY_TOLERANCE_KWH = 0.01;
const RATE_TOLERANCE = 0.000_001;
const NEW_INSTALLATION_PEAK_POWER_KWP_PER_ROOF_M2 = 0.2;
const MAX_SYSTEM_PEAK_POWER_KWP = 1_000;

function closeTo(left: number, right: number, tolerance: number): boolean {
  return Math.abs(left - right) <= tolerance;
}

type AnnualEnergyResult = z.infer<typeof annualEnergyResultSchema>;
type MonthlyEnergyResult = z.infer<typeof monthlyEnergyResultSchema>;

function annualSemanticPaths(annual: AnnualEnergyResult, path: string): string[] {
  const paths: string[] = [];
  if (!closeTo(
    annual.selfConsumptionKwh,
    annual.directConsumptionKwh + annual.fromStorageKwh + annual.fromVehicleKwh,
    ENERGY_TOLERANCE_KWH,
  )) paths.push(`${path}/selfConsumptionKwh`);
  if (!closeTo(
    annual.generationKwh,
    annual.selfConsumptionKwh + annual.feedInKwh + annual.storageLossKwh,
    ENERGY_TOLERANCE_KWH,
  )) paths.push(`${path}/generationKwh`);
  if (!closeTo(
    annual.consumptionKwh,
    annual.selfConsumptionKwh + annual.gridImportKwh,
    ENERGY_TOLERANCE_KWH,
  )) paths.push(`${path}/consumptionKwh`);
  const expectedSelfConsumptionRate = annual.generationKwh === 0
    ? 0
    : annual.selfConsumptionKwh / annual.generationKwh;
  const expectedAutonomyRate = annual.consumptionKwh === 0
    ? 0
    : annual.selfConsumptionKwh / annual.consumptionKwh;
  if (!closeTo(
    annual.selfConsumptionRate,
    expectedSelfConsumptionRate,
    RATE_TOLERANCE,
  )) paths.push(`${path}/selfConsumptionRate`);
  if (!closeTo(annual.autonomyRate, expectedAutonomyRate, RATE_TOLERANCE)) {
    paths.push(`${path}/autonomyRate`);
  }
  // planning-calculation.v1 besitzt noch keine V2H-Physik. Ein Wert groesser
  // null waere deshalb keine Schaetzung, sondern eine falsche Energiequelle.
  if (annual.fromVehicleKwh !== 0) {
    paths.push(`${path}/fromVehicleKwh`);
  }
  return paths;
}

function monthlySemanticPaths(
  monthly: MonthlyEnergyResult,
  annual: AnnualEnergyResult,
  path: string,
): string[] {
  const paths: string[] = [];
  monthly.forEach((entry, index) => {
    if (entry.month !== index + 1) paths.push(`${path}/${index}/month`);
    // Einspeisung entsteht nur aus Erzeugung desselben Monats. Eigenverbrauch
    // darf dagegen Energie enthalten, die im Vormonat in den Speicher geladen
    // wurde; eine lokale selfConsumption+feedIn<=generation-Pruefung wuerde
    // deshalb einen gueltigen Monatsuebertrag ablehnen.
    if (entry.feedInKwh > entry.generationKwh + ENERGY_TOLERANCE_KWH) {
      paths.push(`${path}/${index}/feedInKwh`);
    }
  });
  for (const field of [
    "generationKwh",
    "selfConsumptionKwh",
    "gridImportKwh",
    "feedInKwh",
  ] as const) {
    const total = monthly.reduce((sum, entry) => sum + entry[field], 0);
    if (!closeTo(total, annual[field], ENERGY_TOLERANCE_KWH)) {
      paths.push(`${path}/${field}`);
    }
  }
  return paths;
}

function resultSemanticPaths(value: PlanningCalculationResultV1): string[] {
  const paths: string[] = [];
  const warningCodes = value.warnings.map((warning) => warning.code);
  if (new Set(warningCodes).size !== warningCodes.length) paths.push("/warnings");
  if (!value.warnings.some((warning) =>
    warning.code === "not_f4_reference_validated" && warning.severity === "warning"
  )) {
    paths.push("/warnings");
  }

  if (value.branch === "new_installation") {
    paths.push(...annualSemanticPaths(value.calculation.annual, "/calculation/annual"));
    paths.push(...monthlySemanticPaths(
      value.calculation.monthly,
      value.calculation.annual,
      "/calculation/monthly",
    ));
    if (
      value.calculation.plannedStorageCapacityKwh === 0
      && value.calculation.annual.storageFullCycles !== 0
    ) paths.push("/calculation/annual/storageFullCycles");
  } else {
    paths.push(...annualSemanticPaths(
      value.calculation.baseline.annual,
      "/calculation/baseline/annual",
    ));
    paths.push(...monthlySemanticPaths(
      value.calculation.baseline.monthly,
      value.calculation.baseline.annual,
      "/calculation/baseline/monthly",
    ));
    paths.push(...annualSemanticPaths(
      value.calculation.planned.annual,
      "/calculation/planned/annual",
    ));
    paths.push(...monthlySemanticPaths(
      value.calculation.planned.monthly,
      value.calculation.planned.annual,
      "/calculation/planned/monthly",
    ));
    const expectedAdditionalSelfConsumption =
      value.calculation.planned.annual.selfConsumptionKwh
      - value.calculation.baseline.annual.selfConsumptionKwh;
    const expectedAutonomyPercentagePoints =
      (value.calculation.planned.annual.autonomyRate
        - value.calculation.baseline.annual.autonomyRate) * 100;
    if (!closeTo(
      value.calculation.delta.additionalSelfConsumptionKwh,
      expectedAdditionalSelfConsumption,
      ENERGY_TOLERANCE_KWH,
    )) paths.push("/calculation/delta/additionalSelfConsumptionKwh");
    if (!closeTo(
      value.calculation.delta.autonomyRatePercentagePoints,
      expectedAutonomyPercentagePoints,
      RATE_TOLERANCE,
    )) paths.push("/calculation/delta/autonomyRatePercentagePoints");
    if (
      value.calculation.existingStorageCapacityKwh === 0
      && value.calculation.baseline.annual.storageFullCycles !== 0
    ) paths.push("/calculation/baseline/annual/storageFullCycles");
  }
  return [...new Set(paths)].slice(0, 20);
}

function requestBoundAnnualSemanticPaths(
  annual: AnnualEnergyResult,
  storageCapacityKwh: number,
  request: PlanningCalculationRequestV1,
  path: string,
): string[] {
  const paths: string[] = [];
  const usableCapacityKwh = storageCapacityKwh
    * request.resolvedAssumptions.storageDepthOfDischarge.value;

  if (usableCapacityKwh === 0) {
    if (annual.fromStorageKwh !== 0) {
      paths.push(`${path}/fromStorageKwh`);
    }
    if (annual.storageLossKwh !== 0) {
      paths.push(`${path}/storageLossKwh`);
    }
    if (annual.storageFullCycles !== 0) {
      paths.push(`${path}/storageFullCycles`);
    }
    return paths;
  }

  const expectedStorageLossKwh = annual.fromStorageKwh
    * (1 / request.resolvedAssumptions.storageRoundtripEfficiency.value - 1);
  if (!closeTo(
    annual.storageLossKwh,
    expectedStorageLossKwh,
    ENERGY_TOLERANCE_KWH,
  )) paths.push(`${path}/storageLossKwh`);

  const expectedStorageFullCycles = annual.fromStorageKwh / usableCapacityKwh;
  // Beide Groessen sind auf sechs Dezimalstellen gerundet. Bei kleinen, aber
  // gueltigen Speichern vergroessert die Division die halbe kWh-Rundungseinheit;
  // die Toleranz bildet exakt diesen Fehler fort, statt Kleinspannen abzulehnen.
  const cycleRoundingTolerance = RATE_TOLERANCE
    + (0.5 * RATE_TOLERANCE) / usableCapacityKwh;
  if (!closeTo(
    annual.storageFullCycles,
    expectedStorageFullCycles,
    cycleRoundingTolerance,
  )) paths.push(`${path}/storageFullCycles`);

  return paths;
}

function expectedRequestWarningKeys(request: PlanningCalculationRequestV1): string[] {
  const expected = [
    "not_f4_reference_validated:warning",
    "provider_estimate:info",
  ];
  if (Object.values(request.effectiveConsumption)
    .some((field) => field.resolution === "versioned_default")) {
    expected.push("unknown_profile_field:warning");
  }
  if (request.branch === "existing_installation") {
    expected.push("existing_installation_limited:info");
  }
  if (request.projectRequirements.requestedProducts.bidirectionalCharging) {
    expected.push("bidirectional_charging_not_modeled:warning");
  }
  if (request.projectRequirements.requestedProducts.backupPower) {
    expected.push("backup_power_not_modeled:warning");
  }
  return expected.sort();
}

export function validatePlanningCalculationResult(
  value: unknown,
): CalculationContractResult<PlanningCalculationResultV1> {
  const parsed = planningCalculationResultV1Schema.safeParse(value);
  if (!parsed.success) return { ok: false, paths: validationPaths(parsed.error) };
  const semanticPaths = resultSemanticPaths(parsed.data);
  if (semanticPaths.length > 0) return { ok: false, paths: semanticPaths };
  if (hashPlanningCalculationResult(parsed.data) !== parsed.data.resultSha256) {
    return { ok: false, paths: ["/resultSha256"] };
  }
  return { ok: true, value: parsed.data };
}

/**
 * Validiert die leichte paarweise Engine-Vorprüfung. Ein fuer sich gueltiges Resultat darf
 * nicht mit einem fremden Input-Hash, dem falschen Branch, umetikettierten
 * Anlagen-/Speicherdaten oder semantisch falschen Energiezuordnungen und
 * Warnungen weitergereicht werden. Persistenz und Lesen verwenden zusätzlich
 * die modellexakte Grenze aus validate-result.ts, die auch kohärent gemeinsam
 * veränderte Flüsse durch deterministische Neuberechnung erkennt.
 */
export function validatePlanningCalculationResultForRequest(
  requestValue: unknown,
  resultValue: unknown,
): CalculationContractResult<PlanningCalculationResultV1> {
  const request = validatePlanningCalculationRequest(requestValue);
  if (!request.ok) return request;
  const result = validatePlanningCalculationResult(resultValue);
  if (!result.ok) return result;

  const paths: string[] = [];
  if (result.value.inputSha256 !== hashPlanningCalculationInput(request.value)) {
    paths.push("/inputSha256");
  }
  if (result.value.model.id !== PLANNING_MODEL_ID) paths.push("/model/id");
  if (result.value.model.version !== PLANNING_MODEL_VERSION) paths.push("/model/version");
  if (result.value.model.sourceRevision !== PLANNING_MODEL_SOURCE_REVISION) {
    paths.push("/model/sourceRevision");
  }
  if (result.value.branch !== request.value.branch) {
    paths.push("/branch");
  } else if (result.value.branch === "new_installation") {
    const expectedSystemPeakPowerKwp = Math.min(
      MAX_SYSTEM_PEAK_POWER_KWP,
      request.value.energyProfile.roofs.reduce(
        (total, roof) => total + roof.areaM2,
        0,
      ) * NEW_INSTALLATION_PEAK_POWER_KWP_PER_ROOF_M2,
    );
    if (!closeTo(
      result.value.calculation.systemPeakPowerKwp,
      expectedSystemPeakPowerKwp,
      ENERGY_TOLERANCE_KWH,
    )) paths.push("/calculation/systemPeakPowerKwp");
    if (!closeTo(
      result.value.calculation.plannedStorageCapacityKwh,
      request.value.effectiveStorageRequest.valueKwh,
      ENERGY_TOLERANCE_KWH,
    )) paths.push("/calculation/plannedStorageCapacityKwh");
    paths.push(...requestBoundAnnualSemanticPaths(
      result.value.calculation.annual,
      request.value.effectiveStorageRequest.valueKwh,
      request.value,
      "/calculation/annual",
    ));
  } else {
    const pv = request.value.energyProfile.existingAssets.pv;
    const storage = request.value.energyProfile.existingAssets.storage;
    if (
      pv.status !== "known_present"
      || !closeTo(
        result.value.calculation.existingSystemPeakPowerKwp,
        pv.peakPowerKwp,
        ENERGY_TOLERANCE_KWH,
      )
    ) paths.push("/calculation/existingSystemPeakPowerKwp");
    const expectedExistingStorageKwh = storage.status === "known_present"
      ? storage.capacityKwh
      : 0;
    if (!closeTo(
      result.value.calculation.existingStorageCapacityKwh,
      expectedExistingStorageKwh,
      ENERGY_TOLERANCE_KWH,
    )) paths.push("/calculation/existingStorageCapacityKwh");
    if (!closeTo(
      result.value.calculation.addedStorageCapacityKwh,
      request.value.effectiveStorageRequest.valueKwh,
      ENERGY_TOLERANCE_KWH,
    )) paths.push("/calculation/addedStorageCapacityKwh");
    paths.push(...requestBoundAnnualSemanticPaths(
      result.value.calculation.baseline.annual,
      expectedExistingStorageKwh,
      request.value,
      "/calculation/baseline/annual",
    ));
    paths.push(...requestBoundAnnualSemanticPaths(
      result.value.calculation.planned.annual,
      expectedExistingStorageKwh + request.value.effectiveStorageRequest.valueKwh,
      request.value,
      "/calculation/planned/annual",
    ));
  }

  const actualWarningKeys = result.value.warnings
    .map((warning) => `${warning.code}:${warning.severity}`)
    .sort();
  const expectedWarningKeys = expectedRequestWarningKeys(request.value);
  if (
    actualWarningKeys.length !== expectedWarningKeys.length
    || actualWarningKeys.some((key, index) => key !== expectedWarningKeys[index])
  ) {
    paths.push("/warnings");
  }

  return paths.length === 0
    ? { ok: true, value: result.value }
    : { ok: false, paths: [...new Set(paths)].slice(0, 20) };
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("Ungepaartes Unicode-Surrogat im Calculation-JSON.");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("Ungepaartes Unicode-Surrogat im Calculation-JSON.");
    }
  }
}

/** RFC 8785/JCS fuer I-JSON, als `planning-jcs.v1` gepinnt. */
export function canonicalizeCalculationJson(value: unknown): string {
  const seen = new Set<object>();

  const serialize = (current: unknown): string => {
    if (current === null) return "null";
    if (typeof current === "boolean") {
      return JSON.stringify(current);
    }
    if (typeof current === "string") {
      assertWellFormedUnicode(current);
      return JSON.stringify(current);
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new TypeError("Nicht endliche Zahl im Calculation-JSON.");
      return JSON.stringify(Object.is(current, -0) ? 0 : current);
    }
    if (typeof current !== "object") {
      throw new TypeError("Nicht persistierbarer Wert im Calculation-JSON.");
    }
    if (seen.has(current)) throw new TypeError("Zyklus im Calculation-JSON.");
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
  return createHash("sha256")
    .update(canonicalizeCalculationJson(value), "utf8")
    .digest("hex");
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function toPlanningCalculationInputHashMaterialV1(
  value: unknown,
): JsonValue {
  const validated = validatePlanningCalculationRequest(value);
  if (!validated.ok) {
    throw new TypeError(`Ungueltiger Calculation-Input: ${validated.paths.join(", ")}`);
  }
  const request = structuredClone(validated.value);
  request.energyProfile.roofs.sort((left, right) => codeUnitCompare(left.id, right.id));
  request.yieldSnapshots.sort((left, right) => codeUnitCompare(left.roofId, right.roofId));
  const yieldSnapshots = request.yieldSnapshots.map((snapshot) => {
    const annual = { ...snapshot.annual } as Partial<typeof snapshot.annual>;
    const hourly = { ...snapshot.hourly } as Partial<typeof snapshot.hourly>;
    delete annual.fetchedAt;
    delete hourly.fetchedAt;
    return { ...snapshot, annual, hourly };
  });
  return { ...request, yieldSnapshots } as unknown as JsonValue;
}

export function hashPlanningCalculationInput(value: unknown): string {
  return hashCanonical(toPlanningCalculationInputHashMaterialV1(value));
}

export function hashPlanningCalculationResult(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Calculation-Result muss ein Objekt sein.");
  }
  const body = { ...(value as Record<string, unknown>) };
  delete body.resultSha256;
  const warnings = Array.isArray(body.warnings)
    ? [...body.warnings].sort((left, right) => {
        const leftKey = canonicalizeCalculationJson(left);
        const rightKey = canonicalizeCalculationJson(right);
        return codeUnitCompare(leftKey, rightKey);
      })
    : body.warnings;
  return hashCanonical({ ...body, warnings });
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

export function renderPlanningCalculationJsonSchema(): string {
  const document = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://contracts.wmee.internal/planning-calculation.v1.schema.json",
    title: "WMEE planning calculation v1",
    oneOf: [
      { $ref: "#/$defs/request" },
      { $ref: "#/$defs/result" },
    ],
    $defs: {
      request: jsonSchemaFor(planningCalculationRequestV1Schema),
      result: jsonSchemaFor(planningCalculationResultV1Schema),
    },
    "x-semantic-invariants": [
      "addressRevision equals pinConfirmedAddressRevision",
      "addressRevision equals confirmedEnergyProfileAddressRevision",
      "energyProfileRevision equals confirmedEnergyProfileRevision",
      "branch equals projectRequirements.branch",
      "new_installation requires known_absent PV; existing_installation requires known_present PV and known present-or-absent storage",
      "every calculated roof requires known shading; unknown shading has no hidden engine default",
      "effective inputs equal known profile values or carry a versioned default",
      "energyProfile.roofs and yieldSnapshots form the same unique roofId set",
      "PVGIS coordinates equal the three-decimal Site coordinates and angles equal their roofId",
      "source timestamps are UTC hours of leap year 2020 and normalized series have 8760 values",
      "inputSha256 uses planning-jcs.v1, sorts roofId sets, and omits only fetchedAt",
      "result months are January through December; monthly feed-in does not exceed same-month generation; battery energy may cross month boundaries; monthly sums and cyclic annual balances/rates are conserved",
      "direct, stationary-storage, and vehicle energy allocations are explicit; fromVehicleKwh is zero while bidirectional charging is not modeled",
      "request/result pairs bind model identity, inputSha256, branch, derived or existing PV peak, storage capacities, efficiency loss, full cycles, and the exact quality/feature warning set",
      "resultSha256 uses planning-jcs.v1 over the result without resultSha256 and sorted warnings",
    ],
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
