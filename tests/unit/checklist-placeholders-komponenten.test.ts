import { describe, expect, it } from "vitest";

import { substituteChecklistPlaceholders } from "@/lib/integrations/checklists/contract";
import {
  formatWorkbookComponentsText,
  type WorkbookSection,
} from "@/modules/installations/workbook-service";

/**
 * F7-03E {{komponenten}} (Workbook-Stückliste): Der Format-Helper flacht
 * die Workbook-Projektion zu „Menge Name, …" ab; die Anzeige-Substitution
 * ersetzt das Muster nur bei gesetzter, nicht-leerer Stückliste.
 */

function line(
  position: number,
  name: string,
  quantity: string,
  unit = "Stück",
): WorkbookSection["lines"][number] {
  return {
    position,
    lineDomainId: `00000000-0000-0000-0000-00000000000${position}`,
    name,
    quantity,
    unit,
    grossCents: 100 * position,
    datasheet: null,
  };
}

function section(
  position: number,
  title: string,
  lines: WorkbookSection["lines"],
): WorkbookSection {
  return { position, category: "pv", title, quantityLabel: null, lines };
}

describe("F7-03E Komponenten-Stückliste", () => {
  it("F703E-U-01: Format Menge+Name in Sektions-/Zeilen-Reihenfolge", () => {
    const sections = [
      section(1, "Module", [line(1, "PV-Modul X", "8 Stück")]),
      section(2, "Wechselrichter", [
        line(1, "Wechselrichter Y", "1 Stück"),
        line(2, "Solarkabel", "12,5 m", "meter"),
      ]),
    ];
    expect(formatWorkbookComponentsText(sections)).toBe(
      "8 Stück PV-Modul X, 1 Stück Wechselrichter Y, 12,5 m Solarkabel",
    );
  });

  it("F703E-U-02: Einheiten bleiben formatiert (Stück, Meter-Dezimal)", () => {
    const sections = [
      section(1, "Kabel", [
        line(1, "DC-Kabel 6mm²", "12,5 m", "meter"),
        line(2, "Stecker-Set", "2 Stück"),
      ]),
    ];
    expect(formatWorkbookComponentsText(sections)).toBe(
      "12,5 m DC-Kabel 6mm², 2 Stück Stecker-Set",
    );
  });

  it("F703E-U-03: Leere Sektionen ergeben leeren Text", () => {
    expect(formatWorkbookComponentsText([])).toBe("");
    expect(formatWorkbookComponentsText([section(1, "Leer", [])])).toBe("");
  });

  it("F703E-U-04: Substitution bei gesetzter Stückliste (mehrfach, Case, Whitespace)", () => {
    const values = {
      customerName: "Familie Berger",
      today: "17.09.2026",
      componentsText: "8 Stück PV-Modul X, 1 Stück Wechselrichter Y",
    };
    expect(substituteChecklistPlaceholders("Montage {{komponenten}}", values))
      .toBe("Montage 8 Stück PV-Modul X, 1 Stück Wechselrichter Y");
    expect(substituteChecklistPlaceholders("{{komponenten}} / {{ KOMPONENTEN }}", values))
      .toBe(
        "8 Stück PV-Modul X, 1 Stück Wechselrichter Y / 8 Stück PV-Modul X, 1 Stück Wechselrichter Y",
      );
    expect(substituteChecklistPlaceholders("{{ Komponenten }} für {{kunde}}", values))
      .toBe("8 Stück PV-Modul X, 1 Stück Wechselrichter Y für Familie Berger");
  });

  it("F703E-U-05: Fehlende oder leere Stückliste lässt das Muster stehen", () => {
    expect(substituteChecklistPlaceholders("Montage {{komponenten}}", {
      customerName: "Familie Berger",
      today: "17.09.2026",
    })).toBe("Montage {{komponenten}}");
    expect(substituteChecklistPlaceholders("Montage {{komponenten}}", {
      customerName: "Familie Berger",
      today: "17.09.2026",
      componentsText: "",
    })).toBe("Montage {{komponenten}}");
  });

  it("F703E-U-06: Unbekannte Muster bleiben stehen (Regression)", () => {
    const values = {
      customerName: "Familie Berger",
      today: "17.09.2026",
      componentsText: "8 Stück PV-Modul X",
    };
    expect(substituteChecklistPlaceholders("{{notar}} bestätigt {{komponenten}}", values))
      .toBe("{{notar}} bestätigt 8 Stück PV-Modul X");
    expect(substituteChecklistPlaceholders("{{komponente}} vs {{komponenten}}", values))
      .toBe("{{komponente}} vs 8 Stück PV-Modul X");
  });

  it("F703E-U-07: Leereingabe und Text ohne Muster bleiben stabil", () => {
    const values = {
      customerName: "Familie Berger",
      today: "17.09.2026",
      componentsText: "8 Stück PV-Modul X",
    };
    expect(substituteChecklistPlaceholders("", values)).toBe("");
    expect(substituteChecklistPlaceholders("Dach geprüft", values)).toBe("Dach geprüft");
    expect(substituteChecklistPlaceholders("{{komponenten} offen", values))
      .toBe("{{komponenten} offen");
  });
});
