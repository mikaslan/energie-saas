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

export type EconomicsInputV2 = {
  importPriceCtPerKwh: number;
  priceEscalationRate: number;
  feedInTariffCtPerKwh: number;
  feedInTariffSource: FeedInTariffSource;
  investmentEuro: number;
  /** Optionaler Neutarif [Ct/kWh] für den Jahr-1-Vergleich (F4.4a). */
  alternativeImportPriceCtPerKwh: number | null;
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
  return {
    importPriceCtPerKwh: importPriceCt,
    priceEscalationRate: escalationPct / 100,
    feedInTariffCtPerKwh,
    feedInTariffSource,
    investmentEuro,
    alternativeImportPriceCtPerKwh: alternativeCt,
    horizonYears,
    priceSource: profilePrice !== null ? "profile" : "workspace_default",
    settingsRevision: fallback?.settingsRevision ?? 0,
  };
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

export type EconomicsResultV2 = {
  annualSavingsEuro: number;
  cumulativeCashflowEuro: number[];
  amortizationYears: number | null;
  irr: number | null;
  annualBillsEuro: AnnualBillsV2;
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
  // F4.4a Jahr-1-Tarifvergleich (gleiche physikalische Fluesse).
  const annualBillsEuro: AnnualBillsV2 = {
    noPvEuro: roundMoney(annual.consumptionKwh * importPriceEuro),
    currentEuro: roundMoney(annual.gridImportKwh * importPriceEuro),
    newTariffEuro: input.alternativeImportPriceCtPerKwh === null
      ? null
      : roundMoney(annual.gridImportKwh * (input.alternativeImportPriceCtPerKwh / 100)),
  };
  return { annualSavingsEuro, cumulativeCashflowEuro, amortizationYears, irr, annualBillsEuro };
}
