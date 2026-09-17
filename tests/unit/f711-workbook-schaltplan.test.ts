import { describe, expect, it } from "vitest";

import { buildSingleLineSchematic } from "@/lib/integrations/schematic/single-line-v1";
import {
  deriveSectionQuantityLabel,
  toSchematicInputs,
  type WorkbookSection,
} from "@/modules/installations";

function line(
  position: number,
  name: string,
  quantity: string,
): WorkbookSection["lines"][number] {
  return {
    position,
    lineDomainId: `00000000-0000-0000-0000-00000000000${position}`,
    name,
    quantity,
    unit: "piece",
    grossCents: 100 * (position + 1),
    datasheet: null,
  };
}

function section(
  position: number,
  category: string,
  title: string,
  lines: WorkbookSection["lines"],
  quantityLabel: string | null = null,
): WorkbookSection {
  return { position, category, title, quantityLabel, lines };
}

describe("F7-11 Workbook-Schaltplan", () => {
  it("F711-U-01: Mapper bildet alle sieben Kategorien 1:1 ab (Titel + Mengenlabel)", () => {
    const categories = [
      "module",
      "inverter",
      "battery",
      "wallbox",
      "heat_pump",
      "mounting",
      "other",
    ];
    const sections = categories.map((category, index) =>
      section(index, category, `Titel ${category}`, [line(0, `Name ${category}`, "1 piece")], `${index + 1} piece`),
    );
    expect(toSchematicInputs(sections)).toEqual(
      categories.map((category, index) => ({
        category,
        title: `Titel ${category}`,
        quantityLabel: `${index + 1} piece`,
      })),
    );
    // Keine Preise, keine IDs, keine PII über Titel/Label hinaus.
    const encoded = JSON.stringify(toSchematicInputs(sections));
    expect(encoded).not.toContain("grossCents");
    expect(encoded).not.toContain("lineDomainId");
    expect(encoded).not.toContain("datasheet");
  });

  it("F711-U-02: unbekannte Kategorie faellt fail-closed auf other", () => {
    const sections = [
      section(0, "pv", "PV frei", [line(0, "Freitext", "1 piece")], "1 piece"),
      section(1, "Custom", "Eigenbau", [line(0, "Sonderteil", "2 piece")], "2 piece"),
      section(2, "", "Ohne Kategorie", [line(0, "Rest", "3 piece")], null),
    ];
    expect(toSchematicInputs(sections)).toEqual([
      { category: "other", title: "PV frei", quantityLabel: "1 piece" },
      { category: "other", title: "Eigenbau", quantityLabel: "2 piece" },
      { category: "other", title: "Ohne Kategorie", quantityLabel: null },
    ]);
  });

  it("F711-U-03: zeilenlose Sektionen fallen raus (Angebots-Praezedenz)", () => {
    const sections = [
      section(0, "module", "Module", [line(0, "PV-Modul X", "8 piece")], "8 piece"),
      section(1, "inverter", "Leer", []),
      section(2, "battery", "Auch leer", [], "9 piece"),
    ];
    expect(toSchematicInputs(sections)).toEqual([
      { category: "module", title: "Module", quantityLabel: "8 piece" },
    ]);
    expect(toSchematicInputs([])).toEqual([]);
  });

  it("F711-U-04: quantityLabel summiert genau eine Einheit, gemischt/leer ist null", () => {
    // Eine Einheit über sichtbare Zeilen → summiertes Label (Regel wie
    // Angebots-SchematicCard, Rohwerte in Milli, kein String-Parsing).
    expect(deriveSectionQuantityLabel([
      { quantityMilli: 8000, unit: "piece", isHidden: false },
      { quantityMilli: 18000, unit: "piece", isHidden: false },
    ])).toBe("26 piece");
    expect(deriveSectionQuantityLabel([
      { quantityMilli: 12500, unit: "meter", isHidden: false },
    ])).toBe("12,5 m");
    // Versteckte Zeilen zaehlen nicht (fremde Einheit vergiftet nichts).
    expect(deriveSectionQuantityLabel([
      { quantityMilli: 26000, unit: "piece", isHidden: false },
      { quantityMilli: 5000, unit: "meter", isHidden: true },
    ])).toBe("26 piece");
    // Gemischt, leer oder nur versteckt → null.
    expect(deriveSectionQuantityLabel([
      { quantityMilli: 1000, unit: "piece", isHidden: false },
      { quantityMilli: 2000, unit: "set", isHidden: false },
    ])).toBeNull();
    expect(deriveSectionQuantityLabel([])).toBeNull();
    expect(deriveSectionQuantityLabel([
      { quantityMilli: 1000, unit: "piece", isHidden: true },
    ])).toBeNull();
  });

  it("F711-U-05: leerer Input ergibt leeren Schaltplan (Builder-Reuse)", () => {
    const schematic = buildSingleLineSchematic(toSchematicInputs([]));
    expect(schematic.empty).toBe(true);
    expect(schematic.nodes).toEqual([]);
    expect(schematic.unwired).toEqual([]);
    const lineless = buildSingleLineSchematic(toSchematicInputs([
      section(0, "module", "Leer", []),
    ]));
    expect(lineless.empty).toBe(true);
    expect(lineless.nodes).toEqual([]);
    expect(lineless.unwired).toEqual([]);
  });
});
