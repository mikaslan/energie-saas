import { describe, expect, it } from "vitest";

import {
  CATALOG_RESOLUTION_V2_VERSION,
  F401ResolutionError,
  resolveStorageParamsV2,
} from "@/lib/integrations/calculation/catalog-resolution-v2";

// F4.1 v2-Katalogaufloesung: Battery-Revision -> Speicherparameter mit
// stated Mapping-Regeln; null = No-Storage, ungueltig = cannot_fulfil.

const BATTERY = {
  nominalCapacityWh: 10_500,
  usableCapacityWh: 9_500,
  maxContinuousPowerWatts: 5_000,
  roundTripEfficiencyBasisPoints: 9_025,
};

describe("F4.1 v2 catalog resolution", () => {
  it("traegt die gepinnte Version und bildet disclosed ab", () => {
    expect(CATALOG_RESOLUTION_V2_VERSION).toBe("catalog-resolution.v2");
    const storage = resolveStorageParamsV2(BATTERY);
    expect(storage.capacityKwh).toBeCloseTo(10.5, 12);
    expect(storage.socMinKwh).toBe(0);
    expect(storage.socMaxKwh).toBeCloseTo(9.5, 12);
    expect(storage.chargeKw).toBeCloseTo(5, 12);
    expect(storage.dischargeKw).toBeCloseTo(5, 12);
    // Symmetrischer Sqrt-Split: 0.95^2 = 0.9025.
    expect(storage.etaCharge).toBeCloseTo(0.95, 12);
    expect(storage.etaDischarge).toBeCloseTo(0.95, 12);
  });

  it("liefert null als exakten No-Storage-Zweig", () => {
    expect(resolveStorageParamsV2(null)).toEqual({
      capacityKwh: 0,
      socMinKwh: 0,
      socMaxKwh: 0,
      chargeKw: 0,
      dischargeKw: 0,
      etaCharge: 1,
      etaDischarge: 1,
    });
  });

  it("verweigert aufgeloste-unbrauchbare Batterien fail-closed", () => {
    expect(() => resolveStorageParamsV2({ ...BATTERY, usableCapacityWh: 0 })).toThrow(
      F401ResolutionError,
    );
    expect(() => resolveStorageParamsV2({
      ...BATTERY,
      usableCapacityWh: 11_000,
    })).toThrow(F401ResolutionError);
    expect(() => resolveStorageParamsV2({
      ...BATTERY,
      roundTripEfficiencyBasisPoints: 10_001,
    })).toThrow(F401ResolutionError);
    expect(() => resolveStorageParamsV2({
      ...BATTERY,
      maxContinuousPowerWatts: Number.NaN,
    })).toThrow(F401ResolutionError);
  });
});
