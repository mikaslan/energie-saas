import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {}
  class PermissionDeniedError extends Error {}
  class CatalogImportConflictError extends Error {}
  class CatalogImportInputError extends Error {}
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
    startCatalogImport: vi.fn(),
    cancelCatalogImport: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: deps.revalidatePath }));
vi.mock("@/lib/action", () => ({
  authorizedAction: deps.authorizedAction,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/modules/catalog", () => ({
  startCatalogImport: deps.startCatalogImport,
  cancelCatalogImport: deps.cancelCatalogImport,
  CatalogImportConflictError: deps.CatalogImportConflictError,
  CatalogImportInputError: deps.CatalogImportInputError,
  CatalogImportIntegrityError: deps.CatalogImportIntegrityError,
  CatalogImportPersistenceError: deps.CatalogImportPersistenceError,
  CatalogImportDispatchError: deps.CatalogImportDispatchError,
}));

import {
  cancelCatalogImportAction,
  startCatalogImportAction,
} from "@/app/w/[workspaceId]/katalog/importe/[importId]/actions";
import { CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION } from "@/lib/integrations/catalog/import-contract";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const IMPORT_ID = "22222222-2222-4222-8222-222222222222";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "actor-1" };
const IDLE = { status: "idle" as const };

function form(entries: readonly (readonly [string, string])[]): FormData {
  const data = new FormData();
  for (const [name, value] of entries) data.append(name, value);
  return data;
}

function startForm(): FormData {
  return form([
    ["workspaceId", WORKSPACE_ID],
    ["importId", IMPORT_ID],
    ["rightsAttested", "yes"],
  ]);
}

function cancelForm(): FormData {
  return form([
    ["workspaceId", WORKSPACE_ID],
    ["importId", IMPORT_ID],
  ]);
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedAction.mockImplementation(async (
    _workspaceId: string,
    _action: string,
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.startCatalogImport.mockResolvedValue({
    status: "queued",
    importId: IMPORT_ID,
    replayed: false,
  });
  deps.cancelCatalogImport.mockResolvedValue({
    status: "cancelled_before_start",
    importId: IMPORT_ID,
    replayed: false,
  });
});

describe("M108B catalog import server actions", () => {
  it("startet nur mit exakter Attestation und revalidiert Katalog sowie Detail", async () => {
    await expect(startCatalogImportAction(IDLE, startForm())).resolves.toEqual({
      status: "success",
      state: "queued",
      replayed: false,
    });
    expect(deps.authorizedAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "catalog.manage",
      "catalog_import_start",
      expect.any(Function),
    );
    expect(deps.startCatalogImport).toHaveBeenCalledWith(TX, CTX, {
      importId: IMPORT_ID,
      attestationVersion: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
    });
    expect(deps.revalidatePath.mock.calls).toEqual([
      [`/w/${WORKSPACE_ID}/katalog`],
      [`/w/${WORKSPACE_ID}/katalog/importe/${IMPORT_ID}`],
    ]);
  });

  it("bricht eine prüfbereite Vorschau über denselben Tenantpfad ab", async () => {
    await expect(cancelCatalogImportAction(IDLE, cancelForm())).resolves.toEqual({
      status: "success",
      state: "cancelled_before_start",
      replayed: false,
    });
    expect(deps.authorizedAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      "catalog.manage",
      "catalog_import_cancel",
      expect.any(Function),
    );
    expect(deps.cancelCatalogImport).toHaveBeenCalledWith(TX, CTX, {
      importId: IMPORT_ID,
    });
  });

  it("weist fehlende, zusätzliche und doppelte Formfelder vor Auth zurück", async () => {
    const malformed = [
      form([["workspaceId", WORKSPACE_ID], ["importId", IMPORT_ID]]),
      form([
        ["workspaceId", WORKSPACE_ID], ["importId", IMPORT_ID],
        ["rightsAttested", "yes"], ["privatePrice", "999999"],
      ]),
      form([
        ["workspaceId", WORKSPACE_ID], ["importId", IMPORT_ID],
        ["rightsAttested", "yes"], ["rightsAttested", "yes"],
      ]),
    ];
    for (const candidate of malformed) {
      await expect(startCatalogImportAction(IDLE, candidate)).resolves.toEqual({
        status: "invalid",
      });
    }
    expect(deps.authorizedAction).not.toHaveBeenCalled();
  });

  it("übersetzt autoritative Start-Replays und feste Kontrollzustände", async () => {
    deps.startCatalogImport.mockResolvedValueOnce({
      status: "replayed",
      state: "running",
      importId: IMPORT_ID,
      replayed: true,
    });
    await expect(startCatalogImportAction(IDLE, startForm())).resolves.toEqual({
      status: "success",
      state: "running",
      replayed: true,
    });

    deps.startCatalogImport.mockResolvedValueOnce({ status: "not_found" });
    await expect(startCatalogImportAction(IDLE, startForm()))
      .resolves.toEqual({ status: "not_found" });

    deps.startCatalogImport.mockResolvedValueOnce({
      status: "conflict",
      state: "running",
    });
    await expect(startCatalogImportAction(IDLE, startForm()))
      .resolves.toEqual({ status: "conflict", state: "running" });

    deps.startCatalogImport.mockResolvedValueOnce({
      status: "cancelled_before_start",
      importId: IMPORT_ID,
      replayed: false,
    });
    await expect(startCatalogImportAction(IDLE, startForm()))
      .resolves.toEqual({ status: "expired" });
  });

  it.each([
    [new deps.NotAuthenticatedError(), "unauthenticated"],
    [new deps.PermissionDeniedError(), "denied"],
    [new deps.CatalogImportInputError(), "invalid"],
    [new deps.CatalogImportConflictError(), "conflict"],
    [new deps.CatalogImportIntegrityError(), "unavailable"],
    [new deps.CatalogImportPersistenceError(), "unavailable"],
    [new deps.CatalogImportDispatchError(), "unavailable"],
  ])("übersetzt %s ohne interne Details", async (error, status) => {
    deps.authorizedAction.mockRejectedValueOnce(error);
    await expect(startCatalogImportAction(IDLE, startForm()))
      .resolves.toEqual({ status });
    expect(deps.revalidatePath).not.toHaveBeenCalled();
  });

  it("lässt unbekannte Programmierfehler sichtbar", async () => {
    deps.authorizedAction.mockRejectedValueOnce(new Error("private canary"));
    await expect(startCatalogImportAction(IDLE, startForm()))
      .rejects.toThrow("private canary");
  });
});
