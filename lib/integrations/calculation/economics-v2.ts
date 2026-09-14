/**
 * F4.5 Wirtschaftlichkeitskern (Spec F4-05): Tarifauflösung aus belegtem
 * Profil + Geldrechnung aus Engine-Jahreswerten (Neuanlage).
 *
 * Auflösung (resolveEconomics): Bezugspreis (Profil, Pflicht) +
 * Eskalation (Profil oder 0) + Einspeisekaskade (Override > Post-EEG >
 * Länderdefault) + Investition (Profil, Pflicht). Fehlen Preis oder
 * Investition, ist Wirtschaftlichkeit nicht berechenbar -> null (kein
 * erfundenes Geld, kein Fehler).
 *
 * Bewusste, versionierte ESTIMATE-Entscheidungen (keine behauptete
 * Reonic-Parität; REVIEW-Pflicht in der Spec):
 * - EEG-Tabelle: DE Überschusseinspeisung ≤10 kWp, Ct/kWh, gerundete
 *   Vergütungssätze als Näherung (kein Clearingstellen-Beleg im Repo).
 * - Post-EEG-Marktwert 3,5 Ct/kWh (Größenordnung Marktwert Solar).
 * - Degradation 0,5 %/Jahr auf die Erzeugung; Eigenverbrauch und
 *   Einspeisung skalieren mit der Erzeugungsquote, Last konstant.
 * - Vergütung 20 Jahre fix (EEG-Logik); Bezugspreis eskaliert.
 * - Geld rundet auf Cent.
 * - F4-04e Leistungspreis (€/kW Jahresspitze je Tarif, ESTIMATE): Spitze
 *   exakt aus der Viertelstunden-Simulation (max Netzbezugs-Slot × 4),
 *   konstant über Horizont ohne Eskalation (wie Grundpreis). Nur in den
 *   Rechnungen (Jahr 1 + Serie); Ersparnis/Cashflow/IRR bleiben
 *   unberührt — die Spitzenkappung ist im Rechnungsvergleich sichtbar
 *   (noPv- vs. current-Rechnung), nicht in der Ersparnis-Definition.
 */
import { F401EngineError } from "./engine-v2";

export const ECONOMICS_V2_VERSION = "wmee-economics.v1" as const;

/** Wirtschaftlichkeits-Horizont [Jahre] (F4.5b übernimmt Workspace-Wert). */
export const ECONOMICS_HORIZON_YEARS = 20;

/** Jährliche Erzeugungs-Degradation (ESTIMATE). */
export const ECONOMICS_DEGRADATION_RATE = 0.005;

/**
 * EEG-Länderdefault DE [Inbetriebnahmejahr, Ct/kWh] (ESTIMATE, REVIEW).
 * Überschusseinspeisung ≤10 kWp, gerundete Vergütungssätze.
 */
export const EEG_FEED_IN_DEFAULT_CT: ReadonlyArray<readonly [number, number]> = [
  [2020, 9.0],
  [2021, 7.5],
  [2022, 8.2],
  [2023, 8.2],
  [2024, 8.03],
  [2025, 7.87],
  [2026, 7.5],
];

/** Post-EEG-Marktwert [Ct/kWh] (ESTIMATE, Größenordnung Marktwert Solar). */
export const POST_EEG_MARKET_VALUE_CT = 3.5;

/** EEG-Förderdauer [Jahre] (Anlagenalter-Regel). */
export const EEG_SUPPORT_YEARS = 20;

function economicsError(detail: string): never {
  throw new F401EngineError(`Wirtschaftlichkeit v2 verletzt: ${detail}`);
}

/** Geld auf Cent runden (kein -0). */
export function roundMoney(value: number): number {
  if (!Number.isFinite(value)) economicsError("Geldbetrag ist nicht endlich");
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export type FeedInTariffSource = "override" | "eeg_default" | "post_eeg";

export type EconomicsPriceSource = "profile" | "workspace_default";

/** F4-04f Vergleichstarif (voll aufgelöst, keine Nulls — Fallbacks gebacken). */
export type ComparisonTariffV2 = {
  name: string;
  importPriceCtPerKwh: number;
  priceEscalationRate: number;
  baseFeeEuro: number;
  demandChargeEuroPerKw: number;
};

/** F4-04f Obergrenze Vergleichstarife (ESTIMATE, UI-Formular fix 3 Gruppen). */
export const COMPARISON_TARIFFS_MAX = 3;

export type EconomicsInputV2 = {
  importPriceCtPerKwh: number;
  priceEscalationRate: number;
  feedInTariffCtPerKwh: number;
  feedInTariffSource: FeedInTariffSource;
  investmentEuro: number;
  /** Optionaler Neutarif [Ct/kWh] für den Jahr-1-Vergleich (F4.4a). */
  alternativeImportPriceCtPerKwh: number | null;
  /**
   * Optionale Neutarif-Eskalation [Rate] für die Mehrjahres-Serie
   * (F4-04c). Fehlt der Schlüssel, gilt die aktuelle Eskalation
   * (dokumentiert) — Althashes bleiben ohne Neutarif-Eskalation stabil.
   */
  alternativePriceEscalationRate?: number;
  /**
   * F4-04d Grundpreis je Tarif [€/Jahr], konstant über Horizont.
   * Fehlende Schlüssel = 0 (Althashes stabil).
   */
  baseFeeEuro?: number;
  alternativeBaseFeeEuro?: number;
  /**
   * F4-04e Leistungspreis je Tarif [€/kW Jahresspitze], konstant über
   * Horizont. Fehlende Schlüssel = 0 (Althashes stabil).
   */
  demandChargeEuroPerKw?: number;
  alternativeDemandChargeEuroPerKw?: number;
  /**
   * F4-04f zusätzliche Vergleichstarife (nur bei belegtem Profilfeld;
   * sonst fehlt der Schlüssel und Althashes bleiben stabil).
   */
  comparisonTariffs?: ComparisonTariffV2[];
  horizonYears: number;
  /** Herkunft des Bezugspreises (F4.5b Workspace-Fallback). */
  priceSource: EconomicsPriceSource;
  /** Workspace-Settings-Revision (0 = Profil-allein, kein Fallback). */
  settingsRevision: number;
};

/**
 * F4.5b Workspace-Fallback (eingefrorene F4.6-Defaults aus der
 * Preparation; Bereiche s. workspaceEconomicsV2Schema).
 */
export type EconomicsWorkspaceFallbackV2 = {
  settingsRevision: number;
  electricityPriceNetCentsPerKwh: number | null;
  escalationRateBps: number | null;
  cashflowHorizonYears: number;
};

function knownNumber(entry: unknown): number | null {
  const candidate = entry as { status?: unknown; value?: unknown } | undefined;
  if (candidate === undefined || candidate === null || candidate.status !== "known") return null;
  return typeof candidate.value === "number" && Number.isFinite(candidate.value)
    ? candidate.value
    : null;
}

/** EEG-Default für ein Inbetriebnahmejahr (nächstkleineres Tabellenjahr). */
export function eegDefaultForYear(year: number): number {
  let rate = EEG_FEED_IN_DEFAULT_CT[0]![1];
  for (const [tableYear, tableRate] of EEG_FEED_IN_DEFAULT_CT) {
    if (tableYear <= year) rate = tableRate;
    else break;
  }
  return rate;
}

/**
 * Tarifauflösung aus belegtem Verbrauchsprofil + optionalem
 * Workspace-Fallback (F4.5b) als Request-Baustein. Profil gewinnt immer;
 * Fallback füllt nur Profil-Lücken (Preis, Eskalation, Horizont).
 * Gibt null zurück, wenn Preis oder Investition unbelegt bleiben.
 */
export function resolveEconomics(
  consumption: unknown,
  workspace?: EconomicsWorkspaceFallbackV2 | null,
): EconomicsInputV2 | null {
  const holder = (consumption ?? {}) as Record<string, unknown>;
  const fallback = workspace ?? null;
  const fallbackPrice = fallback?.electricityPriceNetCentsPerKwh ?? null;
  const usableFallbackPrice = fallbackPrice !== null
    && Number.isFinite(fallbackPrice)
    && fallbackPrice >= 1
    && fallbackPrice <= 200
    ? fallbackPrice
    : null;
  const profilePrice = knownNumber(holder.electricityPriceCentsPerKwh);
  const importPriceCt = profilePrice ?? usableFallbackPrice;
  const investmentEuro = knownNumber(holder.investmentEuro);
  if (importPriceCt === null || investmentEuro === null) return null;
  if (profilePrice !== null && (profilePrice < 1 || profilePrice > 200)) {
    economicsError("Bezugspreis ausserhalb 1..200 Ct/kWh");
  }
  if (investmentEuro < 0 || investmentEuro > 10_000_000) {
    economicsError("Investition ausserhalb 0..10.000.000 €");
  }
  const profileEscalationPct = knownNumber(holder.annualPriceIncreasePercent);
  // Basispunkte -> Prozent (200 bps = 2 %); Rate (/100) erst im Return.
  const fallbackEscalationPct = fallback?.escalationRateBps == null
    ? null
    : fallback.escalationRateBps / 100;
  const escalationPct = profileEscalationPct ?? fallbackEscalationPct ?? 0;
  if (escalationPct < -10 || escalationPct > 25) {
    economicsError("Preiseskalation ausserhalb -10..25 %");
  }
  const horizonYears = fallback?.cashflowHorizonYears
    ?? ECONOMICS_HORIZON_YEARS;
  if (!Number.isInteger(horizonYears) || horizonYears < 1 || horizonYears > 50) {
    economicsError("Horizont ausserhalb 1..50 Jahre");
  }
  const alternativeCt = knownNumber(holder.alternativeImportPriceCtPerKwh);
  if (alternativeCt !== null && (alternativeCt < 1 || alternativeCt > 200)) {
    economicsError("Neutarif ausserhalb 1..200 Ct/kWh");
  }
  // F4-04c: Neutarif-Eskalation nur bei belegtem Profilfeld (sonst fehlt
  // der Schlüssel und Althashes bleiben stabil).
  const alternativeEscalationPct = knownNumber(holder.alternativeImportPriceEscalationPct);
  if (alternativeEscalationPct !== null
    && (alternativeEscalationPct < -10 || alternativeEscalationPct > 25)) {
    economicsError("Neutarif-Eskalation ausserhalb -10..25 %");
  }
  const overrideCt = knownNumber(holder.feedInTariffCtPerKwh);
  const commissioningYear = knownNumber(holder.feedInCommissioningYear);
  let feedInTariffCtPerKwh: number;
  let feedInTariffSource: FeedInTariffSource;
  if (overrideCt !== null) {
    if (overrideCt < 0 || overrideCt > 100) {
      economicsError("Einspeise-Override ausserhalb 0..100 Ct/kWh");
    }
    feedInTariffCtPerKwh = overrideCt;
    feedInTariffSource = "override";
  } else {
    const currentYear = new Date().getFullYear();
    const year = commissioningYear === null ? currentYear : Math.trunc(commissioningYear);
    if (year < 1990 || year > 2100) economicsError("Inbetriebnahmejahr ausserhalb 1990..2100");
    if (currentYear - year >= EEG_SUPPORT_YEARS) {
      feedInTariffCtPerKwh = POST_EEG_MARKET_VALUE_CT;
      feedInTariffSource = "post_eeg";
    } else {
      feedInTariffCtPerKwh = eegDefaultForYear(year);
      feedInTariffSource = "eeg_default";
    }
  }
  // F4-04d: Grundpreis nur bei belegtem Profilfeld (sonst fehlt der
  // Schlüssel und Althashes bleiben stabil). Bereich 0..100.000 €/Jahr.
  const baseFee = knownNumber(holder.baseFeeEuroPerYear);
  if (baseFee !== null && (baseFee < 0 || baseFee > 100_000)) {
    economicsError("Grundpreis ausserhalb 0..100000 Euro/Jahr");
  }
  const alternativeBaseFee = knownNumber(holder.alternativeBaseFeeEuroPerYear);
  if (alternativeBaseFee !== null && (alternativeBaseFee < 0 || alternativeBaseFee > 100_000)) {
    economicsError("Neutarif-Grundpreis ausserhalb 0..100000 Euro/Jahr");
  }
  // F4-04e: Leistungspreis nur bei belegtem Profilfeld (sonst fehlt der
  // Schlüssel und Althashes bleiben stabil). Bereich 0..10.000 €/kW/a.
  const demandCharge = knownNumber(holder.demandChargeEuroPerKw);
  if (demandCharge !== null && (demandCharge < 0 || demandCharge > 10_000)) {
    economicsError("Leistungspreis ausserhalb 0..10000 Euro/kW");
  }
  const alternativeDemandCharge = knownNumber(holder.alternativeDemandChargeEuroPerKw);
  if (alternativeDemandCharge !== null && (alternativeDemandCharge < 0 || alternativeDemandCharge > 10_000)) {
    economicsError("Neutarif-Leistungspreis ausserhalb 0..10000 Euro/kW");
  }
  // F4-04f: Vergleichstarife nur bei belegtem Profilfeld (sonst fehlt
  // der Schlüssel und Althashes bleiben stabil). Unbelegte Komponenten
  // fallen auf den aktuellen Tarif zurück (Haupt-Neutarif-Vorbild).
  const comparisonTariffs = resolveComparisonTariffs(
    holder.comparisonTariffs,
    {
      priceEscalationRate: escalationPct / 100,
      baseFeeEuro: baseFee ?? 0,
      demandChargeEuroPerKw: demandCharge ?? 0,
    },
  );
  return {
    importPriceCtPerKwh: importPriceCt,
    priceEscalationRate: escalationPct / 100,
    feedInTariffCtPerKwh,
    feedInTariffSource,
    investmentEuro,
    alternativeImportPriceCtPerKwh: alternativeCt,
    ...(alternativeEscalationPct === null
      ? {}
      : { alternativePriceEscalationRate: alternativeEscalationPct / 100 }),
    ...(baseFee === null ? {} : { baseFeeEuro: baseFee }),
    ...(alternativeBaseFee === null ? {} : { alternativeBaseFeeEuro: alternativeBaseFee }),
    ...(demandCharge === null ? {} : { demandChargeEuroPerKw: demandCharge }),
    ...(alternativeDemandCharge === null
      ? {}
      : { alternativeDemandChargeEuroPerKw: alternativeDemandCharge }),
    ...(comparisonTariffs === null ? {} : { comparisonTariffs }),
    horizonYears,
    priceSource: profilePrice !== null ? "profile" : "workspace_default",
    settingsRevision: fallback?.settingsRevision ?? 0,
  };
}

/**
 * F4-04f Vergleichstarife aus belegtem Profil: null ohne Feld
 * (Althashes stabil), sonst 1..3 voll aufgeloeste Tarife. Jede
 * Bereichs-/Formverletzung und jeder Doppelname ist fail-closed
 * (kein stilles Kuerzen oder Ueberschreiben).
 */
export function resolveComparisonTariffs(
  entry: unknown,
  current: { priceEscalationRate: number; baseFeeEuro: number; demandChargeEuroPerKw: number },
): ComparisonTariffV2[] | null {
  const candidate = entry as { status?: unknown; value?: unknown } | undefined;
  if (candidate === undefined || candidate === null || candidate.status !== "known") return null;
  if (!Array.isArray(candidate.value)) economicsError("Vergleichstarife sind kein Array");
  if (candidate.value.length === 0) economicsError("Vergleichstarife sind leer");
  if (candidate.value.length > COMPARISON_TARIFFS_MAX) {
    economicsError("Zu viele Vergleichstarife");
  }
  const seen = new Set<string>();
  return candidate.value.map((raw) => {
    const tariff = (raw ?? {}) as Record<string, unknown>;
    const name = typeof tariff.name === "string" ? tariff.name.trim() : "";
    if (name.length === 0 || name.length > 40) economicsError("Vergleichstarif-Name ausserhalb 1..40 Zeichen");
    if (seen.has(name)) economicsError("Vergleichstarif-Name doppelt");
    seen.add(name);
    const price = tariff.importPriceCtPerKwh;
    if (typeof price !== "number" || !Number.isFinite(price) || price < 1 || price > 200) {
      economicsError("Vergleichstarif-Preis ausserhalb 1..200 Ct/kWh");
    }
    const escalationPct = tariff.priceEscalationPct ?? null;
    if (escalationPct !== null
      && (typeof escalationPct !== "number" || !Number.isFinite(escalationPct)
        || escalationPct < -10 || escalationPct > 25)) {
      economicsError("Vergleichstarif-Eskalation ausserhalb -10..25 %");
    }
    const baseFee = tariff.baseFeeEuroPerYear ?? null;
    if (baseFee !== null
      && (typeof baseFee !== "number" || !Number.isFinite(baseFee) || baseFee < 0 || baseFee > 100_000)) {
      economicsError("Vergleichstarif-Grundpreis ausserhalb 0..100000 Euro/Jahr");
    }
    const demand = tariff.demandChargeEuroPerKw ?? null;
    if (demand !== null
      && (typeof demand !== "number" || !Number.isFinite(demand) || demand < 0 || demand > 10_000)) {
      economicsError("Vergleichstarif-Leistungspreis ausserhalb 0..10000 Euro/kW");
    }
    return {
      name,
      importPriceCtPerKwh: price,
      priceEscalationRate: escalationPct === null ? current.priceEscalationRate : escalationPct / 100,
      baseFeeEuro: baseFee === null ? current.baseFeeEuro : baseFee,
      demandChargeEuroPerKw: demand === null ? current.demandChargeEuroPerKw : demand,
    };
  });
}

/**
 * F4.4b TOU-Aufloesung aus belegtem Profil: exakt 24 endliche Preise
 * 0..200 Ct/kWh -> Kopie; sonst null (kein TOU-Block, kein Fehler).
 */
export function resolveTouImportPrices(consumption: unknown): number[] | null {
  const holder = (consumption ?? {}) as Record<string, unknown>;
  const entry = holder.touImportPricesCtPerKwh as
    | { status?: unknown; value?: unknown }
    | undefined;
  if (entry === undefined || entry === null || entry.status !== "known") return null;
  if (!Array.isArray(entry.value) || entry.value.length !== 24) return null;
  const prices: number[] = [];
  for (const price of entry.value) {
    if (typeof price !== "number" || !Number.isFinite(price)) return null;
    if (price < 0 || price > 200) return null;
    prices.push(price);
  }
  return prices;
}

/**
 * F4.4b TOU-Jahr-1-Rechnung: Summe Slot-Netzbezug x TOU-Stundenpreis
 * (gleiche Bezugskosten-Semantik wie F4.4a-Bills, ohne Einspeiseabloesung).
 * `slotImportKwh` deckt ganze Tage ab (Laenge % 96 == 0).
 */
export function computeTouBillEuro(
  slotImportKwh: ArrayLike<number>,
  touPricesCtPerKwh: ArrayLike<number>,
): number {
  if (slotImportKwh.length === 0 || slotImportKwh.length % 96 !== 0) {
    economicsError("TOU-Bezugsreihe deckt keine ganzen Tage ab");
  }
  if (touPricesCtPerKwh.length !== 24) {
    economicsError("TOU-Profil hat nicht 24 Stundenpreise");
  }
  let totalCt = 0;
  for (let index = 0; index < slotImportKwh.length; index += 1) {
    const energy = slotImportKwh[index]!;
    const price = touPricesCtPerKwh[Math.floor((index % 96) / 4)]!;
    if (typeof energy !== "number" || !Number.isFinite(energy) || energy < 0) {
      economicsError(`TOU-Bezug[${index}] ist ungueltig`);
    }
    if (typeof price !== "number" || !Number.isFinite(price) || price < 0) {
      economicsError("TOU-Preis ist ungueltig");
    }
    totalCt += energy * price;
  }
  return roundMoney(totalCt / 100);
}

export type ExistingBillDeltaV2 = {
  /** Jahr-1-Bezugskosten Bestand (Netzbezug x Tarif, F4.4a-Semantik). */
  baselineEuro: number;
  /** Jahr-1-Bezugskosten Planung (identisch zu currentEuro). */
  plannedEuro: number;
  /** Ersparnis Planung gegen Bestand (kann negativ sein). */
  savingsEuro: number;
};

/**
 * F4.5b Bestands-Geldvergleich aus den Jahres-Netzbezuegen beider Seiten
 * und dem belegten Importpreis. Importpreis ausserhalb 1..200 Ct/kWh ist
 * fail-closed (gleiche Schranke wie die Tarifaufloesung).
 */
export function computeExistingBillDelta(
  baselineGridImportKwh: number,
  plannedGridImportKwh: number,
  importPriceCtPerKwh: number,
): ExistingBillDeltaV2 {
  for (const [name, value] of [
    ["baselineGridImportKwh", baselineGridImportKwh],
    ["plannedGridImportKwh", plannedGridImportKwh],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      economicsError(`Jahreswert ${name} ist ungueltig`);
    }
  }
  if (
    typeof importPriceCtPerKwh !== "number"
    || !Number.isFinite(importPriceCtPerKwh)
    || importPriceCtPerKwh < 1
    || importPriceCtPerKwh > 200
  ) {
    economicsError("Bestands-Vergleichspreis ausserhalb 1..200 Ct/kWh");
  }
  const baselineEuro = roundMoney(baselineGridImportKwh * (importPriceCtPerKwh / 100));
  const plannedEuro = roundMoney(plannedGridImportKwh * (importPriceCtPerKwh / 100));
  return { baselineEuro, plannedEuro, savingsEuro: roundMoney(baselineEuro - plannedEuro) };
}

export type AnnualBillsV2 = {
  /** Jahr-1-Rechnung ohne PV (Verbrauch × Tarif). */
  noPvEuro: number;
  /** Jahr-1-Rechnung mit PV (Netzbezug × Tarif). */
  currentEuro: number;
  /** Jahr-1-Rechnung mit PV zum Neutarif (null ohne Neutarif). */
  newTariffEuro: number | null;
};

export type AnnualBillSeriesRowV2 = {
  year: number;
  noPvEuro: number;
  currentEuro: number;
  newTariffEuro: number;
};

export type ComparisonBillV2 = {
  /** Vergleichstarif-Name (1..40 Zeichen, eindeutig je Lauf). */
  name: string;
  /** Jahr-1-Rechnung mit PV (Netzbezug × Preis + Grundpreis + Spitze). */
  year1Euro: number;
  /** Mehrjahres-Serie (Horizont, Jahr 1 == year1Euro per Konstruktion). */
  seriesEuro: number[];
};

export type EconomicsResultV2 = {
  annualSavingsEuro: number;
  cumulativeCashflowEuro: number[];
  amortizationYears: number | null;
  irr: number | null;
  annualBillsEuro: AnnualBillsV2;
  /**
   * F4-04c Mehrjahres-Tarifvergleich (nur bei belegtem Neutarif; sonst
   * fehlt der Schlüssel und Altresultate bleiben gültig). Jahr-1-Zeile
   * == annualBillsEuro (gepinnt). Physik je Jahr identisch (kein
   * Degradations-/Verbrauchsdrift — reine Tarifrechnung).
   */
  annualBillSeriesEuro?: AnnualBillSeriesRowV2[];
  /**
   * F4-04f zusätzliche Vergleichstarife (nur bei belegtem Profilfeld;
   * sonst fehlt der Schlüssel und Altresultate bleiben gültig).
   */
  comparisonBillsEuro?: ComparisonBillV2[];
};

/** Kapitalwert einer Zahlungsreihe (t=0..n) bei Zinssatz. */
function npv(cashflows: readonly number[], rate: number): number {
  let total = 0;
  for (let year = 0; year < cashflows.length; year += 1) {
    total += cashflows[year]! / (1 + rate) ** year;
  }
  return total;
}

/**
 * Geldrechnung aus Engine-Jahreswerten (Jahr 1) + Tarifinput.
 * `annual`: { generationKwh, selfConsumptionKwh, feedInKwh, consumptionKwh,
 * gridImportKwh } (Kette: consumption = self + gridImport).
 */
export function computeEconomics(
  annual: {
    generationKwh: number;
    selfConsumptionKwh: number;
    feedInKwh: number;
    consumptionKwh: number;
    gridImportKwh: number;
    /**
     * F4-04e Jahresspitzen [kW, 2 dp] aus der Simulation (geplant bzw.
     * Ohne-PV-Gegenfakt). Fehlen sie bei belegtem Leistungspreis,
     * ist das fail-closed (kein stilles Nullen der Umlage).
     */
    peakImportKw?: number;
    noPvPeakImportKw?: number;
  },
  input: EconomicsInputV2,
): EconomicsResultV2 {
  for (const [name, value] of Object.entries(annual)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      economicsError(`Jahreswert ${name} ist ungueltig`);
    }
  }
  const horizon = input.horizonYears;
  if (!Number.isInteger(horizon) || horizon < 1 || horizon > 50) {
    economicsError("Horizont ausserhalb 1..50 Jahre");
  }
  const importPriceEuro = input.importPriceCtPerKwh / 100;
  const feedInEuro = input.feedInTariffCtPerKwh / 100;
  const quote = (year: number): number => (1 - ECONOMICS_DEGRADATION_RATE) ** (year - 1);
  const price = (year: number): number => importPriceEuro * (1 + input.priceEscalationRate) ** (year - 1);
  const savings = (year: number): number =>
    annual.selfConsumptionKwh * quote(year) * price(year)
    + annual.feedInKwh * quote(year) * feedInEuro;
  const annualSavingsEuro = roundMoney(savings(1));
  const cumulativeCashflowEuro: number[] = [];
  let cumulative = -input.investmentEuro;
  let amortizationYears: number | null = null;
  for (let year = 1; year <= horizon; year += 1) {
    cumulative += savings(year);
    cumulativeCashflowEuro.push(roundMoney(cumulative));
    if (amortizationYears === null && cumulative >= 0) amortizationYears = year;
  }
  // IRR: Bisektion NPV=0 über [-0,9999, 10]; null ohne Vorzeichenwechsel.
  // (Investition 0 + Ersparnis > 0: Amortisation 0, IRR undefiniert.)
  let irr: number | null = null;
  if (input.investmentEuro === 0) {
    if (annualSavingsEuro > 0) amortizationYears = 0;
  } else {
    const cashflows = [-input.investmentEuro];
    for (let year = 1; year <= horizon; year += 1) cashflows.push(savings(year));
    const npvLow = npv(cashflows, -0.9999);
    const npvHigh = npv(cashflows, 10);
    if (Number.isFinite(npvLow) && Number.isFinite(npvHigh) && npvLow * npvHigh < 0) {
      let low = -0.9999;
      let high = 10;
      for (let step = 0; step < 100; step += 1) {
        const mid = (low + high) / 2;
        if (npv(cashflows, mid) > 0) low = mid;
        else high = mid;
      }
      irr = (low + high) / 2;
    }
  }
  // F4-04d Grundpreis je Tarif (konstant, keine Eskalation): Ohne-PV
  // und aktueller Tarif tragen den aktuellen Grundpreis, der Neutarif
  // den eigenen (unbelegt = aktueller, dokumentiert). Ersparnis und
  // Cashflow bleiben unberührt — der Grundpreis kürzt sich analytisch
  // (Netzanschluss bleibt), nur die Rechnungen werden ehrlich.
  const baseFee = input.baseFeeEuro ?? 0;
  const alternativeBaseFee = input.alternativeBaseFeeEuro ?? baseFee;
  // F4-04e Leistungspreis je Tarif (konstant, keine Eskalation): Ohne-PV
  // traegt die Lastspitze, geplante Rechnungen die Dispatch-Spitze, der
  // Neutarif den eigenen Satz (unbelegt = aktueller, dokumentiert).
  // Ersparnis und Cashflow bleiben unberührt (Grundpreis-Vorbild).
  const demandCharge = input.demandChargeEuroPerKw ?? 0;
  const alternativeDemandCharge = input.alternativeDemandChargeEuroPerKw ?? demandCharge;
  const peakKw = annual.peakImportKw;
  const noPvPeakKw = annual.noPvPeakImportKw;
  if (demandCharge > 0 && (peakKw === undefined || noPvPeakKw === undefined)) {
    economicsError("Leistungspreis ohne Jahresspitze aus der Simulation");
  }
  if (alternativeDemandCharge > 0 && (peakKw === undefined || noPvPeakKw === undefined)) {
    economicsError("Neutarif-Leistungspreis ohne Jahresspitze aus der Simulation");
  }
  // F4-04f: Vergleichstarife mit Satz brauchen die Dispatch-Spitze
  // (gleicher fail-closed-Maßstab wie Haupt-Neutarif).
  const comparisons = input.comparisonTariffs ?? [];
  if (comparisons.some((tariff) => tariff.demandChargeEuroPerKw > 0) && peakKw === undefined) {
    economicsError("Vergleichstarif-Leistungspreis ohne Jahresspitze aus der Simulation");
  }
  const demandEuro = demandCharge * (peakKw ?? 0);
  const noPvDemandEuro = demandCharge * (noPvPeakKw ?? 0);
  const alternativeDemandEuro = alternativeDemandCharge * (peakKw ?? 0);
  // F4.4a Jahr-1-Tarifvergleich (gleiche physikalische Fluesse).
  const annualBillsEuro: AnnualBillsV2 = {
    noPvEuro: roundMoney(annual.consumptionKwh * importPriceEuro + baseFee + noPvDemandEuro),
    currentEuro: roundMoney(annual.gridImportKwh * importPriceEuro + baseFee + demandEuro),
    newTariffEuro: input.alternativeImportPriceCtPerKwh === null
      ? null
      : roundMoney(annual.gridImportKwh * (input.alternativeImportPriceCtPerKwh / 100) + alternativeBaseFee + alternativeDemandEuro),
  };
  // F4-04c Mehrjahres-Tarifvergleich mit Eskalation je Tarif (nur bei
  // belegtem Neutarif; unbelegte Neutarif-Eskalation = aktuelle
  // Eskalation, dokumentiert). Reine Tarifrechnung: Physik je Jahr
  // identisch, Jahr 1 == annualBillsEuro per Konstruktion.
  // F4-04f Vergleichsrechnungen je Tarif (Jahr 1 + Serie über Horizont;
  // Physik je Jahr identisch, Sätze konstant — reine Tarifrechnung wie
  // F4-04c, unabhängig vom Haupt-Neutarif).
  const comparisonBills = comparisons.map((tariff) => {
    const tariffPriceEuro = tariff.importPriceCtPerKwh / 100;
    const tariffDemandEuro = tariff.demandChargeEuroPerKw * (peakKw ?? 0);
    const seriesEuro: number[] = [];
    for (let year = 1; year <= horizon; year += 1) {
      seriesEuro.push(roundMoney(
        annual.gridImportKwh * tariffPriceEuro * (1 + tariff.priceEscalationRate) ** (year - 1)
          + tariff.baseFeeEuro
          + tariffDemandEuro,
      ));
    }
    return { name: tariff.name, year1Euro: seriesEuro[0]!, seriesEuro };
  });
  const comparisonEcho = comparisonBills.length === 0
    ? {}
    : { comparisonBillsEuro: comparisonBills };
  if (input.alternativeImportPriceCtPerKwh === null) {
    return {
      annualSavingsEuro,
      cumulativeCashflowEuro,
      amortizationYears,
      irr,
      annualBillsEuro,
      ...comparisonEcho,
    };
  }
  const newPriceEuro = input.alternativeImportPriceCtPerKwh / 100;
  const newEscalation = input.alternativePriceEscalationRate ?? input.priceEscalationRate;
  const annualBillSeriesEuro: AnnualBillSeriesRowV2[] = [];
  for (let year = 1; year <= horizon; year += 1) {
    annualBillSeriesEuro.push({
      year,
      noPvEuro: roundMoney(annual.consumptionKwh * importPriceEuro * (1 + input.priceEscalationRate) ** (year - 1) + baseFee + noPvDemandEuro),
      currentEuro: roundMoney(annual.gridImportKwh * importPriceEuro * (1 + input.priceEscalationRate) ** (year - 1) + baseFee + demandEuro),
      newTariffEuro: roundMoney(annual.gridImportKwh * newPriceEuro * (1 + newEscalation) ** (year - 1) + alternativeBaseFee + alternativeDemandEuro),
    });
  }
  return {
    annualSavingsEuro,
    cumulativeCashflowEuro,
    amortizationYears,
    irr,
    annualBillsEuro,
    annualBillSeriesEuro,
    ...comparisonEcho,
  };
}
