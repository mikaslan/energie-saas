import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class CatalogImportConflictError extends Error {
    constructor(public readonly code: "intent_reused") {
      super(code);
    }
  }
  class CatalogImportInputError extends Error {
    constructor(public readonly paths: string[], public readonly code = "invalid_file") {
      super(code);
    }
  }
  class CatalogImportIntegrityError extends Error {}
  class CatalogImportPersistenceError extends Error {}
  class CatalogImportDispatchError extends Error {}
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    CatalogImportConflictError,
    CatalogImportInputError,
    CatalogImportIntegrityError,
    CatalogImportPersistenceError,
    CatalogImportDispatchError,
    authorizedAction: vi.fn(),
    assertCatalogImportAccess: vi.fn(),
    prepareCatalogImport: vi.fn(),
  };
});

vi.mock("@/lib/action", () => ({
  authorizedAction: deps.authorizedAction,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/catalog", () => ({
  assertCatalogImportAccess: deps.assertCatalogImportAccess,
  prepareCatalogImport: deps.prepareCatalogImport,
  CatalogImportConflictError: deps.CatalogImportConflictError,
  CatalogImportInputError: deps.CatalogImportInputError,
  CatalogImportIntegrityError: deps.CatalogImportIntegrityError,
  CatalogImportPersistenceError: deps.CatalogImportPersistenceError,
  CatalogImportDispatchError: deps.CatalogImportDispatchError,
}));

import { POST } from "@/app/w/[workspaceId]/katalog/import/preview/route";
import {
  CATALOG_CSV_PREVIEW_MEDIA_TYPE,
  CATALOG_CSV_PREVIEW_WIRE_VERSION,
} from "@/lib/integrations/catalog/import-http";
import {
  autoMapCatalogCsvHeaders,
  catalogCsvTemplate,
  inspectCatalogCsvFile,
} from "@/lib/integrations/catalog/import-contract";
import { CATALOG_IMPORT_JOB_STATES } from "@/lib/integrations/catalog/import-wire";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "22222222-2222-4222-8222-222222222222";
const IMPORT_ID = "33333333-3333-4333-8333-333333333333";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "actor-1" };
const file = new TextEncoder().encode(catalogCsvTemplate());
const inspection = inspectCatalogCsvFile({ filename: "produkte.csv", bytes: file });
const mapping = autoMapCatalogCsvHeaders(inspection.headers);

function envelope(mode: "inspect" | "preview", bytes = file): Uint8Array {
  const metadata = new TextEncoder().encode(JSON.stringify({
    schemaVersion: CATALOG_CSV_PREVIEW_WIRE_VERSION,
    mode,
    intentId: INTENT_ID,
    filename: "produkte.csv",
    ...(mode === "preview" ? { mapping } : {}),
  }));
  const body = new Uint8Array(4 + metadata.byteLength + bytes.byteLength);
  new DataView(body.buffer).setUint32(0, metadata.byteLength, false);
  body.set(metadata, 4);
  body.set(bytes, 4 + metadata.byteLength);
  return body;
}

function request(mode: "inspect" | "preview", bytes = file): Request {
  return new Request(
    `https://clone.test/w/${WORKSPACE_ID}/katalog/import/preview`,
    {
      method: "POST",
      headers: {
        "content-type": CATALOG_CSV_PREVIEW_MEDIA_TYPE,
        "sec-fetch-site": "same-origin",
        host: "clone.test",
        origin: "https://clone.test",
      },
      body: envelope(mode, bytes).buffer as ArrayBuffer,
    },
  );
}

function context(workspaceId = WORKSPACE_ID) {
  return { params: Promise.resolve({ workspaceId }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedAction.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.prepareCatalogImport.mockResolvedValue({
    status: "ready_for_review",
    importId: IMPORT_ID,
    intentId: INTENT_ID,
    totalCount: 1,
    validCount: 1,
    invalidCount: 0,
    previewExpiresAt: "2026-09-07T12:00:00.000Z",
    replayed: false,
  });
});

describe("M108B preview route wiring", () => {
  it("prüft Inspect vollständig im autorisierten Tenantkontext", async () => {
    const response = await POST(request("inspect"), context());
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "inspected",
      intentId: INTENT_ID,
      inspection: { filename: "produkte.csv", rowCount: 1 },
      mapping,
    });
    expect(deps.authorizedAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "catalog.manage",
      "catalog_import_preview",
      expect.any(Function),
    );
    expect(deps.assertCatalogImportAccess).toHaveBeenCalledWith(CTX);
    expect(deps.prepareCatalogImport).not.toHaveBeenCalled();
  });

  it("parst Preview serverautoritativ und persistiert nur den versiegelten Vertrag", async () => {
    const response = await POST(request("preview"), context());
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: "prepared",
      importId: IMPORT_ID,
      intentId: INTENT_ID,
      state: "ready_for_review",
      replayed: false,
      counts: { total: 1, valid: 1, invalid: 0 },
    });
    expect(deps.assertCatalogImportAccess).toHaveBeenCalledWith(CTX);
    expect(deps.prepareCatalogImport).toHaveBeenCalledWith(
      TX,
      CTX,
      expect.objectContaining({
        intentId: INTENT_ID,
        preview: expect.objectContaining({
          file: expect.objectContaining({ filename: "produkte.csv" }),
          mapping,
          counts: { total: 1, valid: 1, invalid: 0 },
        }),
      }),
    );
  });

  it.each(CATALOG_IMPORT_JOB_STATES)(
    "bewahrt bei einem Intent-Replay den autoritativen Zustand %s",
    async (state) => {
    deps.prepareCatalogImport.mockResolvedValueOnce({
      status: state,
      importId: IMPORT_ID,
      intentId: INTENT_ID,
      totalCount: 1,
      validCount: 1,
      invalidCount: 0,
      previewExpiresAt: "2026-09-07T12:00:00.000Z",
      replayed: true,
    });

    const response = await POST(request("preview"), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "prepared",
      importId: IMPORT_ID,
      state,
      replayed: true,
    });
    },
  );

  it.each([
    [new deps.NotAuthenticatedError(), 401, "unauthenticated"],
    [new deps.PermissionDeniedError(), 403, "forbidden"],
    [new deps.CatalogImportConflictError("intent_reused"), 409, "intent_reused"],
    [new deps.CatalogImportInputError(["/preview"], "snapshot_budget_exceeded"), 422, "snapshot_budget_exceeded"],
    [new deps.CatalogImportIntegrityError(), 503, "unavailable"],
    [new deps.CatalogImportPersistenceError(), 503, "unavailable"],
    [new deps.CatalogImportDispatchError(), 503, "unavailable"],
  ])("übersetzt %s ohne interne Details", async (error, status, code) => {
    deps.authorizedAction.mockRejectedValueOnce(error);
    const response = await POST(request("inspect"), context());
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  });

  it("übersetzt Parserfehler stabil und ruft keine Persistenz auf", async () => {
    const response = await POST(request("inspect", new Uint8Array([0])), context());
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_encoding" } });
    expect(deps.prepareCatalogImport).not.toHaveBeenCalled();
  });
});
