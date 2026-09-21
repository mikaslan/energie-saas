import { describe, expect, it } from "vitest";

import {
  assertResidentialSchematicScope,
  buildResidentialSingleLineSchematic,
  buildSingleLineSchematic,
  canonicalizeSchematicNetlist,
  hashSchematicNetlist,
  SCHEMATIC_CANONICALIZATION_VERSION,
  SCHEMATIC_NETLIST_VERSION,
  SchematicScopeError,
  sortSingleLineSchematic,
  type SchematicSectionInput,
} from "@/lib/integrations/schematic/single-line-v1";
// Fehlervertrag ohne Server-Bindung (errors.ts-Muster, kein server-only).
import {
  SchematicConflictError,
  SchematicScopeError as ModuleSchematicScopeError,
  SchematicValidationError,
} from "@/modules/schematic/errors";

// F6-01/W-CORE Vertrag: Versionen, goldene Netzliste, Fehleridentitaet.
// Alle Goldwerte sind von Hand abgeleitet (JCS: Schluessel sortiert, NFC,
// sichere Ganzzahlen) — kein Snapshot aus der Implementation.

const RESIDENTIAL_SCOPE = {
  scope: "residential",
  priceAudience: "b2c",
  boardScope: "residential",
  audience: "b2c",
} as const;

function section(
  category: SchematicSectionInput["category"],
  title: string,
): SchematicSectionInput {
  return { category, title, quantityLabel: "1 Stück" };
}

// Handabgeleitete kanonische Netzliste fuer [PV-Module, Wechselrichter]:
// Knoten sortiert (grid < inverter < meter < pv), Kanten sortiert,
// Schluessel sortiert (edges < nodes < schemaVersion < unwired).
const GOLDEN_CANONICAL =
  '{"edges":[{"from":"inverter","label":"AC","to":"meter"},' +
  '{"from":"meter","label":"AC","to":"grid"},' +
  '{"from":"pv","label":"DC","to":"inverter"}],' +
  '"nodes":[{"id":"grid","kind":"grid","label":"Netz","sub":null,"x":560,"y":80},' +
  '{"id":"inverter","kind":"inverter","label":"Wechselrichter","sub":"1 Stück","x":250,"y":80},' +
  '{"id":"meter","kind":"meter","label":"Zähler","sub":null,"x":410,"y":80},' +
  '{"id":"pv","kind":"pv","label":"PV-Module","sub":"1 Stück","x":90,"y":80}],' +
  '"schemaVersion":"schematic-netlist.v1","unwired":[]}';
const GOLDEN_SHA256 = "bf14dba1f048d9411c86bd940ac1f61ffccfd97eb00f4cabe20a527e6416d956";

describe("F6-01/W-CORE Vertrag: Versionen", () => {
  it("pinnt Netzlist- und Kanonisierungsversion", () => {
    expect(SCHEMATIC_NETLIST_VERSION).toBe("schematic-netlist.v1");
    expect(SCHEMATIC_CANONICALIZATION_VERSION).toBe("schematic-jcs.v1");
  });
});

describe("F6-01/W-CORE Vertrag: goldene Netzliste", () => {
  const sections = [section("module", "PV-Module"), section("inverter", "Wechselrichter")];

  it("kanonisiert exakt auf den Goldwert", () => {
    const schematic = buildResidentialSingleLineSchematic(sections, {
      ...RESIDENTIAL_SCOPE,
    });
    expect(canonicalizeSchematicNetlist(schematic)).toBe(GOLDEN_CANONICAL);
  });

  it("hasht exakt auf den Goldwert", () => {
    const schematic = buildResidentialSingleLineSchematic(sections, {
      ...RESIDENTIAL_SCOPE,
    });
    expect(hashSchematicNetlist(schematic)).toBe(GOLDEN_SHA256);
  });

  it("haertet: streng = Gate + sortierter Legacy-Builder", () => {
    const strict = buildResidentialSingleLineSchematic(sections, {
      ...RESIDENTIAL_SCOPE,
    });
    expect(strict).toEqual(sortSingleLineSchematic(buildSingleLineSchematic(sections)));
  });
});

describe("F6-01/W-CORE Vertrag: Scope-Abdeckung (alle Offer-Scope-Felder)", () => {
  it("prueft scope, priceAudience, boardScope und audience", () => {
    const residential = {
      scope: "residential",
      priceAudience: "b2c",
      boardScope: "residential",
      audience: "b2c",
    };
    expect(() => assertResidentialSchematicScope(residential)).not.toThrow();
    const drifts: unknown[] = [
      { ...residential, scope: "commercial" },
      { ...residential, priceAudience: "b2b" },
      { ...residential, boardScope: "commercial" },
      { ...residential, audience: "b2b" },
    ];
    for (const scope of drifts) {
      expect(() => assertResidentialSchematicScope(scope)).toThrowError(
        SchematicScopeError,
      );
    }
  });
});

describe("F6-01/W-CORE Vertrag: Fehleridentitaet", () => {
  it("exportiert Scope-, Konflikt- und Validierungsfehler stabil", () => {
    expect(ModuleSchematicScopeError).toBe(SchematicScopeError);
    expect(new SchematicConflictError(3).name).toBe("SchematicConflictError");
    expect(new SchematicConflictError(3).currentRevision).toBe(3);
    expect(new SchematicValidationError(["/offerId"]).name).toBe(
      "SchematicValidationError",
    );
    expect(new SchematicValidationError(["/offerId"]).paths).toEqual(["/offerId"]);
    expect(new SchematicScopeError().name).toBe("SchematicScopeError");
  });
});
