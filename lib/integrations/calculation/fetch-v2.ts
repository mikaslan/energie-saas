/**
 * F4.1 v2-Fetch (Spec F4-01, "Providerabrufe ... Abrufgrenzen"): holt
 * kanonische PVGIS-URLs ueber den geteilten Transport
 * (`http-transport.ts`) und liefert Rohtext plus Abrufzeiten. Parser
 * (`provider-v2.ts`, `horizon-v2.ts`, `pvcalc-v2.ts`) laufen danach.
 *
 * Regeln: nur GET, `Accept: application/json`, `redirect: manual` mit
 * max. 3 Same-Origin-Hops; Cross-Origin-Redirect bricht deterministisch
 * ab (kein Retry). Größen- und Content-Type-Gates wirft der Transport;
 * Timeouts/5xx/Netzfehler sind retryable (`F401FetchError`), 429 trägt
 * Retry-After (`F401RateLimitedError`), 4xx ist deterministisch
 * (`F401ProviderError`). Tests duerfen ausserhalb von Production den
 * Origin per `PVGIS_BASE_URL` auf Loopback umbiegen (Muster aus v1);
 * Query-Strings bleiben kanonisch unangetastet.
 */
import {
  fetchTransportText,
  HttpTransportError,
  resolveLoopbackOrigin,
} from "./http-transport";
import {
  F401ConfigurationError,
  F401FetchError,
  F401ProviderError,
  F401RateLimitedError,
  F401SizeError,
  parseSeriescalcSnapshot,
  type ParsedSeriescalcSnapshot,
} from "./provider-v2";
import { parsePrinthorizon, type CanonicalHorizon } from "./horizon-v2";
import { parsePVcalcSnapshot, type ParsedPVcalcSnapshot } from "./pvcalc-v2";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECT_HOPS = 3;

export type FetchedRaw = {
  rawText: string;
  fetchedAtUtc: string;
  receivedAtUtc: string;
};

function configurationError(detail: string): never {
  throw new F401ConfigurationError(detail);
}

function applyOriginOverride(canonicalUrl: string): string {
  const override = resolveLoopbackOrigin(
    "PVGIS_BASE_URL",
    process.env.PVGIS_BASE_URL,
    "/api/v5_3",
  );
  if (process.env.PVGIS_BASE_URL?.trim() && override === null) {
    configurationError("PVGIS_BASE_URL ist kein Loopback-/api/v5_3-Origin");
  }
  if (override === null) return canonicalUrl;
  let parsed: URL;
  try {
    parsed = new URL(canonicalUrl);
  } catch {
    configurationError("kanonische URL ist ungueltig");
  }
  // Der Override liefert Origin+Pfad ("/api/v5_3"); der kanonische Pfad
  // steht bereits in der URL — nur der Origin wird ersetzt.
  const overrideOrigin = override.slice(0, -"/api/v5_3".length);
  return `${overrideOrigin}${parsed.pathname}${parsed.search}`;
}

function mapTransportError(error: HttpTransportError): never {
  switch (error.kind) {
    case "timeout":
    case "unavailable":
    case "overloaded":
      throw new F401FetchError(error.kind, error.retryAfterMs);
    case "rate_limited":
      throw new F401RateLimitedError(error.retryAfterMs);
    case "http_error":
      throw new F401ProviderError(`HTTP-Fehler ohne Retry`);
    case "invalid_response":
      throw new F401ProviderError("Antwort verletzt das Abrufformat");
    case "oversize":
      throw new F401SizeError("Antwort ueberschreitet die Byte-Schranke");
  }
}

export async function fetchV2RawText(
  canonicalUrl: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<FetchedRaw> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    configurationError("timeoutMs ungueltig");
  }
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    configurationError("maxBytes ungueltig");
  }
  let current = applyOriginOverride(canonicalUrl);
  const fetchedAtUtc = new Date().toISOString();
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    let response;
    try {
      response = await fetchTransportText(current, {
        timeoutMs,
        maxBytes,
        redirect: "manual",
      });
    } catch (error) {
      if (error instanceof HttpTransportError) mapTransportError(error);
      throw new F401FetchError("Netzfehler");
    }
    if (response.kind === "ok") {
      return { rawText: response.text, fetchedAtUtc, receivedAtUtc: new Date().toISOString() };
    }
    const location = response.headers.get("location");
    if (location === null) {
      throw new F401ProviderError("Redirect ohne Location");
    }
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new F401ProviderError("Redirect-Location ungueltig");
    }
    if (next.origin !== new URL(current).origin) {
      throw new F401ProviderError("Cross-Origin-Redirect abgebrochen");
    }
    if (hop === MAX_REDIRECT_HOPS) {
      throw new F401ProviderError("zu viele Redirects");
    }
    current = next.toString();
  }
  throw new F401ProviderError("Redirect-Schleife abgebrochen");
}

export async function fetchSeriescalcSnapshotV2(
  canonicalUrl: string,
  options: { tilted: boolean; timeoutMs?: number; maxBytes?: number } = { tilted: false },
): Promise<ParsedSeriescalcSnapshot & FetchedRaw> {
  const fetched = await fetchV2RawText(canonicalUrl, options);
  return {
    ...parseSeriescalcSnapshot(fetched.rawText, { tilted: options.tilted }),
    ...fetched,
  };
}

export async function fetchPrinthorizonV2(
  canonicalUrl: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<CanonicalHorizon & FetchedRaw> {
  const fetched = await fetchV2RawText(canonicalUrl, options);
  return { ...parsePrinthorizon(fetched.rawText), ...fetched };
}

export async function fetchPVcalcSnapshotV2(
  canonicalUrl: string,
  options: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ParsedPVcalcSnapshot & FetchedRaw> {
  const fetched = await fetchV2RawText(canonicalUrl, options);
  return { ...parsePVcalcSnapshot(fetched.rawText), ...fetched };
}
