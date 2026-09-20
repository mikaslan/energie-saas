import { describe, expect, it } from "vitest";

import * as engineV2 from "@/lib/integrations/calculation/engine-v2";
import {
  cyclicSocStartTou,
  dispatchQuarterHoursTou,
  touDayPolicy,
  type TouDayPolicy,
} from "@/lib/integrations/calculation/tou-dispatch-v2";
import * as touDispatchV2 from "@/lib/integrations/calculation/tou-dispatch-v2";

// F4-04h Batterie-Degradation/SOH (RED, Ref docs/spec/F4-04h-speicher-degradation.md):
// NUR existierende Imports — kein Import aus noch nicht geschriebenem Code
// (neue Symbole werden per Namespace-Cast geprueft, f405c-Vorbild).
// ROT-Beleg per `npx tsx scripts/run-tests.mts tests/unit/f404h-degradation.red.test.ts`
// (5 rote Tests, Auszug in der Spec); danach describe.skip bis zur Umsetzung.
// SKIP-Grund: SPECIFIED, nicht implementiert (SOH-Modell + TOU-Zyklenausweis +
// 04g-Fallback-Vorrang offen) — Ref F4-04g §3 (Fallback bleibt),
// F4-04b Frage 2, run-v2.ts:300-302 (storageFullCycles),
// tou-dispatch-v2.ts:95-99 (Arbitrage-Marge).

const STORAGE = {
  capacityKwh: 10,
  socMinKwh: 0,
  socMaxKwh: 10,
  chargeKw: 5,
  dischargeKw: 5,
  etaCharge: 0.95,
  etaDischarge: 0.95,
};

// Sortiert: [0..6] = 35,5 → P25 = 35,5; [11..12] = 40 → Median = 40;
// Spanne 4,5 (nicht flach); Marge 40 × 0,9025 − 35,5 = 0,6 (f404g-Vorbild).
const MARGINAL_PRICES = [
  35.5, 35.5, 35.5, 35.5, 35.5, 35.5, 35.5,
  38, 38, 38, 38,
  40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40,
];

describe.skip("F4-04h Batterie-Degradation/SOH (RED, SPECIFIED)", () => {
  it("Zyklenzaehlung: TOU-Totals weisen Vollzyklen-Aequivalente aus (Entlade-Durchsatz / nutzbar)", () => {
    // Pin: storageFullCycles = dischargeOut / usable (run-v2.ts:300-302),
    // hier auf TOU-Totals uebertragen (F4-04h §1). Heute: Feld fehlt.
    const pvKwh = new Array(96).fill(0);
    const loadKwh = new Array(96).fill(0.25);
    const { totals } = dispatchQuarterHoursTou({
      pvKwh,
      loadKwh,
      storage: STORAGE,
      socStartKwh: cyclicSocStartTou({
        pvKwh,
        loadKwh,
        storage: STORAGE,
        touPricesCt: MARGINAL_PRICES,
      }),
      touPricesCt: MARGINAL_PRICES,
    });
    expect(totals.dischargeOutKwh).toBeGreaterThan(0);
    const expected = totals.dischargeOutKwh / (STORAGE.socMaxKwh - STORAGE.socMinKwh);
    const withCycles = totals as typeof totals & { storageFullCycles?: unknown };
    expect(withCycles.storageFullCycles).toBeCloseTo(expected, 10);
  });

  it("SOH-Modell: sohForYear existiert, monoton fallend, begrenzt (ESTIMATE-Parameter)", () => {
    // Spec F4-04h §2: SOH(t) = max(Boden, 1 − kal×t − zyk×kumFEC).
    const sohForYear = (engineV2 as unknown as Record<string, unknown>).sohForYear;
    expect(typeof sohForYear).toBe("function");
    const soh = sohForYear as (input: {
      year: number;
      cumulativeFullCycles: number;
      calendarFadePerYear: number;
      cycleFadePerFullCycle: number;
      sohFloor: number;
    }) => number;
    const drift = {
      cumulativeFullCycles: 250,
      calendarFadePerYear: 0.008,
      cycleFadePerFullCycle: 0.00005,
      sohFloor: 0.7,
    };
    const early = soh({ ...drift, year: 1 });
    const late = soh({ ...drift, year: 10, cumulativeFullCycles: 2500 });
    expect(early).toBeLessThanOrEqual(1);
    expect(late).toBeLessThan(early);
    expect(late).toBeGreaterThanOrEqual(0.7);
    expect(soh({ ...drift, year: 100, cumulativeFullCycles: 100_000 })).toBe(0.7);
  });

  it("04g-Kompatibilitaet: Degradationskosten-Param senkt Netzladung (Marge 0,6 < 0,5 + 1)", () => {
    // F4-04g §3 bleibt Fallback (Default 0 = Status quo): ohne Param
    // erlaubt (Pin), mit Param = 1 verboten. Heute: Param unbekannt.
    const plain = touDayPolicy(MARGINAL_PRICES, STORAGE);
    expect(plain.gridChargeAllowed).toBe(true);
    const withCost = (touDayPolicy as (...args: unknown[]) => TouDayPolicy)(
      MARGINAL_PRICES,
      STORAGE,
      { degradationCostCtPerKwhThroughput: 1 },
    );
    expect(withCost.gridChargeAllowed).toBe(false);
  });

  it("Null-Drift-Default: SOH bleibt 1 ohne belegte Drift (Status quo, Althashes stabil)", () => {
    // Alle Fade-Defaults 0 → kein Kapazitaetsverlust in 20 Jahren.
    const sohForYear = (engineV2 as unknown as Record<string, unknown>).sohForYear;
    expect(typeof sohForYear).toBe("function");
    const soh = sohForYear as (input: {
      year: number;
      cumulativeFullCycles: number;
      calendarFadePerYear: number;
      cycleFadePerFullCycle: number;
      sohFloor: number;
    }) => number;
    for (const year of [1, 10, 20]) {
      expect(soh({
        year,
        cumulativeFullCycles: 5000,
        calendarFadePerYear: 0,
        cycleFadePerFullCycle: 0,
        sohFloor: 0.7,
      })).toBe(1);
    }
  });

  it("Arbitrage-Kalkuel: abgeleitete Durchsatzkosten + Doppelbelegung fail-closed", () => {
    // Spec F4-04h §4: H-Parameter leiten Kosten ab; gleichzeitig belegter
    // 04g-Param → Formfehler (kein stiller Vorrang, 24/8760-Analogie).
    const resolveCost = (touDispatchV2 as unknown as Record<string, unknown>)
      .resolveDegradationCostCt;
    expect(typeof resolveCost).toBe("function");
    const resolve = resolveCost as (input: {
      degradationCostCtPerKwhThroughput?: number;
      storageDegradation?: {
        cycleFadePerFullCycle: number;
        replacementCostEuroPerKwh: number;
      };
    }) => number;
    expect(() => resolve({
      degradationCostCtPerKwhThroughput: 1,
      storageDegradation: { cycleFadePerFullCycle: 0.00005, replacementCostEuroPerKwh: 600 },
    })).toThrow();
    expect(resolve({
      storageDegradation: { cycleFadePerFullCycle: 0.00005, replacementCostEuroPerKwh: 600 },
    })).toBeGreaterThan(0);
  });
});
