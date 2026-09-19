import { describe, expect, it } from "vitest";

import * as subsidyCase from "@/lib/subsidy-case";

// F13-13 RED-Spec (docs/spec/F13-13-foerder-fristen-preis.md): Preis-Snapshot,
// AT-Fristen, Überfällig-Badge, Typenschild-Foto-Slot. NUR existierende
// Imports; die fehlenden Features lassen diese Tests ROT laufen (Beleg in
// der Spec, §6). Aktivierung erst nach Implementierung.

const api = subsidyCase as unknown as Record<string, unknown>;

// SKIP-Grund: F13-13 ist SPECIFIED, nicht implementiert (4/4 Tests ROT,
// Beleg in docs/spec/F13-13-foerder-fristen-preis.md §6). Das Follow-up,
// das Preis-Snapshot + AT-Fristen + Typenschild-Slot baut, entfernt
// dieses .skip wieder.
describe.skip("F13-13 Förder-Fristen-Preis (RED)", () => {
  it("F1313-U-01: Preis-Snapshot an Akte? Default 210 €", () => {
    // Workspace-Stammdatum mit Default 210 € (§1) existiert noch nicht.
    expect(api.SUBSIDY_CASE_FEE_DEFAULT_CENTS).toBe(21_000);
  });

  it("F1313-U-02: Fälligkeitsdatum BzA+3AT?", () => {
    // AT-Rechnung Werktage Mo–Fr Berlin (§2) existiert noch nicht.
    expect(typeof api.addBusinessDaysBerlin).toBe("function");
  });

  it("F1313-U-03: Überfällig-Badge?", () => {
    // Überfällig-Prädikat ab Versand-Übergang (§2) existiert noch nicht.
    expect(typeof api.isSubsidyCaseOverdue).toBe("function");
  });

  it("F1313-U-04: Typenschild-Slot?", () => {
    // Typenschild-Foto-Slot ohne KI-Auswertung (§4) existiert noch nicht.
    expect(api.SUBSIDY_CASE_NAMEPLATE_SLOT).toBe("typenschild-foto");
  });
});
