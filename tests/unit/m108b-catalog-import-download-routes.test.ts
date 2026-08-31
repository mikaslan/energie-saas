import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class CatalogImportIntegrityError extends Error {}
  class CatalogImportPersistenceError extends Error {}
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    CatalogImportIntegrityError,
    CatalogImportPersistenceError,
    authorizedQuery: vi.fn(),
    assertCatalogImportAccess: vi.fn(),
    getCatalogImportErrorReport: vi.fn(),
  };
});

vi.mock("@/lib/action", () => ({
  authorizedQuery: deps.authorizedQuery,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/catalog", () => ({
  assertCatalogImportAccess: deps.assertCatalogImportAccess,
  getCatalogImportErrorReport: deps.getCatalogImportErrorReport,
  CatalogImportIntegrityError: deps.CatalogImportIntegrityError,
  CatalogImportPersistenceError: deps.CatalogImportPersistenceError,
}));

import { GET as downloadTemplate } from "@/app/w/[workspaceId]/katalog/import/vorlage/route";
import { GET as downloadErrorReport } from "@/app/w/[workspaceId]/katalog/importe/[importId]/fehlerbericht/route";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const IMPORT_ID = "22222222-2222-4222-8222-222222222222";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "actor-1" };

function privateCsv(response: Response): void {
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-disposition")).toContain("attachment;");
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedQuery.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.getCatalogImportErrorReport.mockResolvedValue(
    "\uFEFFZeile;Feld;Quellspalte;Code;Meldung\r\n2;purchasePriceNet;'=SUM(A1);invalid_money;Der Nettopreis ist nicht eindeutig lesbar.\r\n",
  );
});

describe("M108B private catalog import downloads", () => {
  it("liefert die kanonische BOM-/Semikolon-Vorlage nur nach Triple-Right-Check", async () => {
    const response = await downloadTemplate(
      new Request("https://clone.test/template"),
      { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) },
    );

    expect(response.status).toBe(200);
    privateCsv(response);
    expect(response.headers.get("content-disposition")).toContain("wmee-katalog-vorlage.csv");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes.slice(3)).startsWith(
      "internalSku;componentType;displayName;",
    )).toBe(true);
    expect(deps.authorizedQuery).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "catalog.manage",
      "catalog_import_template",
      expect.any(Function),
    );
    expect(deps.assertCatalogImportAccess).toHaveBeenCalledWith(CTX);
  });

  it("liefert ausschließlich den formelsicheren persistierten Fehlerreport", async () => {
    const response = await downloadErrorReport(
      new Request("https://clone.test/report"),
      { params: Promise.resolve({ workspaceId: WORKSPACE_ID, importId: IMPORT_ID }) },
    );

    expect(response.status).toBe(200);
    privateCsv(response);
    expect(response.headers.get("content-disposition")).toContain(
      `katalog-import-${IMPORT_ID}-fehler.csv`,
    );
    expect(await response.text()).toContain(";'=SUM(A1);");
    expect(deps.getCatalogImportErrorReport).toHaveBeenCalledWith(TX, CTX, {
      importId: IMPORT_ID,
    });
  });

  it("liefert für fremde oder unbekannte Import-IDs dasselbe private 404", async () => {
    deps.getCatalogImportErrorReport.mockResolvedValueOnce(null);
    const response = await downloadErrorReport(
      new Request("https://clone.test/report"),
      { params: Promise.resolve({ workspaceId: WORKSPACE_ID, importId: IMPORT_ID }) },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.text()).toBe("");
  });

  it.each([
    [new deps.NotAuthenticatedError(), 401],
    [new deps.PermissionDeniedError(), 403],
    [new deps.CatalogImportIntegrityError(), 503],
    [new deps.CatalogImportPersistenceError(), 503],
  ])("übersetzt %s ohne Report- oder Dateidetails", async (error, status) => {
    deps.authorizedQuery.mockRejectedValueOnce(error);
    const response = await downloadErrorReport(
      new Request("https://clone.test/report"),
      { params: Promise.resolve({ workspaceId: WORKSPACE_ID, importId: IMPORT_ID }) },
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("");
  });

  it("verwirft ungültige IDs vor Auth und Datenzugriff", async () => {
    const response = await downloadErrorReport(
      new Request("https://clone.test/report"),
      { params: Promise.resolve({ workspaceId: WORKSPACE_ID, importId: "kein-uuid" }) },
    );
    expect(response.status).toBe(404);
    expect(deps.authorizedQuery).not.toHaveBeenCalled();
    expect(deps.getCatalogImportErrorReport).not.toHaveBeenCalled();
  });
});
