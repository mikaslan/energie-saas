import { describe, expect, it } from "vitest";

import {
  buildProjectCalculationPreparationV2,
  hashProjectCalculationPreparationV2,
  projectCalculationPreparationV2Schema,
} from "@/lib/integrations/calculation/preparation-v2";

// F4.1 v2-Preparation RED: Schema strikt, Hash deterministisch, ohne
// Implementierung rot.

function preparation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "project-calculation-preparation.v2",
    latitude: 52.52,
    longitude: 13.41,
    axis: { slots: 35040, resolution: "quarter_hour" },
    providerRecipe: "pvgis-5.3-sarah3-2020-quarter-hour.v2",
    geometry: {
      surfaces: [
        { tiltDeg: 30, azimuthDeg: 180 },
        { tiltDeg: 0, azimuthDeg: 0 },
      ],
    },
    profile: {
      schemaVersion: "site-energy-profile.v1",
      inputMode: "consumption",
      building: {
        type: { status: "unknown", value: null, source: "not_collected" },
        year: { status: "unknown", value: null, source: "not_collected" },
        heatedAreaM2: { status: "unknown", value: null, source: "not_collected" },
      },
      roofs: [{
        id: "dach-1",
        areaM2: 40,
        azimuthDeg: 180,
        tiltDeg: 30,
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
    ...overrides,
  };
}

describe("F4.1 v2 preparation", () => {
  it("akzeptiert eine gueltige v2-Preparation und hasht deterministisch", () => {
    const first = buildProjectCalculationPreparationV2(preparation());
    const second = buildProjectCalculationPreparationV2(
      JSON.parse(JSON.stringify(preparation())),
    );
    expect(first.schemaVersion).toBe("project-calculation-preparation.v2");
    expect(hashProjectCalculationPreparationV2(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashProjectCalculationPreparationV2(second)).toBe(
      hashProjectCalculationPreparationV2(first),
    );
  });

  it("weist v1-Literal, falsche Achse und ungueltige Geometrie ab", () => {
    expect(() =>
      projectCalculationPreparationV2Schema.parse(
        preparation({ schemaVersion: "project-calculation-preparation.v1" }),
      )).toThrow();
    expect(() =>
      projectCalculationPreparationV2Schema.parse(
        preparation({ axis: { slots: 8760, resolution: "hourly" } }),
      )).toThrow();
    expect(() =>
      projectCalculationPreparationV2Schema.parse(
        preparation({ geometry: { surfaces: [{ tiltDeg: 120, azimuthDeg: 0 }] } }),
      )).toThrow();
    expect(() =>
      projectCalculationPreparationV2Schema.parse(
        preparation({ geometry: { surfaces: [] } }),
      )).toThrow();
    expect(() =>
      projectCalculationPreparationV2Schema.parse(
        preparation({ unknown: 1 }),
      )).toThrow();
  });

  it("der Hash aendert sich bei jeder Eingabeaenderung", () => {
    const base = hashProjectCalculationPreparationV2(
      buildProjectCalculationPreparationV2(preparation()),
    );
    const changed = hashProjectCalculationPreparationV2(
      buildProjectCalculationPreparationV2(preparation({ latitude: 48.14 })),
    );
    expect(changed).not.toBe(base);
  });
});
