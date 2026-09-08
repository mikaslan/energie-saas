/**
 * Geteilter HTTP-Transport fuer Provider-Abrufe (v1 + F4.1 v2). Extrahiert
 * aus `pvgis.ts` ohne Verhaltensänderung (Orakel:
 * `tests/unit/pvgis-provider.test.ts`): Timeout per AbortController,
 * Status-Mapping (429/529/5xx), Content-Type-Pflicht
 * (`application/json`), Content-Length-Vorabpruefung, strombasierte
 * Byte-Schranke, striktes UTF-8-Dekodieren, Retry-After-Auswertung
 * (Sekunden oder HTTP-Datum, gedeckelt).
 *
 * Fehler sind neutral (`HttpTransportError` mit `kind`); jede Schicht
 * mappt auf ihre eigene Taxonomie (v1: `PvgisProviderError`,
 * v2: `F401*Error`). Redirects folgt der Transport nie selbst:
 * `redirect: "error"` wirft (v1-Verhalten), `redirect: "manual"` liefert
 * den 3xx-Status zurueck, damit der Aufrufer die Spec-Politik
 * implementiert (v2: Cross-Origin-Abbruch).
 */
export type HttpTransportFailureKind =
  | "timeout"
  | "rate_limited"
  | "overloaded"
  | "unavailable"
  | "http_error"
  | "invalid_response"
  | "oversize";

export class HttpTransportError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly kind: HttpTransportFailureKind,
    retryAfterMs?: number,
  ) {
    super(`http transport failed: ${kind}`);
    this.retryAfterMs = retryAfterMs;
  }
}

export type TransportResponse =
  | { kind: "ok"; status: number; headers: Headers; text: string }
  | { kind: "redirect"; status: number; headers: Headers };

const MAX_RETRY_AFTER_MS = 60 * 60_000;

function discardBody(response: Response): void {
  if (response.body) void response.body.cancel().catch(() => undefined);
}

function parseRetryAfterMs(response: Response): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  let milliseconds: number;
  if (/^\d+$/u.test(value)) {
    milliseconds = Number(value) * 1_000;
  } else {
    const at = Date.parse(value);
    if (!Number.isFinite(at)) return undefined;
    milliseconds = Math.max(0, at - Date.now());
  }
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined;
  return Math.min(Math.round(milliseconds), MAX_RETRY_AFTER_MS);
}

function isRedirectStatus(status: number): boolean {
  return status === 300 || status === 301 || status === 302 || status === 303
    || status === 307 || status === 308;
}

async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new HttpTransportError("invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new HttpTransportError("oversize");
    }
    chunks.push(next.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpTransportError("invalid_response");
  }
}

export async function fetchTransportText(
  url: string,
  options: {
    timeoutMs: number;
    maxBytes: number;
    redirect: "error" | "manual";
    signal?: AbortSignal;
  },
): Promise<TransportResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs);
  const forwardAbort = options.signal === undefined
    ? undefined
    : () => controller.abort();
  options.signal?.addEventListener("abort", forwardAbort as () => void, { once: true });
  try {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "omit",
        redirect: options.redirect,
        signal: controller.signal,
      });
    } catch {
      if (timedOut) throw new HttpTransportError("timeout");
      throw new HttpTransportError("unavailable");
    }
    if (options.redirect === "manual" && isRedirectStatus(response.status)) {
      discardBody(response);
      return { kind: "redirect", status: response.status, headers: response.headers };
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfterMs(response);
      discardBody(response);
      throw new HttpTransportError("rate_limited", retryAfterMs);
    }
    if (response.status === 529) {
      const retryAfterMs = parseRetryAfterMs(response);
      discardBody(response);
      throw new HttpTransportError("overloaded", retryAfterMs);
    }
    if (response.status >= 500 && response.status <= 599) {
      const retryAfterMs = parseRetryAfterMs(response);
      discardBody(response);
      throw new HttpTransportError("unavailable", retryAfterMs);
    }
    if (!response.ok) {
      discardBody(response);
      throw new HttpTransportError("http_error");
    }
    const contentType = response.headers.get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      discardBody(response);
      throw new HttpTransportError("invalid_response");
    }
    const contentLength = response.headers.get("content-length")?.trim();
    if (
      contentLength !== undefined
      && (!/^\d+$/u.test(contentLength) || Number(contentLength) > options.maxBytes)
    ) {
      discardBody(response);
      throw new HttpTransportError("oversize");
    }
    const text = await readCappedText(response, options.maxBytes);
    return { kind: "ok", status: response.status, headers: response.headers, text };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort as () => void);
  }
}

/**
 * Loopback-nur Origin-Override ausserhalb von Production (Muster aus
 * `pvgis.ts`): exakter Pfad, keine Credentials/Query/Fragment.
 */
export function resolveLoopbackOrigin(
  envVar: string,
  envValue: string | undefined,
  requiredPath: string,
): string | null {
  const override = envValue?.trim();
  if (!override) return null;
  if (process.env.NODE_ENV === "production") return null;
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    return null;
  }
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]";
  const path = parsed.pathname.replace(/\/$/u, "");
  if (
    !loopback
    || (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.search !== ""
    || parsed.hash !== ""
    || path !== requiredPath
  ) {
    return null;
  }
  return `${parsed.origin}${path}`;
}
