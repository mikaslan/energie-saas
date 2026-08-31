import { readFileSync } from "node:fs";
import { PgDialect, getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  catalogImportDispatchReceipt,
  catalogImportJob,
  catalogImportRow,
  catalogImportRowResult,
  type CatalogImportJobState,
  type CatalogImportOperation,
  type CatalogImportResultState,
  type CatalogImportRowValidationStatus,
} from "@/lib/db/schema";
import {
  CATALOG_IMPORT_RIGHTS_ATTESTATION_SHA256,
} from "@/lib/integrations/catalog/import-contract";
import { describe, expect, expectTypeOf, it } from "vitest";

const dialect = new PgDialect();
const tenantTables = [catalogImportJob, catalogImportRow, catalogImportRowResult] as const;

function checkSql(table: PgTable, name: string): string {
  const item = getTableConfig(table).checks.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`Check ${name} fehlt.`);
  return dialect.sqlToQuery(item.value).sql.replaceAll('"', "");
}

function normalizedCheckSql(value: string): string {
  return value.replaceAll('"', "").replace(/\s+/gu, " ").trim();
}

function foreignKeyColumns(
  table: PgTable,
  name: string,
): { local: string[]; foreignTable: string; foreign: string[] } {
  const item = getTableConfig(table).foreignKeys.find(
    (candidate) => candidate.getName() === name,
  );
  if (!item) throw new Error(`Foreign Key ${name} fehlt.`);
  const reference = item.reference();
  return {
    local: reference.columns.map((column) => column.name),
    foreignTable: getTableConfig(reference.foreignTable).name,
    foreign: reference.foreignColumns.map((column) => column.name),
  };
}

describe("M1-08b declarative catalog-import schema", () => {
  it("deklariert exakt vier tenantgebundene Importrelationen ohne Rohdatei", () => {
    expect([
      ...tenantTables,
      catalogImportDispatchReceipt,
    ].map((table) => getTableConfig(table).name)).toEqual([
      "catalog_import_job",
      "catalog_import_row",
      "catalog_import_row_result",
      "catalog_import_dispatch_receipt",
    ]);
    for (const table of tenantTables) {
      const config = getTableConfig(table);
      expect(config.columns.map((column) => column.name)).toEqual(
        expect.arrayContaining(["id", "workspace_id"]),
      );
      expect(config.foreignKeys.map((key) => key.getName())).toContain(
        `${config.name}_workspace_id_fk`,
      );
      expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
        `${config.name}_ws_id_uq`,
      );
    }
    expect(Object.keys(catalogImportJob)).not.toEqual(expect.arrayContaining([
      "fileBytes",
      "rawFile",
      "rawCsv",
    ]));
    expect(Object.keys(catalogImportRow)).not.toEqual(expect.arrayContaining([
      "rawRow",
      "sourceCells",
    ]));
  });

  it("pinnt Dispatch-Receipt und den generierten 0036-Snapshot vollständig", () => {
    const config = getTableConfig(catalogImportDispatchReceipt);
    expect(config.columns.map((column) => column.name)).toEqual([
      "dispatch_id",
      "workspace_id",
      "job_id",
      "receipt_kind",
      "lease_generation",
      "cause_code",
      "outcome_state",
      "outcome_failure_count",
      "outcome_error_code",
      "outcome_next_attempt_at",
      "recorded_at",
    ]);
    expect(foreignKeyColumns(
      catalogImportDispatchReceipt,
      "catalog_import_dispatch_receipt_job_fk",
    )).toEqual({
      local: ["workspace_id", "job_id"],
      foreignTable: "catalog_import_job",
      foreign: ["workspace_id", "id"],
    });
    const jobForeignKey = config.foreignKeys.find(
      (candidate) => candidate.getName() === "catalog_import_dispatch_receipt_job_fk",
    );
    expect(jobForeignKey?.onDelete).toBe("cascade");
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "catalog_import_dispatch_receipt_ws_job_dispatch_uq",
    );
    expect(config.indexes.map((index) => ({
      name: index.config.name,
      columns: index.config.columns.map((column) =>
        "name" in column && typeof column.name === "string" ? column.name : null
      ),
    }))).toContainEqual({
      name: "catalog_import_dispatch_receipt_ws_job_idx",
      columns: ["workspace_id", "job_id", "recorded_at", "dispatch_id"],
    });
    expect(checkSql(
      catalogImportDispatchReceipt,
      "catalog_import_dispatch_receipt_shape_ck",
    )).toMatch(
      /preclaim_failure[\s\S]*lease_failure[\s\S]*claim_terminal[\s\S]*batch_complete[\s\S]*is true/u,
    );

    const snapshot = JSON.parse(
      readFileSync("drizzle/meta/0036_snapshot.json", "utf8"),
    ) as {
      prevId?: unknown;
      tables?: Record<string, {
        checkConstraints?: Record<string, { value?: string }>;
        foreignKeys?: Record<string, { onDelete?: unknown }>;
      }>;
    };
    expect(snapshot.prevId).toBe("2782e308-404e-48cb-b38f-b263a380e073");
    const dispatchSnapshot = snapshot.tables?.["public.catalog_import_dispatch_receipt"];
    const dispatchCheck = dispatchSnapshot?.checkConstraints
      ?.catalog_import_dispatch_receipt_shape_ck?.value;
    expect(typeof dispatchCheck).toBe("string");
    expect(normalizedCheckSql(dispatchCheck ?? "")).toBe(normalizedCheckSql(
      checkSql(
        catalogImportDispatchReceipt,
        "catalog_import_dispatch_receipt_shape_ck",
      ),
    ));
    expect(dispatchSnapshot?.foreignKeys?.catalog_import_dispatch_receipt_job_fk)
      .toMatchObject({ onDelete: "cascade" });
    const fileCheck = snapshot.tables?.["public.catalog_import_job"]
      ?.checkConstraints?.catalog_import_job_file_ck;
    expect(JSON.stringify(fileCheck)).toContain("chr(8297)");
  });

  it("pinnt Intent, Attestation, unbeschränkte Leasegeneration und 25er-Bindung", () => {
    expect(Object.keys(catalogImportJob)).toEqual(expect.arrayContaining([
      "intentId",
      "reservationKey",
      "mappingSnapshot",
      "mappingSha256",
      "executionActorId",
      "attestationVersion",
      "attestationTextSha256",
      "attestedBy",
      "attestedAt",
      "leaseGeneration",
      "leaseToken",
      "leaseRowNumbers",
      "consecutiveFailureCount",
      "previewExpiresAt",
      "snapshotCleanupDueAt",
      "snapshotRedactedAt",
    ]));
    expect(checkSql(catalogImportJob, "catalog_import_job_state_ck")).toMatch(
      /ready_for_review[\s\S]*queued[\s\S]*running[\s\S]*retry_wait[\s\S]*succeeded[\s\S]*partial[\s\S]*failed_final[\s\S]*cancelled_before_start/u,
    );
    const leaseCheck = checkSql(catalogImportJob, "catalog_import_job_lease_ck");
    expect(leaseCheck).toMatch(/lease_generation >= 0/u);
    expect(leaseCheck).toMatch(
      /lease_row_numbers is not null[\s\S]*cardinality\(catalog_import_job\.lease_row_numbers\) between 1 and 25[\s\S]*array_position\(catalog_import_job\.lease_row_numbers, null\) is null/u,
    );
    expect(leaseCheck).toMatch(
      /state <> 'running'[\s\S]*lease_token is null[\s\S]*lease_expires_at is null[\s\S]*lease_row_numbers is null/u,
    );
    expect(leaseCheck).toMatch(/consecutive_failure_count between 0 and 3/u);
    expect(checkSql(catalogImportJob, "catalog_import_job_attestation_ck")).toMatch(
      /execution_actor_id is not null[\s\S]*attestation_version is not null[\s\S]*catalog-import-rights-attestation\.v1[\s\S]*attestation_text_sha256 is not null[\s\S]*attested_at is not null/u,
    );
    expect(checkSql(catalogImportJob, "catalog_import_job_attestation_ck"))
      .toContain(CATALOG_IMPORT_RIGHTS_ATTESTATION_SHA256);
    expect(checkSql(catalogImportJob, "catalog_import_job_count_ck")).toMatch(
      /total_count = catalog_import_job\.valid_count \+ catalog_import_job\.invalid_count[\s\S]*total_count between 1 and 1000/u,
    );
    expect(checkSql(catalogImportJob, "catalog_import_job_terminal_ck")).toMatch(
      /preview_expires_at = catalog_import_job\.created_at \+ interval '7 days'[\s\S]*snapshot_cleanup_due_at is not null[\s\S]*greatest\([\s\S]*created_at \+ interval '30 days'[\s\S]*terminal_at/u,
    );
    expect(checkSql(catalogImportJob, "catalog_import_job_redaction_ck")).toMatch(
      /file_name is null[\s\S]*mapping_snapshot is null[\s\S]*mapping_body_canonical is null[\s\S]*sensitive_payload_bytes = 0/u,
    );
    const jobHashCheck = checkSql(catalogImportJob, "catalog_import_job_hash_ck");
    expect(jobHashCheck).toMatch(
      /mapping_body_canonical\) between 2 and 32768[\s\S]*pg_catalog\.sha256\(catalog_import_job\.mapping_body_canonical\) = catalog_import_job\.mapping_sha256[\s\S]*pg_catalog\.convert_from\([\s\S]*catalog_import_job\.mapping_body_canonical,[\s\S]*'UTF8'[\s\S]*\)::jsonb = catalog_import_job\.mapping_snapshot[\s\S]*is true/u,
    );
    expect(jobHashCheck).toMatch(
      /is true\)\)[\s\S]*attestation_text_sha256 is null[\s\S]*octet_length\(catalog_import_job\.attestation_text_sha256\) = 32/u,
    );
    const executionShape = checkSql(catalogImportJob, "catalog_import_job_execution_shape_ck");
    expect(executionShape).toMatch(
      /state = 'queued'[\s\S]*consecutive_failure_count = 0[\s\S]*state = 'running'[\s\S]*consecutive_failure_count between 0 and 2/u,
    );
    expect(executionShape).toMatch(
      /state = 'retry_wait'[\s\S]*error_code is not null[\s\S]*error_code in \('lease_lost', 'enqueue_failed', 'queue_locator_invalid'\)[\s\S]*consecutive_failure_count between 1 and 2/u,
    );
    expect(executionShape).toMatch(
      /state in \('succeeded', 'partial', 'cancelled_before_start'\)[\s\S]*consecutive_failure_count = 0/u,
    );
    expect(executionShape).toMatch(
      /state = 'failed_final'[\s\S]*error_code is not null[\s\S]*error_code = 'technical_retry_exhausted'[\s\S]*consecutive_failure_count = 3[\s\S]*invalid_persisted_input[\s\S]*all_rows_conflicted[\s\S]*consecutive_failure_count = 0/u,
    );
    expect(catalogImportJob.fileName.notNull).toBe(false);

    type CatalogImportJobRecord = typeof catalogImportJob.$inferSelect;
    expectTypeOf<CatalogImportJobRecord["leaseGeneration"]>().toEqualTypeOf<bigint>();
    expectTypeOf<CatalogImportJobState>().toEqualTypeOf<
      "ready_for_review" | "queued" | "running" | "retry_wait" |
      "succeeded" | "partial" | "failed_final" | "cancelled_before_start"
    >();
  });

  it("referenziert Import-Actor als historische globale Identität", () => {
    for (const [name, column] of [
      ["catalog_import_job_created_by_fk", "created_by"],
      ["catalog_import_job_execution_actor_id_fk", "execution_actor_id"],
      ["catalog_import_job_attested_by_fk", "attested_by"],
    ] as const) {
      expect(foreignKeyColumns(catalogImportJob, name)).toEqual({
        local: [column],
        foreignTable: "user_identity",
        foreign: ["id"],
      });
    }
    expect(getTableConfig(catalogImportJob).foreignKeys.map((key) => key.getName()))
      .not.toContain("catalog_import_job_created_by_membership_fk");
  });

  it("bindet Row, Zielartefakt und atomare Vollredaction geschlossen", () => {
    expect(foreignKeyColumns(catalogImportRow, "catalog_import_row_job_fk")).toEqual({
      local: ["workspace_id", "job_id"],
      foreignTable: "catalog_import_job",
      foreign: ["workspace_id", "id"],
    });
    expect(Object.keys(catalogImportRow)).toEqual(expect.arrayContaining([
      "rowNumber",
      "validationStatus",
      "normalizedSku",
      "operation",
      "commandSnapshot",
      "previewRowBodyCanonical",
      "sourceCommandBodyCanonical",
      "rowCommandBodyCanonical",
      "sourceCommandSha256",
      "rowCommandSha256",
      "sealedTargetSnapshot",
      "sealedTargetBodyCanonical",
      "targetSnapshotSha256",
      "expectedComponentId",
      "expectedRevision",
      "expectedStatus",
      "expectedSnapshotSha256",
      "snapshotRedactedAt",
    ]));
    expect(checkSql(catalogImportRow, "catalog_import_row_shape_ck")).toMatch(
      /validation_status = 'valid'[\s\S]*command_snapshot is not null[\s\S]*sealed_target_body_canonical[\s\S]*validation_status = 'invalid'[\s\S]*error_snapshot is not null/u,
    );
    const rowHashCheck = checkSql(catalogImportRow, "catalog_import_row_hash_ck");
    expect(rowHashCheck).toMatch(
      /preview_row_body_canonical\) between 2 and 131072[\s\S]*pg_catalog\.sha256\(catalog_import_row\.preview_row_body_canonical\)\s*=\s*catalog_import_row\.row_sha256[\s\S]*source_command_body_canonical\) between 2 and 65536[\s\S]*pg_catalog\.sha256\(catalog_import_row\.source_command_body_canonical\)\s*=\s*catalog_import_row\.source_command_sha256[\s\S]*sourceCommand[\s\S]*row_command_body_canonical\) between 2 and 262144[\s\S]*pg_catalog\.sha256\(catalog_import_row\.row_command_body_canonical\)\s*=\s*catalog_import_row\.row_command_sha256[\s\S]*rowCommandSha256[\s\S]*sealed_target_body_canonical\) between 2 and 65536[\s\S]*pg_catalog\.sha256\(catalog_import_row\.sealed_target_body_canonical\)\s*=\s*catalog_import_row\.target_snapshot_sha256[\s\S]*snapshotSha256[\s\S]*is true/u,
    );
    expect(rowHashCheck.match(/\) is true\)\)/gu)).toHaveLength(4);
    expect(checkSql(catalogImportRow, "catalog_import_row_command_binding_ck")).toMatch(
      /schemaVersion[\s\S]*operation[\s\S]*targetComponentId[\s\S]*source,rowNumber[\s\S]*source,rowSha256[\s\S]*source,sourceCommandSha256[\s\S]*rowCommandSha256[\s\S]*expected,componentId[\s\S]*expected,revision[\s\S]*expected,status[\s\S]*sealedTarget,snapshot[\s\S]*is true/u,
    );
    expect(checkSql(catalogImportRow, "catalog_import_row_redaction_ck")).toMatch(
      /normalized_sku is null[\s\S]*preview_row_body_canonical is null[\s\S]*source_command_body_canonical is null[\s\S]*row_command_body_canonical is null[\s\S]*sensitive_payload_bytes = 0[\s\S]*jsonb_path_exists[\s\S]*sourceHeader/u,
    );
    expect(checkSql(catalogImportRow, "catalog_import_row_operation_ck")).toMatch(
      /operation = 'revise'[\s\S]*expected_component_id is not null[\s\S]*expected_status is not null[\s\S]*operation = 'unchanged'[\s\S]*target_snapshot_sha256 is not null/u,
    );
    expect(foreignKeyColumns(
      catalogImportRow,
      "catalog_import_row_expected_revision_fk",
    )).toEqual({
      local: [
        "workspace_id",
        "expected_component_id",
        "expected_revision",
        "expected_snapshot_sha256",
      ],
      foreignTable: "catalog_component_revision",
      foreign: ["workspace_id", "component_id", "revision", "snapshot_sha256"],
    });
    expectTypeOf<CatalogImportRowValidationStatus>().toEqualTypeOf<"valid" | "invalid">();
    expectTypeOf<CatalogImportOperation>().toEqualTypeOf<"create" | "revise" | "unchanged">();
    type CatalogImportRowRecord = typeof catalogImportRow.$inferSelect;
    expectTypeOf<CatalogImportRowRecord["expectedStatus"]>()
      .toEqualTypeOf<"draft" | "active" | null>();
  });

  it("bindet jedes Ergebnis exakt an Jobzeile und erfolgreiche Katalogrevision", () => {
    expect(foreignKeyColumns(
      catalogImportRowResult,
      "catalog_import_row_result_row_fk",
    )).toEqual({
      local: ["workspace_id", "job_id", "row_number"],
      foreignTable: "catalog_import_row",
      foreign: ["workspace_id", "job_id", "row_number"],
    });
    expect(foreignKeyColumns(
      catalogImportRowResult,
      "catalog_import_row_result_revision_fk",
    )).toEqual({
      local: ["workspace_id", "component_id", "revision", "snapshot_sha256"],
      foreignTable: "catalog_component_revision",
      foreign: ["workspace_id", "component_id", "revision", "snapshot_sha256"],
    });
    expect(checkSql(catalogImportRowResult, "catalog_import_row_result_shape_ck"))
      .toMatch(/created[\s\S]*revised[\s\S]*unchanged[\s\S]*component_id is not null[\s\S]*revision is not null[\s\S]*result_state = 'conflict'[\s\S]*error_code is not null/u);
    expect(checkSql(catalogImportRowResult, "catalog_import_row_result_state_ck"))
      .not.toContain("failed");
    expectTypeOf<CatalogImportResultState>().toEqualTypeOf<
      "created" | "revised" | "unchanged" | "conflict"
    >();
  });

  it("deklariert aktive Einmaligkeit, gültige SKU und Cleanup-Due-Indizes", () => {
    const jobIndexes = getTableConfig(catalogImportJob).indexes.map((item) => item.config.name);
    expect(jobIndexes).toEqual(expect.arrayContaining([
      "catalog_import_job_ws_active_uq",
      "catalog_import_job_recovery_idx",
      "catalog_import_job_cleanup_idx",
      "catalog_import_job_preview_expiry_idx",
      "catalog_import_job_ready_actor_quota_idx",
      "catalog_import_job_unredacted_budget_idx",
      "catalog_import_job_latest_idx",
    ]));
    const rowIndexes = getTableConfig(catalogImportRow).indexes.map((item) => item.config.name);
    expect(rowIndexes).toContain("catalog_import_row_ws_job_valid_sku_uq");
  });
});
