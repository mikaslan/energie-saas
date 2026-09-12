import { describe, expect, it } from "vitest";

import {
  deriveCertifiedCapacities,
  type CertifiedCapacityLine,
} from "@/lib/integrations/offers/certified-capacities";

function line(overrides: Partial<CertifiedCapacityLine>): CertifiedCapacityLine {
  return {
    positionType: "required",
    isHidden: false,
    quantityMilli: 1000,
    componentCategory: "module",
    productKind: "catalog",
    technicalData: { schemaVersion: "module.v1", nominalPowerWatts: 400 },
    ...overrides,
  };
}

describe("F7-09 zertifizierte Anlagenkennzahlen", () => {
  it("F709-UNIT-01: summiert Module, Speicher, Wechselrichter und Wallbox", () => {
    const result = deriveCertifiedCapacities([
      line({ quantityMilli: 26_000 }),
      line({
        componentCategory: "battery",
        technicalData: { schemaVersion: "battery.v1", usableCapacityWh: 8000 },
      }),
      line({
        componentCategory: "inverter",
        technicalData: { schemaVersion: "inverter.v1", nominalAcPowerWatts: 10_000 },
      }),
      line({
        componentCategory: "wallbox",
        technicalData: { schemaVersion: "wallbox.v1", maxChargingPowerWatts: 11_000 },
      }),
    ]);
    expect(result.moduleCount).toBe(26);
    expect(result.pvPeakPowerWatts).toBe(10_400);
    expect(result.batteryCount).toBe(1);
    expect(result.storageUsableCapacityWh).toBe(8000);
    expect(result.inverterCount).toBe(1);
    expect(result.inverterAcPowerWatts).toBe(10_000);
    expect(result.wallboxCount).toBe(1);
    expect(result.wallboxChargePowerWatts).toBe(11_000);
    expect(result.hasUncertifiedModuleLines).toBe(false);
    expect(result.hasUncertifiedBatteryLines).toBe(false);
    expect(result.hasUncertifiedInverterLines).toBe(false);
    expect(result.hasUncertifiedWallboxLines).toBe(false);
  });

  it("F709-UNIT-02: versteckte, optionale und Custom-Positionen zaehlen nicht", () => {
    const result = deriveCertifiedCapacities([
      line({ quantityMilli: 10_000 }),
      line({ quantityMilli: 4_000, isHidden: true }),
      line({ quantityMilli: 2_000, positionType: "optional" }),
      line({ quantityMilli: 3_000, productKind: "custom", technicalData: null }),
      line({
        componentCategory: "battery",
        productKind: "custom",
        technicalData: null,
        quantityMilli: 1000,
      }),
    ]);
    expect(result.moduleCount).toBe(10);
    expect(result.pvPeakPowerWatts).toBe(4000);
    expect(result.batteryCount).toBe(0);
    expect(result.storageUsableCapacityWh).toBe(0);
    expect(result.hasUncertifiedModuleLines).toBe(true);
    expect(result.hasUncertifiedBatteryLines).toBe(true);
  });

  it("F709-UNIT-03: unpassende Technische Daten markieren statt zu raten", () => {
    const result = deriveCertifiedCapacities([
      line({
        technicalData: { schemaVersion: "inverter.v1", nominalAcPowerWatts: 8000 },
      }),
      line({ componentCategory: "mounting", technicalData: null }),
    ]);
    expect(result.moduleCount).toBe(0);
    expect(result.pvPeakPowerWatts).toBe(0);
    expect(result.hasUncertifiedModuleLines).toBe(true);
  });

  it("F709-UNIT-04: krumme Stueckmengen scheitern fail-closed", () => {
    expect(() => deriveCertifiedCapacities([line({ quantityMilli: 1500 })]))
      .toThrow(TypeError);
  });
});
