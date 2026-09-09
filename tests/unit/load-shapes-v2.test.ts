import { describe, expect, it } from "vitest";

import { neumaierSum, QUARTER_HOUR_SLOTS } from "@/lib/integrations/calculation/engine-v2";
import {
  buildCoolingDegreeSourceV2,
  buildEvPatternSourceV2,
  buildHotWaterProfileSourceV2,
  COOLING_DEGREE_V2_SOURCE_ID,
  COOLING_LIMIT_DEG_C,
  EV_PATTERN_V2_SOURCE_ID,
  evPatternWeightV2,
  HOT_WATER_PROFILE_V2_SOURCE_ID,
  hotWaterWeightV2,
  LOAD_SHAPES_V2_VERSION,
  parseLoadShapeSlotsV2,
} from "@/lib/integrations/calculation/load-shapes-v2";

// v2-Lastformen: exakte v1-Ports (engine.ts evWeights/degreeWeights/
// hotWaterWeights) auf Viertelstunden-Slots; Wochentag aus dem belegten
// ISO-Kalender der Achsenlabels (v1 zaehlt abstrakt Jan1=Montag).
// Anker: 2020-01-06 = Montag, 2020-01-11 = Samstag (ISO, verifiziert).

function label(date: string, hour: number, quarter = 0): string {
  const hh = String(hour).padStart(2, "0");
  const mm = String(quarter * 15).padStart(2, "0");
  return `${date}T${hh}:${mm}+01:00`;
}

function yearStamps(): string[] {
  // Achsenkonvention: 2020 ohne Schalttag (drop_feb29).
  const stamps: string[] = [];
  const start = Date.UTC(2020, 0, 1);
  for (let day = 0; day < 366; day += 1) {
    const date = new Date(start + day * 86_400_000);
    const stamp = date.toISOString().slice(0, 10);
    if (stamp === "2020-02-29") continue;
    stamps.push(stamp);
  }
  return stamps;
}

function fullYearLabels(): string[] {
  const labels: string[] = [];
  for (const stamp of yearStamps()) {
    for (let quarter = 0; quarter < 96; quarter += 1) {
      labels.push(label(stamp, Math.floor(quarter / 4), quarter % 4));
    }
  }
  return labels;
}

function hourTimesForYear(): string[] {
  const times: string[] = [];
  for (const stamp of yearStamps()) {
    for (let hour = 0; hour < 24; hour += 1) {
      times.push(label(stamp, hour));
    }
  }
  return times;
}

describe("F4.1 v2 load shapes: EV-Pattern", () => {
  it("portiert die v1-Fenster (evening 18-24h, daytime 9-17h, away werktags 8-18h)", () => {
    const monday = { hour: 19, isoWeekday: 1 };
    const mondayMorning = { hour: 10, isoWeekday: 1 };
    const saturday = { hour: 10, isoWeekday: 6 };
    const saturdayEvening = { hour: 20, isoWeekday: 6 };
    expect(evPatternWeightV2("evening", monday)).toBe(1);
    expect(evPatternWeightV2("evening", mondayMorning)).toBe(0.02);
    expect(evPatternWeightV2("evening", saturdayEvening)).toBe(1);
    expect(evPatternWeightV2("daytime", mondayMorning)).toBe(1);
    expect(evPatternWeightV2("daytime", monday)).toBe(0.02);
    expect(evPatternWeightV2("away", mondayMorning)).toBe(1);
    expect(evPatternWeightV2("away", saturday)).toBe(0.02);
    expect(evPatternWeightV2("away", monday)).toBe(0.02);
  });

  it("leitet ISO-Wochentage aus belegten Achsenlabels ab", () => {
    const slots = parseLoadShapeSlotsV2([
      label("2020-01-06", 19),
      label("2020-01-11", 10),
      label("2020-01-12", 10),
    ].concat(new Array<string>(QUARTER_HOUR_SLOTS - 3).fill(label("2020-01-06", 0))));
    expect(slots[0]).toEqual({ hour: 19, isoWeekday: 1 });
    expect(slots[1]).toEqual({ hour: 10, isoWeekday: 6 });
    expect(slots[2]).toEqual({ hour: 10, isoWeekday: 7 });
  });

  it("formt EV-Jahres-kWh energieexakt und weist Nachtlast am Tag ab", () => {
    const labels = fullYearLabels();
    const source = buildEvPatternSourceV2({
      annualKwh: 2400,
      pattern: "evening",
      slotLabels: labels,
    });
    expect(source.sourceId).toBe(EV_PATTERN_V2_SOURCE_ID);
    expect(source.sourceKind).toBe("ev");
    expect(source.sourceRevision).toBe(LOAD_SHAPES_V2_VERSION);
    expect(neumaierSum(source.slotEnergyKwh)).toBeCloseTo(2400, 6);
    const at = (date: string, hour: number): number =>
      source.slotEnergyKwh[labels.indexOf(label(date, hour))]!;
    // Montag: Abendspitze vs. Tagruhe; Nacht (0h) fast null.
    expect(at("2020-01-06", 19)).toBeGreaterThan(at("2020-01-06", 10) * 10);
    expect(at("2020-01-06", 2)).toBeCloseTo(at("2020-01-06", 10), 12);
    // Form ist nicht uniform: Max/Min-Verhaeltnis = v1-Fenster 1/0.02.
    const max = Math.max(...source.slotEnergyKwh);
    const min = Math.min(...source.slotEnergyKwh.filter((value) => value > 0));
    expect(max / min).toBeCloseTo(50, 6);
  });

  it("verweigert unbelegte Pattern fail-closed", () => {
    const labels = fullYearLabels();
    for (const pattern of ["unknown", "night", "", null, undefined, 42]) {
      expect(() => buildEvPatternSourceV2({
        annualKwh: 2400,
        pattern,
        slotLabels: labels,
      })).toThrow();
    }
  });
});

describe("F4.1 v2 load shapes: Kuehlgradtage", () => {
  it("portiert max(0, T-22) und faellt ohne Kuehlgradtage auf uniform zurueck (v1-Semantik)", () => {
    const hourTimesInOrder = hourTimesForYear();
    expect(hourTimesInOrder).toHaveLength(8_760);
    const hot = new Map(hourTimesInOrder.map((time, index) => [
      time,
      index % 2 === 0 ? 30 : 20,
    ] as [string, number]));
    const shaped = buildCoolingDegreeSourceV2({
      annualKwh: 800,
      hourlyTemperatureC: hot,
      hourTimesInOrder,
    });
    expect(shaped.sourceId).toBe(COOLING_DEGREE_V2_SOURCE_ID);
    expect(neumaierSum(shaped.slotEnergyKwh)).toBeCloseTo(800, 6);
    // Gerade Stunden (30 °C -> 8 K) tragen, ungerade (20 °C) sind null.
    expect(shaped.slotEnergyKwh[0]).toBeGreaterThan(0);
    expect(shaped.slotEnergyKwh[4]).toBe(0);
    expect(shaped.slotEnergyKwh[1]).toBe(shaped.slotEnergyKwh[0]);
    const cold = new Map(hourTimesInOrder.map((time) => [time, 10] as [string, number]));
    const fallback = buildCoolingDegreeSourceV2({
      annualKwh: 800,
      hourlyTemperatureC: cold,
      hourTimesInOrder,
    });
    expect(neumaierSum(fallback.slotEnergyKwh)).toBeCloseTo(800, 6);
    const first = fallback.slotEnergyKwh[0]!;
    for (const value of fallback.slotEnergyKwh) expect(value).toBe(first);
  });

  it("verweigert fehlende Stunden fail-closed", () => {
    const hourTimesInOrder = hourTimesForYear();
    expect(() => buildCoolingDegreeSourceV2({
      annualKwh: 800,
      hourlyTemperatureC: new Map(),
      hourTimesInOrder,
    })).toThrow();
    expect(() => buildCoolingDegreeSourceV2({
      annualKwh: 800,
      hourlyTemperatureC: new Map(hourTimesInOrder.map((time) => [time, 20])),
      hourTimesInOrder: hourTimesInOrder.slice(0, 100),
    })).toThrow();
  });
});

describe("F4.1 v2 load shapes: Warmwasser-Tagesgang", () => {
  it("portiert morgens 1.4, abends 1.2, sonst 0.2 (v1-Form)", () => {
    expect(hotWaterWeightV2({ hour: 6, isoWeekday: 3 })).toBe(1.4);
    expect(hotWaterWeightV2({ hour: 19, isoWeekday: 7 })).toBe(1.2);
    expect(hotWaterWeightV2({ hour: 12, isoWeekday: 1 })).toBe(0.2);
    expect(hotWaterWeightV2({ hour: 0, isoWeekday: 6 })).toBe(0.2);
    const labels = fullYearLabels();
    const source = buildHotWaterProfileSourceV2({ annualKwh: 1000, slotLabels: labels });
    expect(source.sourceId).toBe(HOT_WATER_PROFILE_V2_SOURCE_ID);
    expect(neumaierSum(source.slotEnergyKwh)).toBeCloseTo(1000, 6);
    const at = (date: string, hour: number): number =>
      source.slotEnergyKwh[labels.indexOf(label(date, hour))]!;
    // Tagesform: morgens > abends > nacht (1.4 : 1.2 : 0.2).
    expect(at("2020-03-04", 7) / at("2020-03-04", 19)).toBeCloseTo(1.4 / 1.2, 9);
    expect(at("2020-03-04", 7) / at("2020-03-04", 3)).toBeCloseTo(7, 9);
  });

  it("pinnt die Kuehlgrenze 22 °C wie v1", () => {
    expect(COOLING_LIMIT_DEG_C).toBe(22);
  });
});
