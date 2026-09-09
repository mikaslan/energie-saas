/**
 * F4.1 v2-H0-Basislast (Spec F4-01, Lastprofil-Upgrade): Haushaltslast
 * nach BDEW-Standardlastprofil H0 (dynamisiert, energieexakt) statt
 * uniformer Form.
 *
 * Methode (demandlib.bdew.ElecSlp, BDEW-Standardlastprofile Strom):
 * je Slot (Saison, Wochentag, Tagesviertel) -> statischer Tabellenwert
 * (`bdew-h0-table.ts`, demandlib-CSV-SHA gepinnt) x BDEW-
 * Glaettungspolynom F_t (Tag des Jahres) -> Summe 1 normieren ->
 * x Jahres-kWh. Feiertage wie Sonntage; Heiligabend/Silvester wie
 * Samstage (BDEW-Anwendungsregel, ausser an Sonntagen).
 *
 * Bewusste, versionierte Entscheidungen:
 * - F_t-Argument ist der Kalender-Tag des Jahres (Jan1 = 1.0 +
 *   Tagesbruchteil) gemaess BDEW-Standardtext, nicht demandlibs
 *   positionsbasierte Konvention (max. ~1 Tag Versatz, Formeffekt
 *   <= 1 %, im Orakel-Test mit Herleitung gepinnt).
 * - Nach Renormierung auf die Jahres-kWh (Spec: Energieexaktheit);
 *   demandlib normiert h0_dyn nicht nach (Drift ~0.07 %).
 * - Bundesfeiertage 2020 (Rezeptjahr-Pin); keine regionalen.
 * - Achsen-Labels sind Berliner Standardzeit (+01:00, kein DST-Sprung);
 *   H0 folgt den Label-Daten (BDEW-Profile sind Ortszeit).
 */
import { createHash } from "node:crypto";

import { BDEW_H0_CSV_SHA256, BDEW_H0_TABLE } from "./bdew-h0-table";
import { canonicalizeCalculationJson } from "./contract";
import { neumaierSum, QUARTER_HOUR_SLOTS } from "./engine-v2";
import {
  F401LoadError,
  loadProfileSourceV2Schema,
  type LoadProfileSourceV2,
} from "./load-v2";
import { CALCULATION_V2_H0_LOAD_VERSION } from "./versions-v2";

export const H0_LOAD_V2_VERSION = CALCULATION_V2_H0_LOAD_VERSION;
export const H0_LOAD_V2_SOURCE_ID = "wmee-bdew-h0-dyn-basis.v1" as const;

/** Bundesfeiertage 2020 als MM-TT (Rezeptjahr-Pin, keine regionalen). */
const HOLIDAYS_2020_MMDD = new Set([
  "01-01", "04-10", "04-13", "05-01", "05-21", "06-01", "10-03", "12-25", "12-26",
]);

const SLOT_LABEL_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})\+01:00$/;

function loadError(detail: string): never {
  throw new F401LoadError(`H0-Basislast v2 verletzt: ${detail}`);
}

export type H0Season = "summer" | "transition" | "winter";

/**
 * BDEW-Saison aus Monat/Tag (demandlib._seasons-Defaults, lueckenlos):
 * Sommer 15.05.-14.09., Uebergang 21.03.-14.05. + 15.09.-31.10.,
 * Winter 01.01.-20.03. + 01.11.-31.12.
 */
export function h0Season(month: number, day: number): H0Season {
  const mmdd = month * 100 + day;
  if (mmdd >= 515 && mmdd <= 914) return "summer";
  if ((mmdd >= 321 && mmdd <= 514) || (mmdd >= 915 && mmdd <= 1031)) {
    return "transition";
  }
  return "winter";
}

/**
 * BDEW-Glaettungspolynom F_t (demandlib `dynamisation_function`,
 * adjustierte Konstante -3.916649251 statt Standard -3.92 —
 * exakt die Referenzimplementierung).
 */
export function h0DynamicFactor(dayOfYearDecimal: number): number {
  if (!Number.isFinite(dayOfYearDecimal)) loadError("Jahrestag ist nicht endlich");
  const t = dayOfYearDecimal;
  return -3.916649251e-10 * t ** 4
    + 3.2e-7 * t ** 3
    - 7.02e-5 * t ** 2
    + 0.0021 * t
    + 1.24;
}

export type H0SlotDate = {
  year: number;
  month: number;
  day: number;
  quarterOfDay: number;
  /** Tag des Jahres, 1. Januar = 1. */
  dayOfYear: number;
  /** BDEW-Wochentag 1=Mo..7=So (Feiertag=So, 24./31.12.=Sa). */
  weekday17: number;
};

/** Achsen-Slotlabel `YYYY-MM-DDTHH:MM+01:00` -> H0-Datum (fail-closed). */
export function parseH0SlotLabel(label: unknown): H0SlotDate {
  if (typeof label !== "string") loadError("Slotlabel ist kein String");
  const match = SLOT_LABEL_PATTERN.exec(label);
  if (match === null) loadError(`Slotlabel verletzt die Form: ${label}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    loadError(`Slotlabel enthaelt kein Datum: ${label}`);
  }
  if (hour > 23 || minute % 15 !== 0) {
    loadError(`Slotlabel enthaelt kein Viertel: ${label}`);
  }
  const dayMs = Date.UTC(year, month - 1, day);
  const check = new Date(dayMs);
  if (
    check.getUTCFullYear() !== year
    || check.getUTCMonth() !== month - 1
    || check.getUTCDate() !== day
  ) {
    loadError(`Slotlabel enthaelt kein Kalenderdatum: ${label}`);
  }
  const dayOfYear = Math.round((dayMs - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  const quarterOfDay = hour * 4 + minute / 15;
  // ISO-Wochentag aus UTC-Kalender (Label-Datum ist kalendarisch exakt).
  const isoWeekday = ((check.getUTCDay() + 6) % 7) + 1;
  const mmdd = `${match[2]}-${match[3]}`;
  let weekday17 = isoWeekday;
  if (HOLIDAYS_2020_MMDD.has(mmdd) && year === 2020) weekday17 = 7;
  if ((mmdd === "12-24" || mmdd === "12-31") && weekday17 !== 7) weekday17 = 6;
  return { year, month, day, quarterOfDay, dayOfYear, weekday17 };
}

/** Statischer H0-Tabellenwert (demandlib-Rohwert, unnormiert). */
export function h0StaticValue(season: H0Season, weekday17: number, quarterOfDay: number): number {
  const days = BDEW_H0_TABLE[season];
  if (days === undefined) loadError(`Saison fehlt in H0-Tabelle: ${season}`);
  const values = days[weekday17];
  if (values === undefined || values.length !== 96) {
    loadError(`Wochentag fehlt in H0-Tabelle: ${season}/${weekday17}`);
  }
  const value = values[quarterOfDay];
  if (value === undefined) loadError(`Viertel fehlt in H0-Tabelle: ${quarterOfDay}`);
  return value;
}

function h0SourceSha256(annualKwh: number): string {
  return createHash("sha256")
    .update(
      canonicalizeCalculationJson({
        loadMethod: H0_LOAD_V2_VERSION,
        tableSha256: BDEW_H0_CSV_SHA256,
        sourceKind: "basis",
        annualKwh,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * Haushalts-Basisquelle aus Jahres-kWh + 35.040 Achsen-Slotlabels:
 * H0-dyn-Form (Tabelle x F_t), exakt auf die Jahres-kWh normiert.
 * `annualKwh = 0` liefert Nullreihe (kein Divisionsrest).
 */
export function buildH0BasisSourceV2(input: {
  annualKwh: number;
  slotLabels: readonly unknown[];
}): LoadProfileSourceV2 {
  const annualKwh = input.annualKwh;
  if (typeof annualKwh !== "number" || !Number.isFinite(annualKwh) || annualKwh < 0) {
    loadError("H0-Basis hat ungueltige kWh");
  }
  if (!Array.isArray(input.slotLabels) || input.slotLabels.length !== QUARTER_HOUR_SLOTS) {
    loadError(`H0-Basis braucht ${QUARTER_HOUR_SLOTS} Slotlabels`);
  }
  const weights = new Array<number>(QUARTER_HOUR_SLOTS);
  for (let slot = 0; slot < QUARTER_HOUR_SLOTS; slot += 1) {
    const date = parseH0SlotLabel(input.slotLabels[slot]);
    const staticValue = h0StaticValue(
      h0Season(date.month, date.day),
      date.weekday17,
      date.quarterOfDay,
    );
    weights[slot] = staticValue
      * h0DynamicFactor(date.dayOfYear + date.quarterOfDay / 96);
  }
  const total = neumaierSum(weights);
  let slotEnergyKwh: number[];
  if (annualKwh === 0) {
    slotEnergyKwh = new Array<number>(QUARTER_HOUR_SLOTS).fill(0);
  } else {
    if (!(total > 0)) loadError("H0-Form traegt keine Energie");
    const scale = annualKwh / total;
    slotEnergyKwh = weights.map((weight) => weight * scale);
  }
  const parsed = loadProfileSourceV2Schema.safeParse({
    sourceKind: "basis",
    sourceId: H0_LOAD_V2_SOURCE_ID,
    sourceRevision: H0_LOAD_V2_VERSION,
    sourceSha256: h0SourceSha256(annualKwh),
    slotEnergyKwh,
  });
  if (!parsed.success) loadError("H0-Basis verletzt das Quellschema");
  return parsed.data;
}
