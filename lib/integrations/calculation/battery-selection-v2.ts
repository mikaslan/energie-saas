/**
 * F4.1 v2-Batterieauswahl (Spec F4-01): bestaetigte Resolution-Lines ->
 * einstellige Speicherprovenienz fuer die v2-Reservierung. Reine Funktion;
 * die DB-Schicht liefert die Lines mit Component-Revision (Snapshot + SHA).
 *
 * Stated Regeln (ESTIMATE-markiert, fail-closed):
 * - 0 Batterie-Lines + angefragter Speicher (targetStorageKwh > 0) =
 *   `cannot_fulfil` (Bedarf nicht aufgeloest).
 * - 0 Batterie-Lines + kein angefragter Speicher = No-Storage (`null`).
 * - Genau 1 Batterie-Line = deren Revision (nach Integritaets- und
 *   Schema-Pruefung) via `resolveStorageParamsV2`.
 * - > 1 Batterie-Lines = `cannot_fulfil` (Mehrdeutigkeit; kein Summieren,
 *   keine stille Erstwaehlauswahl).
 * - Line-SHA ungleich Revisions-SHA oder technisches Profil ungueltig =
 *   `cannot_fulfil`, niemals stille Defaults.
 */
import { catalogTechnicalDataV1Schema } from "../catalog/contract";
import {
  F401ResolutionError,
  resolveStorageParamsV2,
} from "./catalog-resolution-v2";
import type { StorageParams } from "./engine-v2";

export type BatteryLineV2Input = {
  componentId: string;
  componentRevision: number;
  componentType: string;
  quantity: number;
  lineSnapshotSha256Hex: string;
  revisionSnapshot: unknown;
  revisionSnapshotSha256Hex: string;
};

export type BatterySelectionV2 = {
  storage: StorageParams;
  source: { componentId: string; revision: number } | null;
};

function selectionError(detail: string): never {
  throw new F401ResolutionError(detail);
}

function hexEqual(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function selectBatteryRevisionV2(
  lines: BatteryLineV2Input[],
  targetStorageKwh: number | null,
): BatterySelectionV2 {
  const batteries = lines.filter((line) => line.componentType === "battery");
  if (batteries.length === 0) {
    if (targetStorageKwh !== null && targetStorageKwh > 0) {
      selectionError("angefragter Speicher ist nicht aufgeloest");
    }
    return { storage: resolveStorageParamsV2(null), source: null };
  }
  if (batteries.length > 1) {
    selectionError("mehrere Batterie-Lines sind mehrdeutig");
  }
  const battery = batteries[0]!;
  // ESTIMATE: Stack-Skalierung (Menge > 1) ist nicht modelliert; nur exakt
  // eine Einheit pro aufgeloester Batterie ist reservierbar.
  if (battery.quantity !== 1) {
    selectionError("Batterie-Menge ist nicht genau 1");
  }
  if (
    !hexEqual(battery.lineSnapshotSha256Hex, battery.revisionSnapshotSha256Hex)
  ) {
    selectionError("Line-SHA weicht vom Revisions-SHA ab");
  }
  const snapshot = battery.revisionSnapshot;
  const technicalData = (snapshot as { technicalData?: unknown } | null)?.technicalData;
  const parsed = catalogTechnicalDataV1Schema.safeParse(technicalData);
  if (!parsed.success || parsed.data.schemaVersion !== "battery.v1") {
    selectionError("technisches Batterieprofil ist ungueltig");
  }
  const data = parsed.data;
  return {
    storage: resolveStorageParamsV2({
      nominalCapacityWh: data.nominalCapacityWh,
      usableCapacityWh: data.usableCapacityWh,
      maxContinuousPowerWatts: data.maxContinuousPowerWatts,
      roundTripEfficiencyBasisPoints: data.roundTripEfficiencyBasisPoints,
    }),
    source: { componentId: battery.componentId, revision: battery.componentRevision },
  };
}
