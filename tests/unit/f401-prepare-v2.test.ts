import { describe, expect, it } from "vitest";

import { QUARTER_HOUR_SLOTS } from "@/lib/integrations/calculation/engine-v2";
import {
  PlanningCalculationInputError,
  buildPlanningCalculationInputV2,
  buildPreparedPlanningCalculationInputV2,
} from "@/lib/integrations/calculation/prepare-v2";
import {
  CALCULATION_V2_MODEL_ID,
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
} from "@/lib/integrations/calculation/versions-v2";

// F4.1 v2-Prepare RED: Claim -> Request mit gepinnter Achse, Speicher-
// Durchreiche und stabilem Input-Hash. Ohne Implementierung rot.

function claim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workspaceId: "11111111-1111-4111-8111-111111111111",
    projectId: "22222222-2222-4222-8222-222222222222",
    siteId: "33333333-3333-4333-8333-333333333333",
    startedAt: "2026-08-29T12:00:00.000Z",
    addressRevision: 1,
    pinConfirmedAddressRevision: 1,
    energyProfileId: "44444444-4444-4444-8444-444444444444",
    energyProfileRevision: 1,
    confirmedEnergyProfileRevision: 1,
    confirmedEnergyProfileAddressRevision: 1,
    projectRequirementId: "55555555-5555-4555-8555-555555555555",
    projectRequirementRevision: 1,
    sourceCalculatorSnapshotId: "66666666-6666-4666-8666-666666666666",
    contractVersion: "planning-calculation.v2",
    defaultsVersion: "wmee-planning-defaults.v2",
    providerRequest: { latitude: 52.52, longitude: 13.41 },
    storage: {
      capacityKwh: 10,
      socMinKwh: 1,
      socMaxKwh: 9,
      chargeKw: 5,
      dischargeKw: 5,
      etaCharge: 0.95,
      etaDischarge: 0.95,
    },
    preparation: {
      profile: {
        schemaVersion: "site-energy-profile.v1",
        inputMode: "consumption",
        building: {
          type: { status: "unknown", value: null, source: "not_collected" },
          year: { status: "unknown", value: null, source: "not_collected" },
          heatedAreaM2: { status: "unknown", value: null, source: "not_collected" },
        },
        roofs: [{
          id: "dach-1", areaM2: 40, azimuthDeg: 180, tiltDeg: 30,
          type: "pitched",
          shading: { status: "unknown", value: null, source: "not_collected" },
          source: "default",
        }],
        consumption: {
          householdKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
          electricityPriceCentsPerKwh: { status: "unknown", value: null, source: "not_collected" },
          annualPriceIncreasePercent: { status: "unknown", value: null, source: "not_collected" },
          loadProfile: { status: "unknown", value: null, source: "not_collected" },
          evKmPerYear: { status: "unknown", value: null, source: "not_collected" },
          evChargingPattern: { status: "unknown", value: null, source: "not_collected" },
          heatPumpKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
          coolingKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
          heatingAcKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
          hotWaterKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
        },
        existingAssets: {
          pv: { status: "known_absent", source: "operator_reviewed" },
          storage: { status: "known_absent", source: "operator_reviewed" },
          wallbox: { status: "known_absent", source: "operator_reviewed" },
          ev: { status: "known_absent", source: "operator_reviewed" },
        },
        provenance: {
          source: "rechner_snapshot",
          sourceSchemaVersion: "wmee-solar-snapshot.v1",
          sourceEngine: "wmee-solar.v1",
          roof: "default",
          consumption: "default",
          electricityPrice: "default",
          annualPriceIncrease: "default",
        },
      },
      requirements: {
        schemaVersion: "project-requirements.rechner.v1",
        source: "wmee-rechner-v3",
        branch: "new_installation",
        requestedProducts: {
          targetStorageKwh: 8,
          wallbox: false,
          bidirectionalCharging: false,
          backupPower: false,
        },
      },
      sourceSnapshot: {
        schemaVersion: "wmee-solar-snapshot.v1",
        branch: "new_installation",
        inputs: {},
      },
    },
    ...overrides,
  };
}

describe("F4.1 v2 prepare", () => {
  it("baut Request mit gepinnter Achse, Speicher und stabilem Hash", () => {
    const first = buildPreparedPlanningCalculationInputV2(claim());
    expect(first.inputSnapshot.contractVersion).toBe("planning-calculation.v2");
    expect(first.inputSnapshot.axis).toEqual({ slots: 35040, resolution: "quarter_hour" });
    expect(first.inputSnapshot.storage.capacityKwh).toBe(10);
    expect(first.inputSnapshot.site.latitude).toBe(52.52);
    expect(first.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    const second = buildPreparedPlanningCalculationInputV2(
      JSON.parse(JSON.stringify(claim())),
    );
    expect(second.inputSha256).toBe(first.inputSha256);
  });

  it("weist v1-Vertrag, falsche Defaults und ungueltigen Speicher als InputError ab", () => {
    expect(() => buildPreparedPlanningCalculationInputV2(
      claim({ contractVersion: "planning-calculation.v1" }),
    )).toThrow(PlanningCalculationInputError);
    expect(() => buildPreparedPlanningCalculationInputV2(
      claim({ defaultsVersion: "wmee-planning-defaults.v1" }),
    )).toThrow(PlanningCalculationInputError);
    expect(() => buildPreparedPlanningCalculationInputV2(
      claim({ storage: {
        capacityKwh: 10, socMinKwh: 9, socMaxKwh: 8, chargeKw: 5,
        dischargeKw: 5, etaCharge: 0.95, etaDischarge: 0.95,
      } }),
    )).toThrow(PlanningCalculationInputError);
  });
});

function workerClaim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = claim() as unknown as Record<string, Record<string, unknown>>;
  const preparation = base["preparation"] as unknown as Record<string, unknown>;
  const profile = preparation["profile"] as unknown as {
    roofs: Array<{ tiltDeg: number; azimuthDeg: number }>;
  };
  return {
    workspaceId: base["workspaceId"],
    projectId: base["projectId"],
    siteId: base["siteId"],
    startedAt: base["startedAt"],
    addressRevision: base["addressRevision"],
    pinConfirmedAddressRevision: base["pinConfirmedAddressRevision"],
    energyProfileId: base["energyProfileId"],
    energyProfileRevision: base["energyProfileRevision"],
    confirmedEnergyProfileRevision: base["confirmedEnergyProfileRevision"],
    confirmedEnergyProfileAddressRevision: base["confirmedEnergyProfileAddressRevision"],
    projectRequirementId: base["projectRequirementId"],
    projectRequirementRevision: base["projectRequirementRevision"],
    sourceCalculatorSnapshotId: base["sourceCalculatorSnapshotId"],
    contractVersion: base["contractVersion"],
    providerRecipeVersion: CALCULATION_V2_PROVIDER_RECIPE_VERSION,
    modelId: CALCULATION_V2_MODEL_ID,
    modelVersion: CALCULATION_V2_MODEL_VERSION,
    sourceRevision: CALCULATION_V2_SOURCE_REVISION,
    defaultsVersion: base["defaultsVersion"],
    leaseToken: "33333333-3333-4333-8333-333333333333",
    leaseExpiresAt: new Date("2026-08-29T13:00:00.000Z"),
    attemptCount: 1,
    providerRequest: null,
    input: null,
    preparation: null,
    providerRequestV2: { latitude: 52.52, longitude: 13.41 },
    preparationV2: {
      schemaVersion: "project-calculation-preparation.v2",
      latitude: 52.52,
      longitude: 13.41,
      providerRecipe: CALCULATION_V2_PROVIDER_RECIPE_VERSION,
      geometry: {
        surfaces: profile.roofs.map((roof) => ({
          tiltDeg: roof.tiltDeg,
          azimuthDeg: roof.azimuthDeg,
        })),
      },
      profile: preparation["profile"],
      requirements: preparation["requirements"],
      sourceSnapshot: preparation["sourceSnapshot"],
      storage: base["storage"],
    },
    ...overrides,
  };
}

function workerSeries(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pvKwh: new Array<number>(QUARTER_HOUR_SLOTS).fill(1),
    loadKwh: new Array<number>(QUARTER_HOUR_SLOTS).fill(0.5),
    providerEstimate: false,
    ...overrides,
  };
}

describe("F4.1 v2 execute input builder", () => {
  it("baut Persist-Argumente aus Worker-Claim und Serien", () => {
    const prepared = buildPlanningCalculationInputV2({
      claim: workerClaim(),
      providerSeries: workerSeries(),
    });
    expect(prepared.inputSnapshot.contractVersion).toBe("planning-calculation.v2");
    expect(prepared.inputSnapshot.bindings?.projectId).toBe(
      "22222222-2222-4222-8222-222222222222",
    );
    expect(prepared.inputSnapshot.storage.capacityKwh).toBe(10);
    expect(prepared.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.pvKwh).toHaveLength(QUARTER_HOUR_SLOTS);
    expect(prepared.loadKwh).toHaveLength(QUARTER_HOUR_SLOTS);
    expect(prepared.providerEstimate).toBe(false);
  });

  it("weist fehlende Provenienz, fehlenden Quell-Snapshot und kaputte Serien ab", () => {
    const failingClaims = [
      workerClaim({ preparationV2: null, providerRequestV2: null }),
      workerClaim({ sourceCalculatorSnapshotId: null }),
      workerClaim({ providerRequestV2: { latitude: 52.52, longitude: 999 } }),
    ];
    for (const failingClaim of failingClaims) {
      expect(() => buildPlanningCalculationInputV2({
        claim: failingClaim,
        providerSeries: workerSeries(),
      })).toThrow(PlanningCalculationInputError);
    }
    const failingSeries = [
      workerSeries({ pvKwh: new Array<number>(8760).fill(1) }),
      workerSeries({ loadKwh: new Array<number>(QUARTER_HOUR_SLOTS).fill(-0.5) }),
      workerSeries({ providerEstimate: "false" }),
    ];
    for (const series of failingSeries) {
      expect(() => buildPlanningCalculationInputV2({
        claim: workerClaim(),
        providerSeries: series,
      })).toThrow(PlanningCalculationInputError);
    }
  });
});
