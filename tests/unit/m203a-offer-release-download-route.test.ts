import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class OfferReleaseNotFoundError extends Error {}
  class OfferReleaseIntegrityError extends Error {}
  class OfferReleasePersistenceError extends Error {}
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    OfferReleaseNotFoundError,
    OfferReleaseIntegrityError,
    OfferReleasePersistenceError,
    authorizedQuery: vi.fn(),
    readOfferReleaseCandidateArtifact: vi.fn(),
  };
});

vi.mock("@/lib/action", () => ({
  authorizedQuery: deps.authorizedQuery,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/offers", () => ({
  readOfferReleaseCandidateArtifact: deps.readOfferReleaseCandidateArtifact,
  OfferReleaseNotFoundError: deps.OfferReleaseNotFoundError,
  OfferReleaseIntegrityError: deps.OfferReleaseIntegrityError,
  OfferReleasePersistenceError: deps.OfferReleasePersistenceError,
}));

import { GET } from "@/app/w/[workspaceId]/angebote/[offerId]/freigabekandidaten/[candidateId]/pdf/route";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const OFFER_ID = "20000000-0000-4000-8000-000000000002";
const CANDIDATE_ID = "30000000-0000-4000-8000-000000000003";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "40000000-0000-4000-8000-000000000004" };
const PDF_BYTES = Buffer.concat([
  Buffer.from("%PDF-1.7\nSYNTHETIC M2-03a\n", "ascii"),
  Buffer.alloc(96, 0x20),
  Buffer.from("\n%%EOF\n", "ascii"),
]);
const PDF_SHA256 = createHash("sha256").update(PDF_BYTES).digest("hex");

function context(overrides: Partial<{
  workspaceId: string;
  offerId: string;
  candidateId: string;
}> = {}) {
  return {
    params: Promise.resolve({
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      candidateId: CANDIDATE_ID,
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
  deps.readOfferReleaseCandidateArtifact.mockResolvedValue({
    candidateId: CANDIDATE_ID,
    offerId: OFFER_ID,
    variantId: "50000000-0000-4000-8000-000000000005",
    variantRevision: 7,
    state: "approved_not_issued",
    publicationStatus: "not_issued",
    filename: "ANG-2026-000042-Freigabekandidat-R7.pdf",
    mimeType: "application/pdf",
    sha256: PDF_SHA256,
    sizeBytes: PDF_BYTES.length,
    bytes: PDF_BYTES,
  });
});

describe("M2-03a privater Freigabekandidaten-Download", () => {
  it("reauthorisiert alle IDs und prüft die Bytes erneut vor dem privaten Attachment", async () => {
    const response = await GET(new Request("https://clone.test/download"), context());
    expect(deps.authorizedQuery).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "project.read",
      "offer_release_candidate_artifact",
      expect.any(Function),
    );
    expect(deps.readOfferReleaseCandidateArtifact).toHaveBeenCalledWith(TX, CTX, {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      candidateId: CANDIDATE_ID,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe(String(PDF_BYTES.length));
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PDF_BYTES);
  });

  it("blockiert eine manipulierte Hash-, Längen- oder MIME-Hülle ohne Bytes", async () => {
    for (const mutation of [
      { sha256: "a".repeat(64) },
      { sizeBytes: PDF_BYTES.length + 1 },
      { mimeType: "text/html" },
    ]) {
      deps.readOfferReleaseCandidateArtifact.mockResolvedValueOnce({
        candidateId: CANDIDATE_ID,
        offerId: OFFER_ID,
        filename: "ANG-2026-000042-Freigabekandidat-R7.pdf",
        mimeType: "application/pdf",
        sha256: PDF_SHA256,
        sizeBytes: PDF_BYTES.length,
        bytes: PDF_BYTES,
        ...mutation,
      });
      const response = await GET(new Request("https://clone.test/download"), context());
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.text()).toBe("");
    }
  });

  it.each([
    ["Workspace", { workspaceId: "kein-uuid" }],
    ["Offer", { offerId: "kein-uuid" }],
    ["Candidate", { candidateId: "kein-uuid" }],
  ])("weist eine ungültige %s-ID vor Auth als 404 zurück", async (_label, overrides) => {
    const response = await GET(new Request("https://clone.test/download"), context(overrides));
    expect(response.status).toBe(404);
    expect(deps.authorizedQuery).not.toHaveBeenCalled();
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
  });

  it.each([
    [new deps.NotAuthenticatedError(), 401],
    [new deps.PermissionDeniedError(), 403],
    [new deps.OfferReleaseNotFoundError(), 404],
    [new deps.OfferReleaseIntegrityError(), 503],
    [new deps.OfferReleasePersistenceError(), 503],
  ])("übersetzt %s ohne Interna in einen privaten Fehler", async (error, status) => {
    deps.authorizedQuery.mockRejectedValueOnce(error);
    const response = await GET(new Request("https://clone.test/download"), context());
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
    expect(await response.text()).toBe("");
  });
});
