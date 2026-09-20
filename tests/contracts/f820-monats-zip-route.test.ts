import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class InvoicingNotFoundError extends Error {}
  class InvoicingValidationError extends Error {}
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    InvoicingNotFoundError,
    InvoicingValidationError,
    authorizedQuery: vi.fn(),
    exportMonatsZip: vi.fn(),
    INVOICING_MONATS_ZIP_COMMAND_VERSION: "invoicing-monats-zip-command.v1",
  };
});

vi.mock("@/lib/action", () => ({
  authorizedQuery: deps.authorizedQuery,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/invoicing/errors", () => ({
  InvoicingNotFoundError: deps.InvoicingNotFoundError,
  InvoicingValidationError: deps.InvoicingValidationError,
}));
vi.mock("@/modules/invoicing/month-zip-service", () => ({
  exportMonatsZip: deps.exportMonatsZip,
  INVOICING_MONATS_ZIP_COMMAND_VERSION: deps.INVOICING_MONATS_ZIP_COMMAND_VERSION,
}));

import { GET } from "@/app/w/[workspaceId]/rechnungen/berichte/monats-zip/route";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "member-1" };
const ZIP_BYTES = Buffer.from("PK\x03\x04F820-fixture", "utf8");

function context(workspaceId: string = WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

function request(month: string | null = "2026-11") {
  const url = month === null
    ? "https://clone.test/monats-zip"
    : `https://clone.test/monats-zip?monat=${month}`;
  return new Request(url);
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedQuery.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.exportMonatsZip.mockResolvedValue({
    schemaVersion: "invoicing-monats-zip-batch.v1",
    month: "2026-11",
    fileName: "monatsunterlagen-2026-11.zip",
    contentType: "application/zip",
    bytes: ZIP_BYTES,
    documentCount: 1,
    pdfCount: 1,
  });
});

describe("F8-20 Monats-ZIP Route", () => {
  it("F820-CT-04: reautorisiert issuing_details.write und liefert ein privates ZIP-Attachment", async () => {
    const response = await GET(request(), context());

    expect(deps.authorizedQuery).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "invoicing.issuing_details.write",
      "invoicing_monats_zip",
      expect.any(Function),
    );
    expect(deps.exportMonatsZip).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "invoicing-monats-zip-command.v1",
      month: "2026-11",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="monatsunterlagen-2026-11.zip"',
    );
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ZIP_BYTES);
  });

  it.each([
    ["fehlendem", null],
    ["kalendarisch ungültigem", "2026-13"],
    ["falsch formatiertem", "11-2026"],
  ])("F820-CT-04: weist einen %s monat vor Auth als 400 zurück", async (
    _label,
    month,
  ) => {
    const response = await GET(request(month), context());

    expect(response.status).toBe(400);
    expect(deps.authorizedQuery).not.toHaveBeenCalled();
    expect(deps.exportMonatsZip).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("F820-CT-04: weist eine ungültige Workspace-ID vor Auth als 404 zurück", async () => {
    const response = await GET(request(), context("kein-uuid"));

    expect(response.status).toBe(404);
    expect(deps.authorizedQuery).not.toHaveBeenCalled();
    expect(deps.exportMonatsZip).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it.each([
    [new deps.NotAuthenticatedError(), 401],
    [new deps.PermissionDeniedError(), 403],
    [new deps.InvoicingNotFoundError(), 404],
    [new deps.InvoicingValidationError(), 400],
  ])("F820-CT-04: übersetzt Fehler ohne Interna (%s → %i)", async (error, status) => {
    deps.authorizedQuery.mockRejectedValueOnce(error);

    const response = await GET(request(), context());

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });
});
