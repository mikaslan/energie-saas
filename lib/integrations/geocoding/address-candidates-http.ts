import "server-only";

import { z } from "zod";
import {
  AddressSearchQuerySchema,
  AddressSearchResultSchema,
  type AddressSearchResult,
} from "./contract";
import {
  GeocodingInvalidResponseError,
  GeocodingRateLimitedError,
  GeocodingTimeoutError,
  GeocodingUnavailableError,
} from "./geoapify";

const MAXIMUM_REQUEST_BYTES = 2 * 1024;
const DEFAULT_PROVIDER_RETRY_AFTER_SECONDS = 60;

const uuidSchema = z.string().uuid();
const requestBodySchema = z.strictObject({ query: AddressSearchQuerySchema });

const RESPONSE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export type AddressCandidateSearchAccess =
  | { status: "allowed"; rateLimitKey: string }
  | { status: "unauthenticated" }
  | { status: "forbidden" }
  | { status: "not_found" }
  | { status: "not_editable" };

export type AddressCandidateSearchAuthorizer = (input: {
  workspaceId: string;
  projectId: string;
}) => Promise<AddressCandidateSearchAccess>;

export type AddressCandidateSearcher = (query: string) => Promise<AddressSearchResult>;

export type AddressCandidateSearchDependencies = {
  authorize: AddressCandidateSearchAuthorizer;
  search: AddressCandidateSearcher;
  rateLimiter: FixedWindowRateLimiter;
  now?: () => number;
};

export type FixedWindowRateLimitDecision = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

type FixedWindowBucket = {
  windowStartMs: number;
  count: number;
};

/**
 * Process-local pilot limiter. Its fixed, epoch-aligned windows make the
 * boundary deterministic and its result independent of request duration.
 * A distributed limiter remains an explicit production gate in M1-06.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, FixedWindowBucket>();

  constructor(
    private readonly limit = 20,
    private readonly windowMs = 60_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new TypeError("rate limit must be a positive integer");
    }
    if (!Number.isInteger(windowMs) || windowMs < 1_000) {
      throw new TypeError("rate limit window must be at least one second");
    }
  }

  consume(key: string, nowMs: number): FixedWindowRateLimitDecision {
    if (key.length < 1 || key.length > 512) {
      throw new TypeError("rate limit key is invalid");
    }
    if (!Number.isFinite(nowMs) || nowMs < 0) {
      throw new TypeError("rate limit clock is invalid");
    }

    const timestamp = Math.floor(nowMs);
    const windowStartMs = Math.floor(timestamp / this.windowMs) * this.windowMs;
    const windowEndMs = windowStartMs + this.windowMs;
    const existing = this.buckets.get(key);
    const bucket = existing?.windowStartMs === windowStartMs
      ? existing
      : { windowStartMs, count: 0 };

    this.buckets.set(key, bucket);
    this.removeExpiredBuckets(windowStartMs);

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowEndMs - timestamp) / 1_000),
    );
    if (bucket.count >= this.limit) {
      return { allowed: false, remaining: 0, retryAfterSeconds };
    }

    bucket.count += 1;
    return {
      allowed: true,
      remaining: this.limit - bucket.count,
      retryAfterSeconds,
    };
  }

  private removeExpiredBuckets(currentWindowStartMs: number): void {
    // Authenticated actor/workspace keys are bounded in normal operation. This
    // cleanup additionally prevents abandoned keys from living forever.
    if (this.buckets.size < 256) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStartMs < currentWindowStartMs) this.buckets.delete(key);
    }
  }
}

function jsonResponse(
  body: unknown,
  status: number,
  additionalHeaders?: Readonly<Record<string, string>>,
): Response {
  return Response.json(body, {
    status,
    headers: { ...RESPONSE_HEADERS, ...additionalHeaders },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  additionalHeaders?: Readonly<Record<string, string>>,
): Response {
  return jsonResponse({ error: { code, message } }, status, additionalHeaders);
}

function invalidRequest(): Response {
  return errorResponse(400, "invalid_request", "Die Anfrage ist ungültig.");
}

function isApplicationJson(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  if (contentType === null) return false;
  return contentType.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function isIdentityContentEncoding(request: Request): boolean {
  const contentEncoding = request.headers.get("content-encoding");
  return contentEncoding === null || contentEncoding.trim().toLowerCase() === "identity";
}

function validHostHeader(value: string): boolean {
  return value.length > 0
    && value.length <= 255
    && !/[\s,/@\\]/u.test(value);
}

function isSameOrigin(request: Request): boolean {
  const originHeader = request.headers.get("origin");
  if (originHeader === null) return false;

  let origin: URL;
  let requestUrl: URL;
  try {
    origin = new URL(originHeader);
    requestUrl = new URL(request.url);
  } catch {
    return false;
  }

  if (
    (origin.protocol !== "https:" && origin.protocol !== "http:")
    || origin.username !== ""
    || origin.password !== ""
    || origin.pathname !== "/"
    || origin.search !== ""
    || origin.hash !== ""
  ) {
    return false;
  }

  const rawHost = request.headers.get("host") ?? requestUrl.host;
  if (!validHostHeader(rawHost)) return false;

  // Forwarded headers are deliberately not accepted as trust input here. A
  // deployment that rewrites the public URL must make Request.url canonical
  // at the platform boundary instead of letting callers choose an origin.
  if (origin.protocol !== requestUrl.protocol) return false;

  try {
    const effectiveHost = new URL(`${origin.protocol}//${rawHost}`).host.toLowerCase();
    return origin.host.toLowerCase() === effectiveHost
      && origin.host.toLowerCase() === requestUrl.host.toLowerCase();
  } catch {
    return false;
  }
}

async function readLimitedRequestBody(request: Request): Promise<Uint8Array | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const normalized = declaredLength.trim();
    if (!/^\d+$/u.test(normalized) || Number(normalized) > MAXIMUM_REQUEST_BYTES) {
      if (request.body) void request.body.cancel().catch(() => undefined);
      return null;
    }
  }

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      return null;
    }
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAXIMUM_REQUEST_BYTES) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(chunk.value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function parseBody(request: Request): Promise<{ query: string } | null> {
  const bytes = await readLimitedRequestBody(request);
  if (bytes === null) return null;

  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }

  const parsed = requestBodySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function accessResponse(access: Exclude<AddressCandidateSearchAccess, { status: "allowed" }>): Response {
  switch (access.status) {
    case "unauthenticated":
      return errorResponse(401, "unauthenticated", "Bitte melden Sie sich an.");
    case "forbidden":
      return errorResponse(403, "forbidden", "Sie dürfen diese Adresse nicht suchen.");
    case "not_found":
      return errorResponse(404, "not_found", "Das Projekt wurde nicht gefunden.");
    case "not_editable":
      return errorResponse(
        409,
        "not_editable",
        "Die Adresse kann in diesem Zustand nicht bearbeitet werden.",
      );
  }
}

function retryAfterHeader(seconds: number): Readonly<Record<string, string>> {
  return { "Retry-After": String(seconds) };
}

function providerErrorResponse(error: unknown): Response | null {
  if (error instanceof GeocodingRateLimitedError) {
    return errorResponse(
      429,
      "geocoding_rate_limited",
      "Der Adressdienst nimmt derzeit zu viele Anfragen entgegen.",
      retryAfterHeader(DEFAULT_PROVIDER_RETRY_AFTER_SECONDS),
    );
  }
  if (error instanceof GeocodingInvalidResponseError) {
    return errorResponse(
      502,
      "geocoding_invalid_response",
      "Der Adressdienst hat keine gültige Antwort geliefert.",
    );
  }
  if (error instanceof GeocodingTimeoutError || error instanceof GeocodingUnavailableError) {
    return errorResponse(
      503,
      "geocoding_unavailable",
      "Der Adressdienst ist vorübergehend nicht verfügbar.",
    );
  }
  return null;
}

export async function handleAddressCandidateSearchRequest(
  request: Request,
  rawParams: Readonly<{ workspaceId: string; projectId: string }>,
  dependencies: AddressCandidateSearchDependencies,
): Promise<Response> {
  const parsedParams = z.strictObject({
    workspaceId: uuidSchema,
    projectId: uuidSchema,
  }).safeParse(rawParams);
  if (!parsedParams.success) return invalidRequest();

  if (!isSameOrigin(request)) {
    return errorResponse(
      403,
      "origin_mismatch",
      "Die Herkunft der Anfrage konnte nicht bestätigt werden.",
    );
  }
  if (!isApplicationJson(request) || !isIdentityContentEncoding(request)) {
    return invalidRequest();
  }

  const body = await parseBody(request);
  if (body === null) return invalidRequest();

  let access: AddressCandidateSearchAccess;
  try {
    access = await dependencies.authorize(parsedParams.data);
  } catch {
    return errorResponse(
      500,
      "internal_error",
      "Die Adresssuche konnte nicht ausgeführt werden.",
    );
  }
  if (access.status !== "allowed") return accessResponse(access);

  let rateLimit: FixedWindowRateLimitDecision;
  try {
    rateLimit = dependencies.rateLimiter.consume(
      access.rateLimitKey,
      dependencies.now?.() ?? Date.now(),
    );
  } catch {
    return errorResponse(
      500,
      "internal_error",
      "Die Adresssuche konnte nicht ausgeführt werden.",
    );
  }
  if (!rateLimit.allowed) {
    return errorResponse(
      429,
      "rate_limited",
      "Zu viele Suchanfragen. Bitte versuchen Sie es später erneut.",
      retryAfterHeader(rateLimit.retryAfterSeconds),
    );
  }

  let result: AddressSearchResult;
  try {
    result = await dependencies.search(body.query);
  } catch (error) {
    return providerErrorResponse(error) ?? errorResponse(
      500,
      "internal_error",
      "Die Adresssuche konnte nicht ausgeführt werden.",
    );
  }

  const canonicalResult = AddressSearchResultSchema.safeParse(result);
  if (!canonicalResult.success) {
    return errorResponse(
      502,
      "geocoding_invalid_response",
      "Der Adressdienst hat keine gültige Antwort geliefert.",
    );
  }
  return jsonResponse(canonicalResult.data, 200);
}
