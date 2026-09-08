import { describe, expect, it } from "vitest";

import {
  PlanningCalculationInputError,
  buildPreparedPlanningCalculationInputV2,
} from "@/lib/integrations/calculation/prepare-v2";

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
