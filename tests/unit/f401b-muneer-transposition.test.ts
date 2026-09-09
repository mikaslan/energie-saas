import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  muneerClose,
  muneerSnapNoise,
  muneerTiltedIrradiance,
  type MuneerHourInput,
  type MuneerSurface,
} from "@/lib/integrations/calculation/muneer-v2";

// F4.1B: Muneer-Clean-Room-Kern, normative Branch-Reihenfolge 1-5 der Spec.
// Pflichtbranches inkl. exakter Grenzen (α=0.1, k_t'=0.3, cosξ=0).

const DEG = Math.PI / 180;

function hour(overrides: Partial<MuneerHourInput> = {}): MuneerHourInput {
  return {
    beamHorizontal: 400,
    diffuseHorizontal: 200,
    globalHorizontal: 600,
    groundHorizontal: 0,
    extraterrestrialHorizontal: 1000,
    airMass: 1.5,
    solarElevationRad: 0.5,
    solarAzimuthRad: 180 * DEG,
    horizonElevationRad: -0.01,
    ...overrides,
  };
}

function surface(overrides: Partial<MuneerSurface> = {}): MuneerSurface {
  return {
    tiltRad: 30 * DEG,
    tiltDeg: 30,
    azimuthRad: 180 * DEG,
    albedo: 0.2,
    ...overrides,
  };
}

describe("F4.1B branch order", () => {
  it("α<=0 nullt alles trotz positiver Eingaben (Branch 1)", () => {
    const result = muneerTiltedIrradiance(hour({ solarElevationRad: -0.05 }), surface());
    expect(result).toEqual({ beamTilted: 0, diffuseTilted: 0, reflectedTilted: 0, globalTilted: 0 });
    const zero = muneerTiltedIrradiance(hour({ solarElevationRad: 0 }), surface());
    expect(zero.globalTilted).toBe(0);
  });

  it("tiltDeg==0 liegt vor dem Niedrigsonnenzweig (D_T=D_h, B_T=B_h, R_T=0)", () => {
    const flat = surface({ tiltRad: 0, tiltDeg: 0 });
    const result = muneerTiltedIrradiance(hour({ solarElevationRad: 0.05 }), flat);
    expect(result.diffuseTilted).toBe(200);
    expect(result.beamTilted).toBeCloseTo(400, 9);
    expect(result.reflectedTilted).toBe(0);
  });

  it("Horizontschatten nullt B_T, Reflexion faellt auf D_h zurueck", () => {
    const shaded = hour({ horizonElevationRad: 0.6 });
    const result = muneerTiltedIrradiance(shaded, surface());
    expect(result.beamTilted).toBe(0);
    // R_T = ρ·D_h·(1-cosβ)/2
    const expected = 0.2 * 200 * ((1 - Math.cos(30 * DEG)) / 2);
    expect(result.reflectedTilted).toBeCloseTo(expected, 12);
  });

  it("Rueckseite (cosξ<=0) verhaelt sich wie Schatten", () => {
    // Sonne Nord, Flaeche Sued, moderate Hoehe -> cosξ<0.
    const rear = hour({ solarAzimuthRad: 0 });
    const result = muneerTiltedIrradiance(rear, surface());
    expect(result.beamTilted).toBe(0);
    expect(result.reflectedTilted).toBeCloseTo(
      0.2 * 200 * ((1 - Math.cos(30 * DEG)) / 2),
      12,
    );
  });

  it("G_T = B_T+D_T+R_T innerhalb der Spec-Toleranz", () => {
    const result = muneerTiltedIrradiance(hour(), surface());
    expect(muneerClose(
      result.globalTilted,
      result.beamTilted + result.diffuseTilted + result.reflectedTilted,
      1e-7,
      1e-9,
    )).toBe(true);
  });
});

describe("F4.1B exact boundaries", () => {
  it("α==0.1 nutzt Eq.29 (nicht den 0<α<0.1-Zweig)", () => {
    const alpha = 0.1;
    const beta = 30 * DEG;
    const kb = 400 / 1000;
    const kBeta = Math.sin(beta) - beta * Math.cos(beta)
      - Math.PI * Math.sin(beta / 2) ** 2;
    const n = 0.00263 - 0.712 * kb - 0.6883 * kb * kb;
    const s = (1 + Math.cos(beta)) / 2 + n * kBeta;
    const cosXi = Math.sin(alpha) * Math.cos(beta)
      + Math.cos(alpha) * Math.sin(beta) * Math.cos(180 * DEG - 180 * DEG);
    const expected = 200 * (s * (1 - kb) + (kb * cosXi) / Math.sin(alpha));
    const result = muneerTiltedIrradiance(hour({ solarElevationRad: alpha }), surface());
    expect(result.diffuseTilted).toBeCloseTo(expected, 9);
  });

  it("cosξ==0 ist Rueckseite", () => {
    const alpha = 0.2;
    const beta = 0.5;
    // cosξ = sinα·cosβ + cosα·sinβ·cosΔγ = 0 -> cosΔγ = -tanα/tanβ.
    const delta = Math.acos(-Math.tan(alpha) / Math.tan(beta));
    const input = hour({
      solarElevationRad: alpha,
      solarAzimuthRad: 180 * DEG + delta,
    });
    const result = muneerTiltedIrradiance(input, surface({
      tiltRad: beta,
      tiltDeg: beta / DEG,
    }));
    expect(result.beamTilted).toBe(0);
  });

  it("k_t'==0.3 ist nicht bedeckt (Eq.29), knapp darunter schon (Eq.28)", () => {
    const am = 1.5;
    const g0h = 1000;
    const denom = 0.1 + 1.031 * Math.exp(-1.4 / (0.9 + 9.4 / am));
    const gAtBoundary = 0.3 * denom * g0h;
    const base = {
      extraterrestrialHorizontal: g0h,
      airMass: am,
      beamHorizontal: 0.5 * gAtBoundary,
      diffuseHorizontal: 0.5 * gAtBoundary,
      solarElevationRad: 0.5,
    };
    const beta = 30 * DEG;
    const diffuseAtProbe = 0.5 * gAtBoundary;
    const at = muneerTiltedIrradiance(
      hour({ ...base, diffuseHorizontal: diffuseAtProbe, globalHorizontal: gAtBoundary }),
      surface(),
    );
    const below = muneerTiltedIrradiance(
      hour({ ...base, diffuseHorizontal: diffuseAtProbe, globalHorizontal: gAtBoundary * 0.99 }),
      surface(),
    );
    // Eq.28 am Vergleichspunkt: D_h·S(β,0.25227).
    const kBeta = Math.sin(beta) - beta * Math.cos(beta)
      - Math.PI * Math.sin(beta / 2) ** 2;
    const eq28 = diffuseAtProbe * ((1 + Math.cos(beta)) / 2 + 0.25227 * kBeta);
    expect(below.diffuseTilted).toBeCloseTo(eq28, 9);
    expect(at.diffuseTilted).not.toBeCloseTo(eq28, 9);
  });
});

describe("F4.1B numeric guards", () => {
  it("Rauschregel: [-1e-9,0) wird null, darunter Abbruch", () => {
    expect(muneerSnapNoise(-5e-10, "x")).toBe(0);
    expect(muneerSnapNoise(0, "x")).toBe(0);
    expect(() => muneerSnapNoise(-2e-9, "x")).toThrow();
    expect(() => muneerSnapNoise(Number.NaN, "x")).toThrow();
  });

  it("weist unphysikalische Eingaben ab", () => {
    expect(() => muneerTiltedIrradiance(
      hour({ beamHorizontal: -1 }),
      surface(),
    )).toThrow();
    expect(() => muneerTiltedIrradiance(
      hour(),
      surface({ tiltRad: 100 * DEG }),
    )).toThrow();
    expect(() => muneerTiltedIrradiance(
      hour(),
      surface({ albedo: 1.5 }),
    )).toThrow();
    expect(() => muneerTiltedIrradiance(
      hour({ extraterrestrialHorizontal: 0 }),
      surface(),
    )).toThrow();
  });
});

describe("F4.1B frozen horizontal fixtures", () => {
  const SITES = [
    "berlin-52-52-13-41",
    "madrid-40-42--3-70",
    "stockholm-59-33-18-07",
  ];

  for (const site of SITES) {
    it(`${site}: 8784 geordnete Stunden, Gr==0, Int ganzzahlig`, () => {
      const fixturePath = path.resolve(
        process.cwd(),
        `tests/fixtures/f401/pvgis-horizontal-2020-${site}.json`,
      );
      const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as {
        provenance: { url: string; fetchedAtUtc: string; rawSha256: string };
        hours: Array<{ t: string; gb: number; gd: number; gr: number; hsun: number; t2m: number; int: number }>;
      };
      expect(fixture.provenance.url).toContain("seriescalc");
      expect(fixture.provenance.rawSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fixture.hours).toHaveLength(8784);
      let previous = "";
      for (const row of fixture.hours) {
        expect(row.t > previous).toBe(true);
        previous = row.t;
        // Strahlung ist nichtnegativ; Temperatur folgt Spec [-100,100]°C.
        for (const value of [row.gb, row.gd, row.gr, row.hsun]) {
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        }
        expect(Number.isFinite(row.t2m)).toBe(true);
        expect(row.t2m).toBeGreaterThanOrEqual(-100);
        expect(row.t2m).toBeLessThanOrEqual(100);
        expect(row.gr).toBe(0);
        expect(row.int === 0 || row.int === 1).toBe(true);
      }
    });
  }
});
