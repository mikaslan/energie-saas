import { describe, expect, it } from "vitest";

import {
  computeEconomics,
  computeExistingBillDelta,
  resolveEconomics,
} from "@/lib/integrations/calculation/economics-v2";
import * as economicsV2 from "@/lib/integrations/calculation/economics-v2";

// F4-05d Zubau-Delta (RED, Ref docs/spec/F4-05d-zubau-delta.md):
// NUR existierende Imports — kein Import aus noch nicht geschriebenem Code.
// ROT-Beleg per `npx tsx scripts/run-tests.mts tests/unit/f405d-zubau-delta.red.test.ts`
// (Vitest direkt ist VERBOTEN; 5 rote Tests, Auszug in der Spec); danach
// describe.skip bis zur Umsetzung.

function consumption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    electricityPriceCentsPerKwh: { status: "known", value: 36, source: "customer" },
    annualPriceIncreasePercent: { status: "unknown", value: null, source: "not_collected" },
    investmentEuro: { status: "known", value: 5000, source: "operator_reviewed" },
    feedInTariffCtPerKwh: { status: "unknown", value: null, source: "not_collected" },
    feedInCommissioningYear: { status: "known", value: 2024, source: "operator_reviewed" },
    ...overrides,
  };
}

// SKIP-Grund: F4-05d noch nicht implementiert (reine Spec + Contract +
// RED-Beleg, ROT am 2026-09-20 bewiesen, Auszug in der Spec). Ref:
// docs/spec/F4-05d-zubau-delta.md — aktivieren, sobald der
// Umsetzungs-Slice (Delta-Rechnung/Guards/scopeNote) landet.
describe.skip("f405d zubau delta", () => {
  it("Zubau-Delta-Rechnung trägt Zubau-scopeNote (nicht Gesamtanlage)", () => {
    const input = resolveEconomics(consumption())!;
    const delta = computeEconomics(
      {
        generationKwh: 0,
        selfConsumptionKwh: 1500,
        feedInKwh: 0,
        consumptionKwh: 7200,
        gridImportKwh: 2500,
      },
      input,
    );
    expect(delta).toHaveProperty("scopeNote", "Zubau-Delta (nicht Gesamtanlage)");
  });

  it("Bestands-Geldvergleich trägt scopeNote-Pflicht (Gesamtanlage, F4-05c §3)", () => {
    const delta = computeExistingBillDelta(4000, 2500, 36);
    expect(delta).toHaveProperty("scopeNote", "Gesamtanlage (nicht Zubau-Delta)");
  });

  it("Einspeiserlös-Delta wird ausgewiesen (F4-05b Q2)", () => {
    const delta = computeExistingBillDelta(4000, 2500, 36);
    expect(delta).toHaveProperty("feedInRevenueDeltaEuro");
  });

  it("Doppelzählungs-Guard: computeExtensionDelta ist exportiert (Bestandserzeugung nicht neu vergüten)", () => {
    expect("computeExtensionDelta" in economicsV2).toBe(true);
  });

  it("Fallback ohne Bestand: resolveExtensionDelta ist exportiert (null ohne Bestands-Kontext)", () => {
    expect("resolveExtensionDelta" in economicsV2).toBe(true);
  });
});
