import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { neumaierSum } from "@/lib/integrations/calculation/engine-v2";
import {
  buildHeatingDegreeSourceV2,
  DEGREE_DAY_V2_HEATING_AC_SOURCE_ID,
  DEGREE_DAY_V2_SOURCE_ID,
  DEGREE_DAY_V2_VERSION,
  HEATING_LIMIT_DEG_C,
  heatingDegreeHour,
} from "@/lib/integrations/calculation/degree-day-load-v2";

// Heizgradlast: Einheit (exakt), synthetischer Einzelfall (exakt),
// Berlin-2020-Form (Jan/Jul-Verhaeltnis 40x, Sommer-Nullen exakt,
// Jahresenergie exakt), Fail-closed-Pfade.

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(
    path.resolve(process.cwd(), `tests/fixtures/f401/${name}`),
    "utf8",
  )) as T;
}

type HorizontalHour = { t: string; t2m: number };

function berlinHours(): HorizontalHour[] {
  const envelope = fixture<{ hours: HorizontalHour[] }>(
    "pvgis-horizontal-2020-berlin-52-52-13-41.json",
  );
  // Achsen-Normalisierung wie der Composer: Berliner 29.-Februar raus.
  return envelope.hours.filter((hour) => {
    const berlinMs = Date.parse(
      `${hour.t.slice(0, 4)}-${hour.t.slice(4, 6)}-${hour.t.slice(6, 8)}T`
      + `${hour.t.slice(9, 11)}:${hour.t.slice(11, 13)}:00Z`,
    ) + 3_600_000;
    const berlin = new Date(berlinMs);
    return !(berlin.getUTCMonth() === 1 && berlin.getUTCDate() === 29);
  });
}

describe("heating degree load", () => {
  it("pins version, source id and heating limit", () => {
    expect(DEGREE_DAY_V2_VERSION).toBe("wmee-degree-day.v1");
    expect(DEGREE_DAY_V2_SOURCE_ID).toBe("wmee-degree-day-heat.v1");
    expect(DEGREE_DAY_V2_HEATING_AC_SOURCE_ID).toBe("wmee-degree-day-heating-ac.v1");
    expect(HEATING_LIMIT_DEG_C).toBe(15);
  });

  it("formt Heizungs-Klimatisierung v1-gleich mit eigener Provenienz (WP-SHA stabil)", () => {
    const times = Array.from({ length: 8_760 }, (_, index) => `hour-${index}`);
    const temperatures = new Map<string, number>(
      times.map((time) => [time, 20]),
    );
    temperatures.set("hour-100", 5);
    const ac = buildHeatingDegreeSourceV2({
      annualKwh: 100,
      hourlyTemperatureC: temperatures,
      hourTimesInOrder: times,
      variant: "heating_ac",
    });
    expect(ac.sourceKind).toBe("heat_pump");
    expect(ac.sourceId).toBe(DEGREE_DAY_V2_HEATING_AC_SOURCE_ID);
    expect(ac.sourceRevision).toBe(DEGREE_DAY_V2_VERSION);
    expect(neumaierSum(ac.slotEnergyKwh)).toBeCloseTo(100, 9);
    // Gleiche Form wie WP (v1: dieselben Heizgradstunden).
    const pump = buildHeatingDegreeSourceV2({
      annualKwh: 100,
      hourlyTemperatureC: temperatures,
      hourTimesInOrder: times,
    });
    expect(pump.sourceId).toBe(DEGREE_DAY_V2_SOURCE_ID);
    expect(ac.slotEnergyKwh).toEqual(pump.slotEnergyKwh);
    expect(ac.sourceSha256).not.toBe(pump.sourceSha256);
  });

  it("computes degree hours exactly", () => {
    expect(heatingDegreeHour(15)).toBe(0);
    expect(heatingDegreeHour(20)).toBe(0);
    expect(heatingDegreeHour(10)).toBe(5);
    expect(heatingDegreeHour(-5)).toBe(20);
    expect(() => heatingDegreeHour(Number.NaN)).toThrow();
  });

  it("concentrates a single cold hour exactly", () => {
    const times = Array.from({ length: 8_760 }, (_, index) => `hour-${index}`);
    const temperatures = new Map<string, number>(
      times.map((time) => [time, 20]),
    );
    temperatures.set("hour-100", 5);
    const source = buildHeatingDegreeSourceV2({
      annualKwh: 100,
      hourlyTemperatureC: temperatures,
      hourTimesInOrder: times,
    });
    expect(source.sourceKind).toBe("heat_pump");
    expect(source.sourceRevision).toBe(DEGREE_DAY_V2_VERSION);
    expect(neumaierSum(source.slotEnergyKwh)).toBeCloseTo(100, 9);
    for (let slot = 0; slot < 35_040; slot += 1) {
      const expected = slot >= 400 && slot < 404 ? 25 : 0;
      expect(source.slotEnergyKwh[slot]).toBe(expected);
    }
  });

  it("shapes Berlin 2020 winter-heavy and energy-exact", () => {
    const hours = berlinHours();
    expect(hours).toHaveLength(8_760);
    const temperatures = new Map(hours.map((hour) => [hour.t, hour.t2m]));
    const source = buildHeatingDegreeSourceV2({
      annualKwh: 1500,
      hourlyTemperatureC: temperatures,
      hourTimesInOrder: hours.map((hour) => hour.t),
    });
    expect(neumaierSum(source.slotEnergyKwh)).toBeCloseTo(1500, 6);
    const monthly = new Array<number>(12).fill(0);
    hours.forEach((hour, hourIndex) => {
      const month = Number(hour.t.slice(4, 6)) - 1;
      for (let quarter = 0; quarter < 4; quarter += 1) {
        monthly[month]! += source.slotEnergyKwh[hourIndex * 4 + quarter]!;
      }
    });
    // Gemessen 40x (Fixture); Schranke 20x laesst Wettervariation zu,
    // beweist aber die Winterkonzentration (uniform waere ~1x).
    expect(monthly[0]! / monthly[6]!).toBeGreaterThan(20);
    // Heisse Juli-Stunde (T2m > 25 °C) traegt exakt null.
    const hotIndex = hours.findIndex((hour) => hour.t === "20200704:1311");
    expect(hotIndex).toBeGreaterThan(0);
    for (let quarter = 0; quarter < 4; quarter += 1) {
      expect(source.slotEnergyKwh[hotIndex * 4 + quarter]).toBe(0);
    }
  });

  it("rejects impossible combinations fail-closed", () => {
    const times = Array.from({ length: 8_760 }, (_, index) => `hour-${index}`);
    const warm = new Map<string, number>(times.map((time) => [time, 20]));
    // Positive kWh ohne einen einzigen Heizgradtag: kein stiller Uniform.
    expect(() => buildHeatingDegreeSourceV2({
      annualKwh: 100,
      hourlyTemperatureC: warm,
      hourTimesInOrder: times,
    })).toThrow();
    // Null-kWh traegt Nullreihe (gueltig, kein Abbruch).
    const zero = buildHeatingDegreeSourceV2({
      annualKwh: 0,
      hourlyTemperatureC: warm,
      hourTimesInOrder: times,
    });
    expect(neumaierSum(zero.slotEnergyKwh)).toBe(0);
    // Fehlende Stunde, falsche Anzahl, negative kWh.
    const missing = new Map(warm);
    missing.delete("hour-0");
    expect(() => buildHeatingDegreeSourceV2({
      annualKwh: 100,
      hourlyTemperatureC: missing,
      hourTimesInOrder: times,
    })).toThrow();
    expect(() => buildHeatingDegreeSourceV2({
      annualKwh: 100,
      hourlyTemperatureC: warm,
      hourTimesInOrder: times.slice(0, 100),
    })).toThrow();
    expect(() => buildHeatingDegreeSourceV2({
      annualKwh: -5,
      hourlyTemperatureC: warm,
      hourTimesInOrder: times,
    })).toThrow();
  });
});
