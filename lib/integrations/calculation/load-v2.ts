/**
 * F4.1 v2-Lastprofil (Spec F4-01, Abschnitt "Speicher- und Netzdispatch"):
 * `quarter-hour-load-profile.v1` und Aufloesung der Gesamtlast.
 *
 * Der v2-Request bindet das bereits auf die synthetische Achse
 * aufgeloeste Lastprofil:
 *
 * ```text
 * schemaVersion         = quarter-hour-load-profile.v1
 * axisVersion           = utc_to_berlin_standard_time_circular_then_drop_feb29.v2
 * slotEnergyKwh         = exakt 35.040 endliche, nichtnegative kWh/Slot
 * annualConsumptionKwh  = NeumaierSum(slotEnergyKwh)
 * sourceKind/sourceId/sourceRevision/sourceSha256
 * ```
 *
 * Basis- und spaeter ergaenzte EV-/Waermepumpenlasten werden vor F4.1 als
 * getrennt proveniente Slotreihen aufgeloest und hier zur gebundenen
 * Gesamtlast summiert. F4.1 nimmt weder kW-Werte noch Monats-/Stunden-IDs
 * entgegen. Summe, Achse und SHA muessen vor Reservation und Replay
 * identisch sein.
 *
 * Dieses Modul erfindet keine Last-Shapes: Die Formgebung (Jahreswerte ->
 * Slots je Quelle) gehoert zu den Profilquellen (F4.2+); hier werden nur
 * explizite, bereits aufgeloeste Reihen summiert und gebunden.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

import { AXIS_VERSION } from "./axis-v2";
import { neumaierSum, QUARTER_HOUR_SLOTS } from "./engine-v2";

export const LOAD_PROFILE_V2_SCHEMA_VERSION = "quarter-hour-load-profile.v1" as const;

const finite = () => z.number().finite();

export const loadProfileSourceV2Schema = z.strictObject({
  sourceKind: z.enum(["basis", "ev", "heat_pump", "cooling", "hot_water"]),
  sourceId: z.string().min(1).max(200),
  sourceRevision: z.string().min(1).max(100),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  slotEnergyKwh: z.array(finite().min(0)).length(QUARTER_HOUR_SLOTS),
});

export type LoadProfileSourceV2 = z.infer<typeof loadProfileSourceV2Schema>;

export const loadProfileV2Schema = z.strictObject({
  schemaVersion: z.literal(LOAD_PROFILE_V2_SCHEMA_VERSION),
  axisVersion: z.literal(AXIS_VERSION),
  slotEnergyKwh: z.array(finite().min(0)).length(QUARTER_HOUR_SLOTS),
  annualConsumptionKwh: finite().min(0),
  sources: z.array(loadProfileSourceV2Schema).min(1).max(16),
});

export type LoadProfileV2 = z.infer<typeof loadProfileV2Schema>;

export class F401LoadError extends Error {
  readonly code = "f401_load_invalid_input" as const;

  constructor(readonly detail: string) {
    super(`f4.1 load rejected input: ${detail}`);
  }
}

function loadError(detail: string): never {
  throw new F401LoadError(detail);
}

function sha256Hex(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Totale Slotreihe aus getrennt provenanten Quellen. Genau eine
 * Basis-Reihe ist Pflicht; jede Quelle hoechstens einmal
 * (sourceKind+sourceId+sourceRevision). Die Gesamtlast ist die
 * komponentenweise Summe; `annualConsumptionKwh` die ungerundete
 * Neumaier-Summe (Quantisierung auf sechs Stellen erfolgt an der
 * Persistenzgrenze, nicht hier).
 */
export function resolveTotalLoadProfile(sources: unknown): LoadProfileV2 {
  if (!Array.isArray(sources)) loadError("Quellen sind kein Array");
  const parsedSources = (sources as unknown[]).map((source, index) => {
    const parsed = loadProfileSourceV2Schema.safeParse(source);
    if (!parsed.success) loadError(`Quelle ${index} verletzt das Quellschema`);
    return parsed.data;
  });
  const basisCount = parsedSources.filter((source) => source.sourceKind === "basis").length;
  if (basisCount !== 1) loadError(`genau eine Basis-Reihe noetig, gefunden: ${basisCount}`);
  const keys = parsedSources.map((source) =>
    `${source.sourceKind}\n${source.sourceId}\n${source.sourceRevision}`
  );
  if (new Set(keys).size !== keys.length) loadError("doppelte Quelle gebunden");
  const total = new Array<number>(QUARTER_HOUR_SLOTS).fill(0);
  for (const source of parsedSources) {
    for (let slot = 0; slot < QUARTER_HOUR_SLOTS; slot += 1) {
      total[slot]! += source.slotEnergyKwh[slot]!;
    }
  }
  const candidate = {
    schemaVersion: LOAD_PROFILE_V2_SCHEMA_VERSION,
    axisVersion: AXIS_VERSION,
    slotEnergyKwh: total,
    annualConsumptionKwh: neumaierSum(total),
    sources: parsedSources,
  };
  const parsed = loadProfileV2Schema.safeParse(candidate);
  if (!parsed.success) loadError("Gesamtlast verletzt quarter-hour-load-profile.v1");
  return parsed.data;
}

/** Bindungs-Hash einer Quellreihe (fuer sourceSha256 der Erzeuger). */
export function hashLoadSourceSlots(slotEnergyKwh: readonly number[]): string {
  if (slotEnergyKwh.length !== QUARTER_HOUR_SLOTS) {
    loadError("Quellreihe hat nicht 35040 Slots");
  }
  return sha256Hex(JSON.stringify([...slotEnergyKwh]));
}
