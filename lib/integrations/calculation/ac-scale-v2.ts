/**
 * F4.1 v2-AC-Skalierung (Spec F4-01, Abschnitt "AC-Leistungsstrategie"):
 * Das Wetterjahr (`P_h` aus dem dachbezogenen PVGIS-Snapshot, bereits auf
 * die normalisierte 8760-Stunden-Achse abgebildet) wird auf den
 * langjaehrigen PVcalc-Jahresreferenzwert `E_y` [kWh/kWp] skaliert:
 *
 * ```text
 * s    = PVcalc.E_y/(sum(P_h_after_axis_normalization)/1000)
 * P*_h = s·P_h
 * ```
 *
 * Danach gilt Jahresgleichheit zu `E_y` als Skalierungsinvariante; das
 * Gate (`skaliertes AC-Jahr gegen E_y`, atol `0.01 kWh/kWp`) prueft sie
 * fail-closed (faengt u. a. Achsenfehler wie fehlenden Feb29-Drop).
 * Monatsabweichungen Wetterjahr/langjaehrig werden nur berichtet, nicht
 * gegatet. Die Viertelstundenverteilung `P_q` ueber das eigene
 * Hay-`G_T,q` gehoert zum Geometrie-Slice (F4.1B, SPA-abhaengig) und ist
 * hier bewusst nicht enthalten.
 */
import { neumaierSum } from "./engine-v2";
import { F401ProviderError } from "./provider-v2";

const NORMALIZED_HOURS = 8_760;
/** Spec-Gate: skaliertes AC-Jahr gegen E_y, atol 0.01 kWh/kWp. */
const SCALED_ANNUAL_GATE_ATOL_KWH_PER_KWP = 0.01;

export type ScaledRoofAnnual = {
  scaleFactor: number;
  /** P*_h [W/kWp], Laenge 8760. */
  pScaled: number[];
};

export function scaleRoofAnnualToReference(
  pHourlyNormalized: readonly number[],
  annualReferenceKwhPerKwp: number,
): ScaledRoofAnnual {
  if (!Array.isArray(pHourlyNormalized)) {
    throw new F401ProviderError("P-Reihe ist kein Array");
  }
  if (pHourlyNormalized.length !== NORMALIZED_HOURS) {
    throw new F401ProviderError(
      `P-Reihe hat ${pHourlyNormalized.length} statt ${NORMALIZED_HOURS} Stunden`,
    );
  }
  for (let index = 0; index < pHourlyNormalized.length; index += 1) {
    const value = pHourlyNormalized[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new F401ProviderError(`P[${index}] ist nicht endlich`);
    }
    if (value < 0) throw new F401ProviderError(`P[${index}] ist negativ`);
  }
  if (
    typeof annualReferenceKwhPerKwp !== "number"
    || !Number.isFinite(annualReferenceKwhPerKwp)
    || annualReferenceKwhPerKwp <= 0
  ) {
    throw new F401ProviderError("E_y-Referenz ist nicht positiv");
  }
  const annualKwhPerKwp = neumaierSum(pHourlyNormalized) / 1000;
  if (!(annualKwhPerKwp > 0)) {
    throw new F401ProviderError("Wetterjahr hat keine Erzeugung");
  }
  const scaleFactor = annualReferenceKwhPerKwp / annualKwhPerKwp;
  const pScaled = pHourlyNormalized.map((value) => value * scaleFactor);
  const scaledAnnual = neumaierSum(pScaled) / 1000;
  if (Math.abs(scaledAnnual - annualReferenceKwhPerKwp) > SCALED_ANNUAL_GATE_ATOL_KWH_PER_KWP) {
    throw new F401ProviderError("skaliertes AC-Jahr verletzt das E_y-Gate");
  }
  return { scaleFactor, pScaled };
}
