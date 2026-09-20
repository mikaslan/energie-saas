import { describe, expect, it } from "vitest";

import {
  SITE_ENERGY_PROFILE_SCHEMA_VERSION,
  siteEnergyProfileV1Schema,
} from "@/lib/integrations/calculation/contract";
import { PLANNING_ASSUMPTIONS_V2 } from "@/lib/integrations/calculation/planning-assumptions-v2";

// F4-03c RED-Spec (docs/spec/F4-03c-ev-datenbank.md): kuratierte EV-DB
// (Modell -> kWh/km, lizenzierter Extrakt, Quellen-Pflicht, Segment-Fallback).
// NUR existierende Imports; die fehlenden Features lassen diese Tests ROT
// laufen (Beleg in der Spec). Pin-Test (0.2-Fallback) sichert heutiges
// Verhalten ab.

const unknownField = () => ({
  status: "unknown" as const,
  value: null,
  source: "not_collected" as const,
});

const knownField = (value: unknown) => ({
  status: "known" as const,
  value,
  source: "customer_input" as const,
});

function databaseProfile(): Record<string, unknown> {
  return {
    schemaVersion: SITE_ENERGY_PROFILE_SCHEMA_VERSION,
    inputMode: "consumption",
    building: {
      type: unknownField(),
      year: unknownField(),
      heatedAreaM2: unknownField(),
    },
    roofs: [
      {
        id: "dach-sued",
        areaM2: 52,
        azimuthDeg: 5,
        tiltDeg: 35,
        type: "pitched",
        shading: unknownField(),
        source: "default",
      },
    ],
    consumption: {
      householdKwhPerYear: unknownField(),
      electricityPriceCentsPerKwh: unknownField(),
      annualPriceIncreasePercent: unknownField(),
      loadProfile: unknownField(),
      evKmPerYear: knownField(15_000),
      evChargingPattern: knownField("evening"),
      evDatabaseEntryId: knownField("PLATZHALTER-DB-001"),
      heatPumpKwhPerYear: unknownField(),
      coolingKwhPerYear: unknownField(),
      heatingAcKwhPerYear: unknownField(),
      hotWaterKwhPerYear: unknownField(),
    },
    existingAssets: {
      pv: { status: "known_absent", source: "rechner_branch" },
      storage: { status: "unknown", source: "not_collected" },
      wallbox: { status: "unknown", source: "not_collected" },
      ev: { status: "known", value: true, source: "rechner_input" },
    },
    provenance: {
      source: "rechner_snapshot",
      sourceSchemaVersion: "wmee-solar-snapshot.v1",
      sourceEngine: "wmee-solar.v1",
      roof: "default",
      consumption: "default",
      electricityPrice: "default",
      annualPriceIncrease: "default",
    },
  };
}

// SKIP-Grund: F4-03c ist SPECIFIED, nicht implementiert (5/6 Tests ROT,
// Beleg in docs/spec/F4-03c-ev-datenbank.md „ROT-Beleg"). Das Follow-up,
// das DB-Import + Resolver + Lizenz-Gate baut, entfernt dieses .skip wieder.
describe.skip("F4-03c kuratierte EV-Datenbank (RED)", () => {
  it("akzeptiert evDatabaseEntryId als consumption-Referenz (Schema-Validierung)", () => {
    const parsed = siteEnergyProfileV1Schema.safeParse(databaseProfile());
    expect(parsed.success).toBe(true);
  });

  it("pinnt die DB-Version in den Planungsannahmen", () => {
    const load = PLANNING_ASSUMPTIONS_V2.load as unknown as Record<string, unknown>;
    expect(load.evDatabaseVersion).toBe("wmee-ev-database.v1");
  });

  it("verlangt eine belegte Quelle je DB-Eintrag (wltp/adac/hersteller)", async () => {
    const mod = (await import(
      "@/lib/integrations/calculation/contract"
    )) as unknown as Record<string, unknown>;
    expect(mod.EV_DATABASE_SOURCE_KINDS).toEqual(["wltp", "adac", "hersteller"]);
  });

  it("gatet den DB-Import auf lizenzierte Extrakte (kein Scraping)", async () => {
    const mod = (await import(
      "@/lib/integrations/calculation/fetch-compose-v2"
    )) as unknown as Record<string, unknown>;
    expect(mod.EV_DATABASE_LICENSED_EXTRACT_ONLY).toBe(true);
  });

  it("löst Modell->Verbrauch mit Segment-Fallback auf", async () => {
    const mod = (await import(
      "@/lib/integrations/calculation/load-shapes-v2"
    )) as unknown as Record<string, unknown>;
    expect(typeof mod.resolveEvKwhPerKm).toBe("function");
  });
});

// F4-03c Status-quo-Pin (GRÜN, läuft immer): 03b-Segmentfaktoren bleiben
// der Default, bis ein lizenzierter DB-Eintrag belegt ist.
describe("F4-03c Status-quo-Pin (0.2-Fallback)", () => {
  it("behält den pauschalen Default 0.2 als Fallback", () => {
    expect(PLANNING_ASSUMPTIONS_V2.load.evKwhPerKm).toBe(0.2);
  });
});
