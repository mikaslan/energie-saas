// F1-06 Lead-Wiedervorlage: Band-Regel (ESTIMATE, reversibel).
//
// In-App-Eskalation ohne Mailversand: Jede offene Anfrage kann einen
// Wiedervorlage-Zeitpunkt tragen; das Board zeigt daraus Anstehend/
// Fällig/Überfällig/Eskaliert. Schwellen in Berlin-Kalendertagen:
// fällig = heute oder morgen, eskaliert = länger als 7 Tage überfällig.
// Reine Leseregel über gespeicherte Werte (kein Worker, kein Versand).
export type FollowUpBand = "scheduled" | "due" | "overdue" | "escalated";

export const FOLLOW_UP_BAND_LABEL: Record<FollowUpBand, string> = {
  scheduled: "Anstehend",
  due: "Fällig",
  overdue: "Überfällig",
  escalated: "Eskaliert",
};

// ESTIMATE: Eskalation nach mehr als 7 überfälligen Tagen.
export const FOLLOW_UP_ESCALATION_DAYS = 7;

const berlinDayFormat = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function berlinDayKey(value: Date): string {
  const parts = berlinDayFormat.formatToParts(value);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function dayDiff(fromKey: string, toKey: string): number {
  const from = Date.UTC(
    Number(fromKey.slice(0, 4)),
    Number(fromKey.slice(5, 7)) - 1,
    Number(fromKey.slice(8, 10)),
  );
  const to = Date.UTC(
    Number(toKey.slice(0, 4)),
    Number(toKey.slice(5, 7)) - 1,
    Number(toKey.slice(8, 10)),
  );
  return Math.round((to - from) / 86_400_000);
}

export function followUpBandForDate(followUpAt: Date, now: Date): FollowUpBand {
  const diff = dayDiff(berlinDayKey(now), berlinDayKey(followUpAt));
  if (diff <= -(FOLLOW_UP_ESCALATION_DAYS + 1)) return "escalated";
  if (diff < 0) return "overdue";
  if (diff <= 1) return "due";
  return "scheduled";
}

export function parseFollowUpAt(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

const berlinHourFormat = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

// Wandelt ein Kalenderdatum (YYYY-MM-DD, Formular <input type="date">) in
// einen Berlin-Zeitpunkt (09:00 Ortszeit, DST-sicher) um. Bänder sind
// tagesbasiert; 09:00 meidet Mitternachtskanten. null bei Müll.
export function berlinDateToIso(datePart: string, hour = 9): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2020 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Tagesgültigkeit per Round-Trip (30.02. etc. fail-closed).
  if (new Date(Date.UTC(year, month - 1, day)).getUTCDate() !== day) return null;
  // Berlin-Offset an diesem Tag: Mittags-UTC ist DST-stabil am selben Tag.
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const parts = berlinHourFormat.formatToParts(probe);
  const wallMinutes =
    Number(parts.find((part) => part.type === "hour")?.value ?? "") * 60
    + Number(parts.find((part) => part.type === "minute")?.value ?? "");
  if (!Number.isFinite(wallMinutes)) return null;
  const offsetMinutes = wallMinutes - 12 * 60;
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0) - offsetMinutes * 60_000).toISOString();
}
