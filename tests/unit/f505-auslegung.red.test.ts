import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { HEAT_PUMP_BIVALENCE_TEMP_C_DEFAULT } from "@/lib/integrations/calculation/heat-pump-cop-v2";
import { estimateHeatingLoadV1 } from "@/lib/integrations/heat-pump/sizing-estimate-v1";

// F5-05 RED-Spec (docs/spec/F5-05-vdi-auslegung.md): VDI-4645-Auslegung
// (F5.4a), Bivalenzpunkt als ERGEBNIS, Heizstab-Dimensionierung. NUR
// existierende Imports; der fehlende Builder lässt die RED-Tests ROT
// laufen (Beleg in der Spec). Pin-Tests sichern Fixtures + Defaults ab.

const F5_FIXTURE_SHA256 = {
  "bivalenz-default.json": "177dc964538276882bb0aa593803e7aa0ac558a5461f16ac61fbb20e108269a3",
  "vdi-input-pins.json": "43e71c43bba550f1a6e696f88c93aed5b0d04435219c490ceb474d57b67c6e2c",
} as const;

type F5FixtureName = keyof typeof F5_FIXTURE_SHA256;

interface FixtureValueEntry {
  value: unknown;
  unit: string;
  source: string;
  tolerance: number | null;
  status: string;
  note?: string;
}

interface F5Fixture {
  fixture: string;
  version: string;
  versionSource: string;
  releaseStatus: string;
  values: Record<string, FixtureValueEntry>;
}

function fixturePath(name: string): string {
  return path.resolve(process.cwd(), "tests/fixtures/f5", name);
}

function readF5Fixture(name: F5FixtureName): { raw: string; json: F5Fixture } {
  const raw = readFileSync(fixturePath(name), "utf8");
  return { raw, json: JSON.parse(raw) as F5Fixture };
}

type VdiBuilder = (input: Record<string, unknown>) => Record<string, unknown>;

async function loadVdiBuilder(): Promise<VdiBuilder> {
  // @ts-expect-error RED: Modul existiert erst mit dem Bau-Slice (F5-05 §1).
  const vdiModule = await import("@/lib/integrations/heat-pump/sizing-vdi4645-v1");
  return vdiModule.sizeHeatPumpVdi4645V1 as VdiBuilder;
}

const VDI_INPUT: Record<string, unknown> = {
  heatingLoadKw: 10,
  operatingMode: "monoenergetisch",
  coverageShareThesis: 0.95,
};

// SKIP-Grund: RED-Test zur Spec F5-05 (docs/spec/F5-05-vdi-auslegung.md).
// Der VDI-4645-Builder ist SPECIFIED, nicht gebaut (ROT-Beleg: 3 failed |
// 2 passed am 2026-09-20). Entskippen, sobald der Bau-Slice
// sizeHeatPumpVdi4645V1 nach §1 implementiert (dann dynamischen Import
// durch statischen ersetzen). Fixtures + §5-Pins bleiben aktiv.
describe.skip("F5-05 VDI-4645-Auslegung (RED)", () => {
  it("stellt den Auslegungs-Builder sizeHeatPumpVdi4645V1 bereit", async () => {
    const size = await loadVdiBuilder();
    expect(typeof size).toBe("function");
  });

  it("liefert den Bivalenzpunkt als ERGEBNIS (kein Eingabefeld)", async () => {
    const size = await loadVdiBuilder();
    expect("bivalenceTempC" in VDI_INPUT).toBe(false);
    const result = size({ ...VDI_INPUT });
    expect(result.version).toBe("wmee-hp-sizing-vdi4645.v1");
    expect(typeof result.bivalenceTempC).toBe("number");
    const bivalence = result.bivalenceTempC as number;
    expect(Number.isFinite(bivalence)).toBe(true);
    expect(bivalence).toBeGreaterThanOrEqual(-25);
    expect(bivalence).toBeLessThanOrEqual(15);
  });

  it("dimensioniert den Heizstab für die Restlast (monoenergetisch)", async () => {
    const size = await loadVdiBuilder();
    const result = size({ ...VDI_INPUT });
    expect(typeof result.backupHeaterKw).toBe("number");
    expect(typeof result.heatPumpNominalKw).toBe("number");
    const backup = result.backupHeaterKw as number;
    const nominal = result.heatPumpNominalKw as number;
    expect(Number.isFinite(backup)).toBe(true);
    expect(backup).toBeGreaterThanOrEqual(0);
    expect(nominal + backup).toBeGreaterThanOrEqual(VDI_INPUT.heatingLoadKw as number);
  });
});

// F5-05 Rechenfixtures (§5-Pins, GRÜN, laufen immer): Schema
// (Quelle/Einheit/Toleranz/Status je Wert) + SHA-Pins gegen stille Wechsel.
describe("F5-05 Rechenfixtures (§5-Pins)", () => {
  it("tragen Quelle/Einheit/Toleranz/Status je Wert", () => {
    const names = Object.keys(F5_FIXTURE_SHA256) as F5FixtureName[];
    for (const name of names) {
      const { json } = readF5Fixture(name);
      expect(typeof json.version).toBe("string");
      expect(typeof json.versionSource).toBe("string");
      expect(typeof json.releaseStatus).toBe("string");
      for (const [key, entry] of Object.entries(json.values)) {
        const where = `${name}.${key}`;
        expect(typeof entry.unit, `${where}.unit`).toBe("string");
        expect(typeof entry.source, `${where}.source`).toBe("string");
        expect(
          entry.tolerance === null || typeof entry.tolerance === "number",
          `${where}.tolerance`,
        ).toBe(true);
        expect(typeof entry.status, `${where}.status`).toBe("string");
      }
    }
    const bivalence = readF5Fixture("bivalenz-default.json").json;
    const bivalenceEntry = bivalence.values.bivalenceTempC!;
    expect(bivalenceEntry.value).toBe(-6);
    expect(bivalenceEntry.unit).toBe("°C");
    expect(bivalenceEntry.source).toContain("F5.4");
    expect(bivalenceEntry.status).toBe("ESTIMATE");
    expect(bivalenceEntry.value).toBe(HEAT_PUMP_BIVALENCE_TEMP_C_DEFAULT);
    const pins = readF5Fixture("vdi-input-pins.json").json;
    expect(pins.values.heatingLoadKw!.unit).toBe("kW");
    expect(pins.values.heatingLoadKw!.value).toBe(
      estimateHeatingLoadV1({ annualThermalKwh: 20000, buildingClass: "bestand" })
        .heatingLoadKw,
    );
    expect(pins.values.operatingMode!.value).toBe("monoenergetisch");
    expect(pins.values.coverageShareThesis!.status).toBe("THESE");
  });

  it("sind per SHA-256 gepinnt (kein stiller Wechsel)", () => {
    for (const [name, sha] of Object.entries(F5_FIXTURE_SHA256)) {
      const raw = readFileSync(fixturePath(name), "utf8");
      expect(createHash("sha256").update(raw, "utf8").digest("hex")).toBe(sha);
    }
  });
});
