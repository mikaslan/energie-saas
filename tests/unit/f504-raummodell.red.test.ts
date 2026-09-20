import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import * as contract from "@/lib/integrations/calculation/contract";

// F5-04 RED-Spec (docs/spec/F5-04-raummodell.md): Raummodell für die
// Heizlast-Schätzung — Geschosse/Räume/Wände/Dach/Material. NUR
// existierende Imports; die fehlenden Exporte lassen diese Tests ROT
// laufen (Beleg in der Spec). SPEC-ONLY: keine Migration, keine
// Implementierung auf diesem Branch.

const roomModel = contract as unknown as Record<string, unknown>;

// SKIP-Grund: F5-04 ist SPECIFIED, nicht implementiert (5/5 Tests ROT,
// Beleg in docs/spec/F5-04-raummodell.md „ROT-Beleg"). Das Follow-up,
// das Modul + Exporte + Migration (nach Freigabe) baut, entfernt
// dieses .skip wieder.
describe.skip("F5-04 Raummodell (RED) — Spec: docs/spec/F5-04-raummodell.md", () => {
  it("exportiert die 5 Towards-Werte für den Wand-CHECK", () => {
    expect(roomModel.WALL_TOWARDS_VALUES).toEqual([
      "aussenluft",
      "beheizt",
      "unbeheizt",
      "fremdgebaeude",
      "erdreich",
    ]);
  });

  it("exportiert die Raumtyp-Map mit Solltemp/Luftwechsel (ESTIMATE)", () => {
    const defaults = roomModel.ROOM_TYPE_DEFAULTS_V1 as unknown as Record<
      string,
      { setpointC: number; airChangesPerHour: number }
    >;
    expect(defaults.wohnen).toEqual({ setpointC: 20, airChangesPerHour: 0.5 });
    expect(defaults.bad).toEqual({ setpointC: 24, airChangesPerHour: 0.5 });
    expect(Object.keys(defaults).sort()).toEqual([
      "abstellraum",
      "bad",
      "buero",
      "flur",
      "kellerraum",
      "kueche",
      "schlafen",
      "sonstig",
      "wc",
      "wohnen",
    ]);
  });

  it("stellt das Raummodell-Modul mit Snapshot-Semantik bereit", () => {
    const modulePath = path.resolve(
      process.cwd(),
      "lib/integrations/calculation/room-model-v1.ts",
    );
    expect(existsSync(modulePath)).toBe(true);
  });

  it("pinnt den versionierten TABULA-DE-Seed per SHA-256", () => {
    expect(roomModel.ROOM_MODEL_TABULA_SEED_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exportiert die Gauben-Validierung (Summe/Überlappung/Pflicht)", () => {
    expect(typeof roomModel.validateDormersV1).toBe("function");
  });
});
