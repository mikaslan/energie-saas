// F13-13 AT-Fristen: BUNDESWEITE Feiertage (ESTIMATE, reversibel).
// Rein (keine Imports, kein I/O): 9 bundeseinheitliche Tage — Neujahr,
// Karfreitag, Ostermontag, Tag der Arbeit, Christi Himmelfahrt,
// Pfingstmontag, Tag der Deutschen Einheit, 1./2. Weihnachtstag.
// Landes-Feiertage (z. B. Frauentag Berlin, Fronleichnam, Reformationstag)
// zählen bewusst NICHT: die Sitzland-Heuristik bleibt offen (Spec §2),
// Bund ist die reproduzierbare Näherung. Oster-Algorithmus (Computus,
// Meeus/Jones/Butcher, Gregorianisch). Berlin nur als Kalendertag,
// keine TZ-Rechnung (reine ISO-Dates).
const DAY_MS = 86_400_000;

function easterSundayUtcMs(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(year, month - 1, day);
}

function shiftIsoDate(easterMs: number, days: number): string {
  return new Date(easterMs + days * DAY_MS).toISOString().slice(0, 10);
}

export function bundHolidaysBerlin(year: number): string[] {
  if (!Number.isInteger(year) || year < 1583 || year > 9999) {
    throw new Error(`invalid year: ${year}`);
  }
  const easter = easterSundayUtcMs(year);
  return [
    `${year}-01-01`,
    shiftIsoDate(easter, -2),
    shiftIsoDate(easter, 1),
    `${year}-05-01`,
    shiftIsoDate(easter, 39),
    shiftIsoDate(easter, 50),
    `${year}-10-03`,
    `${year}-12-25`,
    `${year}-12-26`,
  ].sort();
}
