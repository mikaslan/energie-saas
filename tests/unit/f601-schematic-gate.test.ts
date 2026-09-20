import { describe, expect, it } from "vitest";

import {
  assertResidentialSchematicScope,
  buildResidentialSingleLineSchematic,
  buildSingleLineSchematic,
  resolveSchematicScope,
  SchematicScopeError,
  sortSingleLineSchematic,
  type SchematicSectionInput,
} from "@/lib/integrations/schematic/single-line-v1";

function section(
  category: SchematicSectionInput["category"],
  title: string,
): SchematicSectionInput {
  return { category, title, quantityLabel: "1 Stück" };
}

const SECTIONS: SchematicSectionInput[] = [
  section("module", "PV-Module"),
  section("inverter", "Wechselrichter"),
];

// W-CORE-4-Felder-Modell (Fleet-Vertrag): offer.scope + offer.price_audience
// + kanban_board.scope + price_audience_decision.audience. Alle vier sind
// Pflicht; residential gilt nur bei exakt residential+b2c+residential+b2c.
const RESIDENTIAL_SCOPE = {
  scope: "residential",
  priceAudience: "b2c",
  boardScope: "residential",
  audience: "b2c",
} as const;

describe("F6-01/W-CORE Residential-Gate (Builder)", () => {
  it("nimmt exakt residential+b2c+residential+b2c an", () => {
    expect(() =>
      assertResidentialSchematicScope({ ...RESIDENTIAL_SCOPE }),
    ).not.toThrow();
  });

  it("verwirft commercial/b2b je Scope-Feld fail-closed", () => {
    const cases: unknown[] = [
      { ...RESIDENTIAL_SCOPE, scope: "commercial" },
      { ...RESIDENTIAL_SCOPE, priceAudience: "b2b" },
      { ...RESIDENTIAL_SCOPE, boardScope: "commercial" },
      { ...RESIDENTIAL_SCOPE, audience: "b2b" },
    ];
    for (const scope of cases) {
      expect(() => assertResidentialSchematicScope(scope)).toThrowError(
        SchematicScopeError,
      );
    }
  });

  it("verwirft unbekannte/fehlende Scope-Angaben fail-closed", () => {
    const cases: unknown[] = [
      undefined,
      null,
      "residential",
      42,
      [],
      {},
      { scope: "residential", priceAudience: "b2c" },
      { scope: "residential" },
      { priceAudience: "b2c" },
      { ...RESIDENTIAL_SCOPE, boardScope: null },
      { ...RESIDENTIAL_SCOPE, audience: undefined },
      { ...RESIDENTIAL_SCOPE, boardScope: "unknown" },
      { ...RESIDENTIAL_SCOPE, scope: "RESIDENTIAL" },
      { ...RESIDENTIAL_SCOPE, priceAudience: "B2C" },
    ];
    for (const scope of cases) {
      expect(() => assertResidentialSchematicScope(scope)).toThrowError(
        SchematicScopeError,
      );
    }
  });

  it("entscheidet als Status identisch zum Throw-Gate (Single Source)", () => {
    expect(resolveSchematicScope({ ...RESIDENTIAL_SCOPE })).toBe("residential");
    const drifts: unknown[] = [
      { ...RESIDENTIAL_SCOPE, scope: "commercial" },
      { ...RESIDENTIAL_SCOPE, priceAudience: "b2b" },
      { ...RESIDENTIAL_SCOPE, boardScope: "commercial" },
      { ...RESIDENTIAL_SCOPE, audience: "b2b" },
      { ...RESIDENTIAL_SCOPE, boardScope: null },
      { ...RESIDENTIAL_SCOPE, audience: undefined },
      null,
      undefined,
      {},
      "residential",
    ];
    for (const scope of drifts) {
      expect(() => assertResidentialSchematicScope(scope)).toThrowError(
        SchematicScopeError,
      );
      expect(
        resolveSchematicScope(
          scope as { scope: unknown; priceAudience: unknown; boardScope: unknown; audience: unknown },
        ),
      ).toBe("commercial");
    }
  });

  it("wirft SchematicScopeError mit stabilem Namen", () => {
    try {
      assertResidentialSchematicScope({ ...RESIDENTIAL_SCOPE, scope: "commercial" });
      expect.unreachable("Gate muss commercial verwerfen");
    } catch (error) {
      expect(error).toBeInstanceOf(SchematicScopeError);
      expect((error as Error).name).toBe("SchematicScopeError");
    }
  });
});

describe("F6-01/W-CORE strenger Builder", () => {
  it("baut residential wie der sortierte Legacy-Builder", () => {
    const strict = buildResidentialSingleLineSchematic(SECTIONS, {
      ...RESIDENTIAL_SCOPE,
    });
    expect(strict).toEqual(sortSingleLineSchematic(buildSingleLineSchematic(SECTIONS)));
    expect(strict.empty).toBe(false);
  });

  it("verwirft commercial/b2b und fehlenden Scope", () => {
    expect(() =>
      buildResidentialSingleLineSchematic(SECTIONS, {
        ...RESIDENTIAL_SCOPE,
        scope: "commercial",
      }),
    ).toThrowError(SchematicScopeError);
    expect(() =>
      buildResidentialSingleLineSchematic(SECTIONS, {
        ...RESIDENTIAL_SCOPE,
        audience: "b2b",
      }),
    ).toThrowError(SchematicScopeError);
    expect(() =>
      buildResidentialSingleLineSchematic(
        SECTIONS,
        undefined as unknown as typeof RESIDENTIAL_SCOPE,
      ),
    ).toThrowError(SchematicScopeError);
  });

  it("ist leer ohne Angebotsinhalt (Gate bleibt davor)", () => {
    const schematic = buildResidentialSingleLineSchematic([], {
      ...RESIDENTIAL_SCOPE,
    });
    expect(schematic.empty).toBe(true);
    expect(schematic.nodes).toEqual([]);
  });
});

describe("F6-01/W-CORE Legacy-Builder bleibt kompatibel", () => {
  it("baut ohne Scope wie bisher (exakte Reihenfolge)", () => {
    const schematic = buildSingleLineSchematic(SECTIONS);
    expect(schematic.nodes.map((node) => node.id)).toEqual([
      "pv",
      "inverter",
      "meter",
      "grid",
    ]);
    expect(schematic.edges).toEqual([
      { from: "pv", to: "inverter", label: "DC" },
      { from: "inverter", to: "meter", label: "AC" },
      { from: "meter", to: "grid", label: "AC" },
    ]);
  });

  it("prueft optionalen Scope ohne das Ergebnis zu aendern", () => {
    expect(buildSingleLineSchematic(SECTIONS, { ...RESIDENTIAL_SCOPE })).toEqual(
      buildSingleLineSchematic(SECTIONS),
    );
    expect(() =>
      buildSingleLineSchematic(SECTIONS, {
        ...RESIDENTIAL_SCOPE,
        boardScope: "commercial",
      }),
    ).toThrowError(SchematicScopeError);
  });
});

describe("F6-01/W-CORE Determinismus-Haertung", () => {
  const ALL: SchematicSectionInput[] = [
    section("module", "PV-Module"),
    section("inverter", "Wechselrichter"),
    section("battery", "Speicher"),
    section("wallbox", "Wallbox"),
    section("heat_pump", "Wärmepumpe"),
    section("mounting", "Montagesystem"),
    section("other", "Sonstiges"),
  ];

  it("ist unabhaengig von der Eingabereihenfolge", () => {
    const forward = buildResidentialSingleLineSchematic(ALL, {
      ...RESIDENTIAL_SCOPE,
    });
    const reversed = buildResidentialSingleLineSchematic([...ALL].reverse(), {
      ...RESIDENTIAL_SCOPE,
    });
    const rotated = buildResidentialSingleLineSchematic(
      [...ALL.slice(3), ...ALL.slice(0, 3)],
      { ...RESIDENTIAL_SCOPE },
    );
    expect(reversed).toEqual(forward);
    expect(rotated).toEqual(forward);
  });

  it("waehlt bei doppelter Kategorie deterministisch (kleinster Titel gewinnt)", () => {
    const a = section("module", "PV-Module A");
    const b = section("module", "PV-Module B");
    const first = buildResidentialSingleLineSchematic([a, b], {
      ...RESIDENTIAL_SCOPE,
    });
    const second = buildResidentialSingleLineSchematic([b, a], {
      ...RESIDENTIAL_SCOPE,
    });
    expect(second).toEqual(first);
    expect(first.nodes.find((node) => node.id === "pv")?.label).toBe("PV-Module A");
  });

  it("sortiert Knoten/Kanten/Hinweise stabil und ohne Mutation", () => {
    const input = buildSingleLineSchematic(ALL);
    const before = structuredClone(input);
    const sorted = sortSingleLineSchematic(input);
    expect(input).toEqual(before);
    expect(sorted.nodes.map((node) => node.id)).toEqual(
      [...sorted.nodes.map((node) => node.id)].sort(),
    );
    expect(
      sorted.edges.map((edge) => `${edge.from}→${edge.to}→${edge.label}`),
    ).toEqual(
      [...sorted.edges.map((edge) => `${edge.from}→${edge.to}→${edge.label}`)].sort(),
    );
    expect(sorted.unwired).toEqual([...sorted.unwired].sort());
    expect(sorted.empty).toBe(input.empty);
  });
});
