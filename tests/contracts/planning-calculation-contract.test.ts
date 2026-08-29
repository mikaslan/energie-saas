import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CALCULATION_CANONICALIZATION_VERSION,
  PLANNING_CALCULATION_CONTRACT_VERSION,
  PLANNING_CALCULATION_RESULT_CONTRACT_VERSION,
  PLANNING_CALCULATION_SCHEMA_SHA256,
  SITE_ENERGY_PROFILE_SCHEMA_VERSION,
  canonicalizeCalculationJson,
  hashPlanningCalculationInput,
  hashPlanningCalculationResult,
  renderPlanningCalculationJsonSchema,
  validatePlanningCalculationRequest,
  validatePlanningCalculationResult,
  validatePlanningCalculationResultForRequest,
  type PlanningCalculationResultV1,
} from "@/lib/integrations/calculation/contract";
import {
  PLANNING_MODEL_SOURCE_REVISION,
} from "@/lib/integrations/calculation/versions";

const root = resolve(import.meta.dirname, "../..");
const schemaPath = resolve(root, "contracts/planning-calculation.v1.schema.json");
const examplesPath = resolve(root, "contracts/examples");
const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");

const ids = {
  workspace: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  site: "33333333-3333-4333-8333-333333333333",
  energyProfile: "44444444-4444-4444-8444-444444444444",
  projectRequirement: "55555555-5555-4555-8555-555555555555",
  calculatorSnapshot: "66666666-6666-4666-8666-666666666666",
} as const;

type KnownFieldSource =
  | "operator_reviewed"
  | "rechner_input"
  | "customer_metered"
  | "customer_input";

const known = <T>(value: T, source: KnownFieldSource = "operator_reviewed") => ({
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

function yieldSnapshot(
  roofId: string,
  tiltDeg: number,
  azimuthDeg: number,
  hashDigit: "1" | "2",
) {
  return {
    roofId,
    provider: "pvgis" as const,
    apiVersion: "5_3" as const,
    radiationDatabase: "PVGIS-SARAH3" as const,
    request: {
      queryContractVersion: "pvgis-query.v1" as const,
      coordinateRounding: "pvgis-coordinate-rounding-3dp.v1" as const,
      latitude: 49.285,
      longitude: 8.738,
      tiltDeg,
      azimuthDeg,
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
      rawResponseSha256: hashDigit.repeat(64),
      annualYieldKwhPerKwp: 1_114.2,
      monthlyYieldKwhPerKwp: [45, 62, 91, 112, 130, 136, 135, 122, 96, 77, 57, 51.2],
    },
    hourly: {
      tool: "seriescalc" as const,
      weatherYear: 2020 as const,
      startYear: 2020 as const,
      endYear: 2020 as const,
      fetchedAt: "2026-08-29T10:00:01.000Z",
      rawResponseSha256: hashDigit.repeat(64),
      sourceLength: 8_784 as const,
      sourceTimeBasis: "utc" as const,
      sourceTimestampsUtc: [...sourceTimestampsUtc],
      normalization: "pvgis_utc_to_europe_berlin_then_drop_feb_29.v1" as const,
      targetTimeZone: "Europe/Berlin" as const,
      normalizedHourConvention: "local_non_leap_jan01_00.v1" as const,
      annualScaling: "scale_hourly_shape_to_pvcalc_annual.v1" as const,
      hourlyPowerWPerKwp: [...hourlyPowerWPerKwp],
      hourlyTemperatureC: [...hourlyTemperatureC],
    },
  };
}

function requestFixture(
  branch: "new_installation" | "existing_installation" = "new_installation",
) {
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
      roofs: [
        {
          id: "dach-sued",
          areaM2: 52,
          azimuthDeg: 5,
          tiltDeg: 35,
          type: "pitched" as const,
          shading: known("light" as const, "rechner_input"),
          source: "user_drawn" as const,
        },
        {
          id: "dach-west",
          areaM2: 24,
          azimuthDeg: 90,
          tiltDeg: 28,
          type: "pitched" as const,
          shading: known("none" as const, "rechner_input"),
          source: "user_drawn" as const,
        },
      ],
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
    yieldSnapshots: [
      yieldSnapshot("dach-sued", 35, 5, "1"),
      yieldSnapshot("dach-west", 28, 90, "2"),
    ],
  };
}

const resultBase = (
  inputSha256: string,
  branch: "new_installation" | "existing_installation",
) => ({
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

const newAnnual = () => ({
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
});

const baselineAnnual = () => ({
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
});

const plannedAnnual = () => ({
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
});

function withResultHash<T extends object>(body: T): T & { resultSha256: string } {
  return { ...body, resultSha256: hashPlanningCalculationResult(body) };
}

function newResultFixture(inputSha256: string) {
  return withResultHash({
    ...resultBase(inputSha256, "new_installation"),
    branch: "new_installation" as const,
    calculation: {
      systemPeakPowerKwp: 15.2,
      plannedStorageCapacityKwh: 8,
      annual: newAnnual(),
      monthly: months(1_000, 500, 100, 5_791.304348 / 12),
    },
  });
}

function existingResultFixture(inputSha256: string) {
  return withResultHash({
    ...resultBase(inputSha256, "existing_installation"),
    branch: "existing_installation" as const,
    calculation: {
      existingSystemPeakPowerKwp: 7.4,
      existingStorageCapacityKwh: 0,
      addedStorageCapacityKwh: 8,
      baseline: {
        annual: baselineAnnual(),
        monthly: months(700, 300, 300, 400),
      },
      planned: {
        annual: plannedAnnual(),
        monthly: months(700, 500, 100, 2_191.304348 / 12),
      },
      delta: {
        additionalSelfConsumptionKwh: 2_400,
        autonomyRatePercentagePoints: 100 / 3,
      },
    },
  });
}

function rehashResult<T extends { resultSha256: string }>(result: T): T {
  result.resultSha256 = hashPlanningCalculationResult(result);
  return result;
}

describe("planning-calculation.v1 contract", () => {
  it("pinnt sourceRevision an den echten Git-Blob des ausgefuehrten Engine-Kerns", () => {
    const enginePath = resolve(root, "lib/integrations/calculation/engine.ts");
    const actualBlob = execFileSync("git", ["hash-object", enginePath], {
      cwd: root,
      encoding: "utf8",
    }).trim();

    expect(actualBlob).toBe(PLANNING_MODEL_SOURCE_REVISION);
  });

  it("haelt Runtime-Schema, generiertes Artefakt und gepinnten SHA bytegleich", () => {
    const schema = readFileSync(schemaPath, "utf8");
    expect(schema).toBe(renderPlanningCalculationJsonSchema());
    expect(sha256(schema)).toBe(PLANNING_CALCULATION_SCHEMA_SHA256);
  });

  it("pinnt gueltige JSON-Golden-Examples fuer beide Branches byte- und fachgleich", () => {
    const manifest = JSON.parse(readFileSync(
      resolve(examplesPath, "planning-calculation.v1.hashes.json"),
      "utf8",
    )) as {
      schemaSha256: string;
      semanticSha256: Record<string, string>;
      fileSha256: Record<string, string>;
    };
    expect(manifest.schemaSha256).toBe(PLANNING_CALCULATION_SCHEMA_SHA256);
    expect(manifest.semanticSha256).toEqual({
      newInput: "17b55f4a01690356663587f3ccb606783dce5c808932498b2dc52a2f197d0bfb",
      existingInput: "30a4762d66a4fc105e0192e1b7b3251b4953e12a49c9e60a5a097eec457b55d9",
      newResult: "01280199a86e98ae5571b618fca4c6cdf5babe5fe09f059ffaadbce43045587a",
      existingResult: "aa0fde967785384a5ab1e815fc8389edc24cda8f21c7443b83a969952aaff960",
    });

    for (const branch of ["new", "existing"] as const) {
      const requestName = `planning-calculation.v1.${branch}.request.json`;
      const resultName = `planning-calculation.v1.${branch}.result.json`;
      const requestText = readFileSync(resolve(examplesPath, requestName), "utf8");
      const resultText = readFileSync(resolve(examplesPath, resultName), "utf8");
      const request = JSON.parse(requestText) as unknown;
      const result = JSON.parse(resultText) as { inputSha256: string; resultSha256: string };

      expect(sha256(requestText)).toBe(manifest.fileSha256[requestName]);
      expect(sha256(resultText)).toBe(manifest.fileSha256[resultName]);
      expect(validatePlanningCalculationRequest(request).ok).toBe(true);
      expect(validatePlanningCalculationResult(result).ok).toBe(true);
      expect(result.inputSha256).toBe(hashPlanningCalculationInput(request));
      expect(result.resultSha256).toBe(hashPlanningCalculationResult(result));
    }
  });

  it("validiert den revisionsgebundenen Request mit branch und bestaetigtem Profil", () => {
    const request = requestFixture();
    expect(validatePlanningCalculationRequest(request).ok).toBe(true);

    for (const key of [
      "energyProfileId",
      "energyProfileRevision",
      "confirmedEnergyProfileRevision",
      "confirmedEnergyProfileAddressRevision",
    ]) {
      const missing = structuredClone(request) as unknown as { bindings: Record<string, unknown> };
      delete missing.bindings[key];
      expect(validatePlanningCalculationRequest(missing).ok).toBe(false);
    }

    const staleConfirmation = structuredClone(request);
    staleConfirmation.bindings.confirmedEnergyProfileAddressRevision = 1;
    expect(validatePlanningCalculationRequest(staleConfirmation).ok).toBe(false);

    const staleProfile = structuredClone(request);
    staleProfile.bindings.confirmedEnergyProfileRevision = 2;
    expect(validatePlanningCalculationRequest(staleProfile).ok).toBe(false);
  });

  it("verwendet branch und die exakte persistierte Projektanforderung ohne revision", () => {
    const request = requestFixture();
    expect(Object.keys(request.projectRequirements).sort()).toEqual([
      "branch",
      "requestedProducts",
      "schemaVersion",
      "source",
    ]);

    const legacyMode = structuredClone(request) as unknown as Record<string, unknown>;
    legacyMode.mode = "new_installation";
    expect(validatePlanningCalculationRequest(legacyMode).ok).toBe(false);

    const legacyRequirement = structuredClone(request) as unknown as {
      projectRequirements: Record<string, unknown>;
    };
    legacyRequirement.projectRequirements.revision = 1;
    expect(validatePlanningCalculationRequest(legacyRequirement).ok).toBe(false);

    const wrongSource = structuredClone(request) as unknown as {
      projectRequirements: Record<string, unknown>;
    };
    wrongSource.projectRequirements.source = "other-calculator";
    expect(validatePlanningCalculationRequest(wrongSource).ok).toBe(false);

    const missingCommissioningDate = structuredClone(request) as unknown as Record<string, unknown>;
    delete missingCommissioningDate.commissioningDate;
    expect(validatePlanningCalculationRequest(missingCommissioningDate).ok).toBe(false);
  });

  it("laesst engine_default und assumptionOverrides nicht ins bestaetigte Profil", () => {
    const engineDefault = structuredClone(requestFixture()) as unknown as {
      energyProfile: { consumption: { loadProfile: Record<string, unknown> } };
    };
    engineDefault.energyProfile.consumption.loadProfile = {
      status: "known",
      value: "wmee_household_hourly.v1",
      source: "engine_default",
    };
    expect(validatePlanningCalculationRequest(engineDefault).ok).toBe(false);

    const embeddedOverrides = structuredClone(requestFixture()) as unknown as {
      energyProfile: Record<string, unknown>;
    };
    embeddedOverrides.energyProfile.assumptionOverrides = {};
    expect(validatePlanningCalculationRequest(embeddedOverrides).ok).toBe(false);
  });

  it("verlangt pro Annahme einen Rechnerinput oder versionierten Default", () => {
    const request = requestFixture();

    const scalar = structuredClone(request) as unknown as {
      resolvedAssumptions: Record<string, unknown>;
    };
    scalar.resolvedAssumptions.systemLossPercent = 14;
    expect(validatePlanningCalculationRequest(scalar).ok).toBe(false);

    for (const key of ["defaultKey", "defaultsVersion"]) {
      const unpinnedDefault = structuredClone(request) as unknown as {
        resolvedAssumptions: { systemLossPercent: Record<string, unknown> };
      };
      delete unpinnedDefault.resolvedAssumptions.systemLossPercent[key];
      expect(validatePlanningCalculationRequest(unpinnedDefault).ok).toBe(false);
    }

    const mislabeledInput = structuredClone(request) as unknown as {
      resolvedAssumptions: { storageRoundtripEfficiency: Record<string, unknown> };
    };
    mislabeledInput.resolvedAssumptions.storageRoundtripEfficiency.defaultsVersion =
      "wmee-planning-defaults.v1";
    expect(validatePlanningCalculationRequest(mislabeledInput).ok).toBe(false);

    const mismatchedDate = structuredClone(request);
    mismatchedDate.resolvedAssumptions.commissioningDate.value = "2028-01-01";
    expect(validatePlanningCalculationRequest(mismatchedDate).ok).toBe(false);
  });

  it("bewahrt 8784 UTC-Quellstunden und normalisiert exakt auf 8760 Berliner Stunden", () => {
    const request = requestFixture();
    expect(request.yieldSnapshots[0].hourly.sourceTimestampsUtc).toHaveLength(8_784);
    expect(request.yieldSnapshots[0].hourly.hourlyPowerWPerKwp).toHaveLength(8_760);
    expect(request.yieldSnapshots[0].hourly.hourlyTemperatureC).toHaveLength(8_760);

    const wrongSourceLength = structuredClone(request) as unknown as {
      yieldSnapshots: Array<{ hourly: Record<string, unknown> }>;
    };
    wrongSourceLength.yieldSnapshots[0].hourly.sourceLength = 8_760;
    expect(validatePlanningCalculationRequest(wrongSourceLength).ok).toBe(false);

    const shortSource = structuredClone(request);
    shortSource.yieldSnapshots[0].hourly.sourceTimestampsUtc.pop();
    expect(validatePlanningCalculationRequest(shortSource).ok).toBe(false);

    const nonUtcSource = structuredClone(request);
    nonUtcSource.yieldSnapshots[0].hourly.sourceTimestampsUtc[0] =
      "2020-01-01T01:00:00+01:00";
    expect(validatePlanningCalculationRequest(nonUtcSource).ok).toBe(false);

    const shiftedButLengthCorrect = structuredClone(request);
    shiftedButLengthCorrect.yieldSnapshots[0].hourly.sourceTimestampsUtc[0] =
      "2020-01-01T01:00:00.000Z";
    expect(validatePlanningCalculationRequest(shiftedButLengthCorrect).ok).toBe(false);

    const mismatchedRoofTemperature = structuredClone(request);
    mismatchedRoofTemperature.yieldSnapshots[1].hourly.hourlyTemperatureC[100] += 1;
    expect(validatePlanningCalculationRequest(mismatchedRoofTemperature).ok).toBe(false);

    for (const key of ["hourlyPowerWPerKwp", "hourlyTemperatureC"] as const) {
      const shortNormalized = structuredClone(request);
      shortNormalized.yieldSnapshots[0].hourly[key].pop();
      expect(validatePlanningCalculationRequest(shortNormalized).ok).toBe(false);
    }

    for (const [key, value] of [
      ["normalization", "drop_feb_29"],
      ["targetTimeZone", "UTC"],
    ] as const) {
      const wrongNormalization = structuredClone(request) as unknown as {
        yieldSnapshots: Array<{ hourly: Record<string, unknown> }>;
      };
      wrongNormalization.yieldSnapshots[0].hourly[key] = value;
      expect(validatePlanningCalculationRequest(wrongNormalization).ok).toBe(false);
    }
  });

  it("bindet gerundete PVGIS-Koordinaten und Dachwinkel an den bestaetigten Standort", () => {
    const wrongRound = structuredClone(requestFixture());
    wrongRound.yieldSnapshots[0].request.latitude = 49.284;
    expect(validatePlanningCalculationRequest(wrongRound).ok).toBe(false);

    const overprecise = structuredClone(requestFixture());
    overprecise.yieldSnapshots[0].request.longitude = 8.7382;
    expect(validatePlanningCalculationRequest(overprecise).ok).toBe(false);

    const wrongTilt = structuredClone(requestFixture());
    wrongTilt.yieldSnapshots[0].request.tiltDeg = 36;
    expect(validatePlanningCalculationRequest(wrongTilt).ok).toBe(false);

    const wrongAzimuth = structuredClone(requestFixture());
    wrongAzimuth.yieldSnapshots[1].request.azimuthDeg = 89;
    expect(validatePlanningCalculationRequest(wrongAzimuth).ok).toBe(false);

    const unconfirmedDefaultRoof = structuredClone(requestFixture()) as unknown as {
      energyProfile: { roofs: Array<{ source: string }> };
    };
    unconfirmedDefaultRoof.energyProfile.roofs[0].source = "default";
    expect(validatePlanningCalculationRequest(unconfirmedDefaultRoof).ok).toBe(false);

    const unsupportedProvider = structuredClone(requestFixture()) as unknown as {
      yieldSnapshots: Array<Record<string, unknown>>;
    };
    unsupportedProvider.yieldSnapshots[0].provider = "unreviewed-provider";
    expect(validatePlanningCalculationRequest(unsupportedProvider).ok).toBe(false);
  });

  it("akzeptiert die offizielle PVGIS-Cent-Rundung ohne Float-Grenzfehler", () => {
    const request = requestFixture();
    request.site.latitude = 52.52;
    request.site.longitude = 13.405;
    request.energyProfile.roofs[0].tiltDeg = 30;
    request.energyProfile.roofs[0].azimuthDeg = 0;
    request.yieldSnapshots.forEach((snapshot) => {
      snapshot.request.latitude = 52.52;
      snapshot.request.longitude = 13.405;
    });
    request.yieldSnapshots[0].request.tiltDeg = 30;
    request.yieldSnapshots[0].request.azimuthDeg = 0;
    request.yieldSnapshots[0].annual.annualYieldKwhPerKwp = 1_040.79;
    request.yieldSnapshots[0].annual.monthlyYieldKwhPerKwp = [
      29.85, 52.42, 87.95, 120.52, 133.18, 134.69,
      130.77, 121.12, 101.18, 67.51, 36.08, 25.53,
    ];

    expect(
      request.yieldSnapshots[0].annual.monthlyYieldKwhPerKwp
        .reduce((sum, value) => sum + value, 0)
      - request.yieldSnapshots[0].annual.annualYieldKwhPerKwp,
    ).toBeGreaterThan(0.01);
    expect(validatePlanningCalculationRequest(request).ok).toBe(true);

    const twoCentDrift = structuredClone(request);
    twoCentDrift.yieldSnapshots[0].annual.annualYieldKwhPerKwp = 1_040.78;
    expect(validatePlanningCalculationRequest(twoCentDrift).ok).toBe(false);
  });

  it("modelliert unbekannt explizit und erzwingt Branch plus Bestands-PV", () => {
    const branchMismatch = requestFixture();
    branchMismatch.projectRequirements.branch = "existing_installation";
    expect(validatePlanningCalculationRequest(branchMismatch).ok).toBe(false);

    const contradiction = requestFixture("existing_installation");
    contradiction.energyProfile.existingAssets.pv = {
      status: "known_absent",
      source: "rechner_branch",
    };
    expect(validatePlanningCalculationRequest(contradiction).ok).toBe(false);

    const newWithExistingPv = requestFixture();
    newWithExistingPv.energyProfile.existingAssets.pv = {
      status: "known_present",
      source: "rechner_input",
      peakPowerKwp: 7.4,
      commissioningYear: 2012,
    };
    expect(validatePlanningCalculationRequest(newWithExistingPv).ok).toBe(false);

    const existingWithUnknownStorage = structuredClone(
      requestFixture("existing_installation"),
    ) as unknown as {
      energyProfile: { existingAssets: { storage: Record<string, unknown> } };
    };
    existingWithUnknownStorage.energyProfile.existingAssets.storage = {
      status: "unknown",
      source: "not_collected",
    };
    expect(validatePlanningCalculationRequest(existingWithUnknownStorage).ok).toBe(false);

    const existingWithoutStorage = requestFixture("existing_installation");
    expect(validatePlanningCalculationRequest(existingWithoutStorage).ok).toBe(true);

    const unknownShading = structuredClone(requestFixture()) as unknown as {
      energyProfile: { roofs: Array<{ shading: Record<string, unknown> }> };
    };
    unknownShading.energyProfile.roofs[0].shading = {
      status: "unknown",
      value: null,
      source: "not_collected",
    };
    expect(validatePlanningCalculationRequest(unknownShading).ok).toBe(false);

    const inconsistentUnknown = structuredClone(requestFixture()) as unknown as {
      energyProfile: { building: { year: Record<string, unknown> } };
    };
    inconsistentUnknown.energyProfile.building.year = {
      status: "unknown",
      value: 1998,
      source: "not_collected",
    };
    expect(validatePlanningCalculationRequest(inconsistentUnknown).ok).toBe(false);

    const hiddenDefault = structuredClone(requestFixture()) as unknown as {
      effectiveConsumption: { hotWaterKwhPerYear: Record<string, unknown> };
    };
    hiddenDefault.effectiveConsumption.hotWaterKwhPerYear = {
      resolution: "profile_value",
      value: 0,
      profileField: "/consumption/hotWaterKwhPerYear",
    };
    expect(validatePlanningCalculationRequest(hiddenDefault).ok).toBe(false);

    const wrongStorageMeaning = requestFixture("existing_installation");
    wrongStorageMeaning.effectiveStorageRequest.meaning = "planned_total_capacity";
    expect(validatePlanningCalculationRequest(wrongStorageMeaning).ok).toBe(false);
  });

  it("kanonisiert Objektkeys, ignoriert fetchedAt und sortiert Daecher fuer den Input-Hash", () => {
    expect(canonicalizeCalculationJson({ z: 1, a: { d: 2, b: 3 } }))
      .toBe('{"a":{"b":3,"d":2},"z":1}');

    const request = requestFixture();
    const inputSha256 = hashPlanningCalculationInput(request);
    expect(inputSha256).toBe(
      "54244cf328a19a9582ed184518834ac5fc5618f3db017a10bb734019386f9aea",
    );

    const reorderedKeys = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
    reorderedKeys.bindings = Object.fromEntries(
      Object.entries(reorderedKeys.bindings as Record<string, unknown>).reverse(),
    );
    expect(hashPlanningCalculationInput(reorderedKeys)).toBe(inputSha256);

    const laterFetch = structuredClone(request);
    laterFetch.yieldSnapshots.forEach((snapshot) => {
      snapshot.annual.fetchedAt = "2026-08-30T10:00:00.000Z";
      snapshot.hourly.fetchedAt = "2026-08-30T10:00:01.000Z";
    });
    expect(hashPlanningCalculationInput(laterFetch)).toBe(inputSha256);

    const reversedRoofs = structuredClone(request);
    reversedRoofs.energyProfile.roofs.reverse();
    expect(hashPlanningCalculationInput(reversedRoofs)).toBe(inputSha256);

    const reversedYields = structuredClone(request);
    reversedYields.yieldSnapshots.reverse();
    expect(hashPlanningCalculationInput(reversedYields)).toBe(inputSha256);

    const changed = structuredClone(request);
    changed.energyProfile.consumption.householdKwhPerYear.value += 1;
    changed.effectiveConsumption.householdKwhPerYear.value += 1;
    expect(hashPlanningCalculationInput(changed)).not.toBe(inputSha256);
  });

  it("pinnt den RFC-8785-Zahlen-/Unicode-Vektor fuer andere Runtimes", () => {
    const vector = {
      numbers: [333_333_333.33333329, 1e30, 4.50, 2e-3, 1e-27],
      string: "€$\u000f\nA'B\"\\\\\"/",
      literals: [null, true, false],
    };
    const canonical = canonicalizeCalculationJson(vector);
    expect(canonical).toBe(
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}",
    );
    expect(sha256(canonical)).toBe(
      "2d5e01a318d0f0879ab568c4be289c8b1f64ef8921a53c6277d5e069978baacb",
    );
    expect(() => canonicalizeCalculationJson("\ud800")).toThrow(TypeError);
  });

  it("validiert den diskriminierten Neubau- und Bestands-Ergebnisvertrag", () => {
    const inputSha256 = hashPlanningCalculationInput(requestFixture());
    const newResult = newResultFixture(inputSha256);
    const existingResult = existingResultFixture(inputSha256);

    expect(newResult.resultSha256).toBe(
      "e8a65b044cc657ab8e2419a7e674343ea35f2582e92df9eca0a72c320e83b603",
    );
    expect(existingResult.resultSha256).toBe(
      "8bb4d686bb260f38df03279e0c6a0f59a43aab3896c8f0de7fac8b8ac3700e52",
    );

    expect(validatePlanningCalculationResult(newResult).ok).toBe(true);
    expect(validatePlanningCalculationResult(existingResult).ok).toBe(true);

    const expectedMonths = Array.from({ length: 12 }, (_, month) => month + 1);
    expect(newResult.calculation.monthly.map(({ month }) => month)).toEqual(expectedMonths);
    expect(existingResult.calculation.baseline.monthly.map(({ month }) => month))
      .toEqual(expectedMonths);
    expect(existingResult.calculation.planned.monthly.map(({ month }) => month))
      .toEqual(expectedMonths);
  });

  it("erzwingt Monate, Energiebilanz und Bestandsdelta unabhaengig vom Result-Hash", () => {
    const inputSha256 = hashPlanningCalculationInput(requestFixture());

    const duplicateMonth = existingResultFixture(inputSha256);
    duplicateMonth.calculation.baseline.monthly[11].month = 11;
    expect(validatePlanningCalculationResult(rehashResult(duplicateMonth)).ok).toBe(false);

    const brokenBalance = newResultFixture(inputSha256);
    brokenBalance.calculation.annual.storageLossKwh += 1;
    expect(validatePlanningCalculationResult(rehashResult(brokenBalance)).ok).toBe(false);

    const brokenRate = newResultFixture(inputSha256);
    brokenRate.calculation.annual.autonomyRate = 0.5;
    expect(validatePlanningCalculationResult(rehashResult(brokenRate)).ok).toBe(false);

    const brokenDelta = existingResultFixture(inputSha256);
    brokenDelta.calculation.delta.additionalSelfConsumptionKwh += 1;
    expect(validatePlanningCalculationResult(rehashResult(brokenDelta)).ok).toBe(false);
  });

  it("bindet Branch, Kapazitaeten und Featurewarnungen an den exakten Request", () => {
    const newRequest = requestFixture();
    const newResult = newResultFixture(hashPlanningCalculationInput(newRequest));
    expect(validatePlanningCalculationResultForRequest(newRequest, newResult).ok).toBe(true);

    const wrongPlannedCapacity = structuredClone(newResult);
    wrongPlannedCapacity.calculation.plannedStorageCapacityKwh += 1;
    expect(validatePlanningCalculationResult(rehashResult(wrongPlannedCapacity)).ok).toBe(true);
    expect(validatePlanningCalculationResultForRequest(
      newRequest,
      wrongPlannedCapacity,
    )).toEqual({
      ok: false,
      paths: ["/calculation/plannedStorageCapacityKwh"],
    });

    const wrongBranch = existingResultFixture(hashPlanningCalculationInput(newRequest));
    expect(validatePlanningCalculationResult(wrongBranch).ok).toBe(true);
    expect(validatePlanningCalculationResultForRequest(newRequest, wrongBranch)).toEqual({
      ok: false,
      paths: ["/branch", "/warnings"],
    });

    const existingRequest = requestFixture("existing_installation");
    const wrongExistingCapacities = existingResultFixture(
      hashPlanningCalculationInput(existingRequest),
    );
    wrongExistingCapacities.calculation.existingSystemPeakPowerKwp += 1;
    wrongExistingCapacities.calculation.existingStorageCapacityKwh += 1;
    wrongExistingCapacities.calculation.addedStorageCapacityKwh += 1;
    rehashResult(wrongExistingCapacities);
    expect(validatePlanningCalculationResult(wrongExistingCapacities).ok).toBe(true);
    expect(validatePlanningCalculationResultForRequest(
      existingRequest,
      wrongExistingCapacities,
    )).toEqual({
      ok: false,
      paths: [
        "/calculation/existingSystemPeakPowerKwp",
        "/calculation/existingStorageCapacityKwh",
        "/calculation/addedStorageCapacityKwh",
      ],
    });

    const requestedFeatures = structuredClone(newRequest);
    requestedFeatures.projectRequirements.requestedProducts.bidirectionalCharging = true;
    requestedFeatures.projectRequirements.requestedProducts.backupPower = true;
    const undisclosed = newResultFixture(hashPlanningCalculationInput(requestedFeatures));
    expect(validatePlanningCalculationResult(undisclosed).ok).toBe(true);
    expect(validatePlanningCalculationResultForRequest(
      requestedFeatures,
      undisclosed,
    )).toEqual({ ok: false, paths: ["/warnings"] });
  });

  it("bindet Peak, Speicherphysik und Energiequellen an Request und Modell-v1", () => {
    const request = requestFixture();
    const inputSha256 = hashPlanningCalculationInput(request);
    const valid = newResultFixture(inputSha256);

    const wrongPeak = structuredClone(valid);
    wrongPeak.calculation.systemPeakPowerKwp -= 1;
    expect(validatePlanningCalculationResult(rehashResult(wrongPeak)).ok).toBe(true);
    expect(validatePlanningCalculationResultForRequest(request, wrongPeak)).toEqual({
      ok: false,
      paths: ["/calculation/systemPeakPowerKwp"],
    });

    const wrongLoss = structuredClone(valid);
    wrongLoss.calculation.annual.storageLossKwh += 1;
    wrongLoss.calculation.annual.feedInKwh -= 1;
    wrongLoss.calculation.monthly[0].feedInKwh -= 1;
    expect(validatePlanningCalculationResult(rehashResult(wrongLoss)).ok).toBe(true);
    expect(validatePlanningCalculationResultForRequest(request, wrongLoss)).toEqual({
      ok: false,
      paths: ["/calculation/annual/storageLossKwh"],
    });

    const wrongCycles = structuredClone(valid);
    wrongCycles.calculation.annual.storageFullCycles += 1;
    expect(validatePlanningCalculationResult(rehashResult(wrongCycles)).ok).toBe(true);
    expect(validatePlanningCalculationResultForRequest(request, wrongCycles)).toEqual({
      ok: false,
      paths: ["/calculation/annual/storageFullCycles"],
    });

    const impossibleVehicleEnergy = structuredClone(valid);
    impossibleVehicleEnergy.calculation.annual.fromVehicleKwh = 0.000_001;
    impossibleVehicleEnergy.calculation.annual.directConsumptionKwh -= 0.000_001;
    expect(validatePlanningCalculationResultForRequest(
      request,
      rehashResult(impossibleVehicleEnergy),
    )).toEqual({
      ok: false,
      paths: ["/calculation/annual/fromVehicleKwh"],
    });

    const zeroStorageRequest = structuredClone(request);
    zeroStorageRequest.projectRequirements.requestedProducts.targetStorageKwh = 0;
    zeroStorageRequest.effectiveStorageRequest.valueKwh = 0;
    const impossibleStationaryFlow = newResultFixture(
      hashPlanningCalculationInput(zeroStorageRequest),
    );
    impossibleStationaryFlow.calculation.plannedStorageCapacityKwh = 0;
    impossibleStationaryFlow.calculation.annual.storageFullCycles = 0;
    expect(validatePlanningCalculationResult(
      rehashResult(impossibleStationaryFlow),
    ).ok).toBe(true);
    expect(validatePlanningCalculationResultForRequest(
      zeroStorageRequest,
      impossibleStationaryFlow,
    )).toEqual({
      ok: false,
      paths: [
        "/calculation/annual/fromStorageKwh",
        "/calculation/annual/storageLossKwh",
      ],
    });

    const wrongModel: PlanningCalculationResultV1 = structuredClone(valid);
    wrongModel.model.version = "1.0.1";
    wrongModel.model.sourceRevision = "b".repeat(40);
    expect(validatePlanningCalculationResult(rehashResult(wrongModel)).ok).toBe(true);
    expect(validatePlanningCalculationResultForRequest(request, wrongModel)).toEqual({
      ok: false,
      paths: ["/model/version", "/model/sourceRevision"],
    });
  });

  it("bindet alle Qualitaets- und Featurewarnungen exakt an den Request", () => {
    const request = requestFixture();
    const valid = newResultFixture(hashPlanningCalculationInput(request));

    for (const code of ["provider_estimate", "unknown_profile_field"] as const) {
      const missing = structuredClone(valid);
      missing.warnings = missing.warnings.filter((warning) => warning.code !== code);
      expect(validatePlanningCalculationResult(rehashResult(missing)).ok).toBe(true);
      expect(validatePlanningCalculationResultForRequest(request, missing)).toEqual({
        ok: false,
        paths: ["/warnings"],
      });
    }

    const unrequested: PlanningCalculationResultV1 = structuredClone(valid);
    unrequested.warnings.push({
      code: "bidirectional_charging_not_modeled",
      severity: "warning",
    });
    expect(validatePlanningCalculationResult(rehashResult(unrequested)).ok).toBe(true);
    expect(validatePlanningCalculationResultForRequest(request, unrequested)).toEqual({
      ok: false,
      paths: ["/warnings"],
    });

    const existingRequest = requestFixture("existing_installation");
    const existing = existingResultFixture(hashPlanningCalculationInput(existingRequest));
    existing.warnings = existing.warnings.filter(
      (warning) => warning.code !== "existing_installation_limited",
    );
    expect(validatePlanningCalculationResult(rehashResult(existing)).ok).toBe(true);
    expect(validatePlanningCalculationResultForRequest(existingRequest, existing)).toEqual({
      ok: false,
      paths: ["/warnings"],
    });
  });

  it("erlaubt Speicheruebertrag zwischen Monaten, aber keine lokale Uebereinspeisung", () => {
    const inputSha256 = hashPlanningCalculationInput(requestFixture());
    const crossMonth = newResultFixture(inputSha256);
    crossMonth.calculation.monthly[0].selfConsumptionKwh -= 100;
    crossMonth.calculation.monthly[1].selfConsumptionKwh += 100;
    expect(validatePlanningCalculationResult(rehashResult(crossMonth)).ok).toBe(true);

    const excessFeedIn = newResultFixture(inputSha256);
    const shiftedFeedIn = 550.02;
    excessFeedIn.calculation.monthly[0].feedInKwh += shiftedFeedIn;
    for (let index = 1; index < 12; index += 1) {
      excessFeedIn.calculation.monthly[index].feedInKwh -= shiftedFeedIn / 11;
    }
    expect(validatePlanningCalculationResult(rehashResult(excessFeedIn)).ok).toBe(false);
  });

  it("hasht das fachliche Ergebnis ohne resultSha256 und lehnt Wirtschaftlichkeit ab", () => {
    const result = newResultFixture(hashPlanningCalculationInput(requestFixture()));
    expect(result.resultSha256).toBe(hashPlanningCalculationResult(result));

    const staleHash = structuredClone(result);
    staleHash.calculation.annual.generationKwh += 1;
    expect(validatePlanningCalculationResult(staleHash).ok).toBe(false);

    const economics = structuredClone(result) as unknown as {
      calculation: { annual: Record<string, unknown> };
      resultSha256: string;
    };
    economics.calculation.annual.remunerationCents = 1_234;
    expect(validatePlanningCalculationResult(rehashResult(economics)).ok).toBe(false);
  });
});
