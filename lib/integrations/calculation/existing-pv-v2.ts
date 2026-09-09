/**
 * F4.1 v2-Bestands-PV (Spec F4-01, Bestand-Port Slice A: Daten + Serie):
 * Erzeugungsreihe einer bestehenden Anlage aus belegten Bestandsdaten.
 *
 * Methode: exakter Port der v1-Formel (`engine.ts buildGenerationSeries`,
 * existing-Branch) auf Viertelstunden-Slots. Je Dach:
 * `kapazitaet_Dach = bestandsKwp x flaeche_Dach / gesamtflaeche`;
 * `jahresertrag_Dach = ertragJeKwp_Dach x kapazitaet_Dach x degradation`;
 * die Dachreihe folgt der Neuanlagen-Dachform (Muneer/PVcalc-Pfad),
 * normiert auf den Jahresertrag. Degradation
 * `(1 - rate)^max(0, asOfJahr - inbetriebnahmeJahr)`.
 *
 * Belegt (kein ESTIMATE):
 * - Bestands-kWp + Inbetriebnahmejahr aus dem bestaetigten Profil
 *   (`existingAssets.pv`, Rechner-Intake; v1 verlangt `known_present`,
 *   sonst fail-closed — hier ebenso).
 * - Degradationsrate 0,5 %/Jahr = v1-Modell-Default (`prepare.ts`
 *   DEFAULTS, gepinnte Modellversion).
 *
 * Benannte Differenz zu v1: v1 multipliziert zusaetzlich
 * Verschattungsfaktoren je Dach und einen Systemverlust-Relativfaktor;
 * die v2-Dachform traegt die dachspezifische Behandlung bereits im
 * Muneer/PVcalc-Pfad (kein Doppelabschlag). Slice B (Run) nutzt die Serie
 * fuer baseline/geplant/Delta; bis dahin bleibt das Run-Gate.
 */
import { QUARTER_HOUR_SLOTS } from "./engine-v2";
import { F401ProviderError } from "./provider-v2";
import { CALCULATION_V2_EXISTING_PV_VERSION } from "./versions-v2";

export const EXISTING_PV_V2_VERSION = CALCULATION_V2_EXISTING_PV_VERSION;

/**
 * Moduldegradation pro Jahr (v1-Modell-Default, versioniert; keine
 * stille Annahme — flieesst in Provenienz-Beschreibung ein).
 */
export const MODULE_DEGRADATION_PER_YEAR_V2 = 0.005;

function existingPvError(detail: string): never {
  throw new F401ProviderError(`Bestands-PV v2 verletzt: ${detail}`);
}

/**
 * Degradationsfaktor `(1 - rate)^max(0, asOfJahr - inbetriebnahmeJahr)`.
 * Zukuenftige Inbetriebnahme (unmoeglich, aber robust) -> 1.
 */
export function degradationFactorV2(input: {
  commissioningYear: number;
  asOfYear: number;
  rate?: number;
}): number {
  const { commissioningYear, asOfYear } = input;
  const rate = input.rate ?? MODULE_DEGRADATION_PER_YEAR_V2;
  if (
    !Number.isInteger(commissioningYear)
    || commissioningYear < 1900
    || commissioningYear > 2200
  ) {
    existingPvError("Inbetriebnahmejahr ist ungueltig");
  }
  if (!Number.isInteger(asOfYear) || asOfYear < 1900 || asOfYear > 2200) {
    existingPvError("Stichtagjahr ist ungueltig");
  }
  if (!(rate >= 0) || !(rate < 1) || !Number.isFinite(rate)) {
    existingPvError("Degradationsrate ist ungueltig");
  }
  return (1 - rate) ** Math.max(0, asOfYear - commissioningYear);
}

/**
 * Viertelstunden-Energie aus Dachleistung (eine Stelle, getestet;
 * identische Arithmetik wie `assembleSlotPvEnergy` in p-distribute-v2).
 */
const SLOT_HOURS_V2 = 0.25;
const W_PER_KW_V2 = 1000;

export type ExistingPvRoofV2 = {
  roofId: string;
  areaM2: number;
  /** Neuanlagen-Dachleistung (Muneer/PVcalc-Pfad, 35040 Viertel-W/kWp). */
  newPowerWPerKwp: readonly number[];
};

/**
 * Bestands-Reihe je Dach: Neuanlagen-Form, skaliert auf
 * `bestandsKwp x degradation`, Flaechen-Split wie v1. Gibt die
 * summierte 35040er-Reihe plus Jahresenergie zurueck (energieexakt:
 * Summe = bestandsKwp x degradation x sum(DachertragJeKwp x Anteil)).
 */
export function buildExistingPvSeriesV2(input: {
  roofs: readonly ExistingPvRoofV2[];
  existingKwp: number;
  degradationFactor: number;
}): { existingPvKwh: number[]; annualKwh: number } {
  const { existingKwp, degradationFactor } = input;
  if (!(existingKwp > 0) || !Number.isFinite(existingKwp)) {
    existingPvError("Bestands-kWp ist ungueltig");
  }
  if (
    !(degradationFactor > 0)
    || !(degradationFactor <= 1)
    || !Number.isFinite(degradationFactor)
  ) {
    existingPvError("Degradationsfaktor ist ungueltig");
  }
  if (input.roofs.length === 0) existingPvError("kein Dach gebunden");
  let totalArea = 0;
  for (const roof of input.roofs) {
    if (!(roof.areaM2 > 0) || !Number.isFinite(roof.areaM2)) {
      existingPvError(`Dach ${roof.roofId} hat ungueltige Flaeche`);
    }
    if (roof.newPowerWPerKwp.length !== QUARTER_HOUR_SLOTS) {
      existingPvError(`Dach ${roof.roofId} hat falsche Slotzahl`);
    }
    totalArea += roof.areaM2;
  }
  const existingPvKwh = new Array<number>(QUARTER_HOUR_SLOTS).fill(0);
  for (const roof of input.roofs) {
    // v1-Kapazitaetssplit am Bestands-System-kWp: Dachanteil an der
    // Gesamtflaeche mal Bestands-kWp mal Degradation, mal Ertrag je kWp.
    // (Die Neuanlagen-kWp kuenzen sich: Bestand nutzt dieselbe Dachform.)
    const roofKwp = existingKwp * (roof.areaM2 / totalArea) * degradationFactor;
    for (let slot = 0; slot < QUARTER_HOUR_SLOTS; slot += 1) {
      const wattsPerKwp = roof.newPowerWPerKwp[slot]!;
      if (!(wattsPerKwp >= 0) || !Number.isFinite(wattsPerKwp)) {
        existingPvError(`Dach ${roof.roofId} traegt ungueltige Leistung`);
      }
      existingPvKwh[slot]! += wattsPerKwp * SLOT_HOURS_V2 / W_PER_KW_V2 * roofKwp;
    }
  }
  let annualKwh = 0;
  for (const value of existingPvKwh) annualKwh += value;
  return { existingPvKwh, annualKwh };
}
