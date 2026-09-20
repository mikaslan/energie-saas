import {
  OFFER_MAX_MONEY_CENTS,
  optionalBundlesSchema,
  type OptionalBundlesV1,
} from "./contract";

const EURO_CENTS_PATTERN = /^(?:0|[1-9]\d*)(?:[.,](\d{1,2}))?$/u;

export function parseEuroCentsInput(value: string): number | null {
  const normalized = value.trim();
  const match = EURO_CENTS_PATTERN.exec(normalized);
  if (!match) return null;
  const whole = Number(normalized.split(/[.,]/u)[0]);
  const fraction = Number((match[1] ?? "").padEnd(2, "0") || "0");
  const cents = whole * 100 + fraction;
  if (!Number.isSafeInteger(cents) || cents < 0 || cents > OFFER_MAX_MONEY_CENTS) {
    return null;
  }
  return cents;
}

export function formatCentsToEuroInput(value: number | null): string {
  if (value === null) return "";
  const whole = Math.floor(value / 100);
  const fraction = String(value % 100).padStart(2, "0");
  return fraction === "00" ? String(whole) : `${whole},${fraction}`;
}

export function parseBundlesJsonInput(value: string): OptionalBundlesV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  const result = optionalBundlesSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export type VariantContentLock = "pending" | "signed" | "revoked_by_customer";

export type VariantBlockedCode =
  | "variant_signature_pending"
  | "variant_signed"
  | "variant_revoked_by_customer";

export function contentLockToBlockedCode(lock: VariantContentLock): VariantBlockedCode {
  return lock === "pending"
    ? "variant_signature_pending"
    : lock === "signed"
      ? "variant_signed"
      : "variant_revoked_by_customer";
}

export function dominantContentLock(
  locks: Iterable<VariantContentLock>,
): VariantContentLock | null {
  let dominant: VariantContentLock | null = null;
  for (const lock of locks) {
    if (lock === "revoked_by_customer") return "revoked_by_customer";
    if (lock === "signed") dominant = "signed";
    else if (dominant === null) dominant = "pending";
  }
  return dominant;
}
