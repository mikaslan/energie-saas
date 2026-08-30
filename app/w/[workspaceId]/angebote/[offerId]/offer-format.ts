const groupedEurosFormatter = new Intl.NumberFormat("de-DE", {
  maximumFractionDigits: 0,
});

/** Formatiert Centwerte ohne verlustbehaftete Division am Safe-Integer-Rand. */
export function formatOfferCents(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isSafeInteger(value)) return "–";
  const negative = value < 0;
  const absoluteCents = Math.abs(value);
  const euros = Math.floor(absoluteCents / 100);
  const remainder = String(absoluteCents % 100).padStart(2, "0");
  return `${negative ? "−" : ""}${groupedEurosFormatter.format(euros)},${remainder}\u00a0€`;
}

export function formatOfferCentsTotal(values: readonly (number | null | undefined)[]): string {
  let total = BigInt(0);
  for (const value of values) {
    if (value === null || value === undefined) continue;
    if (!Number.isSafeInteger(value)) return "–";
    total += BigInt(value);
  }
  const negative = total < BigInt(0);
  const absoluteCents = negative ? -total : total;
  const euros = absoluteCents / BigInt(100);
  const remainder = String(absoluteCents % BigInt(100)).padStart(2, "0");
  return `${negative ? "−" : ""}${groupedEurosFormatter.format(euros)},${remainder}\u00a0€`;
}

export function formatOfferRetryDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "zu einem späteren Zeitpunkt";
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(parsed);
}
