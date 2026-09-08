import { describe, expect, it } from "vitest";

import {
  buildHorizontalSeriescalcUrl,
  buildRoofPVcalcUrl,
  buildRoofSeriescalcUrl,
  canonicalDecimal,
  F401ProviderError,
  F401SizeError,
  parseSeriescalcSnapshot,
  providerAspectDeg,
  PROVIDER_RECIPE_VERSION,
  serializeCanonicalHorizon,
} from "@/lib/integrations/calculation/provider-v2";

// F4.1 v2-Providervertrag: kanonische Queries, Aspect-Boundary und
// seriescalc-Parser (Spec F4-01 "Providerabrufe").

function syntheticRaw(options: {
  tilted?: boolean;
  rows?: number;
  mutate?: (doc: {
    inputs: Record<string, unknown>;
    outputs: { hourly: Array<Record<string, unknown>> };
  }) => void;
} = {}): string {
  const rows = options.rows ?? 8_784;
  const hourly: Array<Record<string, unknown>> = [];
  const start = Date.UTC(2020, 0, 1, 0, 11);
  for (let index = 0; index < rows; index += 1) {
    const date = new Date(start + index * 3_600_000);
    const pad = (value: number): string => String(value).padStart(2, "0");
    hourly.push({
      time: `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}:${pad(date.getUTCHours())}11`,
      "Gb(i)": index % 24 < 12 ? 0 : 100 + index % 7,
      "Gd(i)": 50,
      "Gr(i)": 0,
      H_sun: index % 24 < 12 ? 0 : 20,
      T2m: 10,
      WS10m: 3,
      Int: 0,
      ...(options.tilted === true ? { P: 120 + index % 5 } : {}),
    });
  }
  const doc = {
    inputs: {
      location: { latitude: 52.52, longitude: 13.41, elevation: 47 },
      meteo_data: {
        radiation_db: "PVGIS-SARAH3",
        meteo_db: "ERA5",
        year_min: 2020,
        year_max: 2020,
        use_horizon: false,
        horizon_db: null,
      },
    },
    outputs: { hourly },
  };
  options.mutate?.(doc);
  return JSON.stringify(doc);
}

const HORIZON_48 = Array.from({ length: 48 }, (_, index) => index * 0.1);

describe("F4.1 v2 provider queries", () => {
  it("baut den horizontalen seriescalc exakt wie die gepinnte Fixture-URL", () => {
    expect(buildHorizontalSeriescalcUrl({ latitude: 52.52, longitude: 13.41 })).toBe(
      "https://re.jrc.ec.europa.eu/api/v5_3/seriescalc"
      + "?lat=52.52&lon=13.41&raddatabase=PVGIS-SARAH3"
      + "&startyear=2020&endyear=2020&pvcalculation=0&trackingtype=0"
      + "&angle=0&aspect=0&optimalinclination=0&optimalangles=0"
      + "&components=1&usehorizon=0&outputformat=json&browser=0",
    );
    expect(PROVIDER_RECIPE_VERSION).toBe("pvgis-5.3-sarah3-2020-quarter-hour.v2");
  });

  it("baut Dach-Queries mit gleichem Geo-/Tech-/Verlust-/Horizontvertrag", () => {
    const roof = {
      latitude: 52.52,
      longitude: 13.41,
      pvTechnology: "crystSi",
      mountingPlace: "building",
      systemLossPercent: 14,
      providerTiltDeg: 30,
      providerAspectDeg: 180,
      canonicalHorizon: HORIZON_48,
    };
    const series = buildRoofSeriescalcUrl(roof);
    expect(series).toContain("pvcalculation=1");
    expect(series).toContain("peakpower=1");
    expect(series).toContain("pvtechchoice=crystSi");
    expect(series).toContain("angle=30&aspect=-179");
    expect(series).toContain(`userhorizon=${HORIZON_48.join(",")}`);
    const pvcalc = buildRoofPVcalcUrl(roof);
    expect(pvcalc).toContain("/api/v5_3/PVcalc?");
    expect(pvcalc).toContain("usehorizon=1");
    expect(pvcalc).not.toContain("startyear");
  });

  it("spiegelt ±180 auf -179 und normiert den Kreis", () => {
    expect(providerAspectDeg(180)).toBe(-179);
    expect(providerAspectDeg(-180)).toBe(-179);
    expect(providerAspectDeg(540)).toBe(-179);
    expect(providerAspectDeg(0)).toBe(0);
    expect(providerAspectDeg(190)).toBe(-170);
    expect(providerAspectDeg(-190)).toBe(170);
    expect(providerAspectDeg(45.5)).toBeCloseTo(45.5, 12);
  });

  it("serialisiert kanonische Dezimalzahlen ohne Exponent und -0 als 0", () => {
    expect(canonicalDecimal(-0)).toBe("0");
    expect(canonicalDecimal(52.52)).toBe("52.52");
    expect(canonicalDecimal(14)).toBe("14");
    expect(() => canonicalDecimal(Number.NaN)).toThrow(F401ProviderError);
    expect(serializeCanonicalHorizon(HORIZON_48).split(",")).toHaveLength(48);
    expect(() => serializeCanonicalHorizon(HORIZON_48.slice(0, 47))).toThrow(
      F401ProviderError,
    );
    expect(() => serializeCanonicalHorizon([...HORIZON_48.slice(0, 47), 91])).toThrow(
      F401ProviderError,
    );
  });
});

describe("F4.1 v2 seriescalc parser", () => {
  it("parst horizontale Snapshots mit Spiegel, Ordnung und Gr==0-Gate", () => {
    const snapshot = parseSeriescalcSnapshot(syntheticRaw(), { tilted: false });
    expect(snapshot.recipeVersion).toBe(PROVIDER_RECIPE_VERSION);
    expect(snapshot.rawSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.hours).toHaveLength(8_784);
    expect(snapshot.site).toMatchObject({ latitude: 52.52, elevation: 47 });
    expect(snapshot.hours[0]).toMatchObject({ time: "20200101:0011", int: 0, p: null });
    expect(snapshot.hours.every((hour) => hour.gr === 0)).toBe(true);
  });

  it("akzeptiert Int=1 (ganzzahlig) fuer die Warnungsbindung", () => {
    const snapshot = parseSeriescalcSnapshot(syntheticRaw({
      mutate: (doc) => {
        doc.outputs.hourly[10]!.Int = 1;
        doc.outputs.hourly[11]!.Int = 1.0;
      },
    }), { tilted: false });
    expect(snapshot.hours[10]!.int).toBe(1);
    expect(snapshot.hours[11]!.int).toBe(1);
  });

  it("verlangt geneigt P und akzeptiert ganzzahlige Int-Floats", () => {
    const snapshot = parseSeriescalcSnapshot(syntheticRaw({ tilted: true }), {
      tilted: true,
    });
    expect(snapshot.hours[100]!.p).toBeGreaterThan(0);
    expect(() => parseSeriescalcSnapshot(syntheticRaw({ tilted: true }), {
      tilted: false,
    })).toThrow(F401ProviderError);
    expect(() => parseSeriescalcSnapshot(syntheticRaw(), { tilted: true })).toThrow(
      F401ProviderError,
    );
  });

  it("bricht fail-closed bei Struktur-, Rezept- und Achsfehlern ab", () => {
    expect(() => parseSeriescalcSnapshot("kein json", { tilted: false })).toThrow(
      F401ProviderError,
    );
    expect(() => parseSeriescalcSnapshot("x".repeat(2 * 1024 * 1024 + 1), {
      tilted: false,
    })).toThrow(F401SizeError);
    expect(() => parseSeriescalcSnapshot(syntheticRaw({ rows: 8_783 }), {
      tilted: false,
    })).toThrow(F401ProviderError);
    expect(() => parseSeriescalcSnapshot(syntheticRaw({
      mutate: (doc) => {
        doc.inputs.meteo_data = {
          ...(doc.inputs.meteo_data as Record<string, unknown>),
          radiation_db: "PVGIS-SARAH2",
        };
      },
    }), { tilted: false })).toThrow(F401ProviderError);
    expect(() => parseSeriescalcSnapshot(syntheticRaw({
      mutate: (doc) => {
        doc.outputs.hourly[5]!.time = doc.outputs.hourly[4]!.time as string;
      },
    }), { tilted: false })).toThrow(F401ProviderError);
    expect(() => parseSeriescalcSnapshot(syntheticRaw({
      mutate: (doc) => {
        doc.outputs.hourly[6]!["Gr(i)"] = 0.5;
      },
    }), { tilted: false })).toThrow(F401ProviderError);
    expect(() => parseSeriescalcSnapshot(syntheticRaw({
      mutate: (doc) => {
        doc.outputs.hourly[7]!.Int = 2;
      },
    }), { tilted: false })).toThrow(F401ProviderError);
    expect(() => parseSeriescalcSnapshot(syntheticRaw({
      mutate: (doc) => {
        delete doc.outputs.hourly[8]!.T2m;
      },
    }), { tilted: false })).toThrow(F401ProviderError);
  });
});
