import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  CATALOG_IMPORT_CLEANUP_DISPATCH_VERSION,
  CATALOG_IMPORT_DISPATCH_VERSION,
} from "@/lib/integrations/catalog/import-contract";
import {
  CatalogImportWorkerDatabaseError,
  type CatalogImportClaim,
  type CatalogImportDatabase,
} from "@/worker/catalog-import-database";
import {
  CATALOG_IMPORT_BATCH_LIMIT,
  createCatalogImportCleanupHandler,
  createCatalogImportHandler,
  startCatalogImportMaintenanceSweep,
} from "@/worker/catalog-import";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const IMPORT_ID = "22222222-2222-4222-8222-222222222222";
const DISPATCH_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_GENERATION = "9007199254740993";

function importJob(overrides: Record<string, unknown> = {}) {
  return {
    id: DISPATCH_ID,
    data: {
      schemaVersion: CATALOG_IMPORT_DISPATCH_VERSION,
      workspaceId: WORKSPACE_ID,
      importId: IMPORT_ID,
    },
    ...overrides,
  };
}

function cleanupJob() {
  return {
    id: DISPATCH_ID,
    data: {
      schemaVersion: CATALOG_IMPORT_CLEANUP_DISPATCH_VERSION,
      workspaceId: WORKSPACE_ID,
      importId: IMPORT_ID,
    },
  };
}

function claim(rowNumbers: readonly number[]): CatalogImportClaim {
  return {
    workspaceId: WORKSPACE_ID,
    importId: IMPORT_ID,
    leaseToken: DISPATCH_ID,
    leaseGeneration: LEASE_GENERATION,
    rowNumbers,
    leaseExpiresAt: new Date("2026-08-31T12:00:00.000Z"),
    replayed: false,
  };
}

function database(overrides: Partial<CatalogImportDatabase> = {}) {
  return {
    claim: vi.fn(async () => claim([2])),
    applyRow: vi.fn(async () => ({
      status: "created" as const,
      importId: IMPORT_ID,
      rowNumber: 2,
      componentId: "44444444-4444-4444-8444-444444444444",
      revision: 1,
      errorCode: null,
      snapshotHashRef: "0123456789abcdef",
      replayed: false,
    })),
    completeBatch: vi.fn(async () => ({
      status: "succeeded" as const,
      importId: IMPORT_ID,
      leaseGeneration: LEASE_GENERATION,
      resultCount: 1,
      successCount: 1,
      conflictCount: 0,
      errorCode: null,
      nextAttemptAt: null,
      dispatchRequired: false,
      replayed: false as const,
    })),
    finalizeFailure: vi.fn(async () => ({ status: "conflict" as const, code: "stale_lease" as const })),
    recordPreclaimFailure: vi.fn(async () => ({ status: "conflict" as const, code: "not_due" as const })),
    recordDispatchFailure: vi.fn(async () => ({
      status: "superseded" as const,
      state: "queued" as const,
      importId: IMPORT_ID,
    })),
    ...overrides,
  } as unknown as CatalogImportDatabase & Record<string, ReturnType<typeof vi.fn>>;
}

describe("M108B-WORKER-01 catalog import orchestration", () => {
  it("verwendet job.id als Claim-Dispatch und verarbeitet 25 Zeilen seriell vor Complete", async () => {
    const rowNumbers = Array.from({ length: 25 }, (_, index) => index + 2);
    const calls: string[] = [];
    const db = database({
      claim: vi.fn(async (input) => {
        calls.push(`claim:${input.dispatchId}`);
        return claim(rowNumbers);
      }),
      applyRow: vi.fn(async (input) => {
        calls.push(`row:${input.rowNumber}`);
        return {
          status: "unchanged" as const,
          importId: IMPORT_ID,
          rowNumber: input.rowNumber,
          componentId: "44444444-4444-4444-8444-444444444444",
          revision: 7,
          errorCode: null,
          snapshotHashRef: "0123456789abcdef",
          replayed: false as const,
        };
      }),
      completeBatch: vi.fn(async () => {
        calls.push("complete");
        return { status: "conflict" as const, code: "stale_lease" as const };
      }),
    });
    await createCatalogImportHandler({ database: db })([importJob()]);

    expect(db.claim).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      importId: IMPORT_ID,
      dispatchId: DISPATCH_ID,
      batchLimit: CATALOG_IMPORT_BATCH_LIMIT,
    });
    expect(db.applyRow).toHaveBeenCalledTimes(25);
    expect(calls).toEqual([
      `claim:${DISPATCH_ID}`,
      ...rowNumbers.map((rowNumber) => `row:${rowNumber}`),
      "complete",
    ]);
  });

  it("verarbeitet exakt 1.000 Zeilen in 40 fortgesetzten 25er-Batches", async () => {
    const dispatchIds = Array.from({ length: 40 }, () => randomUUID());
    const claimedBatches: number[][] = [];
    const claimedBatchLimits: number[] = [];
    const appliedRows: number[] = [];
    const completedGenerations: string[] = [];
    let batchIndex = 0;
    const db = database({
      claim: vi.fn(async (input) => {
        claimedBatchLimits.push(input.batchLimit);
        const currentBatch = batchIndex;
        batchIndex += 1;
        const rowNumbers = Array.from(
          { length: CATALOG_IMPORT_BATCH_LIMIT },
          (_, index) => 2 + currentBatch * CATALOG_IMPORT_BATCH_LIMIT + index,
        );
        claimedBatches.push(rowNumbers);
        return {
          ...claim(rowNumbers),
          leaseToken: input.dispatchId,
          leaseGeneration: String(currentBatch + 1),
        };
      }),
      applyRow: vi.fn(async (input) => {
        appliedRows.push(input.rowNumber);
        return {
          status: "created" as const,
          importId: IMPORT_ID,
          rowNumber: input.rowNumber,
          componentId: "44444444-4444-4444-8444-444444444444",
          revision: 1,
          errorCode: null,
          snapshotHashRef: "0123456789abcdef",
          replayed: false as const,
        };
      }),
      completeBatch: vi.fn(async (input) => {
        completedGenerations.push(input.leaseGeneration);
        const completedRows = Number(input.leaseGeneration) * CATALOG_IMPORT_BATCH_LIMIT;
        const terminal = completedRows === 1_000;
        return {
          status: terminal ? "succeeded" as const : "queued" as const,
          importId: IMPORT_ID,
          leaseGeneration: input.leaseGeneration,
          resultCount: completedRows,
          successCount: completedRows,
          conflictCount: 0,
          errorCode: null,
          nextAttemptAt: terminal ? null : new Date("2026-08-31T12:00:00.000Z"),
          dispatchRequired: !terminal,
          replayed: false as const,
        };
      }),
    });
    const handler = createCatalogImportHandler({ database: db });

    for (const dispatchId of dispatchIds) {
      await handler([importJob({ id: dispatchId })]);
    }

    expect(new Set(dispatchIds).size).toBe(40);
    expect(db.claim).toHaveBeenCalledTimes(40);
    expect(claimedBatchLimits).toEqual(
      Array.from({ length: 40 }, () => CATALOG_IMPORT_BATCH_LIMIT),
    );
    expect(claimedBatches).toHaveLength(40);
    expect(claimedBatches.every((rows) => rows.length === 25)).toBe(true);
    expect(appliedRows).toEqual(Array.from({ length: 1_000 }, (_, index) => index + 2));
    expect(db.applyRow).toHaveBeenCalledTimes(1_000);
    expect(db.completeBatch).toHaveBeenCalledTimes(40);
    expect(completedGenerations).toEqual(Array.from({ length: 40 }, (_, index) => String(index + 1)));
    expect(db.finalizeFailure).not.toHaveBeenCalled();
  });

  it("weist offene Payloads und fremde Job-IDs vor jedem Datenbankzugriff ab", async () => {
    const db = database();
    const handler = createCatalogImportHandler({ database: db });
    await expect(handler([importJob({
      data: { ...importJob().data, privatePrice: "999999,99" },
    })])).rejects.toMatchObject({ name: "CatalogImportDispatchError" });
    await expect(handler([importJob({
      id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    })])).rejects.toMatchObject({ name: "CatalogImportDispatchError" });
    expect(db.claim).not.toHaveBeenCalled();
  });

  it("persistiert einen Claim-Enqueuefehler separat als festen Preclaim-Fehler", async () => {
    const db = database({
      claim: vi.fn(async () => {
        throw new CatalogImportWorkerDatabaseError("enqueue_failed");
      }),
    });
    await createCatalogImportHandler({ database: db })([importJob()]);
    expect(db.recordDispatchFailure).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      importId: IMPORT_ID,
      dispatchId: DISPATCH_ID,
      errorCode: "enqueue_failed",
    });
    expect(db.applyRow).not.toHaveBeenCalled();
  });

  it("übersetzt einen Complete-Enqueuefehler in eine neue Lease-Fehlertransaktion", async () => {
    const db = database({
      completeBatch: vi.fn(async () => {
        throw new CatalogImportWorkerDatabaseError("enqueue_failed");
      }),
    });
    await createCatalogImportHandler({ database: db })([importJob()]);
    expect(db.finalizeFailure).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      importId: IMPORT_ID,
      leaseToken: DISPATCH_ID,
      leaseGeneration: LEASE_GENERATION,
      errorCode: "enqueue_failed",
    });
  });

  it("stoppt bei terminaler Row commitbar und ruft Complete nicht mehr auf", async () => {
    const db = database({
      claim: vi.fn(async () => claim([2, 3])),
      applyRow: vi.fn(async (input) => ({
        status: "failed_final" as const,
        importId: IMPORT_ID,
        rowNumber: input.rowNumber,
        errorCode: "capability_revoked" as const,
        replayed: false as const,
      })),
    });
    await createCatalogImportHandler({ database: db })([importJob()]);
    expect(db.applyRow).toHaveBeenCalledTimes(1);
    expect(db.completeBatch).not.toHaveBeenCalled();
    expect(db.finalizeFailure).not.toHaveBeenCalled();
  });

  it("führt beim Cleanup zuerst Preview-/Lease-Recovery und danach Due-Redaction aus", async () => {
    const calls: string[] = [];
    const maintenance = {
      recoverDue: vi.fn(async () => { calls.push("recover"); return []; }),
      cleanupDue: vi.fn(async () => { calls.push("cleanup"); return []; }),
    };
    await createCatalogImportCleanupHandler(maintenance)([cleanupJob()]);
    expect(calls).toEqual(["recover", "cleanup"]);
    expect(maintenance.recoverDue).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      limit: 100,
    });
  });

  it("dedupliziert Locator-Workspaces und lässt Sweep-Seiten nicht überlappen", async () => {
    let resolvePass: (() => void) | undefined;
    const pass = new Promise<void>((resolve) => { resolvePass = resolve; });
    const maintenance = {
      listRecoveryLocators: vi.fn(async () => ({
        locators: [
          {
            status: "valid" as const,
            locatorJobId: DISPATCH_ID,
            workspaceId: WORKSPACE_ID,
            importId: IMPORT_ID,
          },
          {
            status: "valid" as const,
            locatorJobId: "44444444-4444-4444-8444-444444444444",
            workspaceId: WORKSPACE_ID,
            importId: "55555555-5555-4555-8555-555555555555",
          },
        ],
        nextAfterJobId: null,
      })),
      listCleanupLocators: vi.fn(async () => ({
        locators: [{
          status: "valid" as const,
          locatorJobId: DISPATCH_ID,
          workspaceId: WORKSPACE_ID,
          importId: IMPORT_ID,
        }],
        nextAfterJobId: null,
      })),
      recoverDue: vi.fn(async () => []),
      cleanupDue: vi.fn(async () => {
        resolvePass?.();
        return [];
      }),
      handleInvalidLocator: vi.fn(async () => {}),
    };
    const onFatal = vi.fn();
    const controller = startCatalogImportMaintenanceSweep(
      { database: maintenance, onFatal },
      { intervalMs: 60_000, locatorLimit: 100, jobsPerWorkspaceLimit: 25 },
    );
    await pass;
    await controller.stop();
    expect(maintenance.listRecoveryLocators).toHaveBeenCalledTimes(1);
    expect(maintenance.listCleanupLocators).toHaveBeenCalledTimes(1);
    expect(maintenance.recoverDue).toHaveBeenCalledTimes(2);
    expect(maintenance.cleanupDue).toHaveBeenCalledTimes(1);
    expect(onFatal).not.toHaveBeenCalled();
  });

  it("verarbeitet bindbare und unbindbare Locatorfehler ohne die Seite zu vergiften", async () => {
    let resolvePass: (() => void) | undefined;
    const pass = new Promise<void>((resolve) => { resolvePass = resolve; });
    const invalid = {
      status: "queue_locator_invalid" as const,
      locatorJobId: DISPATCH_ID,
      workspaceId: WORKSPACE_ID,
      importId: IMPORT_ID,
    };
    const unbound = {
      status: "queue_locator_invalid" as const,
      locatorJobId: "44444444-4444-4444-8444-444444444444",
      workspaceId: null,
      importId: null,
    };
    const maintenance = {
      listRecoveryLocators: vi.fn(async () => ({
        locators: [invalid, unbound],
        nextAfterJobId: null,
      })),
      listCleanupLocators: vi.fn(async () => ({
        locators: [],
        nextAfterJobId: null,
      })),
      recoverDue: vi.fn(async () => []),
      cleanupDue: vi.fn(async () => []),
      handleInvalidLocator: vi.fn(async () => { resolvePass?.(); }),
    };
    const onFatal = vi.fn();
    const controller = startCatalogImportMaintenanceSweep(
      { database: maintenance, onFatal },
      { intervalMs: 60_000 },
    );
    await pass;
    await controller.stop();
    expect(maintenance.recoverDue).toHaveBeenCalledTimes(1);
    expect(maintenance.handleInvalidLocator).toHaveBeenCalledTimes(2);
    expect(onFatal).not.toHaveBeenCalled();
  });
});
