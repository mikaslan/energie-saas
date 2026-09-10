import { describe, expect, it } from "vitest";

import {
  computeExistingBillDelta,
} from "@/lib/integrations/calculation/economics-v2";
import {
  annualSankeyLinks,
} from "@/lib/integrations/calculation/sankey-v2";

// F4.5b Bestands-Geldvergleich + Sankey-Erhaltung (Spec F4-05b).

describe("Bestands-Geldvergleich", () => {
  it("rechnet Bestand/Planung/Ersparnis aus Netzbezug x Tarif", () => {
    const bills = computeExistingBillDelta(5000, 2000, 36);
    expect(bills.baselineEuro).toBeCloseTo(1800, 10);
    expect(bills.plannedEuro).toBeCloseTo(720, 10);
    expect(bills.savingsEuro).toBeCloseTo(1080, 10);
  });

  it("laesst negative Ersparnis zu (Planung teurer als Bestand)", () => {
    const bills = computeExistingBillDelta(1000, 1500, 36);
    expect(bills.savingsEuro).toBeCloseTo(-180, 10);
  });

  it("weist ungueltige Eingaben fail-closed ab", () => {
    expect(() => computeExistingBillDelta(-1, 2000, 36)).toThrow();
    expect(() => computeExistingBillDelta(5000, 2000, 0.5)).toThrow();
    expect(() => computeExistingBillDelta(5000, 2000, 201)).toThrow();
    expect(() => computeExistingBillDelta(5000, Number.NaN, 36)).toThrow();
  });
});

describe("Sankey-Erhaltung", () => {
  // Erzeugung 7200 = 3000 direkt + 1500 Speicher + 2500 Export + 200
  // Verlust; Verbrauch 6500 = 3000 + 1500 + 2000 Netz.
  const annual = {
    directConsumptionKwh: 3000,
    fromStorageKwh: 1500,
    feedInKwh: 2500,
    gridImportKwh: 2000,
    storageLossKwh: 200,
  };

  it("liefert 6 Kanten mit exakten Knotenbilanzen", () => {
    const links = annualSankeyLinks(annual);
    expect(links).toHaveLength(6);
    const out = (node: string): number => links
      .filter((link) => link.source === node)
      .reduce((sum, link) => sum + link.valueKwh, 0);
    const into = (node: string): number => links
      .filter((link) => link.target === node)
      .reduce((sum, link) => sum + link.valueKwh, 0);
    // PV-Knoten: Erzeugung = Direkt + Ladung + Export.
    expect(out("PV-Erzeugung")).toBeCloseTo(7200, 10);
    // Speicher: Ladung (= Entladung + Verlust, zyklisch) geht exakt auf.
    expect(into("Speicher")).toBeCloseTo(1700, 10);
    expect(out("Speicher")).toBeCloseTo(into("Speicher"), 12);
    // Verbrauch: Direkt + Speicher + Netz.
    expect(into("Verbrauch")).toBeCloseTo(6500, 10);
    expect(out("Einspeisung")).toBe(0);
    expect(into("Einspeisung")).toBeCloseTo(2500, 10);
  });

  it("weist ungueltige Jahreswerte fail-closed ab", () => {
    expect(() => annualSankeyLinks({ ...annual, gridImportKwh: -1 })).toThrow();
    expect(() => annualSankeyLinks({ ...annual, feedInKwh: Number.NaN })).toThrow();
  });
});
