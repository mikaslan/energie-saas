import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { mapProviderYearToQuarterSlots } from "@/lib/integrations/calculation/axis-v2";
import {
  solarQuarterGeometryUtc,
  SOLAR_GEOMETRY_V2_VERSION,
} from "@/lib/integrations/calculation/solar-geometry-v2";

// TS-Sonnengeometrie gegen unabhaengige SPA-Ground-Truth (pvlib-Sidecar,
// 3 Standorte x 35.040 Viertel): Schranken sind 10-100x unterhalb dessen,
// was die F4.1B-Monatshuelle (±2,4 %) bewegen wuerde; der Downstream-Test
// (Monatsvergleich mit TS-Geometrie) beweist das separat.
// Azimut wird nur bei Tag (elev > 0.5°) verglichen: nachts ist die
// Richtung physikalisch bedeutungslos, am exakten Zenit undefiniert.

const SITES = {
  berlin: { latitude: 52.52, longitude: 13.41, tilted: "pvgis-tilted30-south-2020-berlin.json" },
  madrid: { latitude: 40.42, longitude: -3.7, tilted: "pvgis-tilted30-south-2020-madrid.json" },
  stockholm: { latitude: 59.33, longitude: 18.07, tilted: "pvgis-tilted30-south-2020-stockholm.json" },
} as const;

type GeometrySlot = [elevDeg: number, azimDeg: number, amOrNull: number | null, g0h: number];

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(
    path.resolve(process.cwd(), `tests/fixtures/f401/${name}`),
    "utf8",
  )) as T;
}

function angularDistance(a: number, b: number): number {
  const delta = Math.abs(a - b) % 360;
  return delta > 180 ? 360 - delta : delta;
}

describe("TS solar geometry against SPA ground truth", () => {
  it("pins the module version", () => {
    expect(SOLAR_GEOMETRY_V2_VERSION).toBe(
      "noaa-low-precision_spencer-nrel_sealevel.v1",
    );
  });

  for (const [site, config] of Object.entries(SITES)) {
    it(`${site}: elevation/azimuth/airmass/g0h inside the envelope`, () => {
      const tilted = fixture<{ hours: Array<{ t: string }> }>(config.tilted);
      const geometry = fixture<{ slots: GeometrySlot[] }>(
        `spa-quarters-2020-${site}.json`,
      );
      expect(geometry.slots.length).toBe(35_040);
      const slots = mapProviderYearToQuarterSlots(
        tilted.hours.map((hour) => hour.t),
      );
      let maxElevError = 0;
      let maxAzimError = 0;
      let maxAmRelError = 0;
      let maxG0hRelError = 0;
      let daySlots = 0;
      for (const slot of slots) {
        const computed = solarQuarterGeometryUtc(
          Date.parse(slot.evaluationInstantUtc),
          config.latitude,
          config.longitude,
        );
        const [elev, azim, am, g0h] = geometry.slots[slot.slot]!;
        maxElevError = Math.max(maxElevError, Math.abs(computed.elevationDeg - elev));
        const g0hScale = Math.max(g0h, 50);
        maxG0hRelError = Math.max(
          maxG0hRelError,
          Math.abs(computed.extraterrestrialHorizontal - g0h) / g0hScale,
        );
        // AM-Nullgrenze ist exakt elev <= 0 (Sidecar-Regel); im
        // +-0.02°-Band darf die Nullstellung beidseitig straddlen.
        if (Math.abs(elev) < 0.02) {
          expect(Math.abs(computed.elevationDeg)).toBeLessThanOrEqual(0.05);
        } else if (elev <= 0) {
          expect(am).toBeNull();
          expect(computed.airMass).toBeNull();
        } else {
          expect(am).not.toBeNull();
          expect(computed.airMass).not.toBeNull();
          if (elev > 1) {
            // Unter 1° dominiert das Refraktionsmodell die AM
            // (steile KY-Kurve); dort nur Existenz, keine Praezision.
            maxAmRelError = Math.max(
              maxAmRelError,
              Math.abs(computed.airMass! - am!) / (am as number),
            );
          }
        }
        if (elev > 0.5) {
          daySlots += 1;
          maxAzimError = Math.max(maxAzimError, angularDistance(computed.azimuthDegNorth, azim));
        }
      }
      expect(daySlots).toBeGreaterThan(10_000);
      expect(maxElevError).toBeLessThanOrEqual(0.05);
      expect(maxAzimError).toBeLessThanOrEqual(0.1);
      expect(maxAmRelError).toBeLessThanOrEqual(0.005);
      expect(maxG0hRelError).toBeLessThanOrEqual(0.005);
    }, 180_000);
  }

  it("rejects invalid input fail-closed", () => {
    expect(() => solarQuarterGeometryUtc(Number.NaN, 52.52, 13.41)).toThrow();
    expect(() => solarQuarterGeometryUtc(Date.parse("2020-06-01T12:00:00Z"), 91, 13.41)).toThrow();
    expect(() => solarQuarterGeometryUtc(Date.parse("2020-06-01T12:00:00Z"), 52.52, 181)).toThrow();
  });
});
