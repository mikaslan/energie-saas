/**
 * F4.1 v2-Heizgradlast (Spec F4-01, Lastprofil-Upgrade): Waermepumpenstrom
 * nach Heizgradstunden statt uniformer Form.
 *
 * Methode: Stundenwicht `w_h = max(0, T_grenze - T2m_h)` mit
 * `T_grenze = 15 °C` (Heizgrenztemperatur Bestand, EnEV-Praxis;
 * versioniert, kein stiller Default), Viertel flach in der Stunde
 * (Last hat keine Solargestalt, energieexakt), Summe 1 normieren ->
 * x Jahres-kWh (Strom). T2m kommt aus der standortweiten
 * Horizontalserie (echtes Wetterjahr, kein Zusatzabruf).
 *
 * Bewusste, versionierte Entscheidungen:
 * - Konstant-COP-Annahme: Form folgt dem Waermebedarf; die
 *   Temperaturabhaengigkeit der Arbeitszahl steckt im belegten
 *   Jahres-kWh (Upgrade: COP-Kennlinie aus Katalog, F5).
 * - Warmwasser-Anteil der WP laeuft mit (kein belegter Split;
 *   Upgrade: WW-Split aus Profil, sobald belegt).
 * - Kuehlung hat eine eigene Form (`wmee-cooling-degree.v1`,
 *   Kuehlgradstunden aus derselben T2m-Serie, v1-Port).
 * - Kein lautloser Uniform-Fallback: positive kWh ohne Heizgradtage
 *   brechen fail-closed ab (unmoegliche Kombination sichtbar).
 */
import { createHash } from "node:crypto";

import { canonicalizeCalculationJson } from "./contract";
import { neumaierSum, QUARTER_HOUR_SLOTS } from "./engine-v2";
import {
  F401LoadError,
  loadProfileSourceV2Schema,
  type LoadProfileSourceV2,
} from "./load-v2";
import { CALCULATION_V2_DEGREE_DAY_VERSION } from "./versions-v2";

export const DEGREE_DAY_V2_VERSION = CALCULATION_V2_DEGREE_DAY_VERSION;
export const DEGREE_DAY_V2_SOURCE_ID = "wmee-degree-day-heat.v1" as const;
export const DEGREE_DAY_V2_HEATING_AC_SOURCE_ID =
  "wmee-degree-day-heating-ac.v1" as const;

/**
 * Heizgrad-Quellvariante: `heat_pump` (Waermepumpe) oder `heating_ac`
 * (Heizungs-Klimatisierung — v1 formt sie mit denselben Heizgradstunden).
 * Eigene sourceId + SHA-Anteil je Variante; Default ist die belegte
 * WP-Form (bestehende SHAs unveraendert).
 */
export type DegreeDayVariantV2 = "heat_pump" | "heating_ac";

/** Heizgrenztemperatur [°C] (Bestand, EnEV-Praxis, versioniert). */
export const HEATING_LIMIT_DEG_C = 15;

function degreeDayError(detail: string): never {
  throw new F401LoadError(`Heizgradlast v2 verletzt: ${detail}`);
}

/** Stunden-Heizgrad [K] aus Stundenmittel-Temperatur [°C]. */
export function heatingDegreeHour(temperatureC: number): number {
  if (typeof temperatureC !== "number" || !Number.isFinite(temperatureC)) {
    degreeDayError("Temperatur ist nicht endlich");
  }
  return Math.max(0, HEATING_LIMIT_DEG_C - temperatureC);
}

function degreeDaySha256(annualKwh: number, variant: DegreeDayVariantV2): string {
  return createHash("sha256")
    .update(
      canonicalizeCalculationJson({
        loadMethod: DEGREE_DAY_V2_VERSION,
        heatingLimitDegC: HEATING_LIMIT_DEG_C,
        sourceKind: "heat_pump",
        // Nur die AC-Variante traegt einen Anteil: Die belegte WP-Form
        // behaelt byte-identische SHAs (kein stiller Provenienzwechsel).
        ...(variant === "heating_ac" ? { variant } : {}),
        annualKwh,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * WP-Stromquelle aus Jahres-kWh + 8.760 Stundentemperaturen
 * (Beobachtungszeit -> T2m [°C], Achsenreihenfolge beliebig):
 * Heizgradstunden -> flache Viertel -> exakt Jahres-kWh.
 * `annualKwh = 0` liefert Nullreihe. Variante `heating_ac` fuer
 * Heizungs-Klimatisierung (eigene sourceId, v1-gleiche Form).
 */
export function buildHeatingDegreeSourceV2(input: {
  annualKwh: number;
  hourlyTemperatureC: ReadonlyMap<string, number>;
  hourTimesInOrder: readonly string[];
  variant?: DegreeDayVariantV2;
}): LoadProfileSourceV2 {
  const annualKwh = input.annualKwh;
  if (typeof annualKwh !== "number" || !Number.isFinite(annualKwh) || annualKwh < 0) {
    degreeDayError("Waermepumpe hat ungueltige kWh");
  }
  if (input.hourTimesInOrder.length !== 8_760) {
    degreeDayError(
      `Heizgradlast braucht 8760 Stundenzeiten, gefunden: ${input.hourTimesInOrder.length}`,
    );
  }
  const weights = new Array<number>(QUARTER_HOUR_SLOTS);
  for (let hour = 0; hour < 8_760; hour += 1) {
    const time = input.hourTimesInOrder[hour]!;
    const temperature = input.hourlyTemperatureC.get(time);
    if (temperature === undefined) {
      degreeDayError(`Stundentemperatur fehlt: ${time}`);
    }
    const weight = heatingDegreeHour(temperature);
    weights[hour * 4] = weight;
    weights[hour * 4 + 1] = weight;
    weights[hour * 4 + 2] = weight;
    weights[hour * 4 + 3] = weight;
  }
  const total = neumaierSum(weights);
  let slotEnergyKwh: number[];
  if (annualKwh === 0) {
    slotEnergyKwh = new Array<number>(QUARTER_HOUR_SLOTS).fill(0);
  } else {
    if (!(total > 0)) {
      degreeDayError("Waerme-kWh ohne Heizgradtage im Wetterjahr");
    }
    const scale = annualKwh / total;
    slotEnergyKwh = weights.map((weight) => weight * scale);
  }
  const variant: DegreeDayVariantV2 = input.variant ?? "heat_pump";
  const parsed = loadProfileSourceV2Schema.safeParse({
    sourceKind: "heat_pump",
    sourceId: variant === "heating_ac"
      ? DEGREE_DAY_V2_HEATING_AC_SOURCE_ID
      : DEGREE_DAY_V2_SOURCE_ID,
    sourceRevision: DEGREE_DAY_V2_VERSION,
    sourceSha256: degreeDaySha256(annualKwh, variant),
    slotEnergyKwh,
  });
  if (!parsed.success) {
    degreeDayError(
      variant === "heating_ac"
        ? "Heizungs-Klimatisierung verletzt das Quellschema"
        : "Waermepumpe verletzt das Quellschema",
    );
  }
  return parsed.data;
}
