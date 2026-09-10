import { describe, expect, it } from "vitest";

import {
  schematicExportFilename,
  sanitizeSchematicExportSegment,
  SCHEMATIC_EXPORT_EXTENSION,
  SCHEMATIC_EXPORT_PREFIX,
} from "@/lib/integrations/schematic/export-filename";

// F6-02 Dateiname-Builder: Prefix/Extension pinnen, Sanitierung,
// Kollaps, leere Segmente fail-closed.

describe("schematic export filename", () => {
  it("pinnt Prefix und Extension", () => {
    expect(SCHEMATIC_EXPORT_PREFIX).toBe("schaltplan");
    expect(SCHEMATIC_EXPORT_EXTENSION).toBe(".svg");
  });

  it("baut den Dateinamen aus Nummer und Variante", () => {
    expect(
      schematicExportFilename({ offerNumber: "ANG-2026-0042", variantName: "Basis" }),
    ).toBe("schaltplan-ANG-2026-0042-Basis.svg");
  });

  it("sanitisiert Schrägstriche, Leerzeichen und Umlaute bleiben lesbar", () => {
    expect(
      schematicExportFilename({ offerNumber: "ANG/2026 042", variantName: "Dach Süd + Speicher" }),
    ).toBe("schaltplan-ANG-2026-042-Dach-Süd-Speicher.svg");
  });

  it("kollabiert Folgen und stutzt Ränder", () => {
    expect(sanitizeSchematicExportSegment(" --A//B-- ")).toBe("A-B");
  });

  it("fail-closed bei leeren Segmenten: nackter Prefix statt führendem Bindestrich", () => {
    expect(schematicExportFilename({ offerNumber: "///", variantName: "" })).toBe(
      "schaltplan.svg",
    );
    expect(
      schematicExportFilename({ offerNumber: "ANG-1", variantName: "  " }),
    ).toBe("schaltplan-ANG-1.svg");
  });
});
