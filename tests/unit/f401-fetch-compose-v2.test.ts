import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { mapProviderYearToQuarterSlots } from "@/lib/integrations/calculation/axis-v2";
import { neumaierSum, QUARTER_HOUR_SLOTS } from "@/lib/integrations/calculation/engine-v2";
import {
  buildLoadSourcesFromProfileV2,
  fetchPlanningSeriesV2,
  type SnapshotTransportV2,
} from "@/lib/integrations/calculation/fetch-compose-v2";
import { parsePVcalcSnapshot } from "@/lib/integrations/calculation/pvcalc-v2";
import {
  PLANNING_ASSUMPTIONS_V2_VERSION,
} from "@/lib/integrations/calculation/planning-assumptions-v2";
import {
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
} from "@/lib/integrations/calculation/versions-v2";
import type {
  ParsedSeriescalcSnapshot,
  SeriesHour,
} from "@/lib/integrations/calculation/provider-v2";

// Fetch-Composer: printhorizon + horizontaler seriescalc (standortweit)
// + geneigte seriescalc/PVcalc je Dach (PVGIS-Rezept, Planungstechnik)
// -> PVcalc-Skalierung -> Hay-Geometriegewichte (TS-Geometrie) ->
// kWp-Summation; Last aus uniformen Provenienz-Quellen.
// Echte Fixture-Bytes (Berlin 2020, live verifiziert).

const SITE = { latitude: 52.52, longitude: 13.41 };
const SOUTH_ROOF = {
  roofId: "dach-sued",
  areaM2: 52,
  tiltDeg: 30,
  azimuthDeg: 0,
};

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    latitude: SITE.latitude,
    longitude: SITE.longitude,
    roofs: [SOUTH_ROOF],
    consumption: consumption(),
    ...overrides,
  };
}

type TiltedEnvelope = {
  hours: Array<{
    t: string;
    gb: number;
    gd: number;
    gr: number;
    hsun: number;
    t2m: number;
    int: number;
    p: number;
  }>;
  horizon: { heights48: number[] };
  provenance: { url: string };
};

function tiltedEnvelope(): TiltedEnvelope {
  return JSON.parse(readFileSync(
    path.resolve(process.cwd(), "tests/fixtures/f401/pvgis-tilted30-south-2020-berlin.json"),
    "utf8",
  )) as TiltedEnvelope;
}

type HorizontalEnvelope = {
  hours: Array<{
    t: string;
    gb: number;
    gd: number;
    gr: number;
    hsun: number;
    t2m: number;
    int: number;
  }>;
};

function horizontalEnvelope(): HorizontalEnvelope {
  return JSON.parse(readFileSync(
    path.resolve(
      process.cwd(),
      "tests/fixtures/f401/pvgis-horizontal-2020-berlin-52-52-13-41.json",
    ),
    "utf8",
  )) as HorizontalEnvelope;
}

function berlinAnnualKwhPerKwp(): number {
  const raw = readFileSync(
    path.resolve(process.cwd(), "tests/fixtures/f401/pvcalc-30s-berlin-2020.json"),
    "utf8",
  );
  return parsePVcalcSnapshot(raw).annualReferenceKwhPerKwp;
}

function fakeTransport(envelope: TiltedEnvelope): SnapshotTransportV2 & {
  urls: string[];
} {
  const urls: string[] = [];
  return {
    urls,
    async fetchHorizon(url: string) {
      urls.push(url);
      return {
        rawSha256: "0".repeat(64),
        heights: [...envelope.horizon.heights48],
        horizonDb: "DEM-calculated",
      };
    },
    async fetchSeries(url: string): Promise<ParsedSeriescalcSnapshot> {
      urls.push(url);
      const hours: SeriesHour[] = envelope.hours.map((hour) => ({
        time: hour.t,
        gb: hour.gb,
        gd: hour.gd,
        gr: hour.gr,
        hSun: hour.hsun,
        t2m: hour.t2m,
        // Test-Double: Envelope enthaelt kein WS10m; Produktion parst echt.
        ws10m: 0,
        int: hour.int as 0 | 1,
        p: hour.p,
      }));
      return {
        recipeVersion: CALCULATION_V2_PROVIDER_RECIPE_VERSION,
        rawSha256: "1".repeat(64),
        inputsMirror: {},
        site: { latitude: SITE.latitude, longitude: SITE.longitude, elevation: 34 },
        meteo: {
          radiationDb: "PVGIS-SARAH3",
          meteoDb: "SARAH3",
          yearMin: 2020,
          yearMax: 2020,
          useHorizon: true,
        },
        hours,
      };
    },
    async fetchHorizontal(url: string): Promise<ParsedSeriescalcSnapshot> {
      urls.push(url);
      const envelope = horizontalEnvelope();
      const hours: SeriesHour[] = envelope.hours.map((hour) => ({
        time: hour.t,
        gb: hour.gb,
        gd: hour.gd,
        gr: hour.gr,
        hSun: hour.hsun,
        t2m: hour.t2m,
        ws10m: 0,
        int: hour.int as 0 | 1,
        p: null,
      }));
      return {
        recipeVersion: CALCULATION_V2_PROVIDER_RECIPE_VERSION,
        rawSha256: "2".repeat(64),
        inputsMirror: {},
        site: { latitude: SITE.latitude, longitude: SITE.longitude, elevation: 34 },
        meteo: {
          radiationDb: "PVGIS-SARAH3",
          meteoDb: "SARAH3",
          yearMin: 2020,
          yearMax: 2020,
          useHorizon: false,
        },
        hours,
      };
    },
    async fetchAnnual(url: string) {
      urls.push(url);
      const raw = readFileSync(
        path.resolve(process.cwd(), "tests/fixtures/f401/pvcalc-30s-berlin-2020.json"),
        "utf8",
      );
      return parsePVcalcSnapshot(raw);
    },
  };
}

function consumption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    householdKwhPerYear: { status: "known", value: 4200, source: "customer_metered" },
    evKmPerYear: { status: "known", value: 12000, source: "customer_input" },
    heatPumpKwhPerYear: { status: "known", value: 0, source: "customer_input" },
    coolingKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
    hotWaterKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
    ...overrides,
  };
}

function axisLabels(): string[] {
  const envelope = horizontalEnvelope();
  return mapProviderYearToQuarterSlots(envelope.hours.map((hour) => hour.t))
    .map((slot) => slot.slotLabel);
}

describe("F4.1 v2 load sources from profile", () => {
  it("bindet belegte kWh als H0-Basis plus uniforme Zusatzquellen", () => {
    const sources = buildLoadSourcesFromProfileV2(
      { consumption: consumption() },
      axisLabels(),
    );
    expect(sources.map((source) => source.sourceKind)).toEqual(["basis", "ev"]);
    const basis = sources[0]!;
    expect(basis.sourceId).toBe("wmee-bdew-h0-dyn-basis.v1");
    expect(basis.sourceRevision).toBe("wmee-bdew-h0-dyn.v1");
    expect(neumaierSum(basis.slotEnergyKwh)).toBeCloseTo(4200, 6);
    const ev = sources[1]!;
    expect(neumaierSum(ev.slotEnergyKwh)).toBeCloseTo(2400, 9);
  });

  it("verweigert fehlende Basis und skippt Unbekanntes/Nullen", () => {
    expect(() => buildLoadSourcesFromProfileV2({
      consumption: consumption({
        householdKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
      }),
    }, axisLabels())).toThrow();
    const sources = buildLoadSourcesFromProfileV2({
      consumption: consumption({
        evKmPerYear: { status: "unknown", value: null, source: "not_collected" },
        heatPumpKwhPerYear: { status: "known", value: 1500, source: "customer_input" },
      }),
    }, axisLabels());
    expect(sources.map((source) => source.sourceKind)).toEqual(["basis", "heat_pump"]);
  });
});

describe("F4.1 v2 fetch compose", () => {
  it("komponiert Berlin-Sued aus echten Fixture-Bytes bis E_y x kWp", async () => {
    const envelope = tiltedEnvelope();
    const transport = fakeTransport(envelope);
    const composed = await fetchPlanningSeriesV2({
      request: request(),
      transport,
    });
    expect(composed.providerEstimate).toBe(true);
    expect(composed.pvKwh).toHaveLength(QUARTER_HOUR_SLOTS);
    expect(composed.loadKwh).toHaveLength(QUARTER_HOUR_SLOTS);
    for (const value of composed.pvKwh) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    // E_y (PVcalc-Referenz) x kWp (Flaeche x Planungsleistung), exakt skaliert.
    const expectedAnnual = berlinAnnualKwhPerKwp() * 10.4;
    expect(neumaierSum(composed.pvKwh)).toBeCloseTo(expectedAnnual, 0);
    expect(neumaierSum(composed.loadKwh)).toBeCloseTo(6600, 6);
    expect(composed.provenance.paramsVersion).toBe(PLANNING_ASSUMPTIONS_V2_VERSION);
    expect(composed.provenance.roofs).toHaveLength(1);
    expect(composed.provenance.roofs[0]).toMatchObject({
      roofId: "dach-sued",
      annualReferenceKwhPerKwp: berlinAnnualKwhPerKwp(),
    });
    // Kanonische Query-Form wie der verifizierte Abruf (Technik aus Planung).
    const seriesUrl = transport.urls.find((url) => url.includes("pvcalculation=1"))!;
    expect(seriesUrl).toContain("lat=52.52&lon=13.41");
    expect(seriesUrl).toContain("pvcalculation=1&trackingtype=0&components=1");
    expect(seriesUrl).toContain("angle=30&aspect=0");
    expect(seriesUrl).toContain("pvtechchoice=crystSi&mountingplace=free&loss=14");
    expect(seriesUrl).toContain("usehorizon=1&userhorizon=");
    // Standortweiter Horizontalabruf (pvcalculation=0) + Hay-Provenienz.
    const horizontalUrl = transport.urls.find((url) => url.includes("pvcalculation=0"))!;
    expect(horizontalUrl).toContain("lat=52.52&lon=13.41");
    expect(horizontalUrl).toContain("angle=0&aspect=0");
    expect(composed.provenance.subhourMethod).toBe("hay-geometry-weights.v1");
    expect(composed.provenance.horizontalUrl).toBe(horizontalUrl);
    expect(composed.provenance.horizontalSha256).toBe("2".repeat(64));
  });

  it("verweigert gekreuzte Standort-Echos und fehlende Basis fail-closed", async () => {
    const envelope = tiltedEnvelope();
    const crossed = fakeTransport(envelope);
    const originalSeries = crossed.fetchSeries;
    crossed.fetchSeries = async (url) => {
      const snapshot = await originalSeries(url);
      return { ...snapshot, site: { ...snapshot.site, latitude: 48.14 } };
    };
    await expect(fetchPlanningSeriesV2({
      request: request(),
      transport: crossed,
    })).rejects.toThrow();
    await expect(fetchPlanningSeriesV2({
      request: request({ roofs: [] }),
      transport: fakeTransport(envelope),
    })).rejects.toThrow();
    await expect(fetchPlanningSeriesV2({
      request: request({
        consumption: consumption({
          householdKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
        }),
      }),
      transport: fakeTransport(envelope),
    })).rejects.toThrow();
  });
});
