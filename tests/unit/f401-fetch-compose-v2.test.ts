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
// kWp-Summation; Last aus belegten Provenienz-Quellen (H0, Heizgrad,
// EV-Pattern, Kuehlgrad, Warmwasser-Tagesgang).
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
    // Slice A: Neuanlagen-Setup (Bestand-Kontext wird ignoriert).
    branch: "new_installation",
    asOfDate: "2026-08-29",
    existingPv: { status: "known_absent" },
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
    evChargingPattern: { status: "known", value: "evening", source: "customer_input" },
    heatPumpKwhPerYear: { status: "known", value: 0, source: "customer_input" },
    coolingKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
    hotWaterKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
    ...overrides,
  };
}

function loadContext(): {
  slotLabels: string[];
  hourlyTemperatureC: Map<string, number>;
  hourTimesInOrder: string[];
} {
  const envelope = horizontalEnvelope();
  const slots = mapProviderYearToQuarterSlots(envelope.hours.map((hour) => hour.t));
  const temperatures = new Map(
    envelope.hours.map((hour) => [hour.t, hour.t2m] as [string, number]),
  );
  const seen = new Set<string>();
  const hourTimesInOrder: string[] = [];
  for (const slot of slots) {
    if (seen.has(slot.providerObservedAtUtc)) continue;
    seen.add(slot.providerObservedAtUtc);
    hourTimesInOrder.push(slot.providerObservedAtUtc);
  }
  return {
    slotLabels: slots.map((slot) => slot.slotLabel),
    hourlyTemperatureC: new Map(
      hourTimesInOrder.map((time) => [time, temperatures.get(time)!]),
    ),
    hourTimesInOrder,
  };
}

describe("F4.1 v2 load sources from profile", () => {
  it("bindet belegte kWh als H0-Basis plus geformte Zusatzquellen (v1-Ports)", () => {
    const sources = buildLoadSourcesFromProfileV2(
      { consumption: consumption() },
      loadContext(),
    );
    expect(sources.map((source) => source.sourceKind)).toEqual(["basis", "ev"]);
    const basis = sources[0]!;
    expect(basis.sourceId).toBe("wmee-bdew-h0-dyn-basis.v1");
    expect(basis.sourceRevision).toBe("wmee-bdew-h0-dyn.v1");
    expect(neumaierSum(basis.slotEnergyKwh)).toBeCloseTo(4200, 6);
    const ev = sources[1]!;
    expect(ev.sourceId).toBe("wmee-ev-pattern.v1");
    expect(ev.sourceRevision).toBe("wmee-load-shapes.v1");
    expect(neumaierSum(ev.slotEnergyKwh)).toBeCloseTo(2400, 9);
    // Abend-Pattern: Nachtviertel tragen mehr als Mittagsviertel.
    const context = loadContext();
    const noonQ = ev.slotEnergyKwh[context.slotLabels.findIndex(
      (label) => label.startsWith("2020-01-06T12:"),
    )]!;
    const eveningQ = ev.slotEnergyKwh[context.slotLabels.findIndex(
      (label) => label.startsWith("2020-01-06T19:"),
    )]!;
    expect(eveningQ).toBeGreaterThan(noonQ * 10);
  });

  it("verweigert fehlende Basis und skippt Unbekanntes/Nullen", () => {
    expect(() => buildLoadSourcesFromProfileV2({
      consumption: consumption({
        householdKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
      }),
    }, loadContext())).toThrow();
    const sources = buildLoadSourcesFromProfileV2({
      consumption: consumption({
        evKmPerYear: { status: "unknown", value: null, source: "not_collected" },
        heatPumpKwhPerYear: { status: "known", value: 1500, source: "customer_input" },
      }),
    }, loadContext());
    expect(sources.map((source) => source.sourceKind)).toEqual(["basis", "heat_pump"]);
    const heat = sources[1]!;
    expect(heat.sourceId).toBe("wmee-degree-day-heat.v1");
    expect(heat.sourceRevision).toBe("wmee-degree-day.v1");
    expect(neumaierSum(heat.slotEnergyKwh)).toBeCloseTo(1500, 6);
  });

  it("weist Gewerbe-Lastprofile fail-closed ab (keine G0-Quelle), Wohnformen laufen H0", () => {
    expect(() => buildLoadSourcesFromProfileV2({
      consumption: consumption({
        loadProfile: { status: "known", value: "commercial_interval.v1", source: "customer_input" },
      }),
    }, loadContext())).toThrow();
    expect(() => buildLoadSourcesFromProfileV2({
      consumption: consumption({
        loadProfile: { status: "known", value: "gewerbe_phantasie.v9", source: "customer_input" },
      }),
    }, loadContext())).toThrow();
    for (const value of ["wmee_household_hourly.v1", "customer_monthly_hourly.v1", null]) {
      const sources = buildLoadSourcesFromProfileV2({
        consumption: consumption({
          evKmPerYear: { status: "unknown", value: null, source: "not_collected" },
          loadProfile: { status: value === null ? "unknown" : "known", value, source: "customer_input" },
        }),
      }, loadContext());
      expect(sources[0]!.sourceId).toBe("wmee-bdew-h0-dyn-basis.v1");
    }
  });

  it("verweigert EV-km ohne belegtes Ladepattern (kein erfundener Ladeplan)", () => {
    expect(() => buildLoadSourcesFromProfileV2({
      consumption: consumption({
        evChargingPattern: { status: "unknown", value: null, source: "not_collected" },
      }),
    }, loadContext())).toThrow();
    expect(() => buildLoadSourcesFromProfileV2({
      consumption: consumption({
        evChargingPattern: { status: "known", value: "night", source: "customer_input" },
      }),
    }, loadContext())).toThrow();
  });

  it("bindet Heizungs-Klimatisierung als eigene Heizgrad-Quelle (v1-gleich)", () => {
    const sources = buildLoadSourcesFromProfileV2({
      consumption: consumption({
        evKmPerYear: { status: "unknown", value: null, source: "not_collected" },
        heatPumpKwhPerYear: { status: "known", value: 1500, source: "customer_input" },
        heatingAcKwhPerYear: { status: "known", value: 800, source: "customer_input" },
      }),
    }, loadContext());
    expect(sources.map((source) => source.sourceKind)).toEqual(
      ["basis", "heat_pump", "heat_pump"],
    );
    expect(sources.map((source) => source.sourceId)).toEqual([
      "wmee-bdew-h0-dyn-basis.v1",
      "wmee-degree-day-heat.v1",
      "wmee-degree-day-heating-ac.v1",
    ]);
    expect(neumaierSum(sources[1]!.slotEnergyKwh)).toBeCloseTo(1500, 6);
    expect(neumaierSum(sources[2]!.slotEnergyKwh)).toBeCloseTo(800, 6);
  });

  it("formt Kuehlung nach Kuehlgradstunden und Warmwasser nach Tagesgang", () => {
    const sources = buildLoadSourcesFromProfileV2({
      consumption: consumption({
        evKmPerYear: { status: "unknown", value: null, source: "not_collected" },
        coolingKwhPerYear: { status: "known", value: 500, source: "customer_input" },
        hotWaterKwhPerYear: { status: "known", value: 1000, source: "customer_input" },
      }),
    }, loadContext());
    expect(sources.map((source) => source.sourceKind)).toEqual(
      ["basis", "cooling", "hot_water"],
    );
    const cooling = sources[1]!;
    expect(cooling.sourceId).toBe("wmee-cooling-degree.v1");
    expect(neumaierSum(cooling.slotEnergyKwh)).toBeCloseTo(500, 6);
    const hotWater = sources[2]!;
    expect(hotWater.sourceId).toBe("wmee-hot-water-profile.v1");
    expect(neumaierSum(hotWater.slotEnergyKwh)).toBeCloseTo(1000, 6);
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
    // Neuanlage: keine Bestands-Reihe.
    expect(composed.existingPvKwh).toBeNull();
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

  it("rechnet Bestand als degradierte Neuanlagen-Form und weist unbelegte Anlage ab", async () => {
    const envelope = tiltedEnvelope();
    const newRequest = request();
    const fresh = await fetchPlanningSeriesV2({
      request: newRequest,
      transport: fakeTransport(envelope),
    });
    // Ein Dach (52 m2 x 0,2 kWp/m2 = 10,4 kWp), Anlage 5,2 kWp aus 2020,
    // Stichtag 2026 -> (1-0,005)^6.
    const composed = await fetchPlanningSeriesV2({
      request: request({
        branch: "existing_installation",
        asOfDate: "2026-08-29",
        existingPv: {
          status: "known_present",
          peakPowerKwp: 5.2,
          commissioningYear: 2020,
        },
      }),
      transport: fakeTransport(envelope),
    });
    expect(composed.existingPvKwh).toHaveLength(QUARTER_HOUR_SLOTS);
    const expectedRatio = 5.2 * 0.995 ** 6 / 10.4;
    expect(neumaierSum(composed.existingPvKwh!)).toBeCloseTo(
      neumaierSum(fresh.pvKwh) * expectedRatio,
      6,
    );
    // Gleiche Form wie neu (Slot-proportional, v1-Kapazitaetssplit).
    for (const slot of [0, 1000, 10_000, 35_039]) {
      const freshValue = fresh.pvKwh[slot]!;
      if (freshValue > 0) {
        expect(composed.existingPvKwh![slot]! / freshValue).toBeCloseTo(expectedRatio, 9);
      } else {
        expect(composed.existingPvKwh![slot]!).toBe(0);
      }
    }
    // Unbelegte Anlage im Bestand -> fail-closed (v1 verlangt known_present).
    for (const existingPv of [
      { status: "unknown" },
      { status: "known_absent" },
      { status: "known_present", peakPowerKwp: 5.2, commissioningYear: 1800 },
    ]) {
      await expect(fetchPlanningSeriesV2({
        request: request({ branch: "existing_installation", existingPv }),
        transport: fakeTransport(envelope),
      })).rejects.toThrow();
    }
  });
});
