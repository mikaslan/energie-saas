import { describe, expect, it } from "vitest";

import { substituteChecklistPlaceholders } from "@/lib/integrations/checklists/contract";

/**
 * F7-03C Platzhalter (Anzeige-Substitution): {{kunde}}/{{datum}} werden
 * beim Anzeigen ersetzt; Rohtext bleibt gespeichert. Unbekannte Muster
 * bleiben unangetastet.
 */

const VALUES = { customerName: "Familie Berger", today: "17.09.2026" };

describe("F7-03C Platzhalter", () => {
  it("F703C-U-01: Kunde und Datum werden ersetzt (mehrfach, Whitespace-tolerant)", () => {
    expect(substituteChecklistPlaceholders("Abnahme {{kunde}} am {{datum}}", VALUES))
      .toBe("Abnahme Familie Berger am 17.09.2026");
    expect(substituteChecklistPlaceholders("{{kunde}} / {{ kunde }} / {{kunde}}", VALUES))
      .toBe("Familie Berger / Familie Berger / Familie Berger");
    expect(substituteChecklistPlaceholders("{{ DATUM }}", VALUES)).toBe("17.09.2026");
    expect(substituteChecklistPlaceholders("{{KUNDE}} x {{ Kunde }}", VALUES))
      .toBe("Familie Berger x Familie Berger");
  });

  it("F703C-U-02: Ohne Muster, leer und ungerade Klammern bleiben stabil", () => {
    expect(substituteChecklistPlaceholders("Dach geprüft", VALUES)).toBe("Dach geprüft");
    expect(substituteChecklistPlaceholders("", VALUES)).toBe("");
    expect(substituteChecklistPlaceholders("{{kunde} und {{datum", VALUES))
      .toBe("{{kunde} und {{datum");
  });

  it("F703C-U-03: Unbekannte Muster (inkl. Komponenten) bleiben stehen", () => {
    expect(substituteChecklistPlaceholders("Montage {{komponenten}}", VALUES))
      .toBe("Montage {{komponenten}}");
    expect(substituteChecklistPlaceholders("{{notar}} bestätigt {{kunde}}", VALUES))
      .toBe("{{notar}} bestätigt Familie Berger");
  });

  it("F703C-U-04: Leerer Kundenname ersetzt nicht (kein Phantom-Text)", () => {
    expect(substituteChecklistPlaceholders("Abnahme {{kunde}}", { customerName: "", today: "17.09.2026" }))
      .toBe("Abnahme {{kunde}}");
  });
});
