import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class InvoicePdfNotFoundError extends Error {}
  class InvoicePdfIntegrityError extends Error {}
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    InvoicePdfNotFoundError,
    InvoicePdfIntegrityError,
    authorizedQuery: vi.fn(),
    readInvoicePdfArtifact: vi.fn(),
  };
});

vi.mock("@/lib/action", () => ({
  authorizedQuery: deps.authorizedQuery,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/invoicing", () => ({
  readInvoicePdfArtifact: deps.readInvoicePdfArtifact,
  InvoicePdfNotFoundError: deps.InvoicePdfNotFoundError,
  InvoicePdfIntegrityError: deps.InvoicePdfIntegrityError,
}));

import { GET } from "@/app/w/[workspaceId]/rechnungen/[type]/[documentId]/pdf/[jobId]/route";
import {
  INVOICE_PAYMENT_TEMPLATE_VERSION,
  INVOICE_PDF_TEMPLATE_VERSION,
} from "@/lib/integrations/invoicing/pdf-contract";
import {
  InvoicePdfIntegrityError,
  parseInvoicePdfTemplateVersion,
  resolveInvoicePdfArtifactFilename,
} from "@/modules/invoicing/pdf-service";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const DOCUMENT_ID = "20000000-0000-4000-8000-000000000002";
const JOB_ID = "30000000-0000-4000-8000-000000000003";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "member-1" };
const PDF_BYTES = Buffer.from("%PDF-1.7\nF8-18\n%%EOF\n", "utf8");
const PAYMENT_FILENAME = "RE-2026-000001-zahlung.pdf";

function context(overrides: Partial<{
  workspaceId: string;
  type: string;
  documentId: string;
  jobId: string;
}> = {}) {
  return {
    params: Promise.resolve({
      workspaceId: WORKSPACE_ID,
      type: "invoice",
      documentId: DOCUMENT_ID,
      jobId: JOB_ID,
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
  deps.readInvoicePdfArtifact.mockResolvedValue({
    jobId: JOB_ID,
    documentId: DOCUMENT_ID,
    filename: PAYMENT_FILENAME,
    mimeType: "application/pdf",
    sha256: "b".repeat(64),
    sizeBytes: PDF_BYTES.length,
    bytes: PDF_BYTES,
  });
});

describe("F8-18 payment PDF download route", () => {
  it("F818-CT-02: dient dem Payment-Track ueber die bestehende Route mit -zahlung.pdf und privaten Headern", async () => {
    const response = await GET(new Request("https://clone.test/download"), context());

    expect(deps.authorizedQuery).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "invoicing.issuing_details.write",
      "invoice_pdf_artifact",
      expect.any(Function),
    );
    expect(deps.readInvoicePdfArtifact).toHaveBeenCalledWith(TX, CTX, {
      workspaceId: WORKSPACE_ID,
      documentId: DOCUMENT_ID,
      jobId: JOB_ID,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-length")).toBe(String(PDF_BYTES.length));
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="${PAYMENT_FILENAME}"; filename*=UTF-8''${encodeURIComponent(PAYMENT_FILENAME)}`,
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
    ["Typ", { type: "kein-typ" }],
    ["Document", { documentId: "kein-uuid" }],
    ["Job", { jobId: "kein-uuid" }],
  ])("F818-CT-02: weist eine ungueltige %s-ID vor Auth und Datenzugriff als 404 zurueck", async (
    _label,
    overrides,
  ) => {
    const response = await GET(new Request("https://clone.test/download"), context(overrides));

    expect(response.status).toBe(404);
    expect(deps.authorizedQuery).not.toHaveBeenCalled();
    expect(deps.readInvoicePdfArtifact).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(await response.text()).toBe("");
  });

  it.each([
    [new deps.NotAuthenticatedError(), 401],
    [new deps.PermissionDeniedError(), 403],
    [new deps.InvoicePdfNotFoundError(), 404],
    [new deps.InvoicePdfIntegrityError(), 503],
  ])("F818-CT-02: uebersetzt Fehler ohne Interna in einen privaten Fehler", async (error, status) => {
    deps.authorizedQuery.mockRejectedValueOnce(error);

    const response = await GET(new Request("https://clone.test/download"), context());

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(await response.text()).toBe("");
  });

  it("F818-CT-02: verweigert einen unsicheren Dateinamen als 503 ohne Orakel", async () => {
    deps.readInvoicePdfArtifact.mockResolvedValue({
      jobId: JOB_ID,
      documentId: DOCUMENT_ID,
      filename: "../etc/passwd",
      mimeType: "application/pdf",
      sha256: "b".repeat(64),
      sizeBytes: PDF_BYTES.length,
      bytes: PDF_BYTES,
    });

    const response = await GET(new Request("https://clone.test/download"), context());

    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
  });
});

describe("F8-18 payment track projection", () => {
  it("F818-CT-01: pinnt beide Track-Template-Versionen als Diskriminator", () => {
    expect(INVOICE_PDF_TEMPLATE_VERSION).toBe("invoice-pdf-template.v1");
    expect(INVOICE_PAYMENT_TEMPLATE_VERSION).toBe("invoice-payment-template.v1");
    expect(parseInvoicePdfTemplateVersion("invoice-pdf-template.v1")).toBe(
      INVOICE_PDF_TEMPLATE_VERSION,
    );
    expect(parseInvoicePdfTemplateVersion("invoice-payment-template.v1")).toBe(
      INVOICE_PAYMENT_TEMPLATE_VERSION,
    );
  });

  it("F818-CT-01: weist unbekannte Template-Versionen als Integritaetsfehler ab", () => {
    for (const value of [
      "invoice-pdf-template.v2",
      "invoice-payment-template.v9",
      "",
      null,
      undefined,
      42,
      { templateVersion: "invoice-pdf-template.v1" },
    ]) {
      expect(() => parseInvoicePdfTemplateVersion(value)).toThrow(InvoicePdfIntegrityError);
    }
  });

  it("F818-CT-02: leitet den Track-Dateinamen aus der gespeicherten Template-Version ab", () => {
    expect(resolveInvoicePdfArtifactFilename(
      "RE-2026-000001",
      INVOICE_PDF_TEMPLATE_VERSION,
    )).toBe("RE-2026-000001.pdf");
    expect(resolveInvoicePdfArtifactFilename(
      "RE-2026-000001",
      INVOICE_PAYMENT_TEMPLATE_VERSION,
    )).toBe("RE-2026-000001-zahlung.pdf");
  });

  it("F818-CT-02: weist unsichere Nummern beim Dateinamen fail-closed ab", () => {
    for (const documentNumber of ["../etc/passwd", "", "RE 2026", "x".repeat(65)]) {
      expect(() => resolveInvoicePdfArtifactFilename(
        documentNumber,
        INVOICE_PAYMENT_TEMPLATE_VERSION,
      )).toThrow(InvoicePdfIntegrityError);
    }
  });
});
