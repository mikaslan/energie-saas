/**
 * F4.1 v2-Leistungsverteilung (Spec F4-01, Abschnitt
 * "AC-Leistungsstrategie"): skalierte Stundenleistung `P*_h` [W/kWp] wird
 * ueber das eigene Muneer-`G_T,q` energieerhaltend auf Viertelstunden
 * verteilt; danach Ueberfuehrung in Slotenergie und Summation ueber alle
 * Daeche:
 *
 * ```text
 * P_q        = 4·P*_h·G_T,q/sum(G_T,q)
 * E_pv,q [kWh] = 0.25/1000 · Σ_roof(roofPeakPowerKwp·P_q,roof [W/kWp])
 * ```
 *
 * Bei `P*_h>0 && sum(G_T,q)==0` wird abgebrochen. Muneer steuert nur die
 * Substundenform. `G_T,q` kommt aus dem Geometrie-Slice (F4.1B,
 * SPA-abhaengig) herein; dieses Modul prueft nur Form und
 * Energieerhaltung. Ein kategorialer `shadingFactor` wird nicht nochmals
 * auf Provider-`P` mit gebundenem Horizont angewandt.
 */
import { neumaierSum, reconstructQuarters } from "./engine-v2";
import { F401ProviderError } from "./provider-v2";

const SLOT_HOURS = 0.25;
const W_PER_KW = 1000;
/** Stunde -> 4 Slots Rekonstruktions-Gate (Spec-Tabelle). */
const RECONSTRUCTION_ATOL = 1e-9;

function distributeError(detail: string): never {
  throw new F401ProviderError(detail);
}

/**
 * Eine Stunde `P*_h` [W/kWp] ueber vier Muneer-Gewichte `G_T,q` verteilen.
 * Identische Mathematik wie reconstructQuarters, jedoch mit
 * W/kWp-Einheiten im Gate und provider/...-Fehlerklasse fuer die
 * Worker-Schicht.
 */
export function distributeScaledPowerToQuarters(
  pScaledHour: number,
  tiltedWeights: readonly [number, number, number, number],
): [number, number, number, number] {
  if (!Number.isFinite(pScaledHour)) distributeError("P*_h ist nicht endlich");
  if (pScaledHour < 0) distributeError("P*_h ist negativ");
  if (pScaledHour > 10_000) distributeError("P*_h ueberschreitet 10000 W/kWp");
  // Vollstaendige Vorabpruefung in eigener Fehlertaxonomie (die
  // eingefrorene Engine bleibt reine Defense-in-Depth).
  let weightSum = 0;
  for (const weight of tiltedWeights) {
    if (!Number.isFinite(weight)) distributeError("Gewicht ist nicht endlich");
    if (weight < 0) distributeError("Gewicht ist negativ");
    weightSum += weight;
  }
  if (pScaledHour > 0 && !(weightSum > 0)) {
    distributeError("P*_h ohne Gewicht");
  }
  const quarters = reconstructQuarters(pScaledHour, tiltedWeights);
  const reaggregated = SLOT_HOURS * neumaierSum(quarters);
  if (Math.abs(reaggregated - pScaledHour) > RECONSTRUCTION_ATOL) {
    distributeError("Stunde->Slots verletzt die Energieerhaltung");
  }
  return quarters;
}

export type RoofQuarterPower = {
  roofId: string;
  peakPowerKwp: number;
  /** P_q,roof [W/kWp], Laenge 35040. */
  powerWPerKwp: number[];
};

/**
 * Slot-PV-Energie [kWh] ueber alle Daeche: `0.25/1000 · Σ peak·P_q`.
 * Alle Reihen muessen exakt 35040 Slots tragen; Peakleistungen sind
 * endlich und nichtnegativ, mindestens ein Dach ist Pflicht.
 */
export function assembleSlotPvEnergy(roofs: RoofQuarterPower[]): number[] {
  if (!Array.isArray(roofs) || roofs.length === 0) {
    distributeError("kein Dach gebunden");
  }
  if (roofs.length > 4) distributeError("mehr als 4 Daeche gebunden");
  const length = roofs[0]!.powerWPerKwp.length;
  if (length !== 35_040) distributeError("Dachreihe hat nicht 35040 Slots");
  const ids = roofs.map((roof) => roof.roofId);
  if (new Set(ids).size !== ids.length) distributeError("Dach-Id doppelt");
  for (const roof of roofs) {
    if (typeof roof.roofId !== "string" || roof.roofId.length === 0) {
      distributeError("Dach-Id fehlt");
    }
    if (!Number.isFinite(roof.peakPowerKwp) || roof.peakPowerKwp < 0) {
      distributeError(`Peakleistung ${roof.roofId} ungueltig`);
    }
    if (roof.powerWPerKwp.length !== length) {
      distributeError("Dachreihen ungleich lang");
    }
    for (let slot = 0; slot < length; slot += 1) {
      const value = roof.powerWPerKwp[slot];
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        distributeError(`P_q ${roof.roofId}[${slot}] ungueltig`);
      }
    }
  }
  const energy = new Array<number>(length).fill(0);
  for (const roof of roofs) {
    for (let slot = 0; slot < length; slot += 1) {
      energy[slot]! += roof.peakPowerKwp * roof.powerWPerKwp[slot]!;
    }
  }
  return energy.map((watts) => SLOT_HOURS / W_PER_KW * watts);
}
