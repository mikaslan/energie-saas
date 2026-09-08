import { describe, expect, it } from "vitest";

import {
  selectBatteryRevisionV2,
  type BatteryLineV2Input,
} from "@/lib/integrations/calculation/battery-selection-v2";
import { F401ResolutionError } from "@/lib/integrations/calculation/catalog-resolution-v2";

// F4.1 v2-Batterieauswahl: 0/1/N-Lines, Speicherbedarf, Integritaet.

const TECH = {
  schemaVersion: "battery.v1",
  nominalCapacityWh: 10_000,
  usableCapacityWh: 9_000,
  maxContinuousPowerWatts: 5_000,
  roundTripEfficiencyBasisPoints: 9_000,
  backupCapability: "unknown",
};

function line(overrides: Record<string, unknown> = {}): BatteryLineV2Input {
  return {
    componentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    componentRevision: 3,
    componentType: "battery",
    lineSnapshotSha256Hex: "ab".repeat(32),
    revisionSnapshot: { technicalData: { ...TECH } },
    revisionSnapshotSha256Hex: "ab".repeat(32),
    ...overrides,
  };
}

function other(): BatteryLineV2Input {
  return {
    ...line(),
    componentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    componentType: "module",
  };
}

describe("F4.1 v2 battery selection", () => {
  it("loest genau eine Batterie mit symmetrischen Params auf", () => {
    const selected = selectBatteryRevisionV2([other(), line()], 10);
    expect(selected.source).toEqual({
      componentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      revision: 3,
    });
    expect(selected.storage).toMatchObject({
      capacityKwh: 10,
      socMinKwh: 0,
      socMaxKwh: 9,
      chargeKw: 5,
      dischargeKw: 5,
    });
    expect(selected.storage.etaCharge).toBeCloseTo(Math.sqrt(0.9), 12);
    expect(selected.storage.etaDischarge).toBe(selected.storage.etaCharge);
  });

  it("nimmt No-Storage ohne Bedarf und verweigert ohne Aufloesung mit Bedarf", () => {
    const empty = selectBatteryRevisionV2([other()], null);
    expect(empty.source).toBeNull();
    expect(empty.storage).toMatchObject({ capacityKwh: 0, socMaxKwh: 0, etaCharge: 1 });
    expect(() => selectBatteryRevisionV2([other()], 5)).toThrow(F401ResolutionError);
    expect(() => selectBatteryRevisionV2([], 0)).not.toThrow();
  });

  it("verweigert Mehrdeutigkeit, SHA-Bruch und ungueltige Profile", () => {
    expect(() => selectBatteryRevisionV2([line(), line()], null)).toThrow(F401ResolutionError);
    expect(() => selectBatteryRevisionV2(
      [line({ revisionSnapshotSha256Hex: "cd".repeat(32) })],
      null,
    )).toThrow(F401ResolutionError);
    expect(() => selectBatteryRevisionV2(
      [line({ revisionSnapshot: { technicalData: { ...TECH, usableCapacityWh: 11_000 } } })],
      null,
    )).toThrow(F401ResolutionError);
    expect(() => selectBatteryRevisionV2(
      [line({ revisionSnapshot: { technicalData: { schemaVersion: "module.v1", nominalPowerWatts: 400 } } })],
      null,
    )).toThrow(F401ResolutionError);
  });
});
