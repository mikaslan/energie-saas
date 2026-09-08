import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildRoofSeriescalcUrl } from "@/lib/integrations/calculation/provider-v2";

// F4.1 geneigte PVGIS-Fixtures (Berlin/Madrid/Stockholm, 30°/Sued, echte
// Horizonte): Integritaet + Builder-Konsistenz. Die URLs in der Provenienz
// wurden mit buildRoofSeriescalcUrl erzeugt; der Test schliesst die Kette
// Builder <-> gespeicherte Evidenz.

const SITES = ["berlin", "madrid", "stockholm"] as const;

type TiltedFixture = {
  site: { latitude: number; longitude: number };
  roof: {
    tiltDeg: number;
    aspectDeg: number;
    pvTechnology: string;
    mountingPlace: string;
    systemLossPercent: number;
    peakPowerKwp: number;
  };
  horizon: { source: string; dem: string; heights48: number[] };
  provenance: {
    tool: string;
    url: string;
    fetchedAtUtc: string;
    rawSha256: string;
    rawBytes: number;
    radiationDb: string;
    elevation: number;
  };
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
};

function loadFixture(site: (typeof SITES)[number]): TiltedFixture {
  const file = path.resolve(
    process.cwd(),
    `tests/fixtures/f401/pvgis-tilted30-south-2020-${site}.json`,
  );
  return JSON.parse(readFileSync(file, "utf8")) as TiltedFixture;
}

describe("F4.1 tilted fixtures", () => {
  for (const site of SITES) {
    it(`${site}: 8784 geordnete Stunden mit P-Spalte und Provenienz`, () => {
      const fixture = loadFixture(site);
      expect(fixture.hours).toHaveLength(8_784);
      for (let index = 1; index < fixture.hours.length; index += 1) {
        expect(fixture.hours[index]!.t > fixture.hours[index - 1]!.t).toBe(true);
      }
      expect(
        fixture.hours.every((hour) =>
          Number.isFinite(hour.p) && hour.p >= 0
          && Number.isFinite(hour.gb) && Number.isFinite(hour.gd)
          && Number.isFinite(hour.gr) && (hour.int === 0 || hour.int === 1)
        ),
      ).toBe(true);
      expect(fixture.hours.some((hour) => hour.p > 100)).toBe(true);
      expect(fixture.roof).toMatchObject({
        tiltDeg: 30,
        aspectDeg: 0,
        pvTechnology: "crystSi",
        systemLossPercent: 14,
      });
      expect(fixture.horizon.heights48).toHaveLength(48);
      expect(fixture.provenance.tool).toBe("seriescalc");
      expect(fixture.provenance.rawSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(fixture.provenance.rawBytes).toBeGreaterThan(1_000_000);
      expect(fixture.provenance.radiationDb).toBe("PVGIS-SARAH3");
    });

    it(`${site}: Provenienz-URL ist exakt aus dem Builder reproduzierbar`, () => {
      const fixture = loadFixture(site);
      const rebuilt = buildRoofSeriescalcUrl({
        latitude: fixture.site.latitude,
        longitude: fixture.site.longitude,
        pvTechnology: fixture.roof.pvTechnology,
        mountingPlace: fixture.roof.mountingPlace,
        systemLossPercent: fixture.roof.systemLossPercent,
        providerTiltDeg: fixture.roof.tiltDeg,
        providerAspectDeg: fixture.roof.aspectDeg,
        canonicalHorizon: fixture.horizon.heights48,
      });
      expect(rebuilt).toBe(fixture.provenance.url);
    });
  }
});
