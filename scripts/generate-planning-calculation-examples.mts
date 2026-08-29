import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CALCULATION_CANONICALIZATION_VERSION,
  PLANNING_CALCULATION_CONTRACT_VERSION,
  PLANNING_CALCULATION_RESULT_CONTRACT_VERSION,
  PLANNING_CALCULATION_SCHEMA_SHA256,
  SITE_ENERGY_PROFILE_SCHEMA_VERSION,
  hashPlanningCalculationInput,
  hashPlanningCalculationResult,
  validatePlanningCalculationRequest,
  validatePlanningCalculationResultForRequest,
} from "@/lib/integrations/calculation/contract";
import {
  PLANNING_MODEL_SOURCE_REVISION,
} from "@/lib/integrations/calculation/versions";

const root = resolve(import.meta.dirname, "..");
const examplesDirectory = resolve(root, "contracts/examples");
const mode = process.argv[2] ?? "--check";

const ids = {
  workspace: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  site: "33333333-3333-4333-8333-333333333333",
  energyProfile: "44444444-4444-4444-8444-444444444444",
  projectRequirement: "55555555-5555-4555-8555-555555555555",
  calculatorSnapshot: "66666666-6666-4666-8666-666666666666",
} as const;

type Branch = "new_installation" | "existing_installation";
type KnownSource =
  | "operator_reviewed"
  | "rechner_input"
  | "customer_metered"
  | "customer_input";

const known = <T,>(value: T, source: KnownSource = "operator_reviewed") => ({
  status: "known" as const,
  value,
  source,
});

const unknown = () => ({
  status: "unknown" as const,
  value: null,
  source: "not_collected" as const,
});

const sourceTimestampsUtc = Array.from({ length: 8_784 }, (_, hour) =>
  new Date(Date.UTC(2020, 0, 1, hour)).toISOString(),
);
const hourlyPowerWPerKwp = Array.from({ length: 8_760 }, (_, hour) =>
  hour % 24 >= 7 && hour % 24 <= 18 ? 500 : 0,
);
const hourlyTemperatureC = Array.from({ length: 8_760 }, (_, hour) =>
  Math.round(10 + 8 * Math.sin((hour / 8_760) * Math.PI * 2)),
);

function yieldSnapshot() {
  return {
    roofId: "dach-sued",
    provider: "pvgis" as const,
    apiVersion: "5_3" as const,
    radiationDatabase: "PVGIS-SARAH3" as const,
    request: {
      queryContractVersion: "pvgis-query.v1" as const,
      coordinateRounding: "pvgis-coordinate-rounding-3dp.v1" as const,
      latitude: 49.285,
      longitude: 8.738,
      tiltDeg: 35,
      azimuthDeg: 5,
      azimuthConvention: "pvgis_south_zero_east_negative" as const,
      peakPowerKwp: 1 as const,
      systemLossPercent: 14 as const,
      pvCalculation: true as const,
      pvTechnology: "crystSi" as const,
      mountingPlace: "free" as const,
      useHorizon: true as const,
      trackingType: 0 as const,
      outputFormat: "json" as const,
    },
    annual: {
      tool: "PVcalc" as const,
      fetchedAt: "2026-08-29T10:00:00.000Z",
      rawResponseSha256: "1".repeat(64),
      annualYieldKwhPerKwp: 1_114.2,
      monthlyYieldKwhPerKwp: [45, 62, 91, 112, 130, 136, 135, 122, 96, 77, 57, 51.2],
    },
    hourly: {
      tool: "seriescalc" as const,
      weatherYear: 2020 as const,
      startYear: 2020 as const,
      endYear: 2020 as const,
      fetchedAt: "2026-08-29T10:00:01.000Z",
      rawResponseSha256: "1".repeat(64),
      sourceLength: 8_784 as const,
      sourceTimeBasis: "utc" as const,
      sourceTimestampsUtc,
      normalization: "pvgis_utc_to_europe_berlin_then_drop_feb_29.v1" as const,
      targetTimeZone: "Europe/Berlin" as const,
      normalizedHourConvention: "local_non_leap_jan01_00.v1" as const,
      annualScaling: "scale_hourly_shape_to_pvcalc_annual.v1" as const,
      hourlyPowerWPerKwp,
      hourlyTemperatureC,
    },
  };
}

function requestFixture(branch: Branch) {
  return {
    contractVersion: PLANNING_CALCULATION_CONTRACT_VERSION,
    canonicalizationVersion: CALCULATION_CANONICALIZATION_VERSION,
    branch,
    asOfDate: "2026-08-29",
    commissioningDate: "2027-03-15",
    bindings: {
      workspaceId: ids.workspace,
      projectId: ids.project,
      siteId: ids.site,
      addressRevision: 2,
      pinConfirmedAddressRevision: 2,
      energyProfileId: ids.energyProfile,
      energyProfileRevision: 3,
      confirmedEnergyProfileRevision: 3,
      confirmedEnergyProfileAddressRevision: 2,
      projectRequirementId: ids.projectRequirement,
      projectRequirementRevision: 1,
      sourceCalculatorSnapshotId: ids.calculatorSnapshot,
    },
    site: {
      countryCode: "DE" as const,
      latitude: 49.28463,
      longitude: 8.73821,
    },
    energyProfile: {
      schemaVersion: SITE_ENERGY_PROFILE_SCHEMA_VERSION,
      inputMode: "consumption" as const,
      building: {
        type: known("single_family" as const, "rechner_input"),
        year: known(1998, "rechner_input"),
        heatedAreaM2: known(145, "rechner_input"),
      },
      roofs: [{
        id: "dach-sued",
        areaM2: 52,
        azimuthDeg: 5,
        tiltDeg: 35,
        type: "pitched" as const,
        shading: known("light" as const, "rechner_input"),
        source: "user_drawn" as const,
      }],
      consumption: {
        householdKwhPerYear: known(4_200, "customer_metered"),
        electricityPriceCentsPerKwh: known(36, "customer_input"),
        annualPriceIncreasePercent: unknown(),
        loadProfile: unknown(),
        evKmPerYear: known(12_000, "customer_input"),
        evChargingPattern: known("evening" as const, "customer_input"),
        heatPumpKwhPerYear: known(0, "customer_input"),
        coolingKwhPerYear: known(0, "customer_input"),
        heatingAcKwhPerYear: known(0, "customer_input"),
        hotWaterKwhPerYear: unknown(),
      },
      existingAssets: {
        pv: branch === "existing_installation"
          ? {
              status: "known_present" as const,
              source: "rechner_input" as const,
              peakPowerKwp: 7.4,
              commissioningYear: 2012,
            }
          : { status: "known_absent" as const, source: "rechner_branch" as const },
        storage: { status: "known_absent" as const, source: "rechner_input" as const },
        wallbox: { status: "unknown" as const, source: "not_collected" as const },
        ev: { status: "known_present" as const, source: "rechner_consumption" as const },
      },
      provenance: {
        source: "rechner_snapshot" as const,
        sourceSchemaVersion: "wmee-solar-snapshot.v1" as const,
        sourceEngine: "wmee-solar.v1" as const,
        roof: "user_drawn" as const,
        consumption: "metered_kwh" as const,
        electricityPrice: "customer" as const,
        annualPriceIncrease: "default" as const,
      },
    },
    projectRequirements: {
      schemaVersion: "project-requirements.rechner.v1" as const,
      source: "wmee-rechner-v3" as const,
      branch,
      requestedProducts: {
        targetStorageKwh: 8,
        wallbox: true,
        bidirectionalCharging: false,
        backupPower: false,
      },
    },
    effectiveConsumption: {
      householdKwhPerYear: {
        resolution: "profile_value" as const,
        value: 4_200,
        profileField: "/consumption/householdKwhPerYear" as const,
      },
      loadProfile: {
        resolution: "versioned_default" as const,
        value: "wmee_household_hourly.v1" as const,
        defaultKey: "loadProfile" as const,
        defaultsVersion: "wmee-planning-defaults.v1" as const,
      },
      evKmPerYear: {
        resolution: "profile_value" as const,
        value: 12_000,
        profileField: "/consumption/evKmPerYear" as const,
      },
      evChargingPattern: {
        resolution: "profile_value" as const,
        value: "evening" as const,
        profileField: "/consumption/evChargingPattern" as const,
      },
      heatPumpKwhPerYear: {
        resolution: "profile_value" as const,
        value: 0,
        profileField: "/consumption/heatPumpKwhPerYear" as const,
      },
      coolingKwhPerYear: {
        resolution: "profile_value" as const,
        value: 0,
        profileField: "/consumption/coolingKwhPerYear" as const,
      },
      heatingAcKwhPerYear: {
        resolution: "profile_value" as const,
        value: 0,
        profileField: "/consumption/heatingAcKwhPerYear" as const,
      },
      hotWaterKwhPerYear: {
        resolution: "versioned_default" as const,
        value: 0,
        defaultKey: "hotWaterKwhPerYear" as const,
        defaultsVersion: "wmee-planning-defaults.v1" as const,
      },
    },
    effectiveStorageRequest: {
      resolution: "project_requirement" as const,
      valueKwh: 8,
      requirementField: "/requestedProducts/targetStorageKwh" as const,
      meaning: branch === "new_installation"
        ? "planned_total_capacity" as const
        : "additional_capacity" as const,
    },
    resolvedAssumptions: {
      systemLossPercent: {
        resolution: "versioned_default" as const,
        value: 14,
        defaultKey: "systemLossPercent" as const,
        defaultsVersion: "wmee-planning-defaults.v1" as const,
      },
      storageRoundtripEfficiency: {
        resolution: "rechner_input" as const,
        value: 0.92,
        source: "rechner_snapshot" as const,
        sourceField: "/inputs/assumptions/storageRoundtripEfficiency" as const,
      },
      storageDepthOfDischarge: {
        resolution: "versioned_default" as const,
        value: 0.9,
        defaultKey: "storageDepthOfDischarge" as const,
        defaultsVersion: "wmee-planning-defaults.v1" as const,
      },
      moduleDegradationPerYear: {
        resolution: "versioned_default" as const,
        value: 0.005,
        defaultKey: "moduleDegradationPerYear" as const,
        defaultsVersion: "wmee-planning-defaults.v1" as const,
      },
      horizonYears: {
        resolution: "rechner_input" as const,
        value: 20,
        source: "rechner_snapshot" as const,
        sourceField: "/inputs/assumptions/horizonYears" as const,
      },
      commissioningDate: {
        resolution: "versioned_default" as const,
        value: "2027-03-15",
        defaultKey: "commissioningDate" as const,
        defaultsVersion: "wmee-planning-defaults.v1" as const,
      },
    },
    yieldSnapshots: [yieldSnapshot()],
  };
}

const months = (
  generationKwh: number,
  selfConsumptionKwh: number,
  gridImportKwh: number,
  feedInKwh: number,
) => Array.from({ length: 12 }, (_, month) => ({
  month: month + 1,
  generationKwh,
  selfConsumptionKwh,
  gridImportKwh,
  feedInKwh,
}));

const resultBase = (inputSha256: string, branch: Branch) => ({
  contractVersion: PLANNING_CALCULATION_RESULT_CONTRACT_VERSION,
  canonicalizationVersion: CALCULATION_CANONICALIZATION_VERSION,
  model: {
    id: "wmee-solar" as const,
    version: "1.0.0",
    sourceRevision: PLANNING_MODEL_SOURCE_REVISION,
  },
  inputSha256,
  quality: "server_reproduced_estimate" as const,
  validationStatus: "not_f4_reference_validated" as const,
  temporalResolution: "hourly_8760" as const,
  roundingVersion: "wmee-energy-rounding.v1" as const,
  warnings: [
    { code: "not_f4_reference_validated" as const, severity: "warning" as const },
    { code: "provider_estimate" as const, severity: "info" as const },
    { code: "unknown_profile_field" as const, severity: "warning" as const },
    ...(branch === "existing_installation"
      ? [{ code: "existing_installation_limited" as const, severity: "info" as const }]
      : []),
  ],
});

function withResultHash<T extends object>(body: T): T & { resultSha256: string } {
  return { ...body, resultSha256: hashPlanningCalculationResult(body) };
}

function newResultFixture(inputSha256: string) {
  return withResultHash({
    ...resultBase(inputSha256, "new_installation"),
    branch: "new_installation" as const,
    calculation: {
      systemPeakPowerKwp: 10.4,
      plannedStorageCapacityKwh: 8,
      annual: {
        generationKwh: 12_000,
        consumptionKwh: 7_200,
        directConsumptionKwh: 3_600,
        fromStorageKwh: 2_400,
        selfConsumptionKwh: 6_000,
        feedInKwh: 5_791.304348,
        gridImportKwh: 1_200,
        storageLossKwh: 208.695652,
        selfConsumptionRate: 0.5,
        autonomyRate: 5 / 6,
        storageFullCycles: 333.333333,
        fromVehicleKwh: 0,
      },
      monthly: months(1_000, 500, 100, 5_791.304348 / 12),
    },
  });
}

function existingResultFixture(inputSha256: string) {
  const baselineAnnual = {
    generationKwh: 8_400,
    consumptionKwh: 7_200,
    directConsumptionKwh: 3_600,
    fromStorageKwh: 0,
    selfConsumptionKwh: 3_600,
    feedInKwh: 4_800,
    gridImportKwh: 3_600,
    storageLossKwh: 0,
    selfConsumptionRate: 3 / 7,
    autonomyRate: 0.5,
    storageFullCycles: 0,
    fromVehicleKwh: 0,
  };
  const plannedAnnual = {
    generationKwh: 8_400,
    consumptionKwh: 7_200,
    directConsumptionKwh: 3_600,
    fromStorageKwh: 2_400,
    selfConsumptionKwh: 6_000,
    feedInKwh: 2_191.304348,
    gridImportKwh: 1_200,
    storageLossKwh: 208.695652,
    selfConsumptionRate: 5 / 7,
    autonomyRate: 5 / 6,
    storageFullCycles: 333.333333,
    fromVehicleKwh: 0,
  };
  return withResultHash({
    ...resultBase(inputSha256, "existing_installation"),
    branch: "existing_installation" as const,
    calculation: {
      existingSystemPeakPowerKwp: 7.4,
      existingStorageCapacityKwh: 0,
      addedStorageCapacityKwh: 8,
      baseline: {
        annual: baselineAnnual,
        monthly: months(700, 300, 300, 400),
      },
      planned: {
        annual: plannedAnnual,
        monthly: months(700, 500, 100, 2_191.304348 / 12),
      },
      delta: {
        additionalSelfConsumptionKwh: 2_400,
        autonomyRatePercentagePoints: 100 / 3,
      },
    },
  });
}

const newRequest = requestFixture("new_installation");
const existingRequest = requestFixture("existing_installation");
const newInputSha256 = hashPlanningCalculationInput(newRequest);
const existingInputSha256 = hashPlanningCalculationInput(existingRequest);
const newResult = newResultFixture(newInputSha256);
const existingResult = existingResultFixture(existingInputSha256);

for (const [label, validation] of [
  ["new.request", validatePlanningCalculationRequest(newRequest)],
  ["existing.request", validatePlanningCalculationRequest(existingRequest)],
  ["new.result", validatePlanningCalculationResultForRequest(newRequest, newResult)],
  [
    "existing.result",
    validatePlanningCalculationResultForRequest(existingRequest, existingResult),
  ],
] as const) {
  if (!validation.ok) {
    throw new Error(`${label} ist kein gueltiges Golden Example: ${validation.paths.join(", ")}`);
  }
}

const jsonFiles = new Map<string, string>([
  ["planning-calculation.v1.new.request.json", `${JSON.stringify(newRequest, null, 2)}\n`],
  ["planning-calculation.v1.existing.request.json", `${JSON.stringify(existingRequest, null, 2)}\n`],
  ["planning-calculation.v1.new.result.json", `${JSON.stringify(newResult, null, 2)}\n`],
  ["planning-calculation.v1.existing.result.json", `${JSON.stringify(existingResult, null, 2)}\n`],
]);

const fileSha256 = Object.fromEntries(
  [...jsonFiles].map(([name, contents]) => [
    name,
    createHash("sha256").update(contents).digest("hex"),
  ]),
);
const manifest = {
  contractVersion: PLANNING_CALCULATION_CONTRACT_VERSION,
  canonicalizationVersion: CALCULATION_CANONICALIZATION_VERSION,
  schemaSha256: PLANNING_CALCULATION_SCHEMA_SHA256,
  semanticSha256: {
    newInput: newInputSha256,
    existingInput: existingInputSha256,
    newResult: newResult.resultSha256,
    existingResult: existingResult.resultSha256,
  },
  fileSha256,
};
jsonFiles.set(
  "planning-calculation.v1.hashes.json",
  `${JSON.stringify(manifest, null, 2)}\n`,
);

if (mode === "--write") {
  for (const [name, contents] of jsonFiles) {
    writeFileSync(resolve(examplesDirectory, name), contents, "utf8");
  }
} else if (mode === "--check") {
  for (const [name, contents] of jsonFiles) {
    if (readFileSync(resolve(examplesDirectory, name), "utf8") !== contents) {
      throw new Error(`${name} ist nicht deterministisch aus dem Golden-Generator erzeugt.`);
    }
  }
} else {
  throw new Error("Erlaubt sind --check oder --write.");
}

process.stdout.write(`${JSON.stringify(manifest.semanticSha256)}\n`);
