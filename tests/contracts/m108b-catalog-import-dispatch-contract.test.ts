import { describe, expect, it } from "vitest";

import {
  CATALOG_IMPORT_CLEANUP_DISPATCH_VERSION,
  CATALOG_IMPORT_DISPATCH_VERSION,
  parseCatalogImportCleanupDispatchV1,
  parseCatalogImportDispatchV1,
} from "@/lib/integrations/catalog/import-contract";

const workspaceId = "10000000-0000-4000-8000-000000000001";
const importId = "20000000-0000-4000-8000-00000000000a";

describe("M108B catalog-import ID-only dispatch contract", () => {
  it("akzeptiert fuer beide Queues exakt Version, Workspace und Import", () => {
    expect(parseCatalogImportDispatchV1({
      schemaVersion: CATALOG_IMPORT_DISPATCH_VERSION,
      workspaceId,
      importId,
    })).toEqual({
      schemaVersion: "catalog-import-dispatch.v1",
      workspaceId,
      importId,
    });
    expect(parseCatalogImportCleanupDispatchV1({
      schemaVersion: CATALOG_IMPORT_CLEANUP_DISPATCH_VERSION,
      workspaceId,
      importId,
    })).toEqual({
      schemaVersion: "catalog-import-cleanup-dispatch.v1",
      workspaceId,
      importId,
    });
  });

  it("weist Zusatzdaten, fremde Versionen und ungueltige IDs ab", () => {
    for (const candidate of [
      {
        schemaVersion: CATALOG_IMPORT_DISPATCH_VERSION,
        workspaceId,
        importId,
        rowNumber: 2,
      },
      { schemaVersion: "catalog-import-dispatch.v2", workspaceId, importId },
      {
        schemaVersion: CATALOG_IMPORT_DISPATCH_VERSION,
        workspaceId: "not-a-workspace",
        importId,
      },
    ]) {
      expect(() => parseCatalogImportDispatchV1(candidate)).toThrow();
    }
    expect(() => parseCatalogImportCleanupDispatchV1({
      schemaVersion: CATALOG_IMPORT_CLEANUP_DISPATCH_VERSION,
      workspaceId,
      importId: importId.toUpperCase(),
    })).toThrow();
  });
});
