/**
 * F7-09: Zertifizierte Anlagenkennzahlen aus dem versiegelten Snapshot.
 *
 * Reine, browsergeeignete Projektion (keine Node-APIs, keine DB, keine
 * Simulation): Summen ueber sichtbare, kundenwirksame Katalogpositionen.
 * Nur was der versiegelte Snapshot an Technischen Daten einbettet, zaehlt;
 * alles andere bleibt ehrlich draussen (Uncertified-Flags).
 */

export type CertifiedCapacityLine = {
  positionType: "required" | "additional" | "optional";
  isHidden: boolean;
  quantityMilli: number;
  componentCategory:
    | "module"
    | "inverter"
    | "battery"
    | "wallbox"
    | "heat_pump"
    | "mounting"
    | "other";
  productKind: "catalog" | "custom";
  technicalData: {
    schemaVersion: string;
    nominalPowerWatts?: number;
    nominalAcPowerWatts?: number;
    usableCapacityWh?: number;
    maxChargingPowerWatts?: number;
  } | null;
};

export type CertifiedCapacities = {
  moduleCount: number;
  pvPeakPowerWatts: number;
  batteryCount: number;
  storageUsableCapacityWh: number;
  inverterCount: number;
  inverterAcPowerWatts: number;
  wallboxCount: number;
  wallboxChargePowerWatts: number;
  hasUncertifiedModuleLines: boolean;
  hasUncertifiedBatteryLines: boolean;
  hasUncertifiedInverterLines: boolean;
  hasUncertifiedWallboxLines: boolean;
};

function checkedAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError("Anlagenkennzahlen ueberschreiten den sicheren Ganzzahlbereich.");
  }
  return result;
}

function checkedMultiply(left: number, right: number): number {
  const result = left * right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new TypeError("Anlagenkennzahlen ueberschreiten den sicheren Ganzzahlbereich.");
  }
  return result;
}

/**
 * Stueck-/Set-Mengen liegen als Milli vor; nur glatte Einheiten tragen
 * zertifizierte Leistung. Krumme Milli-Mengen sind ein Datenfehler und
 * scheitern fail-closed statt still zu runden.
 */
function wholeUnits(quantityMilli: number): number {
  if (!Number.isSafeInteger(quantityMilli) || quantityMilli < 1) {
    throw new TypeError("Katalogmenge ist ungueltig.");
  }
  if (quantityMilli % 1000 !== 0) {
    throw new TypeError("Stueckmenge ist nicht ganzzahlig.");
  }
  return quantityMilli / 1000;
}

function validWatts(value: number | undefined, min: number, max: number): value is number {
  return Number.isSafeInteger(value)
    && (value as number) >= min
    && (value as number) <= max;
}

export function deriveCertifiedCapacities(
  lines: readonly CertifiedCapacityLine[],
): CertifiedCapacities {
  const result: CertifiedCapacities = {
    moduleCount: 0,
    pvPeakPowerWatts: 0,
    batteryCount: 0,
    storageUsableCapacityWh: 0,
    inverterCount: 0,
    inverterAcPowerWatts: 0,
    wallboxCount: 0,
    wallboxChargePowerWatts: 0,
    hasUncertifiedModuleLines: false,
    hasUncertifiedBatteryLines: false,
    hasUncertifiedInverterLines: false,
    hasUncertifiedWallboxLines: false,
  };
  for (const line of lines) {
    // Unsichtbare und optionale Positionen sind nicht kundenwirksam und
    // duerfen die zertifizierte Anlagenleistung nicht beeinflussen.
    if (line.isHidden || line.positionType === "optional") continue;
    const units = wholeUnits(line.quantityMilli);
    const technical = line.productKind === "catalog" ? line.technicalData : null;
    switch (line.componentCategory) {
      case "module": {
        if (
          technical?.schemaVersion === "module.v1"
          && validWatts(technical.nominalPowerWatts, 1, 10_000)
        ) {
          result.moduleCount = checkedAdd(result.moduleCount, units);
          result.pvPeakPowerWatts = checkedAdd(
            result.pvPeakPowerWatts,
            checkedMultiply(technical.nominalPowerWatts, units),
          );
        } else {
          result.hasUncertifiedModuleLines = true;
        }
        break;
      }
      case "battery": {
        if (
          technical?.schemaVersion === "battery.v1"
          && validWatts(technical.usableCapacityWh, 1, 100_000_000)
        ) {
          result.batteryCount = checkedAdd(result.batteryCount, units);
          result.storageUsableCapacityWh = checkedAdd(
            result.storageUsableCapacityWh,
            checkedMultiply(technical.usableCapacityWh, units),
          );
        } else {
          result.hasUncertifiedBatteryLines = true;
        }
        break;
      }
      case "inverter": {
        if (
          technical?.schemaVersion === "inverter.v1"
          && validWatts(technical.nominalAcPowerWatts, 1, 10_000_000)
        ) {
          result.inverterCount = checkedAdd(result.inverterCount, units);
          result.inverterAcPowerWatts = checkedAdd(
            result.inverterAcPowerWatts,
            checkedMultiply(technical.nominalAcPowerWatts, units),
          );
        } else {
          result.hasUncertifiedInverterLines = true;
        }
        break;
      }
      case "wallbox": {
        if (
          technical?.schemaVersion === "wallbox.v1"
          && validWatts(technical.maxChargingPowerWatts, 1, 1_000_000)
        ) {
          result.wallboxCount = checkedAdd(result.wallboxCount, units);
          result.wallboxChargePowerWatts = checkedAdd(
            result.wallboxChargePowerWatts,
            checkedMultiply(technical.maxChargingPowerWatts, units),
          );
        } else {
          result.hasUncertifiedWallboxLines = true;
        }
        break;
      }
      default:
        break;
    }
  }
  return result;
}
