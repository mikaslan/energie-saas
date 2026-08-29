import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  FixedWindowRateLimiter,
  handleAddressCandidateSearchRequest,
  type AddressCandidateSearchAccess,
  type AddressCandidateSearchDependencies,
} from "@/lib/integrations/geocoding/address-candidates-http";
import {
  GeocodingInvalidResponseError,
  GeocodingRateLimitedError,
  GeocodingTimeoutError,
  GeocodingUnavailableError,
} from "@/lib/integrations/geocoding";
import type { AddressSearchResult } from "@/lib/integrations/geocoding/contract";

const WORKSPACE_ID = "6f771760-8201-4b44-a813-b4fd5bbbe7b7";
const PROJECT_ID = "ec1593c9-4808-49a2-b6a9-66b8f6f842f7";
const ROUTE = `/api/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/address-candidates`;

const RESULT: AddressSearchResult = {
  candidates: [{
    placeId: "place.123",
    formattedAddress: "Musterstraße 7, 12345 Berlin, Deutschland",
    street: "Musterstraße",
    houseNumber: "7",
    postalCode: "12345",
    city: "Berlin",
    countryCode: "DE",
    latitude: 52.52,
    longitude: 13.405,
    provider: "geoapify",
    precision: "house",
  }],
};

function request(
  body: BodyInit = JSON.stringify({ query: "Musterstraße 7, 12345 Berlin" }),
  headers: Readonly<Record<string, string>> = {},
): Request {
  const requestHeaders = new Headers({
    "content-type": "application/json",
    host: "clone.test",
    origin: "https://clone.test",
  });
  for (const [name, value] of Object.entries(headers)) {
    if (value === "") requestHeaders.delete(name);
    else requestHeaders.set(name, value);
  }
  return new Request(`https://clone.test${ROUTE}`, {
    method: "POST",
    headers: requestHeaders,
    body,
  });
}

function dependencies(
  overrides: Partial<AddressCandidateSearchDependencies> = {},
): AddressCandidateSearchDependencies {
  return {
    authorize: vi.fn(async () => ({
      status: "allowed" as const,
      rateLimitKey: JSON.stringify([WORKSPACE_ID, "actor-1"]),
    })),
    search: vi.fn(async () => RESULT),
    rateLimiter: new FixedWindowRateLimiter(),
    now: () => 12_345,
    ...overrides,
  };
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

function expectPrivateJson(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-type")).toMatch(/^application\/json\b/u);
}

describe("M1-06 address-candidate HTTP boundary", () => {
  it("liefert ausschließlich den kanonischen Ergebnisvertrag und normalisiert die Query", async () => {
    const search = vi.fn(async () => RESULT);
    const authorize = vi.fn(async () => ({
      status: "allowed" as const,
      rateLimitKey: "workspace:actor",
    }));
    const response = await handleAddressCandidateSearchRequest(
      request(JSON.stringify({ query: "  Musterstraße   7,  12345 Berlin  " })),
      { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      dependencies({ authorize, search }),
    );

    expect(response.status).toBe(200);
    expectPrivateJson(response);
    expect(await body(response)).toEqual(RESULT);
    expect(authorize).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      projectId: PROJECT_ID,
    });
    expect(search).toHaveBeenCalledWith("Musterstraße 7, 12345 Berlin");
  });

  it("wartet auf den vollständigen Preflight, bevor der Provider startet", async () => {
    const order: string[] = [];
    let release!: () => void;
    const preflight = new Promise<void>((resolve) => { release = resolve; });
    const authorize = vi.fn(async () => {
      order.push("preflight-start");
      await preflight;
      order.push("preflight-finished");
      return { status: "allowed" as const, rateLimitKey: "workspace:actor" };
    });
    const search = vi.fn(async () => {
      order.push("provider");
      return RESULT;
    });

    const pending = handleAddressCandidateSearchRequest(
      request(),
      { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      dependencies({ authorize, search }),
    );
    await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce());
    expect(search).not.toHaveBeenCalled();
    release();
    expect((await pending).status).toBe(200);
    expect(order).toEqual(["preflight-start", "preflight-finished", "provider"]);
  });

  it.each([
    ["Workspace-ID", { workspaceId: "kein-uuid", projectId: PROJECT_ID }],
    ["Project-ID", { workspaceId: WORKSPACE_ID, projectId: "kein-uuid" }],
  ])("weist eine ungültige %s vor Preflight und Provider zurück", async (_label, params) => {
    const authorize = vi.fn(async () => ({ status: "allowed" as const, rateLimitKey: "x" }));
    const search = vi.fn(async () => RESULT);
    const response = await handleAddressCandidateSearchRequest(
      request(),
      params,
      dependencies({ authorize, search }),
    );

    expect(response.status).toBe(400);
    expect(await body(response)).toMatchObject({ error: { code: "invalid_request" } });
    expect(authorize).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    ["fehlende Origin", { origin: "" }],
    ["fremde Origin", { origin: "https://angreifer.test" }],
    ["fremdes Protokoll", { origin: "http://clone.test" }],
    ["abweichender Host trotz gefälschtem Forwarded Host", {
      host: "angreifer.test",
      "x-forwarded-host": "clone.test",
    }],
  ])("verweigert %s ohne Datenzugriff", async (_label, changedHeaders) => {
    const headers: Record<string, string> = { ...changedHeaders };
    const authorize = vi.fn(async () => ({ status: "allowed" as const, rateLimitKey: "x" }));
    const search = vi.fn(async () => RESULT);
    const response = await handleAddressCandidateSearchRequest(
      request(JSON.stringify({ query: "Musterstraße 7, 12345 Berlin" }), headers),
      { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      dependencies({ authorize, search }),
    );

    expect(response.status).toBe(403);
    expectPrivateJson(response);
    expect(await body(response)).toMatchObject({ error: { code: "origin_mismatch" } });
    expect(authorize).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it.each([
    ["falscher Content-Type", request("{}", { "content-type": "text/plain" })],
    ["komprimierter Body", request("{}", { "content-encoding": "gzip" })],
    ["kaputtes JSON", request("{")],
    ["Zusatzfeld", request(JSON.stringify({ query: "Musterstraße 7", tenant: "fremd" }))],
    ["zu kurze Query", request(JSON.stringify({ query: "Haus" }))],
    ["zu lange Query", request(JSON.stringify({ query: "x".repeat(161) }))],
    ["deklarierter Überlauf", request("{}", { "content-length": "2049" })],
    ["tatsächlicher Überlauf", request(new Uint8Array(2049).fill(0x20))],
    ["Überlauf mit gelogenem kleinen Content-Length", request(
      new Uint8Array(2049).fill(0x20),
      { "content-length": "2" },
    )],
  ])("weist %s generisch und ohne Preflight zurück", async (_label, invalidRequest) => {
    const authorize = vi.fn(async () => ({ status: "allowed" as const, rateLimitKey: "x" }));
    const search = vi.fn(async () => RESULT);
    const response = await handleAddressCandidateSearchRequest(
      invalidRequest,
      { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      dependencies({ authorize, search }),
    );

    expect(response.status).toBe(400);
    expectPrivateJson(response);
    expect(await body(response)).toEqual({
      error: { code: "invalid_request", message: "Die Anfrage ist ungültig." },
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(search).not.toHaveBeenCalled();
  });

  it("akzeptiert exakt 2 KiB, begrenzt also den gelesenen Stream inklusiv", async () => {
    const json = JSON.stringify({ query: "Musterstraße 7, 12345 Berlin" });
    const exactBody = `${json}${" ".repeat(2_048 - Buffer.byteLength(json))}`;
    const response = await handleAddressCandidateSearchRequest(
      request(exactBody),
      { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      dependencies(),
    );
    expect(response.status).toBe(200);
  });

  it.each<[string, AddressCandidateSearchAccess, number, string]>([
    ["unauthenticated", { status: "unauthenticated" }, 401, "unauthenticated"],
    ["forbidden", { status: "forbidden" }, 403, "forbidden"],
    ["not_found", { status: "not_found" }, 404, "not_found"],
    ["not_editable", { status: "not_editable" }, 409, "not_editable"],
  ])("mappt %s fail-closed", async (_label, access, expectedStatus, code) => {
    const search = vi.fn(async () => RESULT);
    const response = await handleAddressCandidateSearchRequest(
      request(),
      { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      dependencies({ authorize: async () => access, search }),
    );

    expect(response.status).toBe(expectedStatus);
    expect(await body(response)).toMatchObject({ error: { code } });
    expect(search).not.toHaveBeenCalled();
  });

  it("liefert beim 21. gültigen Request 429 mit aufgerundetem Retry-After", async () => {
    const limiter = new FixedWindowRateLimiter(20, 60_000);
    const deps = dependencies({ rateLimiter: limiter, now: () => 59_250 });
    for (let index = 0; index < 20; index += 1) {
      expect((await handleAddressCandidateSearchRequest(
        request(),
        { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
        deps,
      )).status).toBe(200);
    }

    const response = await handleAddressCandidateSearchRequest(
      request(),
      { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      deps,
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await body(response)).toMatchObject({ error: { code: "rate_limited" } });
    expect(deps.search).toHaveBeenCalledTimes(20);
  });

  it("isoliert feste Fenster und Actor/Workspace-Schlüssel deterministisch", () => {
    const limiter = new FixedWindowRateLimiter(1, 60_000);
    expect(limiter.consume("workspace-a:actor-a", 10_000).allowed).toBe(true);
    expect(limiter.consume("workspace-a:actor-a", 10_001).allowed).toBe(false);
    expect(limiter.consume("workspace-a:actor-b", 10_001).allowed).toBe(true);
    expect(limiter.consume("workspace-b:actor-a", 10_001).allowed).toBe(true);
    expect(limiter.consume("workspace-a:actor-a", 60_000).allowed).toBe(true);
  });

  it.each([
    [new GeocodingRateLimitedError(), 429, "geocoding_rate_limited", "60"],
    [new GeocodingInvalidResponseError(), 502, "geocoding_invalid_response", null],
    [new GeocodingTimeoutError(), 503, "geocoding_unavailable", null],
    [new GeocodingUnavailableError(), 503, "geocoding_unavailable", null],
  ])("mappt Providerfehler ohne interne Details", async (error, status, code, retryAfter) => {
    const response = await handleAddressCandidateSearchRequest(
      request(JSON.stringify({ query: "GEHEIME SUCHADRESSE" })),
      { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      dependencies({ search: vi.fn(async () => { throw error; }) }),
    );
    const serialized = JSON.stringify(await body(response));

    expect(response.status).toBe(status);
    expect(response.headers.get("retry-after")).toBe(retryAfter);
    expect(serialized).toContain(code);
    expect(serialized).not.toContain("GEHEIME SUCHADRESSE");
    expect(serialized).not.toContain("apiKey");
    expectPrivateJson(response);
  });

  it("weist einen nicht-kanonischen oder zu großen Providervertrag an der Serialisierungsgrenze zurück", async () => {
    const invalid = {
      candidates: Array.from({ length: 6 }, () => RESULT.candidates[0]),
      secret: "DARF-NICHT-RAUS",
    } as unknown as AddressSearchResult;
    const response = await handleAddressCandidateSearchRequest(
      request(),
      { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      dependencies({ search: async () => invalid }),
    );
    const serialized = JSON.stringify(await body(response));

    expect(response.status).toBe(502);
    expect(serialized).toContain("geocoding_invalid_response");
    expect(serialized).not.toContain("DARF-NICHT-RAUS");
  });

  it("gibt weder unerwartete Fehlertexte noch Stack oder Query zurück", async () => {
    const response = await handleAddressCandidateSearchRequest(
      request(JSON.stringify({ query: "GEHEIME SUCHADRESSE" })),
      { workspaceId: WORKSPACE_ID, projectId: PROJECT_ID },
      dependencies({
        search: async () => { throw new Error("SECRET=supergeheim https://provider.test?q=Adresse"); },
      }),
    );
    const serialized = JSON.stringify(await body(response));

    expect(response.status).toBe(500);
    expect(serialized).toContain("internal_error");
    expect(serialized).not.toContain("supergeheim");
    expect(serialized).not.toContain("provider.test");
    expect(serialized).not.toContain("GEHEIME SUCHADRESSE");
  });
});
