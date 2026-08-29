import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class GeocodingInvalidResponseError extends Error {}
  class GeocodingRateLimitedError extends Error {}
  class GeocodingTimeoutError extends Error {}
  class GeocodingUnavailableError extends Error {}
  class SiteAddressCollisionError extends Error {}
  class SiteAddressConflictError extends Error {}
  class SiteAddressInvalidError extends Error {}
  class SiteAddressNotEditableError extends Error {}
  class SiteAddressSharedError extends Error {}
  class SitePinNotConfirmableError extends Error {}
  class SitePinOutOfRangeError extends Error {}

  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    GeocodingInvalidResponseError,
    GeocodingRateLimitedError,
    GeocodingTimeoutError,
    GeocodingUnavailableError,
    SiteAddressCollisionError,
    SiteAddressConflictError,
    SiteAddressInvalidError,
    SiteAddressNotEditableError,
    SiteAddressSharedError,
    SitePinNotConfirmableError,
    SitePinOutOfRangeError,
    authorizedAction: vi.fn(),
    authorizedQuery: vi.fn(),
    confirmPin: vi.fn(),
    correctAddress: vi.fn(),
    getContext: vi.fn(),
    resolveAddress: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: deps.revalidatePath }));

vi.mock("@/lib/action", () => ({
  authorizedAction: deps.authorizedAction,
  authorizedQuery: deps.authorizedQuery,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));

vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));

vi.mock("@/lib/integrations/geocoding", async () => {
  const contract = await import("@/lib/integrations/geocoding/contract");
  return {
    ...contract,
    GeocodingInvalidResponseError: deps.GeocodingInvalidResponseError,
    GeocodingRateLimitedError: deps.GeocodingRateLimitedError,
    GeocodingTimeoutError: deps.GeocodingTimeoutError,
    GeocodingUnavailableError: deps.GeocodingUnavailableError,
    resolveAddressCandidate: deps.resolveAddress,
  };
});

vi.mock("@/modules/projects", () => ({
  confirmProjectSitePin: deps.confirmPin,
  correctProjectSiteAddress: deps.correctAddress,
  getProjectAddressCorrectionContext: deps.getContext,
  SiteAddressCollisionError: deps.SiteAddressCollisionError,
  SiteAddressConflictError: deps.SiteAddressConflictError,
  SiteAddressInvalidError: deps.SiteAddressInvalidError,
  SiteAddressNotEditableError: deps.SiteAddressNotEditableError,
  SiteAddressSharedError: deps.SiteAddressSharedError,
  SitePinNotConfirmableError: deps.SitePinNotConfirmableError,
  SitePinOutOfRangeError: deps.SitePinOutOfRangeError,
}));

import { correctProjectAddressAction } from "@/app/w/[workspaceId]/anfragen/project-actions";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const PROJECT_ID = "20000000-0000-4000-8000-000000000002";

const candidate = {
  placeId: "place-berlin-1",
  formattedAddress: "Musterstraße 12, 10115 Berlin",
  street: "Musterstraße",
  houseNumber: "12",
  postalCode: "10115",
  city: "Berlin",
  countryCode: "DE" as const,
  latitude: 52.532,
  longitude: 13.384,
  provider: "geoapify" as const,
  precision: "house" as const,
};

function validForm(overrides: Record<string, string> = {}): FormData {
  const form = new FormData();
  const values = {
    workspaceId: WORKSPACE_ID,
    projectId: PROJECT_ID,
    expectedAddressRevision: "3",
    placeId: candidate.placeId,
    pinLatitude: candidate.latitude.toString(),
    pinLongitude: candidate.longitude.toString(),
    ...overrides,
  };
  for (const [name, value] of Object.entries(values)) form.set(name, value);
  return form;
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.authorizedQuery.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    callback: (tx: object, ctx: object) => Promise<unknown>,
  ) => callback({}, { workspaceId: WORKSPACE_ID, actor: "member-1" }));
  deps.authorizedAction.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    callback: (tx: object, ctx: object) => Promise<unknown>,
  ) => callback({}, { workspaceId: WORKSPACE_ID, actor: "member-1" }));
  deps.getContext.mockResolvedValue({
    projectId: PROJECT_ID,
    siteId: "30000000-0000-4000-8000-000000000003",
    addressRevision: 3,
    editable: true,
  });
  deps.resolveAddress.mockResolvedValue(candidate);
  deps.correctAddress.mockResolvedValue({
    siteId: "30000000-0000-4000-8000-000000000003",
    addressRevision: 4,
  });
});

describe("M1-06 Adresskorrektur-Action", () => {
  it("prüft zuerst den Tenant, löst danach ohne offene Tx auf und mutiert frisch", async () => {
    const order: string[] = [];
    deps.authorizedQuery.mockImplementationOnce(async (
      _workspaceId: string,
      _action: string,
      _resource: string,
      callback: (tx: object, ctx: object) => Promise<unknown>,
    ) => {
      order.push("preflight");
      return callback({}, { workspaceId: WORKSPACE_ID, actor: "member-1" });
    });
    deps.resolveAddress.mockImplementationOnce(async () => {
      order.push("provider");
      return candidate;
    });
    deps.authorizedAction.mockImplementationOnce(async (
      _workspaceId: string,
      _action: string,
      _resource: string,
      callback: (tx: object, ctx: object) => Promise<unknown>,
    ) => {
      order.push("mutation");
      return callback({}, { workspaceId: WORKSPACE_ID, actor: "member-1" });
    });

    await expect(correctProjectAddressAction({ status: "idle" }, validForm()))
      .resolves.toEqual({ status: "success", addressRevision: 4 });

    expect(order).toEqual(["preflight", "provider", "mutation"]);
    expect(deps.correctAddress).toHaveBeenCalledWith(
      {},
      { workspaceId: WORKSPACE_ID, actor: "member-1" },
      expect.objectContaining({
        projectId: PROJECT_ID,
        expectedAddressRevision: 3,
        resolvedAddress: candidate,
        pin: { latitude: candidate.latitude, longitude: candidate.longitude },
      }),
    );
    expect(deps.revalidatePath).toHaveBeenCalledWith(
      `/w/${WORKSPACE_ID}/anfragen/${PROJECT_ID}`,
    );
    expect(deps.revalidatePath).toHaveBeenCalledWith(`/w/${WORKSPACE_ID}/anfragen`);
  });

  it("ruft bei stale Revision keinen Provider und keine Mutation auf", async () => {
    deps.getContext.mockResolvedValueOnce({
      projectId: PROJECT_ID,
      siteId: "30000000-0000-4000-8000-000000000003",
      addressRevision: 4,
      editable: true,
    });

    await expect(correctProjectAddressAction({ status: "idle" }, validForm()))
      .resolves.toEqual({ status: "stale" });
    expect(deps.resolveAddress).not.toHaveBeenCalled();
    expect(deps.authorizedAction).not.toHaveBeenCalled();
  });

  it("ruft ohne Session keinen Provider und keine Mutation auf", async () => {
    deps.authorizedQuery.mockRejectedValueOnce(new deps.NotAuthenticatedError());

    await expect(correctProjectAddressAction({ status: "idle" }, validForm()))
      .resolves.toEqual({ status: "unauthenticated" });
    expect(deps.resolveAddress).not.toHaveBeenCalled();
    expect(deps.authorizedAction).not.toHaveBeenCalled();
  });

  it("weist ungültige Formwerte vor jeder Abhängigkeit zurück", async () => {
    await expect(correctProjectAddressAction(
      { status: "idle" },
      validForm({ pinLatitude: "" }),
    )).resolves.toEqual({ status: "invalid" });
    expect(deps.authorizedQuery).not.toHaveBeenCalled();
    expect(deps.resolveAddress).not.toHaveBeenCalled();
    expect(deps.authorizedAction).not.toHaveBeenCalled();
  });

  it("weist zusätzliche oder wiederholte Fachfelder strikt zurück", async () => {
    const additional = validForm({ unexpected: "not-allowed" });
    const repeated = validForm();
    repeated.append("placeId", "second-place");

    await expect(correctProjectAddressAction({ status: "idle" }, additional))
      .resolves.toEqual({ status: "invalid" });
    await expect(correctProjectAddressAction({ status: "idle" }, repeated))
      .resolves.toEqual({ status: "invalid" });
    expect(deps.authorizedQuery).not.toHaveBeenCalled();
    expect(deps.resolveAddress).not.toHaveBeenCalled();
    expect(deps.authorizedAction).not.toHaveBeenCalled();
  });

  it.each([
    [deps.GeocodingRateLimitedError, "provider_rate_limited"],
    [deps.GeocodingTimeoutError, "provider_timeout"],
    [deps.GeocodingUnavailableError, "provider_unavailable"],
    [deps.GeocodingInvalidResponseError, "provider_invalid_response"],
  ] as const)("bildet Providerfehler %s PII-frei ab", async (ErrorType, status) => {
    deps.resolveAddress.mockRejectedValueOnce(new ErrorType());

    await expect(correctProjectAddressAction({ status: "idle" }, validForm()))
      .resolves.toEqual({ status });
    expect(deps.authorizedAction).not.toHaveBeenCalled();
  });

  it.each([
    [deps.SiteAddressConflictError, "stale"],
    [deps.SiteAddressNotEditableError, "not_editable"],
    [deps.SiteAddressCollisionError, "collision"],
    [deps.SiteAddressSharedError, "shared_site"],
    [deps.SitePinOutOfRangeError, "pin_out_of_range"],
  ] as const)("bildet Fachfehler %s als kleinen UI-Status ab", async (ErrorType, status) => {
    deps.correctAddress.mockRejectedValueOnce(new ErrorType());

    await expect(correctProjectAddressAction({ status: "idle" }, validForm()))
      .resolves.toEqual({ status });
  });
});
