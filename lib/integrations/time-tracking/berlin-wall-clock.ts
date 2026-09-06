export const TIME_TRACKING_WALL_CLOCK_TIME_ZONE = "Europe/Berlin" as const;

const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const BERLIN_PARTS = new Intl.DateTimeFormat("en-GB-u-ca-gregory-nu-latn", {
  timeZone: TIME_TRACKING_WALL_CLOCK_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function epochFromParts(parts: WallClockParts): number {
  // Vollständige Setter vermeiden die Date.UTC-Sondersemantik für Jahre 0–99.
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
  return date.getTime();
}

function partsAt(instantMs: number): WallClockParts | null {
  const values = new Map(
    BERLIN_PARTS.formatToParts(new Date(instantMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  const parts = {
    year: values.get("year"),
    month: values.get("month"),
    day: values.get("day"),
    hour: values.get("hour"),
    minute: values.get("minute"),
    second: values.get("second"),
  };
  return Object.values(parts).every((value) => Number.isSafeInteger(value))
    ? parts as WallClockParts
    : null;
}

function sameParts(left: WallClockParts, right: WallClockParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function sameWallClockMinute(left: WallClockParts, right: WallClockParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute;
}

function parseWallClock(value: string): { parts: WallClockParts; epochMs: number } | null {
  const match = WALL_CLOCK_PATTERN.exec(value);
  if (!match) return null;
  const parts: WallClockParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: 0,
  };
  if (
    parts.year < 1
    || parts.month < 1 || parts.month > 12
    || parts.day < 1 || parts.day > 31
    || parts.hour < 0 || parts.hour > 23
    || parts.minute < 0 || parts.minute > 59
  ) return null;

  const epochMs = epochFromParts(parts);
  const calendarRoundTrip = new Date(epochMs);
  if (
    calendarRoundTrip.getUTCFullYear() !== parts.year
    || calendarRoundTrip.getUTCMonth() !== parts.month - 1
    || calendarRoundTrip.getUTCDate() !== parts.day
    || calendarRoundTrip.getUTCHours() !== parts.hour
    || calendarRoundTrip.getUTCMinutes() !== parts.minute
  ) return null;
  return { parts, epochMs };
}

/**
 * Interpretiert eine `datetime-local`-Wandzeit ausschließlich in
 * Europe/Berlin. Nicht existente Frühlingszeiten werden verworfen. Bei der
 * doppelten Herbststunde gilt für neue/geänderte Wandzeiten die versionierte
 * ESTIMATE-Regel: früherer Instant zuerst. Wenn ein vorhandener Instant noch
 * dieselbe Berliner Minute abbildet, bleibt er exakt erhalten. So verschieben
 * Kommentaränderungen weder die zweite Herbststunde noch vorhandene Sekunden.
 */
export function berlinWallClockToIso(value: string, preferredInstant?: string | null): string | null {
  const parsed = parseWallClock(value);
  if (!parsed) return null;

  if (preferredInstant) {
    const preferred = new Date(preferredInstant);
    if (!Number.isNaN(preferred.getTime())) {
      const preferredParts = partsAt(preferred.getTime());
      if (preferredParts && sameWallClockMinute(preferredParts, parsed.parts)) {
        return preferred.toISOString();
      }
    }
  }

  // Explizite IANA-Zone statt Host-/Browser-Zone. Die Stichpunkte auf beiden
  // Seiten einer möglichen DST-Kante liefern die dort gültigen Offsets; die
  // Halbjahrespunkte decken zusätzlich historische Saisonregeln ab.
  const samples = [
    parsed.epochMs - 183 * DAY_MS,
    parsed.epochMs - 36 * HOUR_MS,
    parsed.epochMs,
    parsed.epochMs + 36 * HOUR_MS,
    parsed.epochMs + 183 * DAY_MS,
  ];
  const offsetMilliseconds = new Set<number>();
  for (const sample of samples) {
    const sampleParts = partsAt(sample);
    if (!sampleParts) continue;
    offsetMilliseconds.add(epochFromParts(sampleParts) - sample);
  }

  const candidates = [...offsetMilliseconds]
    .map((offsetMs) => parsed.epochMs - offsetMs)
    .filter((candidate) => {
      const candidateParts = partsAt(candidate);
      return candidateParts !== null && sameParts(candidateParts, parsed.parts);
    })
    .sort((left, right) => left - right);
  const selected = candidates[0];
  return selected === undefined ? null : new Date(selected).toISOString();
}

export function isoToBerlinLocalInput(value: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new RangeError("Ungültiger Zeitstempel");
  const parts = partsAt(instant.getTime());
  if (!parts) throw new RangeError("Zeitstempel kann nicht als Europe/Berlin dargestellt werden");
  const pad = (number: number, width = 2): string => String(number).padStart(width, "0");
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}
