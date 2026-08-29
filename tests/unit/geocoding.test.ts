import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  AddressSearchResultSchema,
  GeocodingInvalidResponseError,
  GeocodingRateLimitedError,
  GeocodingTimeoutError,
  GeocodingUnavailableError,
  resolveAddressCandidate,
  searchAddressCandidates,
} from "@/lib/integrations/geocoding";

const ORIGINAL_ENV = {
  apiKey: process.env.GEOAPIFY_API_KEY,
  baseUrl: process.env.GEOAPIFY_BASE_URL,
  nodeEnv: process.env.NODE_ENV,
};

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function rawAddress(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    place_id: "51abcDEF_123:-",
    formatted: "  Hauptstraße 1, 10115 Berlin, Deutschland  ",
    street: "  Hauptstraße  ",
    housenumber: " 1 ",
    postcode: "10115",
    city: " Berlin ",
    country_code: "de",
    lat: 52.532,
    lon: 13.384,
    result_type: "building",
    datasource: { raw: "must not escape the adapter" },
    ...overrides,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => response.clone());
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  setEnv("GEOAPIFY_API_KEY", "unit-test-key");
  setEnv("GEOAPIFY_BASE_URL", undefined);
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setEnv("GEOAPIFY_API_KEY", ORIGINAL_ENV.apiKey);
  setEnv("GEOAPIFY_BASE_URL", ORIGINAL_ENV.baseUrl);
  setEnv("NODE_ENV", ORIGINAL_ENV.nodeEnv);
});

describe("Geoapify address search contract", () => {
  it("calls the fixed autocomplete endpoint and returns only normalized house-level DE candidates", async () => {
    const fetchMock = stubFetch(jsonResponse({
      results: [
        rawAddress({ street: " Ko\u0308nigstraße " }),
        rawAddress({ place_id: "missing-house", housenumber: undefined }),
        rawAddress({ place_id: "foreign", country_code: "at" }),
        rawAddress({ place_id: "bad-postcode", postcode: "1011" }),
        rawAddress({ place_id: "street-only", result_type: "street" }),
      ],
      query: { text: "provider raw data" },
    }));

    const result = await searchAddressCandidates("  Ｋönigstraße   1, Berlin  ");

    expect(result).toEqual({
      candidates: [{
        placeId: "51abcDEF_123:-",
        formattedAddress: "Königstraße 1, 10115 Berlin",
        street: "Königstraße",
        houseNumber: "1",
        postalCode: "10115",
        city: "Berlin",
        countryCode: "DE",
        latitude: 52.532,
        longitude: 13.384,
        provider: "geoapify",
        precision: "house",
      }],
    });
    expect(AddressSearchResultSchema.safeParse(result).success).toBe(true);
    expect(AddressSearchResultSchema.safeParse({
      candidates: [{ ...result.candidates[0], providerRaw: "must stay private" }],
    }).success).toBe(false);
    expect(Object.keys(result.candidates[0] ?? {})).not.toContain("datasource");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const url = new URL(String(input));
    expect(url.origin).toBe("https://api.geoapify.com");
    expect(url.pathname).toBe("/v1/geocode/autocomplete");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      text: "Königstraße 1, Berlin",
      lang: "de",
      format: "json",
      limit: "5",
      filter: "countrycode:de",
      apiKey: "unit-test-key",
    });
    expect(init).toMatchObject({
      method: "GET",
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
    });
  });

  it("deduplicates provider results by opaque place id", async () => {
    stubFetch(jsonResponse({ results: [rawAddress(), rawAddress()] }));

    const result = await searchAddressCandidates("Hauptstraße 1");

    expect(result.candidates).toHaveLength(1);
  });

  it("counts Unicode code points after normalization and rejects unsafe input before fetch", async () => {
    const fetchMock = stubFetch(jsonResponse({ results: [] }));

    await expect(searchAddressCandidates("😀😀😀😀")).rejects.toThrow("invalid geocoding query");
    await expect(searchAddressCandidates("ä".repeat(161))).rejects.toThrow("invalid geocoding query");
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(searchAddressCandidates("  😀😀😀😀😀  ")).resolves.toEqual({ candidates: [] });
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.searchParams.get("text")).toBe("😀😀😀😀😀");

    await expect(searchAddressCandidates("ä".repeat(160))).resolves.toEqual({ candidates: [] });
  });

  it("rejects responses that exceed the 256 KiB byte cap", async () => {
    stubFetch(new Response("x".repeat(256 * 1024 + 1), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(searchAddressCandidates("Hauptstraße 1"))
      .rejects.toBeInstanceOf(GeocodingInvalidResponseError);
  });

  it("classifies malformed JSON and an oversized result envelope as invalid responses", async () => {
    let fetchMock = stubFetch(new Response("not json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    await expect(searchAddressCandidates("Hauptstraße 1"))
      .rejects.toMatchObject({ code: "invalid_response" });

    fetchMock = vi.fn(async () => jsonResponse({
      results: Array.from({ length: 6 }, (_, index) => rawAddress({ place_id: `place-${index}` })),
    }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchAddressCandidates("Hauptstraße 1"))
      .rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("Geoapify place resolution", () => {
  it("resolves one details feature through the fixed endpoint", async () => {
    const placeId = "51abcDEF_123:-";
    const fetchMock = stubFetch(jsonResponse({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {
          ...rawAddress({ result_type: undefined }),
          feature_type: "details",
        },
        geometry: { type: "Point", coordinates: [13.384, 52.532] },
      }],
    }));

    const candidate = await resolveAddressCandidate(`  ${placeId}  `);

    expect(candidate.placeId).toBe(placeId);
    expect(candidate.precision).toBe("house");
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe("/v2/place-details");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      id: placeId,
      features: "details",
      lang: "de",
      apiKey: "unit-test-key",
    });
  });

  it("uses the requested opaque id when a valid details feature omits the optional echo", async () => {
    const placeId = "51requested-place";
    stubFetch(jsonResponse({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {
          ...rawAddress({ place_id: undefined, result_type: undefined }),
          feature_type: "details",
        },
      }],
    }));

    await expect(resolveAddressCandidate(placeId)).resolves.toMatchObject({
      placeId,
      countryCode: "DE",
      precision: "house",
    });
  });

  it("keeps the DE proof fail-closed when details omits country_code", async () => {
    stubFetch(jsonResponse({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {
          ...rawAddress({
            place_id: undefined,
            country: "Deutschland",
            country_code: undefined,
            result_type: undefined,
          }),
          feature_type: "details",
        },
      }],
    }));

    await expect(resolveAddressCandidate("51requested-place"))
      .rejects.toBeInstanceOf(GeocodingInvalidResponseError);
  });

  it("rejects unsafe place ids and mismatched provider identities before returning data", async () => {
    const fetchMock = stubFetch(jsonResponse({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: { ...rawAddress({ place_id: "different" }), feature_type: "details" },
      }],
    }));

    await expect(resolveAddressCandidate("safe&apiKey=stolen"))
      .rejects.toThrow("invalid geocoding place id");
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(resolveAddressCandidate("expected"))
      .rejects.toBeInstanceOf(GeocodingInvalidResponseError);
  });

  it("enforces the 1..300 character place-id boundary", async () => {
    const maximumPlaceId = "a".repeat(300);
    const fetchMock = stubFetch(jsonResponse({
      type: "FeatureCollection",
      features: [{
        type: "Feature",
        properties: {
          ...rawAddress({ place_id: maximumPlaceId, result_type: undefined }),
          feature_type: "details",
        },
      }],
    }));

    await expect(resolveAddressCandidate(" ")).rejects.toThrow("invalid geocoding place id");
    await expect(resolveAddressCandidate("a".repeat(301))).rejects.toThrow("invalid geocoding place id");
    expect(fetchMock).not.toHaveBeenCalled();

    await expect(resolveAddressCandidate(maximumPlaceId))
      .resolves.toMatchObject({ placeId: maximumPlaceId });
  });
});

describe("Geoapify transport hardening", () => {
  it("maps HTTP and network failures to safe error classes without logging provider data", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let fetchMock = stubFetch(jsonResponse({ error: "quota" }, 429));

    await expect(searchAddressCandidates("Geheime Straße 1"))
      .rejects.toBeInstanceOf(GeocodingRateLimitedError);

    fetchMock = vi.fn(async () => jsonResponse({ error: "down" }, 503));
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchAddressCandidates("Geheime Straße 1"))
      .rejects.toBeInstanceOf(GeocodingUnavailableError);

    fetchMock = vi.fn(async () => {
      throw new Error("https://api.geoapify.com/?apiKey=unit-test-key&text=Geheime");
    });
    vi.stubGlobal("fetch", fetchMock);
    const failure = searchAddressCandidates("Geheime Straße 1");
    await expect(failure).rejects.toMatchObject({
      code: "unavailable",
      message: "geocoding provider unavailable",
    });
    await failure.catch((caught: unknown) => {
      const rendered = String(caught);
      expect(rendered).not.toContain("unit-test-key");
      expect(rendered).not.toContain("Geheime");
      expect(rendered).not.toContain("api.geoapify.com");
    });
    expect(log).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });

  it("aborts the complete request after 3.5 seconds and exposes only timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("secret transport URL", "AbortError"));
      }, { once: true });
    }));
    vi.stubGlobal("fetch", fetchMock);

    const pending = searchAddressCandidates("Hauptstraße 1");
    const assertion = expect(pending).rejects.toBeInstanceOf(GeocodingTimeoutError);
    await vi.advanceTimersByTimeAsync(3_500);
    await assertion;
  });

  it("allows a loopback base URL only outside production", async () => {
    setEnv("GEOAPIFY_BASE_URL", "http://localhost:43123/");
    let fetchMock = stubFetch(jsonResponse({ results: [] }));

    await searchAddressCandidates("Hauptstraße 1");
    expect(new URL(String(fetchMock.mock.calls[0]?.[0])).origin).toBe("http://localhost:43123");

    vi.stubEnv("NODE_ENV", "production");
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(searchAddressCandidates("Hauptstraße 1"))
      .rejects.toBeInstanceOf(GeocodingUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-loopback overrides and missing credentials without issuing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    setEnv("GEOAPIFY_BASE_URL", "https://example.test");

    await expect(searchAddressCandidates("Hauptstraße 1"))
      .rejects.toBeInstanceOf(GeocodingUnavailableError);

    setEnv("GEOAPIFY_BASE_URL", undefined);
    setEnv("GEOAPIFY_API_KEY", undefined);
    await expect(searchAddressCandidates("Hauptstraße 1"))
      .rejects.toBeInstanceOf(GeocodingUnavailableError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
