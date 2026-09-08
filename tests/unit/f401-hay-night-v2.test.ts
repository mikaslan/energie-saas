import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { hayTiltedIrradiance } from "@/lib/integrations/calculation/hay-v2";

// F4.1B Pflichtbranch 1 gegen echte geneigte PVGIS-Daten (Berlin/Madrid/
// Stockholm, 30°/Sued): Bei α<=0 (H_sun==0, direkt aus PVGIS) ist
// G_T=B_T=D_T=R_T=0 — unabhaengig von Neigung, Azimut und Horizont.
// Geometrieeintraege ausser α sind Platzhalter (Branch 1 liegt vor jeder
// G_0h-/AM-Nutzung); γ_s/SPA bleibt fuer die Tagesaeste noetig.

const SITES = ["berlin", "madrid", "stockholm"] as const;

type Hour = {
  t: string;
  gb: number;
  gd: number;
  gr: number;
  hsun: number;
  p: number;
};

function tiltedHours(site: (typeof SITES)[number]): Hour[] {
  const fixture = JSON.parse(readFileSync(
    path.resolve(
      process.cwd(),
      `tests/fixtures/f401/pvgis-tilted30-south-2020-${site}.json`,
    ),
    "utf8",
  )) as { hours: Hour[] };
  return fixture.hours;
}

const SURFACES = [
  { tiltDeg: 0, tiltRad: 0, azimuthRad: 0 },
  { tiltDeg: 30, tiltRad: Math.PI / 6, azimuthRad: Math.PI },
  { tiltDeg: 60, tiltRad: Math.PI / 3, azimuthRad: Math.PI / 2 },
  { tiltDeg: 90, tiltRad: Math.PI / 2, azimuthRad: -Math.PI / 2 },
];

describe("F4.1B night branch on tilted PVGIS data", () => {
  for (const site of SITES) {
    it(`${site}: H_sun==0 -> Hay-G_T==0 ueber alle Neigungen/Azimute`, () => {
      const night = tiltedHours(site).filter((hour) => hour.hsun === 0);
      expect(night.length).toBeGreaterThan(4_000);
      // PVGIS-Konsistenz: nachts keine Einstrahlung, keine AC-Leistung.
      expect(night.every((hour) =>
        hour.gb === 0 && hour.gd === 0 && hour.gr === 0 && hour.p === 0,
      )).toBe(true);
      for (const hour of night) {
        for (const surface of SURFACES) {
          const result = hayTiltedIrradiance(
            {
              beamHorizontal: hour.gb,
              diffuseHorizontal: hour.gd,
              globalHorizontal: hour.gb + hour.gd + hour.gr,
              groundHorizontal: hour.gr,
              extraterrestrialHorizontal: 0,
              airMass: 1,
              solarElevationRad: 0,
              solarAzimuthRad: 0,
              horizonElevationRad: 0,
            },
            { ...surface, albedo: 0.2 },
          );
          expect(result).toEqual({
            beamTilted: 0,
            diffuseTilted: 0,
            reflectedTilted: 0,
            globalTilted: 0,
          });
        }
      }
    });
  }
});
