import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class OfferPdfDraftNotFoundError extends Error {}
  class OfferPdfDraftIntegrityError extends Error {}
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    OfferPdfDraftNotFoundError,
    OfferPdfDraftIntegrityError,
    authorizedQuery: vi.fn(),
    readOfferPdfDraftArtifact: vi.fn(),
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
  readOfferPdfDraftArtifact: deps.readOfferPdfDraftArtifact,
  OfferPdfDraftNotFoundError: deps.OfferPdfDraftNotFoundError,
  OfferPdfDraftIntegrityError: deps.OfferPdfDraftIntegrityError,
}));

import { GET } from "@/app/w/[workspaceId]/angebote/[offerId]/pdf/[pdfDraftId]/route";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const OFFER_ID = "20000000-0000-4000-8000-000000000002";
const PDF_DRAFT_ID = "30000000-0000-4000-8000-000000000003";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "member-1" };
const PDF_BYTES = Buffer.from("%PDF-1.7\nM2-02\n%%EOF\n", "utf8");

function context(overrides: Partial<{
  workspaceId: string;
  offerId: string;
  pdfDraftId: string;
}> = {}) {
  return {
    params: Promise.resolve({
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      pdfDraftId: PDF_DRAFT_ID,
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
  deps.readOfferPdfDraftArtifact.mockResolvedValue({
    jobId: PDF_DRAFT_ID,
    offerId: OFFER_ID,
    variantId: "40000000-0000-4000-8000-000000000004",
    variantRevision: 7,
    filename: "ANG-2026-000042-Variante-R7.pdf",
    mimeType: "application/pdf",
    sha256: "a".repeat(64),
    sizeBytes: PDF_BYTES.length,
    bytes: PDF_BYTES,
  });
});

describe("M2-02 offer PDF draft download route", () => {
  it("reauthorisiert project.read, bindet alle IDs und liefert nur ein privates Attachment", async () => {
    const response = await GET(new Request("https://clone.test/download"), context());

    expect(deps.authorizedQuery).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "project.read",
      "offer_pdf_draft_artifact",
      expect.any(Function),
    );
    expect(deps.readOfferPdfDraftArtifact).toHaveBeenCalledWith(TX, CTX, {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      jobId: PDF_DRAFT_ID,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    expect(response.headers.get("content-disposition")).toContain(
      "ANG-2026-000042-Variante-R7.pdf",
    );
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PDF_BYTES);
  });

  it.each([
    ["Workspace", { workspaceId: "kein-uuid" }],
    ["Offer", { offerId: "kein-uuid" }],
    ["Draft", { pdfDraftId: "kein-uuid" }],
  ])("weist eine ungültige %s-ID vor Auth und Datenzugriff als 404 zurück", async (
    _label,
    overrides,
  ) => {
    const response = await GET(new Request("https://clone.test/download"), context(overrides));

    expect(response.status).toBe(404);
    expect(deps.authorizedQuery).not.toHaveBeenCalled();
    expect(deps.readOfferPdfDraftArtifact).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.text()).toBe("");
  });

  it.each([
    [new deps.NotAuthenticatedError(), 401],
    [new deps.PermissionDeniedError(), 403],
    [new deps.OfferPdfDraftNotFoundError(), 404],
    [new deps.OfferPdfDraftIntegrityError(), 503],
  ])("übersetzt %s ohne Interna in einen privaten Fehler", async (error, status) => {
    deps.authorizedQuery.mockRejectedValueOnce(error);

    const response = await GET(new Request("https://clone.test/download"), context());

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toBe("");
  });
});
