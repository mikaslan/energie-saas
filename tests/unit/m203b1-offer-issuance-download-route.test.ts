import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class OfferIssuanceNotFoundError extends Error {}
  class OfferIssuanceIntegrityError extends Error {}
  class OfferIssuancePersistenceError extends Error {}
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    OfferIssuanceNotFoundError,
    OfferIssuanceIntegrityError,
    OfferIssuancePersistenceError,
    authorizedQuery: vi.fn(),
    readOfferIssuanceArtifact: vi.fn(),
  };
});

vi.mock("@/lib/action", () => ({
  authorizedQuery: deps.authorizedQuery,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({ PermissionDeniedError: deps.PermissionDeniedError }));
vi.mock("@/modules/offers", () => ({
  readOfferIssuanceArtifact: deps.readOfferIssuanceArtifact,
  OfferIssuanceNotFoundError: deps.OfferIssuanceNotFoundError,
  OfferIssuanceIntegrityError: deps.OfferIssuanceIntegrityError,
  OfferIssuancePersistenceError: deps.OfferIssuancePersistenceError,
}));

import { GET } from "@/app/w/[workspaceId]/angebote/[offerId]/ausstellungsfassungen/[issuanceId]/pdf/route";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const OFFER_ID = "20000000-0000-4000-8000-000000000002";
const ISSUANCE_ID = "30000000-0000-4000-8000-000000000003";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "40000000-0000-4000-8000-000000000004" };
const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.7\nSYNTHETIC M2-03b1\n", "ascii"),
  Buffer.alloc(96, 0x20),
  Buffer.from("\n%%EOF\n", "ascii"),
]);
const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");

function context(overrides: Partial<{
  workspaceId: string;
  offerId: string;
  issuanceId: string;
}> = {}) {
  return {
    params: Promise.resolve({
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      issuanceId: ISSUANCE_ID,
      ...overrides,
    }),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedQuery.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.readOfferIssuanceArtifact.mockResolvedValue({
    issuanceId: ISSUANCE_ID,
    offerId: OFFER_ID,
    filename: "ANG-2026-000042-NICHT-AUSGESTELLT-Ausstellungsfassung.pdf",
    mimeType: "application/pdf",
    sha256: PDF_SHA256,
    sizeBytes: PDF_BYTES.length,
    bytes: PDF_BYTES,
  });
});

describe("M2-03b1 privater Download der Ausstellungsfassung", () => {
  it("reauthorisiert alle IDs und prueft die PDF-Huelle bei jedem GET", async () => {
    const response = await GET(new Request("https://clone.test/download"), context());
    expect(deps.authorizedQuery).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "project.read",
      "offer_issuance_artifact",
      expect.any(Function),
    );
    expect(deps.readOfferIssuanceArtifact).toHaveBeenCalledWith(TX, CTX, {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      issuanceId: ISSUANCE_ID,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PDF_BYTES);
  });

  it("blockiert manipulierte Hash-, Laengen-, MIME- und Dateinamen-Huellen", async () => {
    for (const mutation of [
      { sha256: "a".repeat(64) },
      { sizeBytes: PDF_BYTES.length + 1 },
      { mimeType: "text/html" },
      { filename: "../../angebot.pdf" },
    ]) {
      deps.readOfferIssuanceArtifact.mockResolvedValueOnce({
        issuanceId: ISSUANCE_ID,
        offerId: OFFER_ID,
        filename: "ANG-2026-000042-NICHT-AUSGESTELLT-Ausstellungsfassung.pdf",
        mimeType: "application/pdf",
        sha256: PDF_SHA256,
        sizeBytes: PDF_BYTES.length,
        bytes: PDF_BYTES,
        ...mutation,
      });
      const response = await GET(new Request("https://clone.test/download"), context());
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("");
    }
  });

  it.each([
    [{ workspaceId: "kein-uuid" }],
    [{ offerId: "kein-uuid" }],
    [{ issuanceId: "kein-uuid" }],
  ])("weist ungueltige Route-IDs vor Auth als 404 zurueck", async (overrides) => {
    const response = await GET(new Request("https://clone.test/download"), context(overrides));
    expect(response.status).toBe(404);
    expect(deps.authorizedQuery).not.toHaveBeenCalled();
  });

  it.each([
    [new deps.NotAuthenticatedError(), 401],
    [new deps.PermissionDeniedError(), 403],
    [new deps.OfferIssuanceNotFoundError(), 404],
    [new deps.OfferIssuanceIntegrityError(), 503],
    [new deps.OfferIssuancePersistenceError(), 503],
  ])("redigiert %s in einen leeren privaten Fehler", async (error, status) => {
    deps.authorizedQuery.mockRejectedValueOnce(error);
    const response = await GET(new Request("https://clone.test/download"), context());
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toBe("");
  });
});
