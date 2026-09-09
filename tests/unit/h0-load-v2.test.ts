import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { mapProviderYearToQuarterSlots } from "@/lib/integrations/calculation/axis-v2";
import { BDEW_H0_CSV_SHA256 } from "@/lib/integrations/calculation/bdew-h0-table";
import { neumaierSum } from "@/lib/integrations/calculation/engine-v2";
import {
  buildH0BasisSourceV2,
  H0_LOAD_V2_SOURCE_ID,
  H0_LOAD_V2_VERSION,
  h0DynamicFactor,
  h0Season,
  h0StaticValue,
  parseH0SlotLabel,
} from "@/lib/integrations/calculation/h0-load-v2";

// BDEW-H0-Basislast: Tabellen-Transkription (exakt), F-Polynom (exakt),
// Saison-/Wochentag-Kanten (handgepruefte 2020-Daten), Volljahr-Form
// gegen demandlib-Orakel (35136 Viertel inkl. Feb 29).
//
// Orakel-Toleranz 1 % mit Herleitung: einzige zulässige Abweichung ist
// das F_t-Argument (Kalender-Tag gemaess BDEW-Standardtext vs.
// demandlibs positionsbasierte Konvention, max. ~1 Tag Versatz).
// |F'| <= 0.005/Tag auf [1,367] (Extremstellen nachgerechnet) ->
// Formeffekt <= 0.7 %; Rundung (Orakel 9dp) und Feb-29-Normierung
// liegen darunter. Uniforme Reskalierung kürzt sich in der
// Form-Normierung beidseitig heraus.

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(
    path.resolve(process.cwd(), `tests/fixtures/f401/${name}`),
    "utf8",
  )) as T;
}

describe("BDEW H0 basis load", () => {
  it("pins version, source id and table sha", () => {
    expect(H0_LOAD_V2_VERSION).toBe("wmee-bdew-h0-dyn.v1");
    expect(H0_LOAD_V2_SOURCE_ID).toBe("wmee-bdew-h0-dyn-basis.v1");
    expect(BDEW_H0_CSV_SHA256).toBe(
      "aa8d5b54c9dea6989ec1f8ced063db8e16963689abbe21c60ff2cd87d0a6a4cc",
    );
  });

  it("transcribes the static table exactly", () => {
    const table = fixture<{
      periods: Record<string, Record<string, number[]>>;
    }>("bdew-h0-static.json");
    for (const season of ["summer", "winter", "transition"] as const) {
      for (let weekday = 1; weekday <= 7; weekday += 1) {
        const expected = table.periods[season]![String(weekday)]!;
        expect(expected).toHaveLength(96);
        for (let quarter = 0; quarter < 96; quarter += 1) {
          expect(h0StaticValue(season, weekday, quarter)).toBe(expected[quarter]);
        }
      }
    }
  });

  it("evaluates the smoothing polynomial exactly", () => {
    const cases: Array<[number, number]> = [
      [1.0, 1.242030119608335],
      [32.5, 1.244649283518524],
      [100.25, 1.0278569888719953],
      [200.5, 0.7852864319519224],
      [300.75, 1.0225777286316085],
      [365.0, 1.2631631661020313],
      [366.9375, 1.268013106099617],
    ];
    for (const [day, expected] of cases) {
      expect(h0DynamicFactor(day)).toBeCloseTo(expected, 12);
    }
  });

  it("maps seasons, weekdays and holidays on checked 2020 dates", () => {
    expect(h0Season(1, 1)).toBe("winter");
    expect(h0Season(3, 20)).toBe("winter");
    expect(h0Season(3, 21)).toBe("transition");
    expect(h0Season(5, 14)).toBe("transition");
    expect(h0Season(5, 15)).toBe("summer");
    expect(h0Season(9, 14)).toBe("summer");
    expect(h0Season(9, 15)).toBe("transition");
    expect(h0Season(10, 31)).toBe("transition");
    expect(h0Season(11, 1)).toBe("winter");
    // 2020-01-01: Mittwoch, Neujahr -> Sonntag.
    expect(parseH0SlotLabel("2020-01-01T12:00+01:00")).toMatchObject({
      dayOfYear: 1, quarterOfDay: 48, weekday17: 7,
    });
    // 2020-01-06: Montag, kein Feiertag.
    expect(parseH0SlotLabel("2020-01-06T00:00+01:00").weekday17).toBe(1);
    // 2020-05-01: Freitag, Feiertag -> Sonntag.
    expect(parseH0SlotLabel("2020-05-01T12:00+01:00").weekday17).toBe(7);
    // 24./31.12.2020 (Do): Samstagsregel; 27.12. (So) bleibt Sonntag.
    expect(parseH0SlotLabel("2020-12-24T12:00+01:00").weekday17).toBe(6);
    expect(parseH0SlotLabel("2020-12-31T12:00+01:00").weekday17).toBe(6);
    expect(parseH0SlotLabel("2020-12-27T12:00+01:00").weekday17).toBe(7);
    // Label-Ueberlauf 2021-01-01 (Freitag): kein Feiertag ausserhalb 2020.
    expect(parseH0SlotLabel("2021-01-01T00:00+01:00").weekday17).toBe(5);
    expect(parseH0SlotLabel("2020-02-29T12:00+01:00")).toMatchObject({
      dayOfYear: 60, weekday17: 6,
    });
  });

  it("rejects malformed labels and counts fail-closed", () => {
    for (const bad of [
      "2020-01-01T12:07+01:00",
      "2020-01-01T12:00+02:00",
      "2020-13-01T12:00+01:00",
      "2020-02-30T12:00+01:00",
      "kein-label",
      42,
      null,
    ]) {
      expect(() => parseH0SlotLabel(bad)).toThrow();
    }
    expect(() => buildH0BasisSourceV2({
      annualKwh: 4200,
      slotLabels: new Array(100).fill("2020-01-01T00:00+01:00"),
    })).toThrow();
    expect(() => buildH0BasisSourceV2({
      annualKwh: -1,
      slotLabels: new Array(35_040).fill("2020-01-01T00:00+01:00"),
    })).toThrow();
  });

  it("matches the demandlib oracle shape and stays energy-exact", () => {
    const horizontal = fixture<{ hours: Array<{ t: string }> }>(
      "pvgis-horizontal-2020-berlin-52-52-13-41.json",
    );
    const slots = mapProviderYearToQuarterSlots(horizontal.hours.map((h) => h.t));
    const labels = slots.map((slot) => slot.slotLabel);
    const source = buildH0BasisSourceV2({ annualKwh: 4200, slotLabels: labels });
    expect(source.sourceKind).toBe("basis");
    expect(source.sourceId).toBe(H0_LOAD_V2_SOURCE_ID);
    expect(source.sourceRevision).toBe(H0_LOAD_V2_VERSION);
    expect(source.slotEnergyKwh).toHaveLength(35_040);
    expect(neumaierSum(source.slotEnergyKwh)).toBeCloseTo(4200, 6);

    const oracle = fixture<{
      stamps: string[];
      h0_dyn: number[];
    }>("bdew-h0-dyn-oracle-2020.json");
    const oracleByStamp = new Map<string, number>();
    oracle.stamps.forEach((stamp, index) => {
      oracleByStamp.set(stamp, oracle.h0_dyn[index]!);
    });
    const ownTotal = neumaierSum(source.slotEnergyKwh);
    const oracleTotal = neumaierSum(oracle.h0_dyn);
    let matched = 0;
    let skippedRule = 0;
    let maxRel = 0;
    for (let slot = 0; slot < 35_040; slot += 1) {
      const key = (labels[slot] as string).slice(0, 16);
      // 24./31.12. weichen per BDEW-Samstagsregel ab (separat gepinnt);
      // 2021-Labels und Feb 29 fehlen im 2020-Orakel.
      if (key.startsWith("2020-12-24") || key.startsWith("2020-12-31")) {
        skippedRule += 1;
        continue;
      }
      const reference = oracleByStamp.get(key);
      if (reference === undefined) continue;
      matched += 1;
      const rel = Math.abs(source.slotEnergyKwh[slot]! / ownTotal - reference / oracleTotal)
        / (reference / oracleTotal);
      maxRel = Math.max(maxRel, rel);
    }
    // 35040 - 192 (24./31.12.-Regel) - 4 (2021-Label-Ueberlauf, nicht im
    // 2020-Orakel); Feb-29-Orakelzeilen matchen nie (kein Achsen-Slot).
    expect(matched).toBe(34_844);
    expect(skippedRule).toBe(192);
    expect(maxRel).toBeLessThan(0.01);
  }, 180_000);
});
