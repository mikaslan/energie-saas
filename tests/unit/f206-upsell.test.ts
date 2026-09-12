import { describe, expect, it } from "vitest";

import {
  resolveUpsellTotal,
  upsellSelectionSchema,
  type UpsellOptionalLine,
} from "@/lib/integrations/offers/upsell";

function line(override: Partial<UpsellOptionalLine> & { lineDomainId: string }): UpsellOptionalLine {
  return {
    name: `Komponente ${override.lineDomainId}`,
    salesGrossCents: 11900,
    positionType: "optional",
    isHidden: false,
    ...override,
  };
}

describe("F2-06 Upsell-Projektor", () => {
  it("F206-U-01: summiert Basis plus gewählte Optionale", () => {
    const result = resolveUpsellTotal({
      basisGrossCents: 1_040_000,
      lines: [
        line({ lineDomainId: "wallbox", salesGrossCents: 95_200 }),
        line({ lineDomainId: "notstrom", salesGrossCents: 41_650 }),
      ],
      selectedIds: ["wallbox"],
    });
    expect(result).toEqual({
      basisGrossCents: 1_040_000,
      selectableCount: 2,
      selectedIds: ["wallbox"],
      unknownIds: [],
      selectedGrossCents: 95_200,
      totalGrossCents: 1_135_200,
    });
  });

  it("F206-U-02: leere Auswahl zeigt nur die Basis", () => {
    const result = resolveUpsellTotal({
      basisGrossCents: 500_000,
      lines: [line({ lineDomainId: "wallbox" })],
      selectedIds: [],
    });
    expect(result.selectedGrossCents).toBe(0);
    expect(result.totalGrossCents).toBe(500_000);
    expect(result.selectableCount).toBe(1);
  });

  it("F206-U-03: unbekannte, versteckte und nicht-optionale fallen raus", () => {
    const result = resolveUpsellTotal({
      basisGrossCents: 100,
      lines: [
        line({ lineDomainId: "sichtbar" }),
        line({ lineDomainId: "versteckt", isHidden: true }),
        line({ lineDomainId: "pflicht", positionType: "required" }),
        line({ lineDomainId: "zusatz", positionType: "additional" }),
      ],
      selectedIds: ["sichtbar", "versteckt", "pflicht", "fremd", "sichtbar"],
    });
    expect(result.selectableCount).toBe(1);
    expect(result.selectedIds).toEqual(["sichtbar"]);
    expect(result.unknownIds).toEqual(["versteckt", "pflicht", "fremd"]);
    expect(result.totalGrossCents).toBe(100 + 11_900);
  });

  it("F206-U-04: Auswahl ist auf 50 begrenzt", () => {
    const ids = Array.from({ length: 51 }, (_, index) => `id-${index}`);
    expect(() => upsellSelectionSchema.parse(ids)).toThrow();
    expect(upsellSelectionSchema.parse(ids.slice(0, 50))).toHaveLength(50);
  });

  it("F206-U-05: ohne optionale Zeilen ist nichts wählbar", () => {
    const result = resolveUpsellTotal({
      basisGrossCents: 77_000,
      lines: [],
      selectedIds: ["egal"],
    });
    expect(result.selectableCount).toBe(0);
    expect(result.selectedIds).toEqual([]);
    expect(result.unknownIds).toEqual(["egal"]);
    expect(result.totalGrossCents).toBe(77_000);
  });
});
