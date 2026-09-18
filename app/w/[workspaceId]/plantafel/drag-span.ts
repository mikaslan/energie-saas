// F7-05c: pure Drag-Spanne-Helfer (unit-testbar, ohne React/Next —
// nutzbar in Server-Komponente, Server-Action und Client-Insel).
export type CalendarDay = string;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

// Max-Spanne 7 Tage (ESTIMATE: Wochenansicht) → Tagesdifferenz <= 6.
const MAX_SPAN_DIFF = 6;

function dayToUtcMs(day: string): number | null {
  if (!DAY_PATTERN.test(day)) return null;
  const [year, month, date] = day.split("-").map(Number);
  const probe = new Date(Date.UTC(year!, month! - 1, date!));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month! - 1
    || probe.getUTCDate() !== date
  ) {
    return null;
  }
  return Date.UTC(year!, month! - 1, date!);
}

// Datum-Paar → [start, end] (min/max; YYYY-MM-DD ist lexikalisch geordnet).
export function normalizeSpan(a: CalendarDay, b: CalendarDay): [CalendarDay, CalendarDay] {
  return a <= b ? [a, b] : [b, a];
}

// end-Param nur bei Mehrtag-Spanne (Eintag = exakte heutige URL-Form).
export function buildCreateHref(
  basePath: string,
  weekStart: string,
  memberId: string,
  start: CalendarDay,
  end: CalendarDay,
): string {
  const base = `${basePath}?week=${weekStart}&create=${start}&member=${memberId}`;
  return end === start ? base : `${base}&end=${end}`;
}

// Action-Guard (fail-closed): endDate >= start und Spanne <= 7 Tage.
export function isValidEndDate(start: CalendarDay, end: string): boolean {
  const startMs = dayToUtcMs(start);
  const endMs = dayToUtcMs(end);
  if (startMs === null || endMs === null) return false;
  const diff = Math.round((endMs - startMs) / 86_400_000);
  return diff >= 0 && diff <= MAX_SPAN_DIFF;
}

// Seiten-Gate (tolerant): ungültig → Fallback end = create, kein Fehler.
export function resolveEndDate(create: CalendarDay, rawEnd: string | null | undefined): CalendarDay {
  if (rawEnd === null || rawEnd === undefined) return create;
  return isValidEndDate(create, rawEnd) ? rawEnd : create;
}

// Action-Compose: Termin-Ende aus Enddatum + Enduhrzeit.
export function composeEndWall(endDate: CalendarDay, endTime: string): string {
  return `${endDate}T${endTime}:00`;
}
