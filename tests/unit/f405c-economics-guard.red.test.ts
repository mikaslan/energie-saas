import { describe, expect, it } from "vitest";

import {
  computeExistingBillDelta,
  eegDefaultForYear,
  resolveEconomics,
} from "@/lib/integrations/calculation/economics-v2";
import * as economicsV2 from "@/lib/integrations/calculation/economics-v2";

// F4-05c Haftung/EEG-Rand/Delta (RED-Guard, Ref docs/spec/F4-05c-haftung-eeg-rand-delta.md):
// NUR existierende Imports — kein Import aus noch nicht geschriebenem Code.
// ROT-Beleg per `npx vitest run tests/unit/f405c-economics-guard.red.test.ts`
// (5 rote Tests, Auszug in der Spec); danach describe.skip bis zur Umsetzung.

function consumption(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    electricityPriceCentsPerKwh: { status: "known", value: 36, source: "customer" },
    annualPriceIncreasePercent: { status: "unknown", value: null, source: "not_collected" },
    investmentEuro: { status: "known", value: 20_000, source: "operator_reviewed" },
    feedInTariffCtPerKwh: { status: "unknown", value: null, source: "not_collected" },
    feedInCommissioningYear: { status: "unknown", value: null, source: "not_collected" },
    ...overrides,
  };
}

const known = (value: number) => ({ status: "known", value, source: "operator_reviewed" });

// SKIP-Grund: F4-05c noch nicht implementiert (reine Spec + RED-Beleg, ROT am
// 2026-09-19 bewiesen, Auszug in der Spec). Ref:
// docs/spec/F4-05c-haftung-eeg-rand-delta.md — aktivieren, sobald der
// Umsetzungs-Slice (Haftungsgate/EEG-Rand/Delta-Kennzeichnung) landet.
describe.skip("f405c economics guard", () => {
  it("EEG-Randjahr 2030 ohne Override ist fail-closed (wirft statt stiller Randsätze)", () => {
    expect(() => eegDefaultForYear(2030)).toThrow();
  });

  it("resolveEconomics Jahr 2030 ohne Override liefert kein Geld", () => {
    const resolved = resolveEconomics(consumption({
      feedInCommissioningYear: known(2030),
    }));
    expect(resolved).toBeNull();
  });

  it("ESTIMATE-Vergütung (eeg_default) trägt Economics-Warning", () => {
    const resolved = resolveEconomics(consumption({
      feedInCommissioningYear: known(2024),
    }))!;
    expect(resolved.feedInTariffSource).toBe("eeg_default");
    expect(resolved).toHaveProperty("warnings", expect.arrayContaining(["economics_estimate"]));
  });

  it("Bestands-Geldvergleich trägt Gesamtanlagen-Kennzeichnung", () => {
    const delta = computeExistingBillDelta(4000, 2500, 36);
    expect(delta).toHaveProperty("scopeNote", "Gesamtanlage (nicht Zubau-Delta)");
  });

  it("Break-even-Definition ist exportiert (Break-even ≡ Amortisationsjahr)", () => {
    expect("BREAK_EVEN_DEFINITION" in economicsV2).toBe(true);
  });
});
