import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => {
  class MockNotAuthenticatedError extends Error {}
  class MockPermissionDeniedError extends Error {}
  return {
    authorizedQuery: vi.fn(),
    getProjectAddressCorrectionContext: vi.fn(),
    searchAddressCandidates: vi.fn(),
    MockNotAuthenticatedError,
    MockPermissionDeniedError,
  };
});

vi.mock("@/lib/action", () => ({
  authorizedQuery: mocks.authorizedQuery,
  NotAuthenticatedError: mocks.MockNotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: mocks.MockPermissionDeniedError,
}));
vi.mock("@/modules/projects", () => ({
  getProjectAddressCorrectionContext: mocks.getProjectAddressCorrectionContext,
}));
vi.mock("@/lib/integrations/geocoding", async () => {
  const http = await import("@/lib/integrations/geocoding/address-candidates-http");
  return {
    ...http,
    searchAddressCandidates: mocks.searchAddressCandidates,
  };
});

import { POST } from "@/app/api/workspaces/[workspaceId]/projects/[projectId]/address-candidates/route";

const WORKSPACE_ID = "6f771760-8201-4b44-a813-b4fd5bbbe7b7";
const PROJECT_ID = "ec1593c9-4808-49a2-b6a9-66b8f6f842f7";
const SITE_ID = "333d1db6-9945-431f-85ee-8cf06104587b";
const TX = { scope: "test-tenant-transaction" };
const CTX = {
  workspaceId: WORKSPACE_ID,
  actor: "2fcedd8a-6922-4fa2-98cf-e4dca12ce51e",
  role: "editor",
  capabilities: {},
  featureFlags: {},
};
const RESULT = {
  candidates: [{
    placeId: "place.123",
    formattedAddress: "Musterstraße 7, 12345 Berlin, Deutschland",
    street: "Musterstraße",
    houseNumber: "7",
    postalCode: "12345",
    city: "Berlin",
    countryCode: "DE" as const,
    latitude: 52.52,
    longitude: 13.405,
    provider: "geoapify" as const,
    precision: "house" as const,
  }],
};

function request(): Request {
  return new Request(
    `https://clone.test/api/workspaces/${WORKSPACE_ID}/projects/${PROJECT_ID}/address-candidates`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        host: "clone.test",
        origin: "https://clone.test",
      },
      body: JSON.stringify({ query: "Musterstraße 7, 12345 Berlin" }),
    },
  );
}

function routeContext(): {
  params: Promise<{ workspaceId: string; projectId: string }>;
} {
  return { params: Promise.resolve({ workspaceId: WORKSPACE_ID, projectId: PROJECT_ID }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authorizedQuery.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    callback: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => callback(TX, CTX));
  mocks.getProjectAddressCorrectionContext.mockResolvedValue({
    projectId: PROJECT_ID,
    siteId: SITE_ID,
    addressRevision: 1,
    editable: true,
  });
  mocks.searchAddressCandidates.mockResolvedValue(RESULT);
});

describe("POST address-candidates route wiring", () => {
  it("bindet project.write an den Projektkontext und startet den Provider erst nach der Query-Grenze", async () => {
    const order: string[] = [];
    mocks.authorizedQuery.mockImplementation(async (
      workspaceId: string,
      action: string,
      resource: string,
      callback: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
    ) => {
      expect([workspaceId, action, resource]).toEqual([
        WORKSPACE_ID,
        "project.write",
        "site_address_search",
      ]);
      order.push("transaction-start");
      const result = await callback(TX, CTX);
      order.push("transaction-ended");
      return result;
    });
    mocks.getProjectAddressCorrectionContext.mockImplementation(async () => {
      order.push("project-preflight");
      return {
        projectId: PROJECT_ID,
        siteId: SITE_ID,
        addressRevision: 1,
        editable: true,
      };
    });
    mocks.searchAddressCandidates.mockImplementation(async () => {
      order.push("provider");
      return RESULT;
    });

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(RESULT);
    expect(mocks.getProjectAddressCorrectionContext).toHaveBeenCalledWith(TX, CTX, PROJECT_ID);
    expect(mocks.searchAddressCandidates).toHaveBeenCalledWith(
      "Musterstraße 7, 12345 Berlin",
    );
    expect(order).toEqual([
      "transaction-start",
      "project-preflight",
      "transaction-ended",
      "provider",
    ]);
  });

  it("macht ein tenant-unsichtbares Projekt zu 404 ohne Provideraufruf", async () => {
    mocks.getProjectAddressCorrectionContext.mockResolvedValue(null);

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    expect(mocks.searchAddressCandidates).not.toHaveBeenCalled();
  });

  it("meldet einen nicht editierbaren Standort als Zustandskonflikt", async () => {
    mocks.getProjectAddressCorrectionContext.mockResolvedValue({
      projectId: PROJECT_ID,
      siteId: SITE_ID,
      addressRevision: 2,
      editable: false,
    });

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "not_editable" } });
    expect(mocks.searchAddressCandidates).not.toHaveBeenCalled();
  });

  it.each([
    [new mocks.MockNotAuthenticatedError(), 401, "unauthenticated"],
    [new mocks.MockPermissionDeniedError(), 403, "forbidden"],
  ])("übersetzt Auth-Grenzfehler fail-closed", async (error, status, code) => {
    mocks.authorizedQuery.mockRejectedValue(error);

    const response = await POST(request(), routeContext());

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
    expect(mocks.getProjectAddressCorrectionContext).not.toHaveBeenCalled();
    expect(mocks.searchAddressCandidates).not.toHaveBeenCalled();
  });
});
