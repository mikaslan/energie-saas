import { describe, expect, it } from "vitest";

import { neumaierSum, QUARTER_HOUR_SLOTS } from "@/lib/integrations/calculation/engine-v2";
import {
  buildExistingPvSeriesV2,
  degradationFactorV2,
  EXISTING_PV_V2_VERSION,
  MODULE_DEGRADATION_PER_YEAR_V2,
} from "@/lib/integrations/calculation/existing-pv-v2";

function roof(input: {
  roofId: string;
  areaM2: number;
  power: number;
}) {
  return {
    roofId: input.roofId,
    areaM2: input.areaM2,
    newPowerWPerKwp: new Array<number>(QUARTER_HOUR_SLOTS).fill(input.power),
  };
}

describe("F4.1 v2 existing PV: Degradation", () => {
  it("pinnt Rate 0,5 %/Jahr (v1-Modell-Default) und Version", () => {
    expect(MODULE_DEGRADATION_PER_YEAR_V2).toBe(0.005);
    expect(EXISTING_PV_V2_VERSION).toBe("wmee-existing-pv.v1");
    expect(degradationFactorV2({ commissioningYear: 2020, asOfYear: 2026 }))
      .toBeCloseTo(0.995 ** 6, 12);
    expect(degradationFactorV2({ commissioningYear: 2026, asOfYear: 2026 })).toBe(1);
    // Zukuenftige Inbetriebnahme -> 1 (robust, kein Throw).
    expect(degradationFactorV2({ commissioningYear: 2030, asOfYear: 2026 })).toBe(1);
  });

  it("verweigert ungueltige Jahre und Raten fail-closed", () => {
    for (const bad of [
      { commissioningYear: 1800, asOfYear: 2026 },
      { commissioningYear: 2020.5, asOfYear: 2026 },
      { commissioningYear: 2020, asOfYear: 3000 },
    ]) {
      expect(() => degradationFactorV2(bad)).toThrow();
    }
    expect(() => degradationFactorV2({
      commissioningYear: 2020,
      asOfYear: 2026,
      rate: 1,
    })).toThrow();
    expect(() => degradationFactorV2({
      commissioningYear: 2020,
      asOfYear: 2026,
      rate: Number.NaN,
    })).toThrow();
  });
});

describe("F4.1 v2 existing PV: Serie", () => {
  it("skaliert die Neuanlagen-Form auf Bestand-kWp x Degradation (v1-Split)", () => {
    // Zwei Daecher 30/70 m2, Form 100/200 W/kWp, Bestand 10 kWp x 0,9.
    const roofs = [
      roof({ roofId: "a", areaM2: 30, power: 100 }),
      roof({ roofId: "b", areaM2: 70, power: 200 }),
    ];
    const { existingPvKwh, annualKwh } = buildExistingPvSeriesV2({
      roofs,
      existingKwp: 10,
      degradationFactor: 0.9,
    });
    expect(existingPvKwh).toHaveLength(QUARTER_HOUR_SLOTS);
    expect(neumaierSum(existingPvKwh)).toBeCloseTo(annualKwh, 6);
    // Dach a: 10 x 0,3 x 0,9 = 2,7 kWp x 100 W -> 67,5 Wh/Viertel.
    // Dach b: 10 x 0,7 x 0,9 = 6,3 kWp x 200 W -> 315 Wh/Viertel.
    expect(existingPvKwh[0]).toBeCloseTo(
      (100 * 2.7 + 200 * 6.3) * 0.25 / 1000,
      12,
    );
    // Jahresenergie: Bestand x Degradation x mittlerer Ertrag je kWp.
    // Mittlerer Ertrag: (0,3x100 + 0,7x200) W/kWp x 8760 h /1000.
    const meanYield = (0.3 * 100 + 0.7 * 200) * 8760 / 1000;
    expect(annualKwh).toBeCloseTo(10 * 0.9 * meanYield, 6);
  });

  it("verweigert leere/kranke Eingaben fail-closed", () => {
    const good = roof({ roofId: "a", areaM2: 30, power: 100 });
    expect(() => buildExistingPvSeriesV2({
      roofs: [],
      existingKwp: 10,
      degradationFactor: 0.9,
    })).toThrow();
    expect(() => buildExistingPvSeriesV2({
      roofs: [good],
      existingKwp: 0,
      degradationFactor: 0.9,
    })).toThrow();
    expect(() => buildExistingPvSeriesV2({
      roofs: [good],
      existingKwp: 10,
      degradationFactor: 0,
    })).toThrow();
    expect(() => buildExistingPvSeriesV2({
      roofs: [good],
      existingKwp: 10,
      degradationFactor: 1.5,
    })).toThrow();
    expect(() => buildExistingPvSeriesV2({
      roofs: [{ ...good, areaM2: -3 }],
      existingKwp: 10,
      degradationFactor: 0.9,
    })).toThrow();
    expect(() => buildExistingPvSeriesV2({
      roofs: [{ ...good, newPowerWPerKwp: [1, 2, 3] }],
      existingKwp: 10,
      degradationFactor: 0.9,
    })).toThrow();
  });
});
