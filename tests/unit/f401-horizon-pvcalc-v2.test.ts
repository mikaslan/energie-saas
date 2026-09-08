import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildPrinthorizonUrl,
  interpolateHorizonElevation,
  parsePrinthorizon,
} from "@/lib/integrations/calculation/horizon-v2";
import { parsePVcalcSnapshot } from "@/lib/integrations/calculation/pvcalc-v2";
import { F401ProviderError } from "@/lib/integrations/calculation/provider-v2";

// F4.1 v2-Horizont/PVcalc: 49-Zeilen-Parser mit Ringschluss, 48-Punkt-
// Horizont mit Interpolation, PVcalc-Jahresreferenz.

function syntheticHorizon(options: {
  rows?: number;
  breakRing?: boolean;
  mutate?: (profile: Array<Record<string, unknown>>) => void;
} = {}): string {
  const rows = options.rows ?? 49;
  const profile: Array<Record<string, unknown>> = [];
  for (let index = 0; index < rows; index += 1) {
    profile.push({ A: -180 + index * 7.5, H_hor: index === rows - 1 && options.breakRing === true ? 0.9 : 0.4 });
  }
  options.mutate?.(profile);
  return JSON.stringify({
    inputs: {
      location: { latitude: 52.52, longitude: 13.41, elevation: 47 },
      horizon_db: "DEM-calculated",
    },
    outputs: { horizon_profile: profile },
  });
}

function syntheticPVcalc(options: {
  mutate?: (doc: {
    inputs: Record<string, unknown>;
    outputs: {
      monthly: { fixed: Array<Record<string, unknown>> };
      totals: { fixed: Record<string, unknown> };
    };
  }) => void;
} = {}): string {
  const fixed = Array.from({ length: 12 }, (_, index) => ({
    month: index + 1,
    E_d: 2.76,
    E_m: 83.87,
    "H(i)_d": 3.57,
    "H(i)_m": 108.57,
    SD_m: 4.64,
  }));
  const doc = {
    inputs: {
      location: { latitude: 52.52, longitude: 13.41, elevation: 47 },
      meteo_data: {
        radiation_db: "PVGIS-SARAH3",
        meteo_db: "ERA5",
        year_min: 2005,
        year_max: 2023,
        use_horizon: true,
        horizon_db: "DEM-calculated",
      },
      mounting_system: {
        fixed: {
          slope: { value: 30, optimal: false },
          azimuth: { value: 0, optimal: false },
          type: "building-integrated",
        },
      },
      pv_module: { technology: "c-Si", peak_power: 1, system_loss: 14 },
    },
    outputs: {
      monthly: { fixed },
      totals: {
        fixed: {
          E_d: 2.76,
          E_m: 83.87,
          E_y: 1006.46,
          "H(i)_d": 3.57,
          "H(i)_m": 108.57,
          "H(i)_y": 1302.8,
          SD_m: 4.64,
          SD_y: 55.67,
          l_aoi: -3.14,
          l_spec: "1.77",
          l_tg: -8.87,
          l_total: -22.75,
        },
      },
    },
  };
  options.mutate?.(doc);
  return JSON.stringify(doc);
}

describe("F4.1 v2 horizon", () => {
  it("parst 49 Zeilen mit Ringschluss zu 48 kanonischen Hoehen", () => {
    const horizon = parsePrinthorizon(syntheticHorizon());
    expect(horizon.heights).toHaveLength(48);
    expect(horizon.heights.every((height) => height === 0.4)).toBe(true);
    expect(horizon.horizonDb).toBe("DEM-calculated");
    expect(horizon.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(buildPrinthorizonUrl({ latitude: 52.52, longitude: 13.41 })).toBe(
      "https://re.jrc.ec.europa.eu/api/v5_3/printhorizon"
      + "?lat=52.52&lon=13.41&outputformat=json&browser=0",
    );
  });

  it("interpoliert zirkulaer-linear und rechnet Nord korrekt um", () => {
    const ramp = Array.from({ length: 48 }, (_, index) => index);
    // Azimut 0° (Nord) = A -180° -> Hoehe 0; 7.5° -> 1.
    expect(interpolateHorizonElevation(ramp, 0)).toBe(0);
    expect(interpolateHorizonElevation(ramp, 7.5)).toBe(1);
    expect(interpolateHorizonElevation(ramp, 3.75)).toBeCloseTo(0.5, 12);
    // 359° liegt zwischen Punkt 47 (172.5°) und Punkt 0 (-180°):
    // 47*(1-frac) + 0*frac mit frac = 359/7.5-47.
    expect(interpolateHorizonElevation(ramp, 359)).toBeCloseTo(
      47 * (48 - 359 / 7.5),
      12,
    );
    // Ost (90°) = A -90° -> Index 12.
    expect(interpolateHorizonElevation(ramp, 90)).toBe(12);
    expect(() => interpolateHorizonElevation(ramp, 360)).toThrow(F401ProviderError);
    expect(() => interpolateHorizonElevation(ramp.slice(0, 47), 10)).toThrow(
      F401ProviderError,
    );
  });

  it("bricht fail-closed bei Zeilenzahl, Schritt, Ring und Bereich ab", () => {
    expect(() => parsePrinthorizon(syntheticHorizon({ rows: 48 }))).toThrow(
      F401ProviderError,
    );
    expect(() => parsePrinthorizon(syntheticHorizon({ breakRing: true }))).toThrow(
      F401ProviderError,
    );
    expect(() => parsePrinthorizon(syntheticHorizon({
      mutate: (profile) => {
        profile[10]!.A = -100;
      },
    }))).toThrow(F401ProviderError);
    expect(() => parsePrinthorizon(syntheticHorizon({
      mutate: (profile) => {
        profile[11]!.H_hor = 91;
      },
    }))).toThrow(F401ProviderError);
    expect(() => parsePrinthorizon("kein json")).toThrow(F401ProviderError);
  });
});

describe("F4.1 v2 pvcalc", () => {
  it("parst die echte Berlin-Response mit E_y=1006.46", () => {
    const raw = readFileSync(
      path.resolve(process.cwd(), "tests/fixtures/f401/pvcalc-30s-berlin-2020.json"),
      "utf8",
    );
    const snapshot = parsePVcalcSnapshot(raw);
    expect(snapshot.annualReferenceKwhPerKwp).toBe(1006.46);
    expect(snapshot.monthly).toHaveLength(12);
    expect(snapshot.mounting).toMatchObject({ tiltDeg: 30, place: "building-integrated" });
    expect(snapshot.module).toMatchObject({ technology: "c-Si", peakPowerKwp: 1 });
  });

  it("parst die Jahresreferenz E_y mit Monaten und Verlusten", () => {
    const snapshot = parsePVcalcSnapshot(syntheticPVcalc());
    expect(snapshot.annualReferenceKwhPerKwp).toBe(1006.46);
    expect(snapshot.annualIrradiationKwhPerM2).toBe(1302.8);
    expect(snapshot.monthly).toHaveLength(12);
    expect(snapshot.monthly[0]).toMatchObject({ month: 1, energyKwhPerKwpMonth: 83.87 });
    expect(snapshot.mounting).toMatchObject({
      tiltDeg: 30,
      aspectDeg: 0,
      place: "building-integrated",
    });
    expect(snapshot.module).toMatchObject({ technology: "c-Si", peakPowerKwp: 1 });
    expect(snapshot.losses).toMatchObject({ aoi: -3.14, total: -22.75 });
    expect(snapshot.meteo).toMatchObject({ yearMin: 2005, yearMax: 2023 });
  });

  it("bricht fail-closed bei Spiegel-, Monats- und Totalsfehlern ab", () => {
    expect(() => parsePVcalcSnapshot(syntheticPVcalc({
      mutate: (doc) => {
        (doc.inputs.meteo_data as Record<string, unknown>).radiation_db = "X";
      },
    }))).toThrow(F401ProviderError);
    expect(() => parsePVcalcSnapshot(syntheticPVcalc({
      mutate: (doc) => {
        doc.outputs.monthly.fixed.pop();
      },
    }))).toThrow(F401ProviderError);
    expect(() => parsePVcalcSnapshot(syntheticPVcalc({
      mutate: (doc) => {
        doc.outputs.monthly.fixed[5]!.month = 5;
      },
    }))).toThrow(F401ProviderError);
    expect(() => parsePVcalcSnapshot(syntheticPVcalc({
      mutate: (doc) => {
        doc.outputs.totals.fixed.E_y = -1;
      },
    }))).toThrow(F401ProviderError);
    expect(() => parsePVcalcSnapshot(syntheticPVcalc({
      mutate: (doc) => {
        delete (doc.inputs.pv_module as Record<string, unknown>).peak_power;
      },
    }))).toThrow(F401ProviderError);
  });
});
