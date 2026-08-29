import "server-only";

import { z } from "zod";
import {
  AddressCandidateSchema,
  AddressPlaceIdSchema,
  AddressSearchQuerySchema,
  AddressSearchResultSchema,
  type AddressCandidate,
  type AddressSearchResult,
} from "./contract";

const DEFAULT_BASE_URL = "https://api.geoapify.com";
const REQUEST_TIMEOUT_MS = 3_500;
const MAX_RESPONSE_BYTES = 256 * 1024;

export type GeocodingProviderErrorCode =
  | "unavailable"
  | "rate_limited"
  | "timeout"
  | "invalid_response";

export abstract class GeocodingProviderError extends Error {
  protected constructor(
    public readonly code: GeocodingProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GeocodingProviderError";
  }
}

export class GeocodingUnavailableError extends GeocodingProviderError {
  constructor() {
    super("unavailable", "geocoding provider unavailable");
    this.name = "GeocodingUnavailableError";
  }
}

export class GeocodingRateLimitedError extends GeocodingProviderError {
  constructor() {
    super("rate_limited", "geocoding provider rate limited");
    this.name = "GeocodingRateLimitedError";
  }
}

export class GeocodingTimeoutError extends GeocodingProviderError {
  constructor() {
    super("timeout", "geocoding provider timed out");
    this.name = "GeocodingTimeoutError";
  }
}

export class GeocodingInvalidResponseError extends GeocodingProviderError {
  constructor() {
    super("invalid_response", "geocoding provider returned an invalid response");
    this.name = "GeocodingInvalidResponseError";
  }
}

const autocompleteEnvelopeSchema = z.object({
  results: z.array(z.unknown()).max(5),
});

const placeDetailsEnvelopeSchema = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(z.unknown()).max(5),
});

const rawRecordSchema = z.record(z.string(), z.unknown());

function safeQuery(value: unknown): string {
  const parsed = AddressSearchQuerySchema.safeParse(value);
  if (!parsed.success) throw new TypeError("invalid geocoding query");
  return parsed.data;
}

function safePlaceId(value: unknown): string {
  const parsed = AddressPlaceIdSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("invalid geocoding place id");
  return parsed.data;
}

function apiKey(): string {
  const value = process.env.GEOAPIFY_API_KEY?.trim();
  if (
    !value
    || value.length > 512
    || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new GeocodingUnavailableError();
  }
  return value;
}

function providerBaseUrl(): string {
  const override = process.env.GEOAPIFY_BASE_URL;
  if (override === undefined) return DEFAULT_BASE_URL;
  if (process.env.NODE_ENV === "production") {
    throw new GeocodingUnavailableError();
  }

  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new GeocodingUnavailableError();
  }

  const loopbackHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const cleanOrigin =
    (parsed.protocol === "http:" || parsed.protocol === "https:")
    && loopbackHost
    && parsed.username === ""
    && parsed.password === ""
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === "";

  if (!cleanOrigin) throw new GeocodingUnavailableError();
  return parsed.origin;
}

function discardBody(response: Response): void {
  if (response.body) void response.body.cancel().catch(() => undefined);
}

function assertJsonContentType(response: Response): void {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json" && contentType !== "application/geo+json") {
    discardBody(response);
    throw new GeocodingInvalidResponseError();
  }
}

function assertContentLength(response: Response): void {
  const header = response.headers.get("content-length");
  if (header === null) return;
  const normalized = header.trim();
  if (!/^\d+$/u.test(normalized) || Number(normalized) > MAX_RESPONSE_BYTES) {
    discardBody(response);
    throw new GeocodingInvalidResponseError();
  }
}

async function readLimitedJson(response: Response): Promise<unknown> {
  assertJsonContentType(response);
  assertContentLength(response);
  if (!response.body) throw new GeocodingInvalidResponseError();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new GeocodingInvalidResponseError();
    }
    chunks.push(chunk.value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new GeocodingInvalidResponseError();
  }
}

async function requestJson(path: string, parameters: Readonly<Record<string, string>>): Promise<unknown> {
  const url = new URL(path, `${providerBaseUrl()}/`);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  url.searchParams.set("apiKey", apiKey());

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });

    if (response.status === 429) {
      discardBody(response);
      throw new GeocodingRateLimitedError();
    }
    if (!response.ok) {
      discardBody(response);
      throw new GeocodingUnavailableError();
    }

    return await readLimitedJson(response);
  } catch (error) {
    if (error instanceof GeocodingProviderError) throw error;
    if (timedOut) throw new GeocodingTimeoutError();
    throw new GeocodingUnavailableError();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeProviderText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized === "" ? null : normalized;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = rawRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function candidateFromProperties(
  properties: Record<string, unknown>,
  requireAddressResultType: boolean,
  requestedPlaceId?: string,
): AddressCandidate | null {
  const resultType = normalizeProviderText(properties.result_type);
  if (
    requireAddressResultType
    && resultType !== "building"
    && resultType !== "amenity"
  ) {
    return null;
  }

  const providerPlaceId = normalizeProviderText(properties.place_id);
  if (
    requestedPlaceId !== undefined
    && providerPlaceId !== null
    && providerPlaceId !== requestedPlaceId
  ) {
    return null;
  }
  // Place Details is already addressed by the server-normalized opaque ID.
  // Geoapify examples echo place_id, but the Details address-field table does
  // not promise it. A present echo must match; an absent echo does not make a
  // response to the fixed ID ambiguous.
  const placeId = requestedPlaceId ?? providerPlaceId;
  const street = normalizeProviderText(properties.street);
  const houseNumber = normalizeProviderText(properties.housenumber);
  const postalCode = normalizeProviderText(properties.postcode);
  const city = normalizeProviderText(properties.city);
  const countryCode = normalizeProviderText(properties.country_code)?.toUpperCase();

  if (!placeId || !street || !houseNumber || !postalCode || !city || countryCode !== "DE") {
    return null;
  }

  const candidate = AddressCandidateSchema.safeParse({
    placeId,
    formattedAddress: `${street} ${houseNumber}, ${postalCode} ${city}`,
    street,
    houseNumber,
    postalCode,
    city,
    countryCode,
    latitude: properties.lat,
    longitude: properties.lon,
    provider: "geoapify",
    precision: "house",
  });

  return candidate.success ? candidate.data : null;
}

function searchCandidate(value: unknown): AddressCandidate | null {
  const properties = asRecord(value);
  return properties ? candidateFromProperties(properties, true) : null;
}

function detailsCandidate(value: unknown, requestedPlaceId: string): AddressCandidate | null {
  const feature = asRecord(value);
  if (!feature || feature.type !== "Feature") return null;
  const properties = asRecord(feature.properties);
  if (!properties || normalizeProviderText(properties.feature_type) !== "details") return null;
  return candidateFromProperties(properties, false, requestedPlaceId);
}

export async function searchAddressCandidates(query: string): Promise<AddressSearchResult> {
  const normalizedQuery = safeQuery(query);
  const raw = await requestJson("/v1/geocode/autocomplete", {
    text: normalizedQuery,
    lang: "de",
    format: "json",
    limit: "5",
    filter: "countrycode:de",
  });

  const envelope = autocompleteEnvelopeSchema.safeParse(raw);
  if (!envelope.success) throw new GeocodingInvalidResponseError();

  const seen = new Set<string>();
  const candidates: AddressCandidate[] = [];
  for (const value of envelope.data.results) {
    const candidate = searchCandidate(value);
    if (!candidate || seen.has(candidate.placeId)) continue;
    seen.add(candidate.placeId);
    candidates.push(candidate);
  }

  const result = AddressSearchResultSchema.safeParse({ candidates });
  if (!result.success) throw new GeocodingInvalidResponseError();
  return result.data;
}

export async function resolveAddressCandidate(placeId: string): Promise<AddressCandidate> {
  const normalizedPlaceId = safePlaceId(placeId);
  const raw = await requestJson("/v2/place-details", {
    id: normalizedPlaceId,
    features: "details",
    lang: "de",
  });

  const envelope = placeDetailsEnvelopeSchema.safeParse(raw);
  if (!envelope.success) throw new GeocodingInvalidResponseError();

  for (const value of envelope.data.features) {
    const candidate = detailsCandidate(value, normalizedPlaceId);
    if (candidate) return candidate;
  }

  throw new GeocodingInvalidResponseError();
}
