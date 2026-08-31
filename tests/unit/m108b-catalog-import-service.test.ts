import { describe, expect, it, vi } from "vitest";

import type { TenantTx } from "@/lib/db/types";
import {
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  sealCatalogComponentRevision,
} from "@/lib/integrations/catalog/contract";
import {
  CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
  autoMapCatalogCsvHeaders,
  catalogCsvTemplate,
  inspectCatalogCsvFile,
  parseCatalogCsvPreview,
} from "@/lib/integrations/catalog/import-contract";
import type { ServiceCtx } from "@/lib/permissions";
import {
  cancelCatalogImport,
  getCatalogImport,
  getCatalogImportErrorReport,
  getLatestCatalogImport,
  listCatalogImportRows,
  prepareCatalogImport,
  startCatalogImport,
} from "@/modules/catalog/import-service";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const INTENT_ID = "33333333-3333-4333-8333-333333333333";
const IMPORT_ID = "44444444-4444-4444-8444-444444444444";
const COMPONENT_ID = "55555555-5555-4555-8555-555555555555";
const DATABASE_TIME = "2026-08-31T12:00:00.000Z";

function preview() {
  const bytes = new TextEncoder().encode(catalogCsvTemplate());
  const inspection = inspectCatalogCsvFile({ filename: "produkte.csv", bytes });
  return parseCatalogCsvPreview({
    filename: "produkte.csv",
    bytes,
    mapping: autoMapCatalogCsvHeaders(inspection.headers),
  });
}

function context(overrides: Partial<ServiceCtx> = {}): ServiceCtx {
  return {
    workspaceId: WORKSPACE_ID,
    actor: ACTOR_ID,
    role: "editor",
    capabilities: {
      manage_catalog: true,
      edit_prices: true,
      see_purchase_prices: true,
    },
    featureFlags: {},
    ...overrides,
  };
}

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
      current_role: "app_runtime",
      session_role: "app_runtime",
      database_name: "energie_saas",
    }],
  };
}

function currentCatalogRow(status: "draft" | "active" | "archived") {
  const sourceRow = preview().rows[0];
  if (sourceRow?.status !== "valid") throw new Error("fixture must be valid");
  const snapshot = sealCatalogComponentRevision({
    schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    identity: {
      workspaceId: WORKSPACE_ID,
      componentId: COMPONENT_ID,
      revision: 3,
      internalSku: sourceRow.command.internalSku,
      componentType: sourceRow.command.componentType,
    },
    presentation: sourceRow.command.presentation,
    technicalData: sourceRow.command.technicalData,
    commercial: sourceRow.command.commercial,
    technicalProvenance: sourceRow.command.technicalProvenance,
  });
  return {
    id: COMPONENT_ID,
    workspace_id: WORKSPACE_ID,
    internal_sku: sourceRow.command.internalSku,
    component_type: sourceRow.command.componentType,
    status,
    current_revision: 3,
    revision_snapshot: snapshot,
    snapshot_sha256_hex: snapshot.snapshotSha256,
  };
}

function catalogImportJobRow(overrides: Record<string, unknown> = {}) {
  const parsedPreview = preview();
  return {
    import_id: IMPORT_ID,
    intent_id: INTENT_ID,
    file_name: parsedPreview.file.filename,
    file_size_bytes: parsedPreview.file.sizeBytes,
    encoding: parsedPreview.file.encoding,
    delimiter: parsedPreview.file.delimiter,
    mapping_snapshot: parsedPreview.mapping,
    total_count: 1,
    valid_count: 1,
    invalid_count: 0,
    state: "ready_for_review",
    consecutive_failure_count: 0,
    next_attempt_at: null,
    error_code: null,
    created_by: ACTOR_ID,
    execution_actor_id: null,
    attested_by: null,
    attested_at: null,
    created_at: DATABASE_TIME,
    preview_expires_at: DATABASE_TIME,
    started_at: null,
    terminal_at: null,
    snapshot_cleanup_due_at: null,
    snapshot_redacted_at: null,
    created_result_count: 0,
    revised_result_count: 0,
    unchanged_result_count: 0,
    conflict_result_count: 0,
    ...overrides,
  };
}

function validCatalogImportRow(overrides: Record<string, unknown> = {}) {
  const sourceRow = preview().rows[0];
  if (sourceRow?.status !== "valid") throw new Error("fixture must be valid");
  return {
    row_number: 2,
    validation_status: "valid",
    normalized_sku: sourceRow.normalizedSku,
    operation: "create",
    source_command: sourceRow.command,
    error_snapshot: null,
    target_component_id: COMPONENT_ID,
    expected_component_id: null,
    expected_revision: null,
    expected_status: null,
    result_state: "created",
    result_component_id: COMPONENT_ID,
    result_revision: 1,
    result_error_code: null,
    result_created_at: DATABASE_TIME,
    ...overrides,
  };
}

function invalidCatalogImportRow(overrides: Record<string, unknown> = {}) {
  return {
    row_number: 3,
    validation_status: "invalid",
    normalized_sku: null,
    operation: null,
    source_command: null,
    error_snapshot: [{
      field: "purchasePriceNet",
      sourceHeader: "Einkaufspreis netto",
      code: "invalid_money",
      message: "Der Nettopreis ist nicht eindeutig lesbar.",
    }],
    target_component_id: null,
    expected_component_id: null,
    expected_revision: null,
    expected_status: null,
    result_state: null,
    result_component_id: null,
    result_revision: null,
    result_error_code: null,
    result_created_at: null,
    ...overrides,
  };
}

describe("M108B-SERVICE-01 catalog import runtime boundary", () => {
  it("authorisiert alle drei Rechte und External vor dem ersten SQL-Zugriff", async () => {
    const denied = [
      context({ role: "viewer" }),
      context({ capabilities: { manage_catalog: true, see_purchase_prices: true } }),
      context({ capabilities: { manage_catalog: true, edit_prices: true } }),
      context({ capabilities: {
        manage_catalog: true,
        edit_prices: true,
        see_purchase_prices: true,
        external_only: true,
      } }),
    ];
    for (const ctx of denied) {
      const harness = transaction([]);
      await expect(prepareCatalogImport(harness.tx, ctx, {
        intentId: INTENT_ID,
        preview: preview(),
      })).rejects.toMatchObject({ name: "PermissionDeniedError" });
      expect(harness.execute).not.toHaveBeenCalled();
    }
  });

  it("versiegelt einen neuen Produktentwurf und koppelt den Preview-Cleanup atomar", async () => {
    const harness = transaction([
      { rows: [] },
      { rows: [{ result: {
        status: "ready_for_review",
        importId: IMPORT_ID,
        intentId: INTENT_ID,
        totalCount: 1,
        validCount: 1,
        invalidCount: 0,
        previewExpiresAt: DATABASE_TIME,
        replayed: false,
      } }] },
      dispatchGate("cleanup"),
      { rows: [{}] },
    ]);

    await expect(prepareCatalogImport(harness.tx, context(), {
      intentId: INTENT_ID,
      preview: preview(),
    })).resolves.toMatchObject({
      status: "ready_for_review",
      importId: IMPORT_ID,
      replayed: false,
    });

    expect(harness.execute).toHaveBeenCalledTimes(4);
    const sqlCalls = JSON.stringify(harness.execute.mock.calls);
    expect(sqlCalls).toContain("prepare_catalog_import_v1");
    expect(sqlCalls).toContain("catalog-import-row-command.v1");
    expect(sqlCalls).toContain("create");
    expect(sqlCalls).toContain("enqueue_catalog_import_cleanup_v1");
    expect(sqlCalls).not.toContain("enqueue_catalog_import_v1(uuid,uuid,uuid)");
  });

  it("versiegelt identische bestehende Nutzdaten als unchanged ohne Zielbody", async () => {
    const harness = transaction([
      { rows: [currentCatalogRow("active")] },
      { rows: [{ result: {
        status: "ready_for_review",
        importId: IMPORT_ID,
        intentId: INTENT_ID,
        totalCount: 1,
        validCount: 1,
        invalidCount: 0,
        previewExpiresAt: DATABASE_TIME,
        replayed: false,
      } }] },
      dispatchGate("cleanup"),
      { rows: [{}] },
    ]);
    await prepareCatalogImport(harness.tx, context(), {
      intentId: INTENT_ID,
      preview: preview(),
    });
    const sqlCalls = JSON.stringify(harness.execute.mock.calls);
    const sourceRow = preview().rows[0];
    if (sourceRow?.status !== "valid") throw new Error("fixture must be valid");
    expect(JSON.stringify(harness.execute.mock.calls[0]))
      .toContain(sourceRow.normalizedSku.toLocaleLowerCase("en-US"));
    expect(sqlCalls).toContain("unchanged");
    expect(sqlCalls).toContain(COMPONENT_ID);
    expect(sqlCalls).toContain("snapshotSha256");
    expect(sqlCalls).toContain("sealedTarget");
  });

  it("minimiert einen Archivkonflikt vor Persistenz und entfernt Preis-/Provenienzwerte", async () => {
    const harness = transaction([
      { rows: [currentCatalogRow("archived")] },
      { rows: [{ result: {
        status: "ready_for_review",
        importId: IMPORT_ID,
        intentId: INTENT_ID,
        totalCount: 1,
        validCount: 0,
        invalidCount: 1,
        previewExpiresAt: DATABASE_TIME,
        replayed: false,
      } }] },
      dispatchGate("cleanup"),
      { rows: [{}] },
    ]);
    await prepareCatalogImport(harness.tx, context(), {
      intentId: INTENT_ID,
      preview: preview(),
    });
    const prepareCall = JSON.stringify(harness.execute.mock.calls[1]);
    expect(prepareCall).toContain("archived_requires_manual_reactivation");
    expect(prepareCall).not.toContain("purchasePriceNetCents");
    expect(prepareCall).not.toContain("Eigene autorisierte Preisliste");
    expect(prepareCall).not.toContain("technicalProvenance");
  });

  it("koppelt Start und Abbruch an die jeweils ID-only Queue", async () => {
    const started = transaction([
      { rows: [{ result: {
        status: "queued",
        importId: IMPORT_ID,
        replayed: false,
        dispatchRequired: true,
        nextAttemptAt: DATABASE_TIME,
      } }] },
      dispatchGate("import"),
      { rows: [{}] },
    ]);
    await expect(startCatalogImport(started.tx, context(), {
      importId: IMPORT_ID,
      attestationVersion: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
    })).resolves.toMatchObject({ status: "queued", importId: IMPORT_ID });
    expect(JSON.stringify(started.execute.mock.calls))
      .toContain("enqueue_catalog_import_v1");

    const cancelled = transaction([
      { rows: [{ result: {
        status: "cancelled_before_start",
        importId: IMPORT_ID,
        replayed: false,
        cleanupDispatchAt: DATABASE_TIME,
      } }] },
      dispatchGate("cleanup"),
      { rows: [{}] },
    ]);
    await expect(cancelCatalogImport(cancelled.tx, context(), {
      importId: IMPORT_ID,
    })).resolves.toMatchObject({ status: "cancelled_before_start" });
    expect(JSON.stringify(cancelled.execute.mock.calls))
      .toContain("enqueue_catalog_import_cleanup_v1");
  });

  it("akzeptiert weder offene Attestationsversionen noch still fehlende Produktionsqueues", async () => {
    const invalid = transaction([]);
    await expect(startCatalogImport(invalid.tx, context(), {
      importId: IMPORT_ID,
      attestationVersion: "catalog-import-rights-attestation.v2",
    })).rejects.toMatchObject({ name: "CatalogImportInputError" });
    expect(invalid.execute).not.toHaveBeenCalled();

    const missing = transaction([
      { rows: [{ result: {
        status: "queued",
        importId: IMPORT_ID,
        replayed: false,
        dispatchRequired: true,
        nextAttemptAt: DATABASE_TIME,
      } }] },
      { rows: [{
        dispatch_signature: null,
        current_role: "app_runtime",
        session_role: "app_runtime",
        database_name: "energie_saas",
      }] },
    ]);
    await expect(startCatalogImport(missing.tx, context(), {
      importId: IMPORT_ID,
      attestationVersion: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
    })).rejects.toMatchObject({ name: "CatalogImportDispatchError" });
  });

  it("behandelt idempotente Replays ohne erneuten terminalen Cleanup-Dispatch", async () => {
    const startedReplay = transaction([{ rows: [{ result: {
      status: "replayed",
      state: "succeeded",
      importId: IMPORT_ID,
      dispatchRequired: false,
    } }] }]);
    await expect(startCatalogImport(startedReplay.tx, context(), {
      importId: IMPORT_ID,
      attestationVersion: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
    })).resolves.toMatchObject({ status: "replayed", state: "succeeded" });
    expect(startedReplay.execute).toHaveBeenCalledTimes(1);

    const cancelledReplay = transaction([{ rows: [{ result: {
      status: "cancelled_before_start",
      importId: IMPORT_ID,
      replayed: true,
      cleanupDispatchAt: DATABASE_TIME,
    } }] }]);
    await expect(cancelCatalogImport(cancelledReplay.tx, context(), {
      importId: IMPORT_ID,
    })).resolves.toMatchObject({ replayed: true });
    expect(cancelledReplay.execute).toHaveBeenCalledTimes(1);

    const preparedReplay = transaction([
      { rows: [] },
      { rows: [{ result: {
        status: "ready_for_review",
        importId: IMPORT_ID,
        intentId: INTENT_ID,
        totalCount: 1,
        validCount: 1,
        invalidCount: 0,
        previewExpiresAt: DATABASE_TIME,
        replayed: true,
      } }] },
    ]);
    await expect(prepareCatalogImport(preparedReplay.tx, context(), {
      intentId: INTENT_ID,
      preview: preview(),
    })).resolves.toMatchObject({ replayed: true });
    expect(preparedReplay.execute).toHaveBeenCalledTimes(2);
  });

  it("akzeptiert den geschlossenen Persistenzkonflikt und bindet Result-IDs", async () => {
    const invalidPersisted = transaction([{ rows: [{ result: {
      status: "conflict",
      code: "invalid_persisted_input",
    } }] }]);
    await expect(startCatalogImport(invalidPersisted.tx, context(), {
      importId: IMPORT_ID,
      attestationVersion: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
    })).resolves.toEqual({
      status: "conflict",
      code: "invalid_persisted_input",
    });

    const wrongId = transaction([{ rows: [{ result: {
      status: "queued",
      importId: "66666666-6666-4666-8666-666666666666",
      replayed: false,
      dispatchRequired: true,
      nextAttemptAt: DATABASE_TIME,
    } }] }]);
    await expect(startCatalogImport(wrongId.tx, context(), {
      importId: IMPORT_ID,
      attestationVersion: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
    })).rejects.toMatchObject({ name: "CatalogImportIntegrityError" });
    expect(wrongId.execute).toHaveBeenCalledTimes(1);

    const wrongIntent = transaction([
      { rows: [] },
      { rows: [{ result: {
        status: "ready_for_review",
        importId: IMPORT_ID,
        intentId: "77777777-7777-4777-8777-777777777777",
        totalCount: 1,
        validCount: 1,
        invalidCount: 0,
        previewExpiresAt: DATABASE_TIME,
        replayed: false,
      } }] },
    ]);
    await expect(prepareCatalogImport(wrongIntent.tx, context(), {
      intentId: INTENT_ID,
      preview: preview(),
    })).rejects.toMatchObject({ name: "CatalogImportIntegrityError" });
    expect(wrongIntent.execute).toHaveBeenCalledTimes(2);
  });

  it("bindet Prepare-Counts und Replay-Dispatch exakt an den DB-Vertrag", async () => {
    const countDrift = transaction([
      { rows: [] },
      { rows: [{ result: {
        status: "ready_for_review",
        importId: IMPORT_ID,
        intentId: INTENT_ID,
        totalCount: 2,
        validCount: 2,
        invalidCount: 0,
        previewExpiresAt: DATABASE_TIME,
        replayed: false,
      } }] },
    ]);
    await expect(prepareCatalogImport(countDrift.tx, context(), {
      intentId: INTENT_ID,
      preview: preview(),
    })).rejects.toMatchObject({ name: "CatalogImportIntegrityError" });

    const stateDrift = transaction([
      { rows: [] },
      { rows: [{ result: {
        status: "queued",
        importId: IMPORT_ID,
        intentId: INTENT_ID,
        totalCount: 1,
        validCount: 1,
        invalidCount: 0,
        previewExpiresAt: DATABASE_TIME,
        replayed: false,
      } }] },
    ]);
    await expect(prepareCatalogImport(stateDrift.tx, context(), {
      intentId: INTENT_ID,
      preview: preview(),
    })).rejects.toMatchObject({ name: "CatalogImportIntegrityError" });

    for (const [state, dispatchRequired] of [
      ["queued", false],
      ["succeeded", true],
    ] as const) {
      const replayDrift = transaction([{ rows: [{ result: {
        status: "replayed",
        state,
        importId: IMPORT_ID,
        dispatchRequired,
      } }] }]);
      await expect(startCatalogImport(replayDrift.tx, context(), {
        importId: IMPORT_ID,
        attestationVersion: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
      })).rejects.toMatchObject({ name: "CatalogImportIntegrityError" });
      expect(replayDrift.execute).toHaveBeenCalledTimes(1);
    }
  });

  it("übersetzt DB-Reautorisierungsentzug in eine Permission-Ablehnung", async () => {
    const execute = vi.fn(async () => {
      throw Object.assign(new Error("permission denied"), { code: "42501" });
    });
    const tx = { execute } as unknown as TenantTx;
    await expect(startCatalogImport(tx, context(), {
      importId: IMPORT_ID,
      attestationVersion: CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
    })).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "catalog.manage",
      reason: "database_reauthorization",
      actor: ACTOR_ID,
    });
  });

  it("liest den vollständigen Reviewzustand nur bei konsistentem Snapshot", async () => {
    const harness = transaction([{ rows: [catalogImportJobRow()] }]);
    const result = await getCatalogImport(harness.tx, context(), {
      importId: IMPORT_ID,
    });
    expect(result).toMatchObject({
      importId: IMPORT_ID,
      intentId: INTENT_ID,
      fileName: "produkte.csv",
      counts: { total: 1, valid: 1, invalid: 0 },
      state: "ready_for_review",
      resultCounts: { created: 0, revised: 0, unchanged: 0, conflict: 0 },
    });
    expect(result?.mapping).toEqual(preview().mapping);
    expect(JSON.stringify(harness.execute.mock.calls)).toContain("read_catalog_import_v1");
  });

  it("liest den letzten Import ausschließlich über das enge ID-Gateway", async () => {
    const harness = transaction([
      { rows: [{ latest_import_id: IMPORT_ID }] },
      { rows: [catalogImportJobRow()] },
    ]);
    await expect(getLatestCatalogImport(harness.tx, context())).resolves.toMatchObject({
      importId: IMPORT_ID,
      state: "ready_for_review",
    });
    const sqlCalls = JSON.stringify(harness.execute.mock.calls);
    expect(sqlCalls).toContain("read_latest_catalog_import_id_v1");
    expect(sqlCalls).toContain("read_catalog_import_v1");

    const empty = transaction([{ rows: [{ latest_import_id: null }] }]);
    await expect(getLatestCatalogImport(empty.tx, context())).resolves.toBeNull();
    expect(empty.execute).toHaveBeenCalledTimes(1);

    const malformed = transaction([{ rows: [{ latest_import_id: "not-a-uuid" }] }]);
    await expect(getLatestCatalogImport(malformed.tx, context()))
      .rejects.toMatchObject({ name: "CatalogImportIntegrityError" });

    const execute = vi.fn(async () => {
      throw Object.assign(new Error("permission denied"), { code: "42501" });
    });
    await expect(getLatestCatalogImport(
      { execute } as unknown as TenantTx,
      context(),
    )).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "catalog.manage",
      reason: "database_reauthorization",
    });
  });

  it("liefert nach Cleanup nur den explizit redigierten Jobzustand", async () => {
    const harness = transaction([{ rows: [catalogImportJobRow({
      file_name: null,
      mapping_snapshot: null,
      snapshot_redacted_at: DATABASE_TIME,
    })] }]);
    await expect(getCatalogImport(harness.tx, context(), {
      importId: IMPORT_ID,
    })).resolves.toMatchObject({
      fileName: null,
      mapping: null,
      snapshotRedactedAt: DATABASE_TIME,
    });
  });

  it("behält nach Cleanup feste Fehler im Report, aber entfernt die Quellspalte", async () => {
    const harness = transaction([
      { rows: [catalogImportJobRow({
        file_name: null,
        mapping_snapshot: null,
        total_count: 1,
        valid_count: 0,
        invalid_count: 1,
        snapshot_redacted_at: DATABASE_TIME,
      })] },
      { rows: [invalidCatalogImportRow({
        row_number: 2,
        error_snapshot: [{
          field: "purchasePriceNet",
          sourceHeader: null,
          code: "invalid_money",
          message: "Der Nettopreis ist nicht eindeutig lesbar.",
        }],
      })] },
    ]);

    const report = await getCatalogImportErrorReport(harness.tx, context(), {
      importId: IMPORT_ID,
    });

    expect(report).toContain("2;purchasePriceNet;;invalid_money;");
    expect(report).not.toContain("Einkaufspreis netto");
    expect(harness.execute).toHaveBeenCalledTimes(2);
  });

  it("liest gültige, ungültige und bereits verarbeitete Zeilen strikt paginiert", async () => {
    const harness = transaction([{ rows: [
      validCatalogImportRow(),
      invalidCatalogImportRow(),
    ] }]);
    const result = await listCatalogImportRows(harness.tx, context(), {
      importId: IMPORT_ID,
      afterRow: 1,
      limit: 2,
    });
    expect(result.nextAfterRow).toBe(3);
    expect(result.rows).toEqual([
      expect.objectContaining({
        rowNumber: 2,
        validationStatus: "valid",
        operation: "create",
        result: expect.objectContaining({
          state: "created",
          componentId: COMPONENT_ID,
          revision: 1,
        }),
      }),
      expect.objectContaining({
        rowNumber: 3,
        validationStatus: "invalid",
        sourceCommand: null,
        errors: [expect.objectContaining({ code: "invalid_money" })],
        result: null,
      }),
    ]);
  });

  it("akzeptiert eine redigierte valide Zeile nur ohne SKU und Quellcommand", async () => {
    const harness = transaction([{ rows: [validCatalogImportRow({
      normalized_sku: null,
      source_command: null,
    })] }]);
    await expect(listCatalogImportRows(harness.tx, context(), {
      importId: IMPORT_ID,
      afterRow: 1,
      limit: 10,
    })).resolves.toMatchObject({
      rows: [expect.objectContaining({
        normalizedSku: null,
        sourceCommand: null,
        targetComponentId: COMPONENT_ID,
      })],
      nextAfterRow: null,
    });
  });

  it("scheitert geschlossen bei Redaktions-, Command- und Ergebnisdrift", async () => {
    const redactionDrift = transaction([{ rows: [catalogImportJobRow({
      file_name: null,
    })] }]);
    await expect(getCatalogImport(redactionDrift.tx, context(), {
      importId: IMPORT_ID,
    })).rejects.toMatchObject({ name: "CatalogImportIntegrityError" });

    const sourceRow = preview().rows[0];
    if (sourceRow?.status !== "valid") throw new Error("fixture must be valid");
    const commandDrift = transaction([{ rows: [validCatalogImportRow({
      source_command: { ...sourceRow.command, unexpected: true },
    })] }]);
    await expect(listCatalogImportRows(commandDrift.tx, context(), {
      importId: IMPORT_ID,
      afterRow: 1,
      limit: 10,
    })).rejects.toMatchObject({ name: "CatalogImportIntegrityError" });

    const resultDrift = transaction([{ rows: [validCatalogImportRow({
      result_state: "conflict",
      result_component_id: COMPONENT_ID,
      result_revision: 1,
      result_error_code: "revision_drift",
    })] }]);
    await expect(listCatalogImportRows(resultDrift.tx, context(), {
      importId: IMPORT_ID,
      afterRow: 1,
      limit: 10,
    })).rejects.toMatchObject({ name: "CatalogImportIntegrityError" });

    const rowGap = transaction([{ rows: [validCatalogImportRow({
      row_number: 4,
    })] }]);
    await expect(listCatalogImportRows(rowGap.tx, context(), {
      importId: IMPORT_ID,
      afterRow: 1,
      limit: 10,
    })).rejects.toMatchObject({ name: "CatalogImportIntegrityError" });

    const semanticDrifts = [
      validCatalogImportRow({
        result_state: "unchanged",
      }),
      validCatalogImportRow({
        result_component_id: "88888888-8888-4888-8888-888888888888",
      }),
      validCatalogImportRow({
        result_revision: 2,
      }),
      invalidCatalogImportRow({
        result_state: "conflict",
        result_error_code: "revision_drift",
        result_created_at: DATABASE_TIME,
      }),
    ];
    for (const drift of semanticDrifts) {
      const harness = transaction([{ rows: [drift] }]);
      await expect(listCatalogImportRows(harness.tx, context(), {
        importId: IMPORT_ID,
        afterRow: 1,
        limit: 10,
      })).rejects.toMatchObject({ name: "CatalogImportIntegrityError" });
    }
  });
});
