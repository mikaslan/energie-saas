import { describe, expect, it } from "vitest";

import {
  computeEconomics,
  eegDefaultForYear,
  ECONOMICS_DEGRADATION_RATE,
  ECONOMICS_HORIZON_YEARS,
  POST_EEG_MARKET_VALUE_CT,
  resolveEconomics,
  roundMoney,
} from "@/lib/integrations/calculation/economics-v2";

// F4.5 Wirtschaftlichkeit (Spec F4-05): Tarifkaskade, Cashflow-Reihe,
// Amortisation, IRR, Rundung, Fail-closed-Pfade.

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
const unknown = () => ({ status: "unknown", value: null, source: "not_collected" });

describe("economics resolution", () => {
  it("pinnt Horizont, Degradation und Post-EEG-Marktwert", () => {
    expect(ECONOMICS_HORIZON_YEARS).toBe(20);
    expect(ECONOMICS_DEGRADATION_RATE).toBe(0.005);
    expect(POST_EEG_MARKET_VALUE_CT).toBe(3.5);
  });

  it("loest Override vor EEG-Default vor Post-EEG auf", () => {
    const currentYear = new Date().getFullYear();
    // Override gewinnt immer.
    const overridden = resolveEconomics(consumption({
      feedInTariffCtPerKwh: known(5),
      feedInCommissioningYear: known(2000),
    }))!;
    expect(overridden.feedInTariffCtPerKwh).toBe(5);
    expect(overridden.feedInTariffSource).toBe("override");
    // Aktuelles Jahr: EEG-Default aus Tabelle.
    const eeg = resolveEconomics(consumption({
      feedInCommissioningYear: known(currentYear),
    }))!;
    expect(eeg.feedInTariffSource).toBe("eeg_default");
    expect(eeg.feedInTariffCtPerKwh).toBe(eegDefaultForYear(currentYear));
    // Ohne Jahr: laufendes Jahr.
    const implicit = resolveEconomics(consumption())!;
    expect(implicit.feedInTariffSource).toBe("eeg_default");
    expect(implicit.feedInTariffCtPerKwh).toBe(eegDefaultForYear(currentYear));
    // Altanlage (>20 Jahre): Post-EEG-Marktwert.
    const old = resolveEconomics(consumption({
      feedInCommissioningYear: known(currentYear - 25),
    }))!;
    expect(old.feedInTariffSource).toBe("post_eeg");
    expect(old.feedInTariffCtPerKwh).toBe(POST_EEG_MARKET_VALUE_CT);
    // Eskalation aus Profil, Default 0.
    expect(implicit.priceEscalationRate).toBe(0);
    const escalated = resolveEconomics(consumption({
      annualPriceIncreasePercent: known(3),
    }))!;
    expect(escalated.priceEscalationRate).toBeCloseTo(0.03, 12);
    expect(escalated.horizonYears).toBe(ECONOMICS_HORIZON_YEARS);
  });

  it("bleibt ohne Preis oder Investition unbelegt (kein erfundenes Geld)", () => {
    expect(resolveEconomics(consumption({
      electricityPriceCentsPerKwh: unknown(),
    }))).toBeNull();
    expect(resolveEconomics(consumption({ investmentEuro: unknown() }))).toBeNull();
  });

  it("bricht bei Bereichsverletzungen fail-closed ab", () => {
    expect(() => resolveEconomics(consumption({
      electricityPriceCentsPerKwh: known(0.5),
    }))).toThrow();
    expect(() => resolveEconomics(consumption({ investmentEuro: known(-1) }))).toThrow();
    expect(() => resolveEconomics(consumption({ feedInTariffCtPerKwh: known(101) }))).toThrow();
    expect(() => resolveEconomics(consumption({ feedInCommissioningYear: known(1989) }))).toThrow();
  });
});

describe("economics workspace fallback (F4.5b)", () => {
  const workspace = {
    settingsRevision: 3,
    electricityPriceNetCentsPerKwh: 30,
    escalationRateBps: 200,
    cashflowHorizonYears: 15,
  };

  it("fuellt Profil-Luecken aus Workspace-Defaults (Profil gewinnt)", () => {
    // Preis fehlt im Profil -> Workspace 30 Ct, Quelle workspace_default.
    const filled = resolveEconomics(
      consumption({ electricityPriceCentsPerKwh: unknown() }),
      workspace,
    )!;
    expect(filled.importPriceCtPerKwh).toBe(30);
    expect(filled.priceSource).toBe("workspace_default");
    expect(filled.settingsRevision).toBe(3);
    // Eskalation 200 bps = 2 % (Profil unbekannt).
    expect(filled.priceEscalationRate).toBeCloseTo(0.02, 12);
    // Horizont aus Workspace.
    expect(filled.horizonYears).toBe(15);
    // Profilpreis gewinnt ueber Workspace; Eskalations-Luecke fuellt der
    // Fallback trotzdem (Profil-Eskalation ist unknown).
    const profile = resolveEconomics(consumption(), workspace)!;
    expect(profile.importPriceCtPerKwh).toBe(36);
    expect(profile.priceSource).toBe("profile");
    expect(profile.settingsRevision).toBe(3);
    expect(profile.priceEscalationRate).toBeCloseTo(0.02, 12);
    expect(profile.horizonYears).toBe(15);
  });

  it("bleibt ohne Preis ueberall unbelegt; Muell-Fallback zaehlt nicht", () => {
    expect(resolveEconomics(
      consumption({ electricityPriceCentsPerKwh: unknown() }),
      null,
    )).toBeNull();
    // Fallback-Preis 0 oder >200: unbelegt statt Fehler.
    for (const bad of [0, 500]) {
      expect(resolveEconomics(
        consumption({ electricityPriceCentsPerKwh: unknown() }),
        { ...workspace, electricityPriceNetCentsPerKwh: bad },
      )).toBeNull();
    }
    // Unbrauchbarer Horizont: fail-closed.
    expect(() => resolveEconomics(consumption(), {
      ...workspace,
      cashflowHorizonYears: 99,
    })).toThrow();
  });
});

describe("economics computation", () => {
  const annual = {
    generationKwh: 10_000,
    selfConsumptionKwh: 4_000,
    feedInKwh: 6_000,
    consumptionKwh: 7_000,
    gridImportKwh: 3_000,
  };
  const input = {
    importPriceCtPerKwh: 36,
    priceEscalationRate: 0,
    feedInTariffCtPerKwh: 8,
    feedInTariffSource: "eeg_default" as const,
    investmentEuro: 20_000,
    alternativeImportPriceCtPerKwh: null,
    horizonYears: 20,
    priceSource: "profile" as const,
    settingsRevision: 0,
  };

  it("rechnet Jahresersparnis, Cashflow und Amortisation exakt", () => {
    const result = computeEconomics(annual, input);
    // Jahr 1: 4000 × 0,36 + 6000 × 0,08 = 1440 + 480 = 1920.
    expect(result.annualSavingsEuro).toBe(1_920);
    expect(result.cumulativeCashflowEuro).toHaveLength(20);
    // Jahr 1 kumuliert: -20000 + 1920 = -18080.
    expect(result.cumulativeCashflowEuro[0]).toBe(-18_080);
    // Degradation senkt Folgejahre: kumuliert Jahr 2 < 2 × Jahr-1-Effekt.
    const second = result.cumulativeCashflowEuro[1]! - result.cumulativeCashflowEuro[0]!;
    expect(second).toBeLessThan(1_920);
    expect(second).toBeGreaterThan(0);
    // Amortisation: kumuliert erreicht 0 (ca. Jahr 11-12 bei Degradation).
    expect(result.amortizationYears).not.toBeNull();
    const year = result.amortizationYears!;
    expect(result.cumulativeCashflowEuro[year - 1]).toBeGreaterThanOrEqual(0);
    expect(result.cumulativeCashflowEuro[year - 2]).toBeLessThan(0);
    // F4.4a Konsistenz (exakt): noPv − current = self × Preis;
    // Ersparnis liegt darüber um feed × Vergütung.
    expect(result.annualBillsEuro).toEqual({
      noPvEuro: 2_520,
      currentEuro: 1_080,
      newTariffEuro: null,
    });
    expect(
      result.annualBillsEuro.noPvEuro - result.annualBillsEuro.currentEuro,
    ).toBe(1_440);
    expect(result.annualSavingsEuro - 1_440).toBe(480);
  });

  it("rechnet F4.4a-Neutarif-Rechnung (null ohne Neutarif)", () => {
    const plain = computeEconomics(
      {
        generationKwh: 10_000,
        selfConsumptionKwh: 4_000,
        feedInKwh: 6_000,
        consumptionKwh: 7_000,
        gridImportKwh: 3_000,
      },
      {
        importPriceCtPerKwh: 36,
        priceEscalationRate: 0,
        feedInTariffCtPerKwh: 8,
        feedInTariffSource: "override",
        investmentEuro: 20_000,
        alternativeImportPriceCtPerKwh: 28,
        horizonYears: 20,
        priceSource: "profile",
        settingsRevision: 0,
      },
    );
    expect(plain.annualBillsEuro).toEqual({
      noPvEuro: 2_520,
      currentEuro: 1_080,
      newTariffEuro: 840,
    });
  });

  it("meldet nie-Amortisation; negativer IRR ist ein ehrlicher Wert", () => {
    const expensive = computeEconomics(annual, { ...input, investmentEuro: 1_000_000 });
    expect(expensive.amortizationYears).toBeNull();
    // Kapitalvernichtung hat einen (negativen) internen Zins, kein null.
    expect(expensive.irr).not.toBeNull();
    expect(expensive.irr!).toBeLessThan(0);
    // Wirklich undefiniert nur ohne jeden Zahlungsfluss.
    const flat = computeEconomics(
      {
      generationKwh: 0,
      selfConsumptionKwh: 0,
      feedInKwh: 0,
      consumptionKwh: 0,
      gridImportKwh: 0,
    },
      { ...input, investmentEuro: 0 },
    );
    expect(flat.irr).toBeNull();
    // Kein Ertrag: keine Ersparnis, keine Amortisation.
    const idle = computeEconomics(
      {
      generationKwh: 0,
      selfConsumptionKwh: 0,
      feedInKwh: 0,
      consumptionKwh: 0,
      gridImportKwh: 0,
    },
      input,
    );
    expect(idle.annualSavingsEuro).toBe(0);
    expect(idle.amortizationYears).toBeNull();
    expect(idle.irr).toBeNull();
  });

  it("loest IRR gegen den geschlossenen Einjahres-Fall", () => {
    // -1000 + 1100 in Jahr 1, Rest 0: IRR = 10 %.
    const one = computeEconomics(
      {
      generationKwh: 1_100,
      selfConsumptionKwh: 1_100,
      feedInKwh: 0,
      consumptionKwh: 1_100,
      gridImportKwh: 0,
    },
      {
        importPriceCtPerKwh: 100,
        priceEscalationRate: -1,
        feedInTariffCtPerKwh: 0,
        feedInTariffSource: "override",
        investmentEuro: 1_000,
        alternativeImportPriceCtPerKwh: null,
        horizonYears: 20,
        priceSource: "profile",
        settingsRevision: 0,
      },
    );
    // Eskalation -100 %: nur Jahr 1 zahlt (1100 × 1,00), Rest 0.
    expect(one.annualSavingsEuro).toBe(1_100);
    expect(one.irr).not.toBeNull();
    expect(one.irr!).toBeCloseTo(0.1, 6);
    expect(one.amortizationYears).toBe(1);
  });

  it("behandelt Investition 0 als sofort amortisiert ohne IRR", () => {
    const free = computeEconomics(annual, { ...input, investmentEuro: 0 });
    expect(free.amortizationYears).toBe(0);
    expect(free.irr).toBeNull();
  });

  it("rundet Geld auf Cent und bricht bei Muell ab", () => {
    // 1.125 ist binaer exakt (1/8) -> deterministisch 1.13; 1.005 ist
    // binaer 1.00499… und rundet ehrlich auf 1.00 (kein Dezimal-Runden).
    expect(roundMoney(1.125)).toBe(1.13);
    expect(roundMoney(1.005)).toBe(1);
    expect(roundMoney(-0.001)).toBe(0);
    expect(Object.is(roundMoney(-0.001), -0)).toBe(false);
    expect(() => roundMoney(Number.NaN)).toThrow();
    expect(() => computeEconomics(
      {
      generationKwh: -1,
      selfConsumptionKwh: 0,
      feedInKwh: 0,
      consumptionKwh: 0,
      gridImportKwh: 0,
    },
      input,
    )).toThrow();
    expect(() => computeEconomics(annual, { ...input, horizonYears: 0 })).toThrow();
    expect(() => computeEconomics(annual, { ...input, horizonYears: 51 })).toThrow();
  });

  it("eskaliert den Bezugspreis, nicht die Verguetung", () => {
    const flat = computeEconomics(annual, input);
    const esc = computeEconomics(annual, { ...input, priceEscalationRate: 0.05 });
    // Jahr-1-Ersparnis identisch (Eskalation wirkt erst ab Jahr 2).
    expect(esc.annualSavingsEuro).toBe(flat.annualSavingsEuro);
    // Kumuliert Jahr 20 klar hoeher (Bezugspreis-Anteil waechst).
    expect(esc.cumulativeCashflowEuro[19]).toBeGreaterThan(flat.cumulativeCashflowEuro[19]);
    // Reine Einspeisung ohne Eigenverbrauch: Eskalation wirkungslos.
    const feedOnly = {
    generationKwh: 6_000,
    selfConsumptionKwh: 0,
    feedInKwh: 6_000,
    consumptionKwh: 4_200,
    gridImportKwh: 4_200,
  };
    const a = computeEconomics(feedOnly, input);
    const b = computeEconomics(feedOnly, { ...input, priceEscalationRate: 0.05 });
    expect(b.cumulativeCashflowEuro[19]).toBeCloseTo(a.cumulativeCashflowEuro[19], 6);
  });
});
