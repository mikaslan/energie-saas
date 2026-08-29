const FALLBACK_NEXT_PATH = "/";
const INTERNAL_ORIGIN = "https://wmee.invalid";
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

function decodeForInspection(value: string): string | null {
  let decoded = value;

  for (let pass = 0; pass < 5; pass += 1) {
    if (
      !decoded.startsWith("/")
      || decoded.startsWith("//")
      || CONTROL_CHARACTER.test(decoded)
      || decoded.includes("\\")
    ) {
      return null;
    }

    let nextDecoded: string;
    try {
      nextDecoded = decodeURIComponent(decoded);
    } catch {
      return null;
    }
    if (nextDecoded === decoded) return decoded;
    decoded = nextDecoded;
  }

  // Ungewöhnlich tief verschachtelte Kodierung bleibt fail-closed, damit eine
  // spätere Proxy-/Browser-Schicht keinen anders interpretierten Pfad erhält.
  return null;
}

export function safeInternalNextPath(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return FALLBACK_NEXT_PATH;
  }

  const decoded = decodeForInspection(value);
  if (decoded === null || !decoded.startsWith("/") || decoded.startsWith("//")) {
    return FALLBACK_NEXT_PATH;
  }

  try {
    const target = new URL(value, INTERNAL_ORIGIN);
    const inspectedTarget = new URL(decoded, INTERNAL_ORIGIN);
    if (target.origin !== INTERNAL_ORIGIN || inspectedTarget.origin !== INTERNAL_ORIGIN) {
      return FALLBACK_NEXT_PATH;
    }

    const inspectedPathname = inspectedTarget.pathname.toLowerCase().replace(/\/+$/, "");
    if (inspectedPathname === "/login" || inspectedPathname.startsWith("/login/")) {
      return FALLBACK_NEXT_PATH;
    }

    const normalizedTarget = `${target.pathname}${target.search}${target.hash}`;
    if (
      !normalizedTarget.startsWith("/")
      || normalizedTarget.startsWith("//")
      || CONTROL_CHARACTER.test(normalizedTarget)
      || normalizedTarget.includes("\\")
    ) {
      return FALLBACK_NEXT_PATH;
    }
    return normalizedTarget;
  } catch {
    return FALLBACK_NEXT_PATH;
  }
}
