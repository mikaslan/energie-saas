import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { mapProviderYearToQuarterSlots } from "@/lib/integrations/calculation/axis-v2";
import {
  MUNEER_WEIGHTS_ALBEDO,
  MUNEER_WEIGHTS_V2_VERSION,
  muneerQuarterWeightsV2,
  quarterGeometryForHourV2,
} from "@/lib/integrations/calculation/muneer-weights-v2";
import { neumaierSum } from "@/lib/integrations/calculation/engine-v2";

// Muneer-Gewichtemodul gegen echtes PVGIS-Wetterjahr: horizontale Stunden
// (Gb/Gd) + TS-Geometrie -> G_T,q je Stunde; Jahressumme gegen die
// geneigten PVGIS-Stundensummen (30°/Sued, Albedo 0.2) desselben Jahrs.
// Zusaetzlich: kein einziger Fehl-Abbruch auf 3 x 8760 echten Stunden
// (Fail-closed-Pfad bleibt scharf, feuert aber nicht spurios),
// Nachtstunden liefern exakt Nullgewichte.

const SITES = {
  berlin: { latitude: 52.52, longitude: 13.41 },
  madrid: { latitude: 40.42, longitude: -3.7 },
  stockholm: { latitude: 59.33, longitude: 18.07 },
} as const;

type Hour = { t: string; gb: number; gd: number; gr: number };

function fixture<T>(site: string, kind: string): T {
  const name = kind === "horizontal"
    ? {
      berlin: "pvgis-horizontal-2020-berlin-52-52-13-41.json",
      madrid: "pvgis-horizontal-2020-madrid-40-42--3-70.json",
      stockholm: "pvgis-horizontal-2020-stockholm-59-33-18-07.json",
    }[site as keyof typeof SITES]!
    : `pvgis-tilted30-south-2020-${site}.json`;
  return JSON.parse(readFileSync(
    path.resolve(process.cwd(), `tests/fixtures/f401/${name}`),
    "utf8",
  )) as T;
}

describe("muneer quarter weights on PVGIS weather year", () => {
  it("pins version and albedo", () => {
    expect(MUNEER_WEIGHTS_V2_VERSION).toBe("muneer-geometry-weights.v1");
    expect(MUNEER_WEIGHTS_ALBEDO).toBe(0.2);
  });

  for (const [site, coords] of Object.entries(SITES)) {
    it(`${site}: annual envelope, no spurious abort, night zeros`, () => {
      const horizontal = fixture<{ hours: Hour[] }>(site, "horizontal");
      const tilted = fixture<{ hours: Hour[]; horizon: { heights48: number[] } }>(
        site, "tilted",
      );
      const slots = mapProviderYearToQuarterSlots(horizontal.hours.map((h) => h.t));
      const observed = new Set(slots.map((slot) => slot.providerObservedAtUtc));
      const kept = horizontal.hours.filter((hour) => observed.has(hour.t));
      expect(kept.length).toBe(8_760);
      const tiltedByTime = new Map(tilted.hours.map((hour) => [hour.t, hour]));
      let muneerAnnual = 0;
      let refAnnual = 0;
      let nightHours = 0;
      for (let hourIndex = 0; hourIndex < 8_760; hourIndex += 1) {
        const hour = kept[hourIndex]!;
        const base = hourIndex * 4;
        const instants = [
          slots[base]!.evaluationInstantUtc,
          slots[base + 1]!.evaluationInstantUtc,
          slots[base + 2]!.evaluationInstantUtc,
          slots[base + 3]!.evaluationInstantUtc,
        ] as [string, string, string, string];
        // Dachazimut: Tilted-Fixture aspectDeg=0 (PVGIS Sued-Null)
        // -> 180° Nord/Uhrzeigersinn (Spec-Konvention, muneer-v2).
        const weights = muneerQuarterWeightsV2({
          beamHourWhPerM2: hour.gb,
          diffuseHourWhPerM2: hour.gd,
          quarterGeometry: quarterGeometryForHourV2({
            latitude: coords.latitude,
            longitude: coords.longitude,
            quarterInstantsUtc: instants,
          }),
          horizonHeights48: tilted.horizon.heights48,
          surface: { tiltDeg: 30, azimuthDegNorth: 180 },
        });
        for (const weight of weights) {
          expect(Number.isFinite(weight)).toBe(true);
          expect(weight).toBeGreaterThanOrEqual(0);
        }
        if (hour.gb + hour.gd === 0) {
          nightHours += 1;
          expect(weights).toEqual([0, 0, 0, 0]);
        } else {
          expect(weights[0]! + weights[1]! + weights[2]! + weights[3]!).toBeGreaterThan(0);
        }
        muneerAnnual += 0.25 * neumaierSum(weights);
        const reference = tiltedByTime.get(hour.t)!;
        refAnnual += reference.gb + reference.gd + reference.gr;
      }
      expect(nightHours).toBeGreaterThan(3_000);
      expect(Math.abs(muneerAnnual - refAnnual)).toBeLessThanOrEqual(0.0025 * refAnnual);
    }, 240_000);
  }

  it("rejects invalid input fail-closed", () => {
    const geometry = quarterGeometryForHourV2({
      latitude: 52.52,
      longitude: 13.41,
      quarterInstantsUtc: [
        "2020-06-21T11:07:30.000Z",
        "2020-06-21T11:22:30.000Z",
        "2020-06-21T11:37:30.000Z",
        "2020-06-21T11:52:30.000Z",
      ],
    });
    const valid = {
      beamHourWhPerM2: 500,
      diffuseHourWhPerM2: 200,
      quarterGeometry: geometry,
      horizonHeights48: new Array<number>(48).fill(0),
      surface: { tiltDeg: 30, azimuthDegNorth: 180 },
    };
    expect(() => muneerQuarterWeightsV2(valid).length).not.toThrow();
    expect(() => muneerQuarterWeightsV2({ ...valid, beamHourWhPerM2: -1 })).toThrow();
    expect(() => muneerQuarterWeightsV2({
      ...valid, horizonHeights48: new Array<number>(47).fill(0),
    })).toThrow();
    expect(() => muneerQuarterWeightsV2({
      ...valid, surface: { tiltDeg: 91, azimuthDegNorth: 180 },
    })).toThrow();
    expect(() => muneerQuarterWeightsV2({
      ...valid, surface: { tiltDeg: 30, azimuthDegNorth: 360 },
    })).toThrow();
  });
});
