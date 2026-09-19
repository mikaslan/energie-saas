import { describe, expect, it } from "vitest";

import {
  computeEconomics,
  computeTouBillEuro,
  resolveTouImportPrices,
  roundMoney,
  type EconomicsInputV2,
} from "@/lib/integrations/calculation/economics-v2";
import {
  cyclicSocStartTou,
  dispatchQuarterHoursTou,
  touDayPolicy,
} from "@/lib/integrations/calculation/tou-dispatch-v2";

// F4-04g Day-ahead + TOU-Haertung (RED, Ref docs/spec/F4-04g-day-ahead-tou-haertung.md):
// NUR existierende Imports — kein Import aus noch nicht geschriebenem Code.
// ROT-Beleg per `npx vitest run tests/unit/f404g-day-ahead.red.test.ts`
// (6 rote Tests, Auszug in der Spec); danach describe.skip bis zur Umsetzung.
// SKIP-Grund: SPECIFIED, nicht implementiert (G3-Fix + Day-ahead-Slice offen,
// statisches 24-h-Profil als V1 eingefroren) — Ref F4-04b Offene Fragen 2-4,
// run-v2.ts:597 (savingsVsFlat), economics-v2.ts:360-383 (computeTouBillEuro).

const STORAGE = {
  capacityKwh: 10,
  socMinKwh: 0,
  socMaxKwh: 10,
  chargeKw: 5,
  dischargeKw: 5,
  etaCharge: 0.95,
  etaDischarge: 0.95,
};

const FLAT36 = new Array(24).fill(36);

const touKnown = (value: unknown) => ({
  status: "known",
  value,
  source: "operator_reviewed",
});

// Sortiert: [0..6] = 35,5 → P25 = 35,5; [11..12] = 40 → Median = 40;
// Spanne 4,5 (nicht flach); Marge 40 × 0,9025 − 35,5 = 0,6.
const MARGINAL_PRICES = [
  35.5, 35.5, 35.5, 35.5, 35.5, 35.5, 35.5,
  38, 38, 38, 38,
  40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40,
];

function economicsInput(overrides: Partial<EconomicsInputV2> = {}): EconomicsInputV2 {
  return {
    importPriceCtPerKwh: 36,
    priceEscalationRate: 0,
    feedInTariffCtPerKwh: 8,
    feedInTariffSource: "override",
    investmentEuro: 20_000,
    alternativeImportPriceCtPerKwh: null,
    horizonYears: 20,
    priceSource: "profile",
    settingsRevision: 0,
    ...overrides,
  };
}

type Annual96 = {
  generationKwh: number;
  selfConsumptionKwh: number;
  feedInKwh: number;
  consumptionKwh: number;
  gridImportKwh: number;
  peakImportKw?: number;
  noPvPeakImportKw?: number;
};

function annual96(overrides: Partial<Annual96> = {}): Annual96 {
  return {
    generationKwh: 0,
    selfConsumptionKwh: 0,
    feedInKwh: 0,
    consumptionKwh: 96,
    gridImportKwh: 96,
    ...overrides,
  };
}

describe.skip("F4-04g Day-ahead + TOU-Haertung (RED, SPECIFIED)", () => {
  it("Day-ahead: 8760-Preisvektor wird aufgeloest (CSV-Import)", () => {
    // Heute: resolveTouImportPrices nimmt nur exakt 24 Preise (sonst null).
    const vector = new Array(8760).fill(30);
    expect(resolveTouImportPrices({ touImportPricesCtPerKwh: touKnown(vector) })).not.toBeNull();
  });

  it("Day-ahead: TOU-Bill honoriert 8760-Preisvektor tagesspezifisch", () => {
    // 2 Tage × 96 kWh; Tag 2 faellt in teure Day-ahead-Stunden (60 Ct).
    // Heute: jede Nicht-24-Laenge wirft (economics-v2.ts:367-369).
    const imports = new Array(2 * 96).fill(1);
    const dayAhead = new Array(8760).fill(20);
    dayAhead.fill(60, 24, 48);
    // Tag 1: 96 × 20 Ct = 19,20 EUR; Tag 2: 96 × 60 Ct = 57,60 EUR.
    expect(computeTouBillEuro(imports, dayAhead)).toBeCloseTo(76.8, 10);
  });

  it("G3: TOU-Bill enthaelt Grundpreis bei belegtem Grundpreis", () => {
    // Gleiche kWh, gleicher Arbeitspreis: TOU-Bill muss der
    // Flattarif-Rechnung mit Grundpreis gleichen (heute: nur Arbeit).
    const touBill = computeTouBillEuro(new Array(96).fill(1), FLAT36);
    const flat = computeEconomics(
      annual96(),
      economicsInput({ baseFeeEuro: 120 }),
    );
    expect(touBill).toBe(flat.annualBillsEuro.currentEuro);
  });

  it("G3: TOU-Bill enthaelt TOU-Dispatch-Spitze × Satz", () => {
    // Spec: Bill = Arbeit + TOU-Spitze × Satz (8,5 kW × 100 = 850);
    // die 8,5 kW stehen hier fuer die TOU-Dispatch-Spitze (fail-closed
    // wie F4-04e — fehlende Spitze bei belegtem Satz wirft).
    const touBill = computeTouBillEuro(new Array(96).fill(1), FLAT36);
    const flat = computeEconomics(
      annual96({ peakImportKw: 8.5, noPvPeakImportKw: 12 }),
      economicsInput({ demandChargeEuroPerKw: 100 }),
    );
    expect(touBill).toBe(flat.annualBillsEuro.currentEuro);
  });

  it("Zyklenkosten-Param senkt Netzladung (Marge 0,6 < 0,5 + 1)", () => {
    const policy = touDayPolicy(MARGINAL_PRICES, STORAGE);
    // Marge pinnen: Median 40, P25 35,5 → heute ≥ 0,5 erlaubt.
    expect(policy.dischargeFromCt).toBe(40);
    expect(policy.gridChargeUpToCt).toBe(35.5);
    expect(policy.flatDay).toBe(false);
    // F4-04g(c): mit degradationCostCtPerKwhThroughput = 1 (Default 0)
    // waere 0,6 < 0,5 + 1 → Netzladung verboten. Heute ohne Param erlaubt.
    expect(policy.gridChargeAllowed).toBe(false);
    // Dispatch-Ebene: ohne Netzladung kein Arbitrage-Volumen.
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
    expect(totals.gridChargeInKwh).toBe(0);
  });

  it("savingsVsFlat ohne Fixkosten-Artefakt (gleiche Preise → 0)", () => {
    // run-v2.ts:597 rechnet currentEuro (mit Grundpreis) minus TOU-Bill
    // (nur Arbeit): bei gleichen kWh/Preisen ein Phantom-Bonus von 120.
    // Spec: savingsVsFlat gegen arbeitspreisbereinigte Rechnung.
    const touBill = computeTouBillEuro(new Array(96).fill(1), FLAT36);
    const flat = computeEconomics(
      annual96(),
      economicsInput({ baseFeeEuro: 120 }),
    );
    expect(roundMoney(flat.annualBillsEuro.currentEuro - touBill)).toBe(0);
  });
});
