/**
 * F4.1 v2-Katalogaufloesung (Spec F4-01, `catalog-resolution.v2`):
 * bestaetigte Battery-Revision -> v2-Speicherparameter. Reine Funktion
 * (kein DB-Zugriff); die Worker-Schicht liefert die Revision aus der
 * bestaetigten Projektaufloesung.
 *
 * Abbildungsregeln (stated, versioniert, reversibel):
 * - `capacityKwh` = nominale Kapazitaet (Wh/1000).
 * - SoC-Fenster bodenbuendig wie v1: `socMinKwh = 0`,
 *   `socMaxKwh = nutzbare Kapazitaet` (Wh/1000).
 * - `chargeKw = dischargeKw` = maximale Dauerleistung (W/1000, symmetrisch).
 * - `etaCharge = etaDischarge = sqrt(Roundtrip)` (symmetrischer Split des
 *   Roundtrip-Wirkungsgrads aus Basispunkten).
 * - Keine Batterie (`null`) = legitimer No-Storage-Zweig (alle Nullen,
 *   Eta 1): Dispatch ist No-Op, Run/Finalize bleiben exakt.
 * - Aufgeloeste, aber ungueltige Batterie (z. B. nutzbar <= 0 oder ueber
 *   nominal) = `cannot_fulfil`, niemals stille Defaults oder
 *   Still-Runden auf No-Storage.
 */
import type { StorageParams } from "./engine-v2";
import { CALCULATION_V2_CATALOG_RESOLUTION_VERSION } from "./versions-v2";

export const CATALOG_RESOLUTION_V2_VERSION = CALCULATION_V2_CATALOG_RESOLUTION_VERSION;

export type BatteryRevisionV2Input = {
  nominalCapacityWh: number;
  usableCapacityWh: number;
  maxContinuousPowerWatts: number;
  roundTripEfficiencyBasisPoints: number;
};

export class F401ResolutionError extends Error {
  readonly code = "cannot_fulfil" as const;

  constructor(readonly detail: string) {
    super(`f4.1 resolution cannot fulfil: ${detail}`);
  }
}

function resolutionError(detail: string): never {
  throw new F401ResolutionError(detail);
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value)) resolutionError(`${name} ist nicht endlich`);
  if (value <= 0) resolutionError(`${name} ist nicht positiv`);
  return value;
}

export function resolveStorageParamsV2(
  battery: BatteryRevisionV2Input | null,
): StorageParams {
  if (battery === null) {
    return {
      capacityKwh: 0,
      socMinKwh: 0,
      socMaxKwh: 0,
      chargeKw: 0,
      dischargeKw: 0,
      etaCharge: 1,
      etaDischarge: 1,
    };
  }
  const nominalWh = finitePositive(battery.nominalCapacityWh, "nominalCapacityWh");
  const usableWh = finitePositive(battery.usableCapacityWh, "usableCapacityWh");
  if (usableWh > nominalWh) resolutionError("nutzbar ueber nominal");
  const powerW = finitePositive(battery.maxContinuousPowerWatts, "maxContinuousPowerWatts");
  const roundTrip = battery.roundTripEfficiencyBasisPoints;
  if (!Number.isInteger(roundTrip) || roundTrip < 1 || roundTrip > 10_000) {
    resolutionError("roundTripEfficiencyBasisPoints ausserhalb [1,10000]");
  }
  const eta = Math.sqrt(roundTrip / 10_000);
  return {
    capacityKwh: nominalWh / 1000,
    socMinKwh: 0,
    socMaxKwh: usableWh / 1000,
    chargeKw: powerW / 1000,
    dischargeKw: powerW / 1000,
    etaCharge: eta,
    etaDischarge: eta,
  };
}
