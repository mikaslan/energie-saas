/**
 * F4.3 v2-Waermepumpenstrom mit COP-Kennlinie (Spec F4-03): thermischer
 * Jahresbedarf -> temperaturabhaengige Arbeitszahl -> Strom-Slots.
 *
 * Methode: Heizanteil des thermischen Bedarfs folgt den Heizgradstunden
 * (15-°C-Grenze wie `degree-day-load-v2.ts`, echtes Wetterjahr, Viertel
 * flach in der Stunde); Warmwasser-Anteil laeuft konstant ueber alle
 * Stunden (kein belegtes Zapfprofil). Pro Stunde:
 * `T < Bivalenz -> el = thermal (Heizstab, COP = 1)`,
 * sonst `el = thermal / COP(T)` (WW mit 0,8-fachem COP wegen hoeherer
 * Vorlauftemperatur).
 *
 * Bewusste, versionierte ESTIMATE-Entscheidungen (keine behauptete
 * Reonic-Paritaet; alle Parameter stehen in der Quell-SHA):
 * - Referenzkennlinie stueckweise linear durch (-7 -> 2,2), (2 -> 3,1),
 *   (7 -> 4,0), (20 -> 5,2); ausserhalb geklemmt. `copNominal` skaliert
 *   die Kurve so, dass COP(7 °C) = copNominal gilt (Default 4,0).
 * - Bivalenz-Default -6 °C (Katalog F5.4, dort VDI-4645-Auslegung).
 * - WW-Split-Default 0 (kein belegter WW-Anteil der WP).
 * - WW-Konstanz und 0,8-Faktor sind Naeherungen ohne Referenzbeleg.
 * - Kein lautloser Uniform-Fallback: positiver Heizanteil ohne
 *   Heizgradtage bricht fail-closed ab (wie Gradquelle).
 */
import { createHash } from "node:crypto";

import { canonicalizeCalculationJson } from "./contract";
import { heatingDegreeHour } from "./degree-day-load-v2";
import { QUARTER_HOUR_SLOTS } from "./engine-v2";
import {
  F401LoadError,
  loadProfileSourceV2Schema,
  type LoadProfileSourceV2,
} from "./load-v2";
import { CALCULATION_V2_HEAT_PUMP_COP_VERSION } from "./versions-v2";

export const HEAT_PUMP_COP_V2_VERSION = CALCULATION_V2_HEAT_PUMP_COP_VERSION;
export const HEAT_PUMP_COP_V2_SOURCE_ID = "wmee-heat-pump-cop.v1" as const;

/** ESTIMATE-Defaults (versioniert, in SHA + Spec dokumentiert). */
export const HEAT_PUMP_COP_NOMINAL_DEFAULT = 4.0;
export const HEAT_PUMP_BIVALENCE_TEMP_C_DEFAULT = -6;
export const HEAT_PUMP_HOT_WATER_SHARE_DEFAULT = 0;

/** WW-COP-Faktor (hoehere Vorlauftemperatur, ESTIMATE). */
export const HEAT_PUMP_HOT_WATER_COP_FACTOR = 0.8;

/**
 * Referenzkennlinie [Aussentemperatur °C, COP], stueckweise linear
 * (ESTIMATE, keine Reonic-Referenz belegt).
 */
export const HEAT_PUMP_COP_CURVE: ReadonlyArray<readonly [number, number]> = [
  [-7, 2.2],
  [2, 3.1],
  [7, 4.0],
  [20, 5.2],
];

function heatPumpError(detail: string): never {
  throw new F401LoadError(`Waermepumpen-COP v2 verletzt: ${detail}`);
}

/** Referenz-COP bei Aussentemperatur (linear interpoliert, geklemmt). */
export function referenceCopAt(temperatureC: number): number {
  if (typeof temperatureC !== "number" || !Number.isFinite(temperatureC)) {
    heatPumpError("Temperatur ist nicht endlich");
  }
  const curve = HEAT_PUMP_COP_CURVE;
  const first = curve[0]!;
  const last = curve[curve.length - 1]!;
  if (temperatureC <= first[0]) return first[1];
  if (temperatureC >= last[0]) return last[1];
  for (let index = 0; index < curve.length - 1; index += 1) {
    const [t0, cop0] = curve[index]!;
    const [t1, cop1] = curve[index + 1]!;
    if (temperatureC >= t0 && temperatureC <= t1) {
      const fraction = (temperatureC - t0) / (t1 - t0);
      return cop0 + fraction * (cop1 - cop0);
    }
  }
  heatPumpError("Kennlinien-Interpolation ausserhalb der Stuetzstellen");
}

function heatPumpSha256(input: {
  thermalKwh: number;
  copNominal: number;
  bivalenceTempC: number;
  hotWaterShare: number;
}): string {
  return createHash("sha256")
    .update(
      canonicalizeCalculationJson({
        loadMethod: HEAT_PUMP_COP_V2_VERSION,
        sourceKind: "heat_pump",
        thermalKwh: input.thermalKwh,
        copNominal: input.copNominal,
        bivalenceTempC: input.bivalenceTempC,
        hotWaterShare: input.hotWaterShare,
      }),
      "utf8",
    )
    .digest("hex");
}

/**
 * WP-Stromquelle aus thermischem Jahresbedarf + 8.760 Stundentemperaturen:
 * Heizgrad-Anteil + konstanter WW-Anteil, je durch COP(T) bzw. Heizstab.
 * `thermalKwh = 0` liefert Nullreihe.
 */
export function buildHeatPumpCopSourceV2(input: {
  thermalKwh: number;
  copNominal?: number;
  bivalenceTempC?: number;
  hotWaterShare?: number;
  hourlyTemperatureC: ReadonlyMap<string, number>;
  hourTimesInOrder: readonly string[];
}): LoadProfileSourceV2 {
  const thermalKwh = input.thermalKwh;
  if (
    typeof thermalKwh !== "number"
    || !Number.isFinite(thermalKwh)
    || thermalKwh < 0
  ) {
    heatPumpError("Waermepumpe hat ungueltige thermische kWh");
  }
  const copNominal = input.copNominal ?? HEAT_PUMP_COP_NOMINAL_DEFAULT;
  if (
    typeof copNominal !== "number"
    || !Number.isFinite(copNominal)
    || copNominal < 1
    || copNominal > 8
  ) {
    heatPumpError("COP-Nennwert ausserhalb 1..8");
  }
  const bivalenceTempC = input.bivalenceTempC ?? HEAT_PUMP_BIVALENCE_TEMP_C_DEFAULT;
  if (
    typeof bivalenceTempC !== "number"
    || !Number.isFinite(bivalenceTempC)
    || bivalenceTempC < -25
    || bivalenceTempC > 15
  ) {
    heatPumpError("Bivalenzpunkt ausserhalb -25..15 °C");
  }
  const hotWaterShare = input.hotWaterShare ?? HEAT_PUMP_HOT_WATER_SHARE_DEFAULT;
  if (
    typeof hotWaterShare !== "number"
    || !Number.isFinite(hotWaterShare)
    || hotWaterShare < 0
    || hotWaterShare > 1
  ) {
    heatPumpError("Warmwasser-Anteil ausserhalb 0..1");
  }
  if (input.hourTimesInOrder.length !== 8_760) {
    heatPumpError(
      `WP-COP braucht 8760 Stundenzeiten, gefunden: ${input.hourTimesInOrder.length}`,
    );
  }
  const copScale = copNominal / referenceCopAt(7);
  const heatingThermalKwh = thermalKwh * (1 - hotWaterShare);
  const hotWaterThermalPerHour = (thermalKwh * hotWaterShare) / 8_760;
  const slotEnergyKwh = new Array<number>(QUARTER_HOUR_SLOTS);
  let degreeTotal = 0;
  const degreeByHour = new Array<number>(8_760);
  for (let hour = 0; hour < 8_760; hour += 1) {
    const time = input.hourTimesInOrder[hour]!;
    const temperature = input.hourlyTemperatureC.get(time);
    if (temperature === undefined) {
      heatPumpError(`Stundentemperatur fehlt: ${time}`);
    }
    const degree = heatingDegreeHour(temperature);
    degreeByHour[hour] = degree;
    degreeTotal += degree;
  }
  if (heatingThermalKwh > 0 && !(degreeTotal > 0)) {
    heatPumpError("Heizwaerme ohne Heizgradtage im Wetterjahr");
  }
  const heatingScale = degreeTotal > 0 ? heatingThermalKwh / degreeTotal : 0;
  for (let hour = 0; hour < 8_760; hour += 1) {
    const time = input.hourTimesInOrder[hour]!;
    const temperature = input.hourlyTemperatureC.get(time)!;
    const heatingThermal = degreeByHour[hour]! * heatingScale;
    let heatingEl: number;
    let hotWaterEl: number;
    if (temperature < bivalenceTempC) {
      heatingEl = heatingThermal;
      hotWaterEl = hotWaterThermalPerHour;
    } else {
      // Physikalischer Boden: Unter COP 1 hilft der Heizstab mehr;
      // niemand betreibt die WP schlechter als direkten Strom.
      const cop = Math.max(1, copScale * referenceCopAt(temperature));
      heatingEl = heatingThermal / cop;
      hotWaterEl = hotWaterThermalPerHour / (HEAT_PUMP_HOT_WATER_COP_FACTOR * cop);
    }
    const hourlyEl = heatingEl + hotWaterEl;
    slotEnergyKwh[hour * 4] = hourlyEl / 4;
    slotEnergyKwh[hour * 4 + 1] = hourlyEl / 4;
    slotEnergyKwh[hour * 4 + 2] = hourlyEl / 4;
    slotEnergyKwh[hour * 4 + 3] = hourlyEl / 4;
  }
  const parsed = loadProfileSourceV2Schema.safeParse({
    sourceKind: "heat_pump",
    sourceId: HEAT_PUMP_COP_V2_SOURCE_ID,
    sourceRevision: HEAT_PUMP_COP_V2_VERSION,
    sourceSha256: heatPumpSha256({
      thermalKwh,
      copNominal,
      bivalenceTempC,
      hotWaterShare,
    }),
    slotEnergyKwh,
  });
  if (!parsed.success) {
    heatPumpError("Waermepumpen-COP verletzt das Quellschema");
  }
  return parsed.data;
}
