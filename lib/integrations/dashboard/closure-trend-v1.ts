// DASH-07 · Abschlusstrend-Helfer (ESTIMATE, reversibel).
// Reine Funktion: Monats-Buckets ("YYYY-MM", Berlin-seitig in SQL gebildet)
// auf die letzten N Monate auffuellen (fehlende Monate = 0/0).

export type ClosureTrendMonth = {
  /** Berliner Monats-Key „YYYY-MM". */
  month: string;
  /** Deutsche Monatsbezeichnung („Sep 2026"). */
  label: string;
  won: number;
  lost: number;
  total: number;
};

const MONTH_LABELS = [
  "Jan", "Feb", "Mär", "Apr", "Mai", "Jun",
  "Jul", "Aug", "Sep", "Okt", "Nov", "Dez",
] as const;

export function monthLabel(monthKey: string): string {
  const [year, month] = monthKey.split("-").map(Number);
  if (!year || !month || month < 1 || month > 12) return monthKey;
  return `${MONTH_LABELS[month - 1]} ${year}`;
}

function shiftMonth(monthKey: string, delta: number): string {
  const [year, month] = monthKey.split("-").map(Number) as [number, number];
  const total = (year * 12 + (month - 1)) + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (total % 12) + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}`;
}

/**
 * Fuellt Monats-Buckets lueckenlos auf (aeltester zuerst). Unbekannte
 * Outcomes ausserhalb won/lost werden ignoriert (cannot_fulfill zaehlt
 * nicht als Abschluss im Trend-Sinne — ESTIMATE, reversibel).
 */
export function fillClosureTrendMonths(
  counts: Readonly<Record<string, { won?: number; lost?: number }>>,
  endMonth: string,
  length: number,
): ClosureTrendMonth[] {
  const months: ClosureTrendMonth[] = [];
  for (let index = length - 1; index >= 0; index -= 1) {
    const month = shiftMonth(endMonth, -index);
    const bucket = counts[month] ?? {};
    const won = Math.max(0, Math.floor(bucket.won ?? 0));
    const lost = Math.max(0, Math.floor(bucket.lost ?? 0));
    months.push({ month, label: monthLabel(month), won, lost, total: won + lost });
  }
  return months;
}
