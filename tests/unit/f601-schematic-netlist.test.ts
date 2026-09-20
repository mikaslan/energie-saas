import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildResidentialSingleLineSchematic,
  buildSingleLineSchematic,
  canonicalizeSchematicNetlist,
  hashSchematicNetlist,
  type SchematicSectionInput,
  type SingleLineSchematic,
} from "@/lib/integrations/schematic/single-line-v1";

function section(
  category: SchematicSectionInput["category"],
  title: string,
): SchematicSectionInput {
  return { category, title, quantityLabel: "1 Stück" };
}

const RESIDENTIAL_SCOPE = {
  scope: "residential",
  priceAudience: "b2c",
  boardScope: "residential",
  audience: "b2c",
} as const;

const SECTIONS: SchematicSectionInput[] = [
  section("module", "PV-Module"),
  section("inverter", "Wechselrichter"),
];

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe("F6-01/W-CORE JCS-kanonische Netzliste", () => {
  it("kanonisiert die leere Netzliste exakt (Schluessel sortiert)", () => {
    const empty: SingleLineSchematic = { nodes: [], edges: [], unwired: [], empty: true };
    expect(canonicalizeSchematicNetlist(empty)).toBe(
      '{"edges":[],"nodes":[],"schemaVersion":"schematic-netlist.v1","unwired":[]}',
    );
  });

  it("ist unabhaengig von Knoten-/Kantenreihenfolge", () => {
    const legacy = buildSingleLineSchematic(SECTIONS);
    const strict = buildResidentialSingleLineSchematic(SECTIONS, {
      ...RESIDENTIAL_SCOPE,
    });
    // Unterschiedliche Ausgabereihenfolge, identische kanonische Netzliste.
    expect(strict.nodes.map((node) => node.id)).not.toEqual(
      legacy.nodes.map((node) => node.id),
    );
    expect(canonicalizeSchematicNetlist(strict)).toBe(
      canonicalizeSchematicNetlist(legacy),
    );
    expect(hashSchematicNetlist(strict)).toBe(hashSchematicNetlist(legacy));
  });

  it("aendert den Hash bei jeder Inhaltsdrift", () => {
    const base = hashSchematicNetlist(
      buildResidentialSingleLineSchematic(SECTIONS, { ...RESIDENTIAL_SCOPE }),
    );
    const withBattery = hashSchematicNetlist(
      buildResidentialSingleLineSchematic([...SECTIONS, section("battery", "Speicher")], {
        ...RESIDENTIAL_SCOPE,
      }),
    );
    const renamed = hashSchematicNetlist(
      buildResidentialSingleLineSchematic(
        [section("module", "PV-Anlage"), section("inverter", "Wechselrichter")],
        { ...RESIDENTIAL_SCOPE },
      ),
    );
    expect(withBattery).not.toBe(base);
    expect(renamed).not.toBe(base);
    expect(base).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("hasht exakt sha256 der kanonischen Form (unabhaengig geprueft)", () => {
    const schematic = buildResidentialSingleLineSchematic(SECTIONS, {
      ...RESIDENTIAL_SCOPE,
    });
    expect(hashSchematicNetlist(schematic)).toBe(
      sha256Hex(canonicalizeSchematicNetlist(schematic)),
    );
  });

  it("normalisiert NFC (e + Kombi-Akut = é)", () => {
    const decomposed = buildResidentialSingleLineSchematic(
      [section("module", "PV-Module é".normalize("NFD")), section("inverter", "Wechselrichter")],
      { ...RESIDENTIAL_SCOPE },
    );
    const composed = buildResidentialSingleLineSchematic(
      [section("module", "PV-Module é"), section("inverter", "Wechselrichter")],
      { ...RESIDENTIAL_SCOPE },
    );
    expect(canonicalizeSchematicNetlist(decomposed)).toBe(
      canonicalizeSchematicNetlist(composed),
    );
    expect(canonicalizeSchematicNetlist(composed)).toContain("PV-Module é");
  });

  it("verwirft nicht-kanonisierbare Netzlisten fail-closed", () => {
    const badX: SingleLineSchematic = {
      nodes: [{ id: "inverter", kind: "inverter", label: "WR", sub: null, x: 1.5, y: 80 }],
      edges: [],
      unwired: [],
      empty: false,
    };
    expect(() => canonicalizeSchematicNetlist(badX)).toThrowError(TypeError);
    const badSurrogate: SingleLineSchematic = {
      nodes: [{ id: "grid", kind: "grid", label: "Netz\ud800", sub: null, x: 560, y: 80 }],
      edges: [],
      unwired: [],
      empty: false,
    };
    expect(() => canonicalizeSchematicNetlist(badSurrogate)).toThrowError(TypeError);
    expect(() =>
      canonicalizeSchematicNetlist(null as unknown as SingleLineSchematic),
    ).toThrowError(TypeError);
  });
});
