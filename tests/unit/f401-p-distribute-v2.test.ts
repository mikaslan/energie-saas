import { describe, expect, it } from "vitest";

import { neumaierSum } from "@/lib/integrations/calculation/engine-v2";
import {
  assembleSlotPvEnergy,
  distributeScaledPowerToQuarters,
} from "@/lib/integrations/calculation/p-distribute-v2";
import { F401ProviderError } from "@/lib/integrations/calculation/provider-v2";

// F4.1 v2-Leistungsverteilung: P*_h -> P_q (Hay-Gewichte injiziert) ->
// E_pv,q ueber alle Daeche.

describe("F4.1 v2 power distribution", () => {
  it("verteilt Stundenleistung energieerhaltend auf vier Slots", () => {
    const quarters = distributeScaledPowerToQuarters(800, [0.2, 0.6, 1, 0.4]);
    expect(0.25 * neumaierSum(quarters)).toBeCloseTo(800, 9);
    // Gewichtsproportionale Form: letztes Gewicht groesstes Viertel.
    expect(quarters[2]).toBeCloseTo(800 * 4 * (1 / 2.2), 9);
    expect(distributeScaledPowerToQuarters(0, [0, 0, 0, 0])).toEqual([0, 0, 0, 0]);
  });

  it("bricht bei P*_h ohne Gewicht und bei Bereichsfehlern ab", () => {
    expect(() => distributeScaledPowerToQuarters(5, [0, 0, 0, 0])).toThrow(
      F401ProviderError,
    );
    expect(() => distributeScaledPowerToQuarters(-1, [1, 1, 1, 1])).toThrow(
      F401ProviderError,
    );
    expect(() => distributeScaledPowerToQuarters(10_001, [1, 1, 1, 1])).toThrow(
      F401ProviderError,
    );
  });

  it("summiert Dach-Slotleistung zu E_pv,q in kWh", () => {
    const slots = 35_040;
    const energy = assembleSlotPvEnergy([
      { roofId: "dach-sued", peakPowerKwp: 5, powerWPerKwp: new Array(slots).fill(400) },
      { roofId: "dach-nord", peakPowerKwp: 3, powerWPerKwp: new Array(slots).fill(100) },
    ]);
    expect(energy).toHaveLength(slots);
    // 0.25/1000 * (5*400 + 3*100) = 0.575 kWh/Slot.
    expect(energy[0]).toBeCloseTo(0.575, 12);
    expect(neumaierSum(energy)).toBeCloseTo(0.575 * slots, 6);
  });

  it("weist leere/ueberzaehlige/doppelte/ungleiche Dachsaetze ab", () => {
    const slots = 35_040;
    const roof = (id: string, n = slots): { roofId: string; peakPowerKwp: number; powerWPerKwp: number[] } => ({
      roofId: id,
      peakPowerKwp: 5,
      powerWPerKwp: new Array(n).fill(10),
    });
    expect(() => assembleSlotPvEnergy([])).toThrow(F401ProviderError);
    expect(() => assembleSlotPvEnergy([roof("a"), roof("b"), roof("c"), roof("d"), roof("e")])).toThrow(
      F401ProviderError,
    );
    expect(() => assembleSlotPvEnergy([roof("a"), roof("a")])).toThrow(F401ProviderError);
    expect(() => assembleSlotPvEnergy([roof("a", 100)])).toThrow(F401ProviderError);
  });
});
