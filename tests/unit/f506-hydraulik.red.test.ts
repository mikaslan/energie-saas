import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { energyRoomSchema } from "@/lib/integrations/calculation/contract";

// F5-06 RED-Spec (docs/spec/F5-06-hydraulischer-abgleich.md): Hydraulischer
// Abgleich Verfahren B (Katalog F5.5) — Ventileinstellwerte je Heizkörper,
// Volumenströme, Heizkörper-Ampel mit Tauschvorschlägen → BOM-Zeilen.
// NUR existierende Imports; das Verfahren-B-Modul fehlt, daher laufen die
// vier RED-Tests ROT (Beleg in der Spec). Der Pin-Test sichert die einzige
// heutige Heizkörper-Spur (F1-19 radiatorCount 0–50).

const HYDRAULIC_MODULE = path.resolve(
  process.cwd(),
  "lib/integrations/heat-pump/hydraulic-balancing-v1.ts",
);

function hydraulicSource(): string {
  return existsSync(HYDRAULIC_MODULE) ? readFileSync(HYDRAULIC_MODULE, "utf8") : "";
}

// SKIP-Grund: F5-06 ist SPECIFIED, nicht implementiert (4/4 Tests ROT,
// Beleg in docs/spec/F5-06-hydraulischer-abgleich.md „ROT-Beleg").
// Roadmap parkt F5.2–F5.5 bis Umsatz (docs/blaupause/05-roadmap.md);
// das Follow-up, das Verfahren B + Ampel + BOM-Kopplung baut,
// entfernt dieses .skip wieder.
describe.skip("F5-06 Hydraulischer Abgleich Verfahren B (RED)", () => {
  it("bietet einen Verfahren-B-Builder hydraulic-balancing-v1 an", () => {
    expect(existsSync(HYDRAULIC_MODULE)).toBe(true);
  });

  it("exportiert die Ampel-Regel classifyRadiatorCoverageV1 (versioniert)", () => {
    expect(hydraulicSource()).toContain("classifyRadiatorCoverageV1");
  });

  it("exportiert den BOM-Zeilen-Builder buildHydraulicBomLinesV1", () => {
    expect(hydraulicSource()).toContain("buildHydraulicBomLinesV1");
  });

  it("verweigert die Berechnung ohne Raumheizlast (Blocker-Gate fail-closed)", () => {
    expect(hydraulicSource()).toContain("assertHydraulicReadinessV1");
  });
});

// F5-06 Status-quo-Pin (GRÜN, läuft immer): sichert die F1-19-Spur bis
// zur Implementierung — Zählung ohne Typ/Maße/Leistung, keine Entity.
describe("F5-06 Status-quo-Pin (F1-19 radiatorCount)", () => {
  it("pinnt radiatorCount 0–50 als einzige Heizkörper-Spur (keine Entity)", () => {
    const room = { name: "Wohnen", areaM2: 20, usage: "living" };
    expect(energyRoomSchema.safeParse({ ...room, radiatorCount: 2 }).success).toBe(true);
    expect(energyRoomSchema.safeParse({ ...room, radiatorCount: 51 }).success).toBe(false);
    const shape = energyRoomSchema.shape;
    expect("radiatorCount" in shape).toBe(true);
    expect("radiators" in shape).toBe(false);
    expect("heating" in shape).toBe(false);
  });
});
