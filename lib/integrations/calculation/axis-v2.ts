/**
 * F4.1 v2-Achse (Spec F4-01, Abschnitt "Achse und
 * Viertelstunden-Rekonstruktion"): Abbildung der 8.784 Providerstunden
 * (PVGIS-Schaltjahr 2020, echte UTC-Achse, SARAH-Minute erhalten) auf die
 * ordinale Simulationsachse Slot 0..35.039.
 *
 * Regeln: fester UTC+01-Versatz auf Berliner Standardzeit (kein DST-Sprung),
 * zirkulaerer Jahresrand (Slots sind fortlaufend, Slot 35.039 folgt auf
 * Slot 0 im zyklischen Dispatch), danach Entfernung der 24 synthetischen
 * 29.-Februar-Stunden -> 8.760 Stunden -> 35.040 Slots. Die DST-Regel ist
 * Spec-ESTIMATE (`utc_to_berlin_standard_time_circular_then_drop_feb29.v2`);
 * die kollisionsbehaftete v1-Abbildung wird nicht wiederverwendet.
 *
 * Originalzeit und synthetisches Slot-Label bleiben getrennt; Temperatur
 * und Wind bleiben innerhalb der Quellstunde konstant (constantQuarters).
 * Geometrie (SPA-Auswertung an den Viertelstundenpunkten) injiziert der
 * Aufrufer; dieses Modul liefert dafuer die physikalischen
 * Auswertezeitpunkte +07:30/+22:30/+37:30/+52:30 je Quellstunde.
 */
import { quarterSlotsForHour, QUARTER_HOUR_SLOTS } from "./engine-v2";
import { CALCULATION_V2_AXIS_VERSION } from "./versions-v2";

/** Implementierte Achsenversion (Spec-Tupel, einzig erlaubter Wert). */
export const AXIS_VERSION = CALCULATION_V2_AXIS_VERSION;

const PROVIDER_HOURS_PER_LEAP_YEAR = 8_784;
const NORMALIZED_HOURS = 8_760;
const QUARTERS_PER_HOUR = 4;
const BERLIN_STANDARD_OFFSET_MS = 3_600_000;
/** Viertelstunden-Auswerteoffsets je Quellstunde in Minuten (Spec). */
const EVALUATION_OFFSET_MINUTES = [7.5, 22.5, 37.5, 52.5] as const;

export class F401AxisError extends Error {
  readonly code = "f401_axis_invalid_input" as const;

  constructor(readonly detail: string) {
    super(`f4.1 axis rejected input: ${detail}`);
  }
}

function axisError(detail: string): never {
  throw new F401AxisError(detail);
}

export type AxisSlot = {
  /** Ordinaler Slot 0..35.039 (eindeutig, lueckenlos). */
  slot: number;
  /** Normalisierte Stunde 0..8.759. */
  hourIndex: number;
  /** Viertelstundenindex in der Stunde 0..3. */
  quarterIndex: number;
  /** Originale SARAH-Beobachtungszeit `YYYYMMDD:HHmm` (Minute erhalten). */
  providerObservedAtUtc: string;
  /** Auf die Stunde abgerundete UTC-Startzeit (ISO). */
  providerHourStartUtc: string;
  /** Physikalischer Auswertezeitpunkt der Geometrie (ISO). */
  evaluationInstantUtc: string;
  /** Synthetisches Berliner Standardzeit-Label `YYYY-MM-DDTHH:MM+01:00`. */
  slotLabel: string;
};

function parseProviderTimestamp(value: unknown): number {
  if (typeof value !== "string") axisError("Zeitstempel ist kein String");
  const match = /^(\d{4})(\d{2})(\d{2}):(\d{2})(\d{2})$/.exec(value);
  if (match === null) axisError(`Zeitstempelformat verletzt: ${String(value)}`);
  const [, year, month, day, hour, minute] = match as unknown as
    [string, string, string, string, string, string];
  const utcMs = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
  );
  const check = new Date(utcMs);
  if (
    check.getUTCFullYear() !== Number(year)
    || check.getUTCMonth() !== Number(month) - 1
    || check.getUTCDate() !== Number(day)
    || check.getUTCHours() !== Number(hour)
    || check.getUTCMinutes() !== Number(minute)
  ) {
    axisError(`ungueltiges Kalenderdatum: ${value}`);
  }
  return utcMs;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isoUtc(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * 8.784 Providerstunden ("YYYYMMDD:HHmm", strikt aufsteigend, Minuten
 * beliebig) -> 35.040 Achsen-Slots. Fail-closed bei falscher Zeilenzahl,
 * Duplikaten, Unordnung, fehlendem/ueberzaehligem 29. Februar oder
 * Formfehlern. Das Providerjahr ist per Rezept auf 2020 gepinnt; genau die
 * 24 Berliner 29.-Februar-Stunden werden entfernt.
 */
export function mapProviderYearToQuarterSlots(
  hours: readonly unknown[],
): AxisSlot[] {
  if (!Array.isArray(hours)) axisError("Stundenachse ist kein Array");
  if (hours.length !== PROVIDER_HOURS_PER_LEAP_YEAR) {
    axisError(
      `Providerjahr hat ${hours.length} statt ${PROVIDER_HOURS_PER_LEAP_YEAR} Stunden`,
    );
  }
  const observedMs = hours.map(parseProviderTimestamp);
  for (let index = 1; index < observedMs.length; index += 1) {
    if (!(observedMs[index]! > observedMs[index - 1]!)) {
      axisError(`Stundenachse ist nicht strikt aufsteigend bei Index ${index}`);
    }
  }
  type KeptHour = { observed: string; observedMs: number; hourStartMs: number };
  const kept: KeptHour[] = [];
  let feb29Count = 0;
  for (let index = 0; index < observedMs.length; index += 1) {
    const ms = observedMs[index]!;
    const berlin = new Date(ms + BERLIN_STANDARD_OFFSET_MS);
    if (berlin.getUTCMonth() === 1 && berlin.getUTCDate() === 29) {
      feb29Count += 1;
      continue;
    }
    const floored = new Date(ms);
    floored.setUTCMinutes(0, 0, 0);
    kept.push({
      observed: hours[index] as string,
      observedMs: ms,
      hourStartMs: floored.getTime(),
    });
  }
  if (feb29Count !== 24) {
    axisError(`29. Februar hat ${feb29Count} statt 24 Stunden`);
  }
  if (kept.length !== NORMALIZED_HOURS) axisError("normalisierte Achse ist nicht 8760");
  const slots: AxisSlot[] = new Array<AxisSlot>(QUARTER_HOUR_SLOTS);
  for (let hourIndex = 0; hourIndex < NORMALIZED_HOURS; hourIndex += 1) {
    const hour = kept[hourIndex]!;
    const [q0, q1, q2, q3] = quarterSlotsForHour(hourIndex);
    const quarters = [q0, q1, q2, q3];
    const berlin = new Date(hour.hourStartMs + BERLIN_STANDARD_OFFSET_MS);
    const datePart = `${berlin.getUTCFullYear()}-${pad2(berlin.getUTCMonth() + 1)}-`
      + `${pad2(berlin.getUTCDate())}T${pad2(berlin.getUTCHours())}`;
    for (let quarter = 0; quarter < QUARTERS_PER_HOUR; quarter += 1) {
      const slot = quarters[quarter]!;
      slots[slot] = {
        slot,
        hourIndex,
        quarterIndex: quarter,
        providerObservedAtUtc: hour.observed,
        providerHourStartUtc: isoUtc(hour.hourStartMs),
        evaluationInstantUtc: isoUtc(
          hour.hourStartMs + EVALUATION_OFFSET_MINUTES[quarter]! * 60_000,
        ),
        slotLabel: `${datePart}:${quarter === 0 ? "00" : quarter === 1 ? "15" : quarter === 2 ? "30" : "45"}+01:00`,
      };
    }
  }
  return slots;
}

/**
 * Temperatur und Wind bleiben innerhalb der Quellstunde konstant: alle
 * vier Slots erhalten den Stundenwert (keine energieerhaltende Umverteilung;
 * dafuer reconstructQuarters aus engine-v2.ts).
 */
export function constantQuarters(hourValue: number): [number, number, number, number] {
  if (!Number.isFinite(hourValue)) {
    throw new F401AxisError("Stundenwert ist nicht endlich");
  }
  return [hourValue, hourValue, hourValue, hourValue];
}
