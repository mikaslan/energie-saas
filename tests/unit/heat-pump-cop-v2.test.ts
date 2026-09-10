import { describe, expect, it } from "vitest";

import { neumaierSum } from "@/lib/integrations/calculation/engine-v2";
import {
  buildHeatPumpCopSourceV2,
  HEAT_PUMP_BIVALENCE_TEMP_C_DEFAULT,
  HEAT_PUMP_COP_NOMINAL_DEFAULT,
  HEAT_PUMP_COP_V2_SOURCE_ID,
  HEAT_PUMP_COP_V2_VERSION,
  HEAT_PUMP_HOT_WATER_COP_FACTOR,
  HEAT_PUMP_HOT_WATER_SHARE_DEFAULT,
  referenceCopAt,
} from "@/lib/integrations/calculation/heat-pump-cop-v2";

// WP-COP-Quelle (Spec F4-03): Kennlinien-Interpolation, Bivalenz-Schalter,
// WW-Split, Relation Strom < Wärme, Fail-closed-Pfade.

function syntheticYear(coldHours: number, coldTempC: number, warmTempC: number): {
  times: string[];
  temperatures: Map<string, number>;
} {
  const times = Array.from({ length: 8_760 }, (_, index) => `hour-${index}`);
  const temperatures = new Map<string, number>(
    times.map((time, index) => [time, index < coldHours ? coldTempC : warmTempC]),
  );
  return { times, temperatures };
}

const sum = (values: readonly number[]): number => neumaierSum([...values]);

describe("heat pump COP source", () => {
  it("pinnt Version, Quelle und ESTIMATE-Defaults", () => {
    expect(HEAT_PUMP_COP_V2_VERSION).toBe("wmee-heat-pump-cop.v1");
    expect(HEAT_PUMP_COP_V2_SOURCE_ID).toBe("wmee-heat-pump-cop.v1");
    expect(HEAT_PUMP_COP_NOMINAL_DEFAULT).toBe(4.0);
    expect(HEAT_PUMP_BIVALENCE_TEMP_C_DEFAULT).toBe(-6);
    expect(HEAT_PUMP_HOT_WATER_SHARE_DEFAULT).toBe(0);
    expect(HEAT_PUMP_HOT_WATER_COP_FACTOR).toBe(0.8);
  });

  it("trifft die Kennlinien-Stuetzstellen exakt und klemmt aussen", () => {
    expect(referenceCopAt(-7)).toBeCloseTo(2.2, 12);
    expect(referenceCopAt(2)).toBeCloseTo(3.1, 12);
    expect(referenceCopAt(7)).toBeCloseTo(4.0, 12);
    expect(referenceCopAt(20)).toBeCloseTo(5.2, 12);
    expect(referenceCopAt(-30)).toBeCloseTo(2.2, 12);
    expect(referenceCopAt(40)).toBeCloseTo(5.2, 12);
    // Mittelpunkt zwischen 2 und 7 °C: linear interpoliert.
    expect(referenceCopAt(4.5)).toBeCloseTo((3.1 + 4.0) / 2, 12);
  });

  it("liefert Strom unter Waerme und skaliert mit COP-Nennwert", () => {
    const { times, temperatures } = syntheticYear(4_000, -2, 12);
    const base = { hourlyTemperatureC: temperatures, hourTimesInOrder: times };
    const low = buildHeatPumpCopSourceV2({ thermalKwh: 10_000, copNominal: 2, ...base });
    const high = buildHeatPumpCopSourceV2({ thermalKwh: 10_000, copNominal: 6, ...base });
    const lowSum = sum(low.slotEnergyKwh);
    const highSum = sum(high.slotEnergyKwh);
    expect(lowSum).toBeLessThan(10_000);
    expect(highSum).toBeLessThan(lowSum);
    // 35.040 Slots, alle endlich und nicht-negativ.
    expect(low.slotEnergyKwh).toHaveLength(35_040);
    expect(high.slotEnergyKwh.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
  });

  it("schaltet unter Bivalenz auf Heizstab (COP = 1)", () => {
    // Alle Stunden bei -10 °C, Bivalenz -6 °C: Strom == Waerme.
    const { times, temperatures } = syntheticYear(8_760, -10, -10);
    const source = buildHeatPumpCopSourceV2({
      thermalKwh: 8_760,
      hourlyTemperatureC: temperatures,
      hourTimesInOrder: times,
    });
    expect(sum(source.slotEnergyKwh)).toBeCloseTo(8_760, 6);
    // Bivalenz unter -10 °C: COP-Pfad greift, Strom < Waerme.
    const cop = buildHeatPumpCopSourceV2({
      thermalKwh: 8_760,
      bivalenceTempC: -15,
      hourlyTemperatureC: temperatures,
      hourTimesInOrder: times,
    });
    expect(sum(cop.slotEnergyKwh)).toBeLessThan(8_760);
  });

  it("verteilt WW-Anteil konstant mit 0,8-Faktor", () => {
    // Alle Stunden 10 °C (kein Heizstab): reiner WW-Anteil 1.
    const { times, temperatures } = syntheticYear(8_760, 10, 10);
    const base = { hourlyTemperatureC: temperatures, hourTimesInOrder: times };
    const full = buildHeatPumpCopSourceV2({ thermalKwh: 8_760, hotWaterShare: 1, ...base });
    const expected = 8_760 / (HEAT_PUMP_HOT_WATER_COP_FACTOR * referenceCopAt(10));
    expect(sum(full.slotEnergyKwh)).toBeCloseTo(expected, 4);
    // Konstanz: alle Stunden-Summen (je 4 Viertel) identisch.
    const hourly = Array.from({ length: 8_760 }, (_, hour) =>
      full.slotEnergyKwh[hour * 4]! * 4);
    expect(Math.max(...hourly) - Math.min(...hourly)).toBeLessThan(1e-9);
    // Halber WW-Anteil: Heizanteil (Grad 15-10=5, COP-Pfad) + halber WW.
    const half = buildHeatPumpCopSourceV2({ thermalKwh: 8_760, hotWaterShare: 0.5, ...base });
    expect(sum(half.slotEnergyKwh)).toBeGreaterThan(sum(full.slotEnergyKwh) / 2);
    expect(sum(half.slotEnergyKwh)).toBeLessThan(8_760);
  });

  it("liefert Nullreihe bei 0 kWh und bricht fail-closed ab", () => {
    const { times, temperatures } = syntheticYear(4_000, -2, 12);
    const base = { hourlyTemperatureC: temperatures, hourTimesInOrder: times };
    const zero = buildHeatPumpCopSourceV2({ thermalKwh: 0, ...base });
    expect(sum(zero.slotEnergyKwh)).toBe(0);
    expect(() => buildHeatPumpCopSourceV2({ thermalKwh: -1, ...base })).toThrow();
    expect(() => buildHeatPumpCopSourceV2({ thermalKwh: 100, copNominal: 0.5, ...base })).toThrow();
    expect(() => buildHeatPumpCopSourceV2({ thermalKwh: 100, copNominal: 9, ...base })).toThrow();
    expect(() => buildHeatPumpCopSourceV2({ thermalKwh: 100, bivalenceTempC: -30, ...base })).toThrow();
    expect(() => buildHeatPumpCopSourceV2({ thermalKwh: 100, hotWaterShare: 1.5, ...base })).toThrow();
    expect(() => buildHeatPumpCopSourceV2({
      thermalKwh: 100,
      hourlyTemperatureC: temperatures,
      hourTimesInOrder: times.slice(0, 8_000),
    })).toThrow();
    // Heizwaerme ohne Heizgradtage (alle 20 °C) bricht ab.
    const warm = syntheticYear(0, 20, 20);
    expect(() => buildHeatPumpCopSourceV2({
      thermalKwh: 100,
      hourlyTemperatureC: warm.temperatures,
      hourTimesInOrder: warm.times,
    })).toThrow();
  });

  it("unterscheidet Provenienz je Parameter (kein stiller Default-Wechsel)", () => {
    const { times, temperatures } = syntheticYear(4_000, -2, 12);
    const base = { hourlyTemperatureC: temperatures, hourTimesInOrder: times };
    const a = buildHeatPumpCopSourceV2({ thermalKwh: 5_000, ...base });
    const b = buildHeatPumpCopSourceV2({ thermalKwh: 5_000, copNominal: 5, ...base });
    const c = buildHeatPumpCopSourceV2({ thermalKwh: 5_000, bivalenceTempC: 2, ...base });
    const d = buildHeatPumpCopSourceV2({ thermalKwh: 5_000, hotWaterShare: 0.3, ...base });
    const shas = new Set([a.sourceSha256, b.sourceSha256, c.sourceSha256, d.sourceSha256]);
    expect(shas.size).toBe(4);
    expect(a.sourceKind).toBe("heat_pump");
    expect(a.sourceId).toBe(HEAT_PUMP_COP_V2_SOURCE_ID);
  });
});
