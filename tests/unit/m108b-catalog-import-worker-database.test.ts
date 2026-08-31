import { describe, expect, it, vi } from "vitest";

import type { TenantTx } from "@/lib/db/types";
import {
  applyCatalogImportRow,
  claimCatalogImport,
  completeCatalogImportBatch,
  finalizeCatalogImportFailure,
  recordCatalogImportDispatchFailure,
  recordCatalogImportPreclaimFailure,
  recoverDueCatalogImports,
} from "@/worker/catalog-import-database";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const IMPORT_ID = "22222222-2222-4222-8222-222222222222";
const DISPATCH_ID = "33333333-3333-4333-8333-333333333333";
const NEXT_DISPATCH_ID = "44444444-4444-4444-8444-444444444444";
const LEASE_GENERATION = "9007199254740993";
const COMPONENT_ID = "55555555-5555-4555-8555-555555555555";
const DATABASE_TIME = "2026-08-31T12:00:00.000Z";

function transaction(responses: Array<{ rows: unknown[] }>) {
  let index = 0;
  const execute = vi.fn(async () => responses[index++] ?? { rows: [] });
  return { execute, tx: { execute } as unknown as TenantTx };
}

function dispatchGate(kind: "import" | "cleanup") {
  return {
    rows: [{
      dispatch_signature: kind === "import"
        ? "pgboss.enqueue_catalog_import_v1(uuid,uuid,uuid)"
        : "pgboss.enqueue_catalog_import_cleanup_v1(uuid,uuid,uuid)",
      current_role: "app_worker",
      session_role: "app_worker",
      database_name: "energie_saas",
    }],
  };
}

function leaseKey() {
  return {
    workspaceId: WORKSPACE_ID,
    importId: IMPORT_ID,
    leaseToken: DISPATCH_ID,
    leaseGeneration: LEASE_GENERATION,
  };
}

describe("M108B-WORKER-DB-01 catalog import database gateway", () => {
  it("bindet Claim und Lease-Sentinel an die echte pg-boss Job-ID", async () => {
    const harness = transaction([
      { rows: [{ result: {
        status: "claimed",
        importId: IMPORT_ID,
        leaseToken: DISPATCH_ID,
        leaseGeneration: LEASE_GENERATION,
        rowNumbers: [2, 4, 9],
        leaseExpiresAt: DATABASE_TIME,
        replayed: false,
      } }] },
      dispatchGate("import"),
      { rows: [{}] },
    ]);
    await expect(claimCatalogImport(harness.tx, {
      workspaceId: WORKSPACE_ID,
      importId: IMPORT_ID,
      dispatchId: DISPATCH_ID,
      batchLimit: 25,
    })).resolves.toMatchObject({
      importId: IMPORT_ID,
      leaseToken: DISPATCH_ID,
      leaseGeneration: LEASE_GENERATION,
      rowNumbers: [2, 4, 9],
    });
    expect(harness.execute).toHaveBeenCalledTimes(3);
    const sqlCalls = JSON.stringify(harness.execute.mock.calls);
    expect(sqlCalls).toContain("claim_catalog_import_v1");
    expect(sqlCalls).toContain(DISPATCH_ID);
    expect(sqlCalls).toContain("enqueue_catalog_import_v1");
    expect(sqlCalls).not.toContain("purchasePriceNetCents");
    expect(sqlCalls).not.toContain("technicalProvenance");
  });

  it("weist unsortierte Lease-Zeilen, Uppercase-UUID und unsichere Generationen ab", async () => {
    const unsorted = transaction([{ rows: [{ result: {
      status: "claimed",
      importId: IMPORT_ID,
      leaseToken: DISPATCH_ID,
      leaseGeneration: "1",
      rowNumbers: [3, 2],
      leaseExpiresAt: DATABASE_TIME,
      replayed: false,
    } }] }]);
    await expect(claimCatalogImport(unsorted.tx, {
      workspaceId: WORKSPACE_ID,
      importId: IMPORT_ID,
      dispatchId: DISPATCH_ID,
      batchLimit: 25,
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(unsorted.execute).toHaveBeenCalledTimes(1);

    const invalid = transaction([]);
    await expect(claimCatalogImport(invalid.tx, {
      workspaceId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      importId: IMPORT_ID,
      dispatchId: DISPATCH_ID,
      batchLimit: 25,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(completeCatalogImportBatch(invalid.tx, {
      ...leaseKey(),
      leaseGeneration: 9_007_199_254_740_992,
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(completeCatalogImportBatch(invalid.tx, {
      ...leaseKey(),
      leaseGeneration: "9223372036854775808",
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(invalid.execute).not.toHaveBeenCalled();
  });

  it("bindet die Claim-Antwort an das angeforderte Batchlimit", async () => {
    const harness = transaction([{ rows: [{ result: {
      status: "claimed",
      importId: IMPORT_ID,
      leaseToken: DISPATCH_ID,
      leaseGeneration: "1",
      rowNumbers: [2, 3],
      leaseExpiresAt: DATABASE_TIME,
      replayed: false,
    } }] }]);
    await expect(claimCatalogImport(harness.tx, {
      workspaceId: WORKSPACE_ID,
      importId: IMPORT_ID,
      dispatchId: DISPATCH_ID,
      batchLimit: 1,
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(harness.execute).toHaveBeenCalledTimes(1);
  });

  it("enqueued nach frischem Batch nur den passenden Folgepfad und nie bei Replay", async () => {
    const queued = transaction([
      { rows: [{ result: {
        status: "queued",
        importId: IMPORT_ID,
        leaseGeneration: LEASE_GENERATION,
        resultCount: 25,
        successCount: 24,
        conflictCount: 1,
        errorCode: null,
        nextAttemptAt: DATABASE_TIME,
        dispatchRequired: true,
        replayed: false,
      } }] },
      dispatchGate("import"),
      { rows: [{}] },
    ]);
    await completeCatalogImportBatch(queued.tx, leaseKey());
    expect(JSON.stringify(queued.execute.mock.calls)).toContain("enqueue_catalog_import_v1");

    const terminal = transaction([
      { rows: [{ result: {
        status: "partial",
        importId: IMPORT_ID,
        leaseGeneration: LEASE_GENERATION,
        resultCount: 93,
        successCount: 93,
        conflictCount: 0,
        errorCode: null,
        nextAttemptAt: null,
        dispatchRequired: false,
        replayed: false,
      } }] },
      dispatchGate("cleanup"),
      { rows: [{}] },
    ]);
    await completeCatalogImportBatch(terminal.tx, leaseKey());
    expect(JSON.stringify(terminal.execute.mock.calls))
      .toContain("enqueue_catalog_import_cleanup_v1");

    const replay = transaction([{ rows: [{ result: {
      status: "partial",
      importId: IMPORT_ID,
      leaseGeneration: LEASE_GENERATION,
      failureCount: 0,
      errorCode: null,
      nextAttemptAt: null,
      dispatchRequired: false,
      replayed: true,
    } }] }]);
    await completeCatalogImportBatch(replay.tx, leaseKey());
    expect(replay.execute).toHaveBeenCalledTimes(1);
  });

  it("committet fachliche Zeilenresultate und koppelt nur globale Terminals an Cleanup", async () => {
    const success = transaction([{ rows: [{ result: {
      status: "created",
      importId: IMPORT_ID,
      rowNumber: 2,
      componentId: COMPONENT_ID,
      revision: 1,
      errorCode: null,
      snapshotHashRef: "0123456789abcdef",
      replayed: false,
    } }] }]);
    await expect(applyCatalogImportRow(success.tx, {
      ...leaseKey(),
      rowNumber: 2,
    })).resolves.toMatchObject({ status: "created", componentId: COMPONENT_ID });
    expect(success.execute).toHaveBeenCalledTimes(1);

    const terminal = transaction([
      { rows: [{ result: {
        status: "failed_final",
        importId: IMPORT_ID,
        rowNumber: 2,
        errorCode: "actor_revoked",
        replayed: false,
      } }] },
      dispatchGate("cleanup"),
      { rows: [{}] },
    ]);
    await expect(applyCatalogImportRow(terminal.tx, {
      ...leaseKey(),
      rowNumber: 2,
    })).resolves.toMatchObject({ status: "failed_final" });
    expect(JSON.stringify(terminal.execute.mock.calls))
      .toContain("enqueue_catalog_import_cleanup_v1");
  });

  it("persistiert feste Preclaim-/Lease-Fehler und enqueued den DB-abgeleiteten Retry", async () => {
    const preclaim = transaction([
      { rows: [{ result: {
        status: "retry_wait",
        importId: IMPORT_ID,
        failureCount: 1,
        errorCode: "enqueue_failed",
        nextAttemptAt: DATABASE_TIME,
        dispatchRequired: true,
        replayed: false,
      } }] },
      dispatchGate("import"),
      { rows: [{}] },
    ]);
    await recordCatalogImportPreclaimFailure(preclaim.tx, {
      workspaceId: WORKSPACE_ID,
      importId: IMPORT_ID,
      dispatchId: DISPATCH_ID,
      errorCode: "enqueue_failed",
    });
    expect(JSON.stringify(preclaim.execute.mock.calls))
      .toContain("record_catalog_import_preclaim_failure_v1");

    const lease = transaction([
      { rows: [{ result: {
        status: "retry_wait",
        importId: IMPORT_ID,
        leaseGeneration: LEASE_GENERATION,
        failureCount: 2,
        errorCode: "lease_lost",
        nextAttemptAt: DATABASE_TIME,
        dispatchRequired: true,
        replayed: false,
      } }] },
      dispatchGate("import"),
      { rows: [{}] },
    ]);
    await finalizeCatalogImportFailure(lease.tx, {
      ...leaseKey(),
      errorCode: "lease_lost",
    });
    expect(JSON.stringify(lease.execute.mock.calls))
      .toContain("finalize_catalog_import_failure_v1");
  });

  it("entscheidet einen Claim-Enqueuefehler nach Rollback DB-autoritativ", async () => {
    const harness = transaction([
      { rows: [{ result: {
        status: "retry_wait",
        importId: IMPORT_ID,
        leaseGeneration: LEASE_GENERATION,
        failureCount: 1,
        errorCode: "enqueue_failed",
        nextAttemptAt: DATABASE_TIME,
        dispatchRequired: true,
        replayed: false,
      } }] },
      dispatchGate("import"),
      { rows: [{}] },
    ]);
    await expect(recordCatalogImportDispatchFailure(harness.tx, {
      workspaceId: WORKSPACE_ID,
      importId: IMPORT_ID,
      dispatchId: DISPATCH_ID,
      errorCode: "enqueue_failed",
    })).resolves.toMatchObject({
      status: "retry_wait",
      leaseGeneration: LEASE_GENERATION,
    });
    const calls = JSON.stringify(harness.execute.mock.calls);
    expect(calls).toContain("record_catalog_import_dispatch_failure_v1");
    expect(calls).toContain("enqueue_catalog_import_v1");
  });

  it("verwendet bei Recovery exakt die DB-generierten Dispatch-IDs", async () => {
    const otherImportId = "66666666-6666-4666-8666-666666666666";
    const cleanupDispatchId = "77777777-7777-4777-8777-777777777777";
    const harness = transaction([
      { rows: [
        {
          import_id: IMPORT_ID,
          recovery_action: "dispatch_required",
          dispatch_id: NEXT_DISPATCH_ID,
        },
        {
          import_id: otherImportId,
          recovery_action: "cleanup_required",
          dispatch_id: cleanupDispatchId,
        },
      ] },
      dispatchGate("import"),
      { rows: [{}] },
      dispatchGate("cleanup"),
      { rows: [{}] },
    ]);
    await expect(recoverDueCatalogImports(harness.tx, {
      workspaceId: WORKSPACE_ID,
      limit: 25,
    })).resolves.toHaveLength(2);
    const sqlCalls = JSON.stringify(harness.execute.mock.calls);
    expect(sqlCalls).toContain(NEXT_DISPATCH_ID);
    expect(sqlCalls).toContain(cleanupDispatchId);
    expect(sqlCalls).toContain("recover_catalog_imports_v1");
  });

  it("weist widersprüchliche Failure- und Batch-Envelopes geschlossen ab", async () => {
    const invalidFailure = transaction([{ rows: [{ result: {
      status: "retry_wait",
      importId: IMPORT_ID,
      leaseGeneration: LEASE_GENERATION,
      failureCount: 3,
      errorCode: "enqueue_failed",
      nextAttemptAt: DATABASE_TIME,
      dispatchRequired: true,
      replayed: false,
    } }] }]);
    await expect(finalizeCatalogImportFailure(invalidFailure.tx, {
      ...leaseKey(),
      errorCode: "enqueue_failed",
    })).rejects.toMatchObject({ code: "invalid_input" });

    const invalidBatch = transaction([{ rows: [{ result: {
      status: "succeeded",
      importId: IMPORT_ID,
      leaseGeneration: LEASE_GENERATION,
      resultCount: 2,
      successCount: 1,
      conflictCount: 0,
      errorCode: null,
      nextAttemptAt: null,
      dispatchRequired: false,
      replayed: false,
    } }] }]);
    await expect(completeCatalogImportBatch(invalidBatch.tx, leaseKey()))
      .rejects.toMatchObject({ code: "invalid_input" });
  });
});
