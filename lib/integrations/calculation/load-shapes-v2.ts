/**
 * F4.1 v2-Lastformen (Spec F4-01, Paritaets-Upgrade): EV-Ladepattern,
 * Kuehlgradtage und Warmwasser-Tagesgang als belegte Formen statt
 * uniformer Verteilung.
 *
 * Methode: exakte Ports der v1-Maschinenraum-Formen (`engine.ts` —
 * `evWeights`, `degreeWeights(..., "cooling")`, `hotWaterWeights`) auf
 * Viertelstunden-Slots. Eine Stunde traegt in allen vier Vierteln dasselbe
 * Stundengewicht (Last hat keine Solargestalt, energieexakt); die Summe
 * wird auf 1 normiert und mit den belegten Jahres-kWh skaliert.
 *
 * Belegte Eingaben (kein ESTIMATE):
 * - EV-Pattern `evening`/`daytime`/`away` aus dem bestaetigten
 *   Verbrauchsprofil (`siteEnergyProfileV1Schema`-Enum, Rechner-Intake).
 *   Unbekanntes Pattern bei EV-km > 0 bricht fail-closed ab.
 * - Kuehlgradstunden `max(0, T2m_h - 22 °C)` aus der standortweiten
 *   Horizontalserie (echtes Wetterjahr, kein Zusatzabruf).
 * - Warmwasser-Tagesgang (morgens 1.4, abends 1.2, sonst 0.2).
 *
 * Benannte Differenz zu v1: v1 zaehlt abstrakte Wochentage (Jan1 = Montag,
 * Nicht-Schaltjahr); v2 nutzt den belegten ISO-Kalender der 2020-Achse aus
 * den Slotlabels. Die Pattern-Regeln (Stundenfenster, Basis 0.02) sind
 * identisch; nur die Wochenend-Lage folgt dem echten Kalender.
 */
import { createHash } from "node:crypto";

import { canonicalizeCalculationJson } from "./contract";
import { neumaierSum, QUARTER_HOUR_SLOTS } from "./engine-v2";
import { parseH0SlotLabel } from "./h0-load-v2";
import {
  F401LoadError,
  loadProfileSourceV2Schema,
  type LoadProfileSourceV2,
} from "./load-v2";
import { CALCULATION_V2_LOAD_SHAPES_VERSION } from "./versions-v2";

export const LOAD_SHAPES_V2_VERSION = CALCULATION_V2_LOAD_SHAPES_VERSION;
export const EV_PATTERN_V2_SOURCE_ID = "wmee-ev-pattern.v1" as const;
export const COOLING_DEGREE_V2_SOURCE_ID = "wmee-cooling-degree.v1" as const;
export const HOT_WATER_PROFILE_V2_SOURCE_ID = "wmee-hot-water-profile.v1" as const;

/** Belegte EV-Ladepattern (Rechner-Intake-Enum, v1-`chargingPatternSchema`). */
export const EV_CHARGING_PATTERNS_V2 = ["evening", "daytime", "away"] as const;
export type EvChargingPatternV2 = (typeof EV_CHARGING_PATTERNS_V2)[number];

export function isEvChargingPatternV2(value: unknown): value is EvChargingPatternV2 {
  return value === "evening" || value === "daytime" || value === "away";
}

/** Kuehlgrenze [°C] (v1-`degreeWeights`, belegt). */
export const COOLING_LIMIT_DEG_C = 22;

function loadShapesError(detail: string): never {
  throw new F401LoadError(`Lastformen v2 verletzt: ${detail}`);
}

export type LoadShapeSlotV2 = {
  /** Stunde des Tages 0..23 (aus Slotlabel). */
  hour: number;
  /** ISO-Wochentag 1=Mo..7=So (echter Achsenkalender, ohne Feiertagslogik). */
  isoWeekday: number;
};

/**
 * Achsen-Slotlabels -> Stundenzeiten (fail-closed via H0-Parser:
 * Form, Datum und Viertel werden geprueft).
 */
export function parseLoadShapeSlotsV2(slotLabels: readonly unknown[]): LoadShapeSlotV2[] {
  if (slotLabels.length !== QUARTER_HOUR_SLOTS) {
    loadShapesError(
      `Lastformen brauchen ${QUARTER_HOUR_SLOTS} Slotlabels, gefunden: ${slotLabels.length}`,
    );
  }
  return slotLabels.map((label) => {
    const parsed = parseH0SlotLabel(label);
    const hour = Math.floor(parsed.quarterOfDay / 4);
    const isoWeekday =
      ((new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay() + 6) % 7) + 1;
    return { hour, isoWeekday };
  });
}

/**
 * EV-Stundengewicht (Port von v1-`evWeights`): `daytime` 9-17h, `away`
 * werktags 8-18h, sonst (`evening`) 18-24h, jeweils 1, sonst 0.02.
 */
export function evPatternWeightV2(
  pattern: EvChargingPatternV2,
  slot: LoadShapeSlotV2,
): number {
  const weekend = slot.isoWeekday >= 6;
  if (pattern === "daytime") return slot.hour >= 9 && slot.hour < 17 ? 1 : 0.02;
  if (pattern === "away") {
    return !weekend && slot.hour >= 8 && slot.hour < 18 ? 1 : 0.02;
  }
  return slot.hour >= 18 && slot.hour < 24 ? 1 : 0.02;
}

/**
 * Warmwasser-Stundengewicht (Port von v1-`hotWaterWeights`): 5-9h 1.4,
 * 18-22h 1.2, sonst 0.2.
 */
export function hotWaterWeightV2(slot: LoadShapeSlotV2): number {
  if (slot.hour >= 5 && slot.hour < 9) return 1.4;
  if (slot.hour >= 18 && slot.hour < 22) return 1.2;
  return 0.2;
}

/** Stunden-Kuehlgrad [K] aus Stundenmittel-Temperatur [°C] (v1-Form). */
export function coolingDegreeHour(temperatureC: number): number {
  if (typeof temperatureC !== "number" || !Number.isFinite(temperatureC)) {
    loadShapesError("Temperatur ist nicht endlich");
  }
  return Math.max(0, temperatureC - COOLING_LIMIT_DEG_C);
}

function shapeSourceSha256(input: {
  sourceId: string;
  sourceKind: string;
  annualKwh: number;
  detail: Record<string, unknown>;
}): string {
  return createHash("sha256")
    .update(
      canonicalizeCalculationJson({
        loadMethod: LOAD_SHAPES_V2_VERSION,
        sourceId: input.sourceId,
        sourceKind: input.sourceKind,
        annualKwh: input.annualKwh,
        ...input.detail,
      }),
      "utf8",
    )
    .digest("hex");
}

function normalizeShapeWeights(weights: number[], what: string): number[] {
  if (weights.length !== QUARTER_HOUR_SLOTS) {
    loadShapesError(`${what} hat falsche Slotzahl: ${weights.length}`);
  }
  const total = neumaierSum(weights);
  if (!(total > 0)) loadShapesError(`${what} hat keine positive Form`);
  return weights.map((weight) => weight / total);
}

function buildShapeSourceV2(input: {
  sourceId: string;
  sourceKind: LoadProfileSourceV2["sourceKind"];
  annualKwh: number;
  weights: number[];
  detail: Record<string, unknown>;
}): LoadProfileSourceV2 {
  const annualKwh = input.annualKwh;
  if (typeof annualKwh !== "number" || !Number.isFinite(annualKwh) || annualKwh < 0) {
    loadShapesError(`Lastquelle ${input.sourceKind} hat ungueltige kWh`);
  }
  let slotEnergyKwh: number[];
  if (annualKwh === 0) {
    slotEnergyKwh = new Array<number>(QUARTER_HOUR_SLOTS).fill(0);
  } else {
    const normalized = normalizeShapeWeights(input.weights, input.sourceKind);
    slotEnergyKwh = normalized.map((weight) => weight * annualKwh);
  }
  const parsed = loadProfileSourceV2Schema.safeParse({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourceRevision: LOAD_SHAPES_V2_VERSION,
    sourceSha256: shapeSourceSha256({
      sourceId: input.sourceId,
      sourceKind: input.sourceKind,
      annualKwh,
      detail: input.detail,
    }),
    slotEnergyKwh,
  });
  if (!parsed.success) {
    loadShapesError(`Lastquelle ${input.sourceKind} verletzt das Quellschema`);
  }
  return parsed.data;
}

/**
 * EV-Quelle aus Jahres-km x Planungsfaktor, geformt nach belegtem Pattern.
 * Unbekanntes Pattern bricht fail-closed ab (kein erfundener Ladeplan).
 */
export function buildEvPatternSourceV2(input: {
  annualKwh: number;
  pattern: unknown;
  slotLabels: readonly unknown[];
}): LoadProfileSourceV2 {
  const pattern = input.pattern;
  if (!isEvChargingPatternV2(pattern)) {
    loadShapesError("EV-Ladepattern ist nicht belegt");
  }
  const slots = parseLoadShapeSlotsV2(input.slotLabels);
  const weights = slots.map((slot) => evPatternWeightV2(pattern, slot));
  return buildShapeSourceV2({
    sourceId: EV_PATTERN_V2_SOURCE_ID,
    sourceKind: "ev",
    annualKwh: input.annualKwh,
    weights,
    detail: { pattern },
  });
}

/**
 * Kuehlungsquelle aus Jahres-kWh + 8.760 Stundentemperaturen: Kuehlgrad-
 * stunden -> flache Viertel -> exakt Jahres-kWh. Ohne Kuehlgradtage faellt
 * die Form auf uniform zurueck (v1-`degreeWeights`-Semantik: leere Form
 * bedeutet keine Wetterbindung, kein Abort).
 */
export function buildCoolingDegreeSourceV2(input: {
  annualKwh: number;
  hourlyTemperatureC: ReadonlyMap<string, number>;
  hourTimesInOrder: readonly string[];
}): LoadProfileSourceV2 {
  if (input.hourTimesInOrder.length !== 8_760) {
    loadShapesError(
      `Kuehlgradlast braucht 8760 Stundenzeiten, gefunden: ${input.hourTimesInOrder.length}`,
    );
  }
  const hourly = new Array<number>(8_760);
  for (let hour = 0; hour < 8_760; hour += 1) {
    const time = input.hourTimesInOrder[hour]!;
    const temperature = input.hourlyTemperatureC.get(time);
    if (temperature === undefined) {
      loadShapesError(`Stundentemperatur fehlt: ${time}`);
    }
    hourly[hour] = coolingDegreeHour(temperature);
  }
  const total = neumaierSum(hourly);
  const weights = new Array<number>(QUARTER_HOUR_SLOTS);
  for (let hour = 0; hour < 8_760; hour += 1) {
    // Leere Kuehlform -> uniform (v1-Semantik), sonst Stunden-Kuehlgrad.
    const weight = total > 0 ? hourly[hour]! : 1;
    weights[hour * 4] = weight;
    weights[hour * 4 + 1] = weight;
    weights[hour * 4 + 2] = weight;
    weights[hour * 4 + 3] = weight;
  }
  return buildShapeSourceV2({
    sourceId: COOLING_DEGREE_V2_SOURCE_ID,
    sourceKind: "cooling",
    annualKwh: input.annualKwh,
    weights,
    detail: { coolingLimitDegC: COOLING_LIMIT_DEG_C },
  });
}

/**
 * Warmwasser-Quelle aus Jahres-kWh + 35.040 Achsen-Slotlabels:
 * Tagesgang (morgens/abends betont) -> exakt Jahres-kWh.
 */
export function buildHotWaterProfileSourceV2(input: {
  annualKwh: number;
  slotLabels: readonly unknown[];
}): LoadProfileSourceV2 {
  const slots = parseLoadShapeSlotsV2(input.slotLabels);
  const weights = slots.map((slot) => hotWaterWeightV2(slot));
  return buildShapeSourceV2({
    sourceId: HOT_WATER_PROFILE_V2_SOURCE_ID,
    sourceKind: "hot_water",
    annualKwh: input.annualKwh,
    weights,
    detail: {},
  });
}
