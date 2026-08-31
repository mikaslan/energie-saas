import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CatalogComponentRevisionV1,
} from "@/lib/integrations/catalog/contract";
import type {
  CatalogCsvColumnMappingV1,
  CatalogCsvJobErrorCode,
  CatalogCsvProcessingResultCode,
  CatalogCsvRowErrorV1,
  CatalogImportRowCommandV1,
} from "@/lib/integrations/catalog/import-contract";
import { catalogComponentRevision } from "./catalog";
import { userIdentity, workspace } from "./core";
import { bytea } from "./types";

export type CatalogImportJobState =
  | "ready_for_review"
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "partial"
  | "failed_final"
  | "cancelled_before_start";

export type CatalogImportRowValidationStatus = "valid" | "invalid";
export type CatalogImportOperation = "create" | "revise" | "unchanged";
export type CatalogImportResultState =
  | "created"
  | "revised"
  | "unchanged"
  | "conflict";
export type CatalogImportDispatchReceiptKind =
  | "preclaim_failure"
  | "lease_failure"
  | "claim_terminal"
  | "batch_complete";

export const catalogImportJob = pgTable(
  "catalog_import_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    intentId: uuid("intent_id").notNull(),
    reservationKey: bytea("reservation_key").notNull(),
    fileName: text("file_name"),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    fileSha256: bytea("file_sha256").notNull(),
    encoding: text("encoding").$type<"utf-8" | "windows-1252">().notNull(),
    delimiter: text("delimiter").$type<";" | ",">().notNull(),
    contractVersion: text("contract_version").notNull(),
    parserVersion: text("parser_version").notNull(),
    mappingVersion: text("mapping_version").notNull(),
    mappingSnapshot: jsonb("mapping_snapshot").$type<CatalogCsvColumnMappingV1>(),
    mappingBodyCanonical: bytea("mapping_body_canonical"),
    mappingSha256: bytea("mapping_sha256").notNull(),
    totalCount: integer("total_count").notNull(),
    validCount: integer("valid_count").notNull(),
    invalidCount: integer("invalid_count").notNull(),
    sensitivePayloadBytes: integer("sensitive_payload_bytes").notNull(),
    state: text("state").$type<CatalogImportJobState>().notNull(),
    leaseGeneration: bigint("lease_generation", { mode: "bigint" })
      .notNull().default(sql`0`),
    leaseToken: uuid("lease_token"),
    leaseRowNumbers: integer("lease_row_numbers").array(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    consecutiveFailureCount: integer("consecutive_failure_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    errorCode: text("error_code").$type<CatalogCsvJobErrorCode>(),
    createdBy: uuid("created_by").notNull(),
    executionActorId: uuid("execution_actor_id"),
    attestationVersion: text("attestation_version"),
    attestationTextSha256: bytea("attestation_text_sha256"),
    attestedBy: uuid("attested_by"),
    attestedAt: timestamp("attested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    previewExpiresAt: timestamp("preview_expires_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
    snapshotCleanupDueAt: timestamp("snapshot_cleanup_due_at", { withTimezone: true }),
    snapshotRedactedAt: timestamp("snapshot_redacted_at", { withTimezone: true }),
  },
  (t) => [
    unique("catalog_import_job_ws_id_uq").on(t.workspaceId, t.id),
    unique("catalog_import_job_ws_intent_uq").on(t.workspaceId, t.intentId),
    unique("catalog_import_job_ws_reservation_uq").on(t.workspaceId, t.reservationKey),
    uniqueIndex("catalog_import_job_ws_active_uq")
      .on(t.workspaceId)
      .where(sql`${t.state} in ('queued', 'running', 'retry_wait')`),
    index("catalog_import_job_recovery_idx").on(
      t.workspaceId,
      t.state,
      t.nextAttemptAt,
      t.id,
    ),
    index("catalog_import_job_cleanup_idx")
      .on(t.workspaceId, t.snapshotCleanupDueAt, t.id)
      .where(sql`${t.snapshotRedactedAt} is null`),
    index("catalog_import_job_preview_expiry_idx")
      .on(t.workspaceId, t.previewExpiresAt, t.id)
      .where(sql`${t.state} = 'ready_for_review'`),
    index("catalog_import_job_ready_actor_quota_idx")
      .on(t.workspaceId, t.createdBy, t.createdAt, t.id)
      .where(sql`${t.state} = 'ready_for_review'`),
    index("catalog_import_job_unredacted_budget_idx")
      .on(t.workspaceId, t.createdAt, t.id)
      .where(sql`${t.snapshotRedactedAt} is null`),
    index("catalog_import_job_latest_idx")
      .on(
        t.workspaceId,
        t.createdAt.desc().nullsFirst(),
        t.id.desc().nullsFirst(),
      ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "catalog_import_job_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.createdBy],
      foreignColumns: [userIdentity.id],
      name: "catalog_import_job_created_by_fk",
    }),
    foreignKey({
      columns: [t.executionActorId],
      foreignColumns: [userIdentity.id],
      name: "catalog_import_job_execution_actor_id_fk",
    }),
    foreignKey({
      columns: [t.attestedBy],
      foreignColumns: [userIdentity.id],
      name: "catalog_import_job_attested_by_fk",
    }),
    check(
      "catalog_import_job_state_ck",
      sql`${t.state} in (
        'ready_for_review', 'queued', 'running', 'retry_wait',
        'succeeded', 'partial', 'failed_final', 'cancelled_before_start'
      )`,
    ),
    check(
      "catalog_import_job_version_ck",
      sql`${t.contractVersion} = 'catalog-csv-import.v1'
        and ${t.parserVersion} = 'papaparse-5.7.0-wmee.v1'
        and ${t.mappingVersion} = 'catalog-csv-column-mapping.v1'`,
    ),
    check(
      "catalog_import_job_file_ck",
      sql`${t.fileSizeBytes} between 1 and 1048576
        and (${t.fileName} is null or (
          ${t.fileName} ~* '\\.csv$'
          and char_length(${t.fileName}) between 1 and 180
          and ${t.fileName} = normalize(${t.fileName}, NFKC)
          and ${t.fileName} !~ '(^[[:space:]])|([[:space:]]$)'
          and ${t.fileName} !~ '[[:cntrl:]]'
          and pg_catalog.strpos(${t.fileName}, '/') = 0
          and pg_catalog.strpos(${t.fileName}, pg_catalog.chr(92)) = 0
          and pg_catalog.strpos(${t.fileName}, pg_catalog.chr(8234)) = 0
          and pg_catalog.strpos(${t.fileName}, pg_catalog.chr(8235)) = 0
          and pg_catalog.strpos(${t.fileName}, pg_catalog.chr(8236)) = 0
          and pg_catalog.strpos(${t.fileName}, pg_catalog.chr(8237)) = 0
          and pg_catalog.strpos(${t.fileName}, pg_catalog.chr(8238)) = 0
          and pg_catalog.strpos(${t.fileName}, pg_catalog.chr(8294)) = 0
          and pg_catalog.strpos(${t.fileName}, pg_catalog.chr(8295)) = 0
          and pg_catalog.strpos(${t.fileName}, pg_catalog.chr(8296)) = 0
          and pg_catalog.strpos(${t.fileName}, pg_catalog.chr(8297)) = 0
        ))
        and ${t.encoding} in ('utf-8', 'windows-1252')
        and ${t.delimiter} in (pg_catalog.chr(59), pg_catalog.chr(44))`,
    ),
    check(
      "catalog_import_job_hash_ck",
      sql`octet_length(${t.reservationKey}) = 32
        and octet_length(${t.fileSha256}) = 32
        and octet_length(${t.mappingSha256}) = 32
        and (${t.mappingBodyCanonical} is null
          or ((
            octet_length(${t.mappingBodyCanonical}) between 2 and 32768
            and pg_catalog.sha256(${t.mappingBodyCanonical}) = ${t.mappingSha256}
            and pg_catalog.convert_from(${t.mappingBodyCanonical}, 'UTF8') =
              public.canonicalize_catalog_json_v1(${t.mappingSnapshot})
            and pg_catalog.convert_from(
              ${t.mappingBodyCanonical},
              'UTF8'
            )::jsonb = ${t.mappingSnapshot}
          ) is true))
        and (${t.attestationTextSha256} is null
          or octet_length(${t.attestationTextSha256}) = 32)`,
    ),
    check(
      "catalog_import_job_count_ck",
      sql`${t.totalCount} = ${t.validCount} + ${t.invalidCount}
        and ${t.totalCount} between 1 and 1000
        and ${t.validCount} between 0 and ${t.totalCount}
        and ${t.invalidCount} between 0 and ${t.totalCount}
        and ${t.sensitivePayloadBytes} between 0 and 31457280`,
    ),
    check(
      "catalog_import_job_lease_ck",
      sql`${t.leaseGeneration} >= 0
        and (
          (${t.state} = 'running'
            and ${t.leaseToken} is not null
            and ${t.leaseExpiresAt} is not null
            and ${t.leaseRowNumbers} is not null
            and cardinality(${t.leaseRowNumbers}) between 1 and 25
            and pg_catalog.array_position(${t.leaseRowNumbers}, null) is null)
          or
          (${t.state} <> 'running'
            and ${t.leaseToken} is null
            and ${t.leaseExpiresAt} is null
            and ${t.leaseRowNumbers} is null)
        )
        and ${t.consecutiveFailureCount} between 0 and 3`,
    ),
    check(
      "catalog_import_job_execution_shape_ck",
      sql`(
          ${t.state} = 'ready_for_review'
          and ${t.nextAttemptAt} is null
          and ${t.errorCode} is null
          and ${t.consecutiveFailureCount} = 0
        ) or (
          ${t.state} = 'queued'
          and ${t.nextAttemptAt} is not null
          and ${t.errorCode} is null
          and ${t.consecutiveFailureCount} = 0
        ) or (
          ${t.state} = 'running'
          and ${t.nextAttemptAt} is null
          and ${t.errorCode} is null
          and ${t.consecutiveFailureCount} between 0 and 2
        ) or (
          ${t.state} = 'retry_wait'
          and ${t.nextAttemptAt} is not null
          and ${t.errorCode} is not null
          and ${t.errorCode} in ('lease_lost', 'enqueue_failed', 'queue_locator_invalid')
          and ${t.consecutiveFailureCount} between 1 and 2
        ) or (
          ${t.state} in ('succeeded', 'partial', 'cancelled_before_start')
          and ${t.nextAttemptAt} is null
          and ${t.errorCode} is null
          and ${t.consecutiveFailureCount} = 0
        ) or (
          ${t.state} = 'failed_final'
          and ${t.nextAttemptAt} is null
          and ${t.errorCode} is not null
          and (
            (${t.errorCode} = 'technical_retry_exhausted'
              and ${t.consecutiveFailureCount} = 3)
            or (${t.errorCode} in (
                'actor_revoked', 'capability_revoked',
                'invalid_persisted_input', 'all_rows_conflicted'
              ) and ${t.consecutiveFailureCount} = 0)
          )
        )`,
    ),
    check(
      "catalog_import_job_error_ck",
      sql`${t.errorCode} is null or ${t.errorCode} in (
        'actor_revoked', 'capability_revoked', 'lease_lost', 'enqueue_failed',
        'invalid_persisted_input', 'technical_retry_exhausted',
        'all_rows_conflicted', 'queue_locator_invalid'
      )`,
    ),
    check(
      "catalog_import_job_attestation_ck",
      sql`(
          ${t.state} in ('ready_for_review', 'cancelled_before_start')
          and ${t.executionActorId} is null
          and ${t.attestationVersion} is null
          and ${t.attestationTextSha256} is null
          and ${t.attestedBy} is null
          and ${t.attestedAt} is null
          and ${t.startedAt} is null
        ) or (
          ${t.state} not in ('ready_for_review', 'cancelled_before_start')
          and ${t.executionActorId} is not null
          and ${t.attestationVersion} is not null
          and ${t.attestationVersion} = 'catalog-import-rights-attestation.v1'
          and ${t.attestationTextSha256} is not null
          and ${t.attestationTextSha256} = pg_catalog.decode(
            '4511413a407acc4c073184ecbb127b449b13c72db28fe8b1682ba17cced1b4f8',
            'hex'
          )
          and ${t.attestedBy} = ${t.executionActorId}
          and ${t.attestedAt} is not null
          and ${t.startedAt} is not null
        )`,
    ),
    check(
      "catalog_import_job_terminal_ck",
      sql`${t.previewExpiresAt} = ${t.createdAt} + interval '7 days'
        and (
          (${t.state} in ('succeeded', 'partial', 'failed_final', 'cancelled_before_start')
            and ${t.terminalAt} is not null
            and ${t.snapshotCleanupDueAt} is not null
            and ${t.snapshotCleanupDueAt} = greatest(
              ${t.createdAt} + interval '30 days',
              ${t.terminalAt}
            ))
          or (${t.state} not in ('succeeded', 'partial', 'failed_final', 'cancelled_before_start')
            and ${t.terminalAt} is null
            and ${t.snapshotCleanupDueAt} is null
            and ${t.snapshotRedactedAt} is null)
        )`,
    ),
    check(
      "catalog_import_job_redaction_ck",
      sql`(${t.snapshotRedactedAt} is null
          and ${t.fileName} is not null
          and ${t.mappingSnapshot} is not null
          and ${t.mappingBodyCanonical} is not null
          and ${t.sensitivePayloadBytes} > 0)
        or (${t.snapshotRedactedAt} is not null
          and ${t.fileName} is null
          and ${t.mappingSnapshot} is null
          and ${t.mappingBodyCanonical} is null
          and ${t.sensitivePayloadBytes} = 0
          and ${t.terminalAt} is not null
          and ${t.snapshotCleanupDueAt} is not null
          and ${t.snapshotRedactedAt} >= ${t.snapshotCleanupDueAt})`,
    ),
  ],
);

export const catalogImportRow = pgTable(
  "catalog_import_row",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    jobId: uuid("job_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    validationStatus: text("validation_status")
      .$type<CatalogImportRowValidationStatus>().notNull(),
    normalizedSku: text("normalized_sku"),
    operation: text("operation").$type<CatalogImportOperation>(),
    commandSnapshot: jsonb("command_snapshot").$type<CatalogImportRowCommandV1>(),
    previewRowBodyCanonical: bytea("preview_row_body_canonical"),
    sourceCommandBodyCanonical: bytea("source_command_body_canonical"),
    rowCommandBodyCanonical: bytea("row_command_body_canonical"),
    rowSha256: bytea("row_sha256").notNull(),
    sourceCommandSha256: bytea("source_command_sha256"),
    rowCommandSha256: bytea("row_command_sha256"),
    errorSnapshot: jsonb("error_snapshot").$type<CatalogCsvRowErrorV1[]>(),
    targetComponentId: uuid("target_component_id"),
    sealedTargetSnapshot: jsonb("sealed_target_snapshot")
      .$type<CatalogComponentRevisionV1>(),
    sealedTargetBodyCanonical: bytea("sealed_target_body_canonical"),
    targetSnapshotSha256: bytea("target_snapshot_sha256"),
    expectedComponentId: uuid("expected_component_id"),
    expectedRevision: integer("expected_revision"),
    expectedStatus: text("expected_status").$type<"draft" | "active">(),
    expectedSnapshotSha256: bytea("expected_snapshot_sha256"),
    sensitivePayloadBytes: integer("sensitive_payload_bytes").notNull().default(0),
    snapshotRedactedAt: timestamp("snapshot_redacted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("catalog_import_row_ws_id_uq").on(t.workspaceId, t.id),
    unique("catalog_import_row_ws_job_row_uq").on(t.workspaceId, t.jobId, t.rowNumber),
    uniqueIndex("catalog_import_row_ws_job_valid_sku_uq")
      .on(t.workspaceId, t.jobId, t.normalizedSku)
      .where(sql`${t.validationStatus} = 'valid'`),
    index("catalog_import_row_ws_job_status_idx").on(
      t.workspaceId,
      t.jobId,
      t.validationStatus,
      t.rowNumber,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "catalog_import_row_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.jobId],
      foreignColumns: [catalogImportJob.workspaceId, catalogImportJob.id],
      name: "catalog_import_row_job_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        t.workspaceId,
        t.expectedComponentId,
        t.expectedRevision,
        t.expectedSnapshotSha256,
      ],
      foreignColumns: [
        catalogComponentRevision.workspaceId,
        catalogComponentRevision.componentId,
        catalogComponentRevision.revision,
        catalogComponentRevision.snapshotSha256,
      ],
      name: "catalog_import_row_expected_revision_fk",
    }),
    check("catalog_import_row_number_ck", sql`${t.rowNumber} between 2 and 1001`),
    check(
      "catalog_import_row_status_ck",
      sql`${t.validationStatus} in ('valid', 'invalid')
        and (${t.operation} is null or ${t.operation} in ('create', 'revise', 'unchanged'))`,
    ),
    check(
      "catalog_import_row_shape_ck",
      sql`(
          ${t.validationStatus} = 'valid'
          and ${t.operation} is not null
          and ${t.sourceCommandSha256} is not null
          and ${t.rowCommandSha256} is not null
          and ${t.errorSnapshot} is null
          and ${t.targetComponentId} is not null
          and (
            (${t.snapshotRedactedAt} is null
              and ${t.normalizedSku} is not null
              and ${t.commandSnapshot} is not null
              and ${t.previewRowBodyCanonical} is not null
              and ${t.sourceCommandBodyCanonical} is not null
              and ${t.rowCommandBodyCanonical} is not null
              and (
                (${t.operation} in ('create', 'revise')
                  and ${t.sealedTargetSnapshot} is not null
                  and ${t.sealedTargetBodyCanonical} is not null)
                or (${t.operation} = 'unchanged'
                  and ${t.sealedTargetSnapshot} is null
                  and ${t.sealedTargetBodyCanonical} is null)
              ))
            or (${t.snapshotRedactedAt} is not null
              and ${t.commandSnapshot} is null
              and ${t.previewRowBodyCanonical} is null
              and ${t.sourceCommandBodyCanonical} is null
              and ${t.rowCommandBodyCanonical} is null
              and ${t.sealedTargetSnapshot} is null
              and ${t.sealedTargetBodyCanonical} is null)
          )
        ) or (
          ${t.validationStatus} = 'invalid'
          and ${t.operation} is null
          and ${t.commandSnapshot} is null
          and (
            (${t.snapshotRedactedAt} is null
              and ${t.previewRowBodyCanonical} is not null)
            or (${t.snapshotRedactedAt} is not null
              and ${t.previewRowBodyCanonical} is null)
          )
          and ${t.sourceCommandBodyCanonical} is null
          and ${t.rowCommandBodyCanonical} is null
          and ${t.sourceCommandSha256} is null
          and ${t.rowCommandSha256} is null
          and ${t.errorSnapshot} is not null
          and ${t.targetComponentId} is null
          and ${t.sealedTargetSnapshot} is null
          and ${t.sealedTargetBodyCanonical} is null
          and ${t.targetSnapshotSha256} is null
          and ${t.expectedComponentId} is null
          and ${t.expectedRevision} is null
          and ${t.expectedStatus} is null
          and ${t.expectedSnapshotSha256} is null
        )`,
    ),
    check(
      "catalog_import_row_operation_ck",
      sql`(${t.validationStatus} = 'invalid') or (
        (${t.operation} = 'create'
          and ${t.expectedComponentId} is null
          and ${t.expectedRevision} is null
          and ${t.expectedStatus} is null
          and ${t.expectedSnapshotSha256} is null
          and ${t.targetSnapshotSha256} is not null)
        or (${t.operation} = 'revise'
          and ${t.expectedComponentId} is not null
          and ${t.expectedComponentId} = ${t.targetComponentId}
          and ${t.expectedRevision} is not null
          and ${t.expectedRevision} > 0
          and ${t.expectedStatus} is not null
          and ${t.expectedStatus} in ('draft', 'active')
          and ${t.expectedSnapshotSha256} is not null
          and ${t.targetSnapshotSha256} is not null)
        or (${t.operation} = 'unchanged'
          and ${t.expectedComponentId} is not null
          and ${t.expectedComponentId} = ${t.targetComponentId}
          and ${t.expectedRevision} is not null
          and ${t.expectedRevision} > 0
          and ${t.expectedStatus} is not null
          and ${t.expectedStatus} in ('draft', 'active')
          and ${t.expectedSnapshotSha256} is not null
          and ${t.targetSnapshotSha256} is not null
          and ${t.targetSnapshotSha256} = ${t.expectedSnapshotSha256})
      )`,
    ),
    check(
      "catalog_import_row_hash_ck",
      sql`octet_length(${t.rowSha256}) = 32
        and (${t.previewRowBodyCanonical} is null
          or ((
            octet_length(${t.previewRowBodyCanonical}) between 2 and 131072
            and pg_catalog.sha256(${t.previewRowBodyCanonical}) = ${t.rowSha256}
            and pg_catalog.convert_from(${t.previewRowBodyCanonical}, 'UTF8') =
              public.canonicalize_catalog_json_v1(case
                when ${t.validationStatus} = 'valid' then
                  pg_catalog.jsonb_build_object(
                    'status', 'valid',
                    'rowNumber', ${t.rowNumber},
                    'normalizedSku', ${t.normalizedSku},
                    'commandSha256', pg_catalog.encode(${t.sourceCommandSha256}, 'hex'),
                    'command', ${t.commandSnapshot}->'sourceCommand'
                  )
                else
                  pg_catalog.jsonb_build_object(
                    'status', 'invalid',
                    'rowNumber', ${t.rowNumber},
                    'normalizedSku', ${t.normalizedSku},
                    'errors', ${t.errorSnapshot}
                  )
              end)
            and pg_catalog.convert_from(
              ${t.previewRowBodyCanonical},
              'UTF8'
            )::jsonb = case
              when ${t.validationStatus} = 'valid' then
                pg_catalog.jsonb_build_object(
                  'status', 'valid',
                  'rowNumber', ${t.rowNumber},
                  'normalizedSku', ${t.normalizedSku},
                  'commandSha256', pg_catalog.encode(${t.sourceCommandSha256}, 'hex'),
                  'command', ${t.commandSnapshot}->'sourceCommand'
                )
              else
                pg_catalog.jsonb_build_object(
                  'status', 'invalid',
                  'rowNumber', ${t.rowNumber},
                  'normalizedSku', ${t.normalizedSku},
                  'errors', ${t.errorSnapshot}
                )
            end
          ) is true))
        and (${t.sourceCommandSha256} is null
          or octet_length(${t.sourceCommandSha256}) = 32)
        and (${t.rowCommandSha256} is null
          or octet_length(${t.rowCommandSha256}) = 32)
        and (${t.sourceCommandBodyCanonical} is null
          or ((
            octet_length(${t.sourceCommandBodyCanonical}) between 2 and 65536
            and pg_catalog.sha256(${t.sourceCommandBodyCanonical}) =
              ${t.sourceCommandSha256}
            and pg_catalog.convert_from(${t.sourceCommandBodyCanonical}, 'UTF8') =
              public.canonicalize_catalog_json_v1(
                ${t.commandSnapshot}->'sourceCommand'
              )
            and pg_catalog.convert_from(
              ${t.sourceCommandBodyCanonical},
              'UTF8'
            )::jsonb = ${t.commandSnapshot}->'sourceCommand'
          ) is true))
        and (${t.rowCommandBodyCanonical} is null
          or ((
            octet_length(${t.rowCommandBodyCanonical}) between 2 and 262144
            and pg_catalog.sha256(${t.rowCommandBodyCanonical}) = ${t.rowCommandSha256}
            and pg_catalog.convert_from(${t.rowCommandBodyCanonical}, 'UTF8') =
              public.canonicalize_catalog_json_v1(
                ${t.commandSnapshot} - 'rowCommandSha256'
              )
            and pg_catalog.convert_from(
              ${t.rowCommandBodyCanonical},
              'UTF8'
            )::jsonb = ${t.commandSnapshot} - 'rowCommandSha256'
          ) is true))
        and (${t.sealedTargetBodyCanonical} is null
          or ((
            octet_length(${t.sealedTargetBodyCanonical}) between 2 and 65536
            and pg_catalog.sha256(${t.sealedTargetBodyCanonical}) =
              ${t.targetSnapshotSha256}
            and pg_catalog.convert_from(${t.sealedTargetBodyCanonical}, 'UTF8') =
              public.canonicalize_catalog_json_v1(
                ${t.sealedTargetSnapshot} - 'snapshotSha256'
              )
            and pg_catalog.convert_from(
              ${t.sealedTargetBodyCanonical},
              'UTF8'
            )::jsonb = ${t.sealedTargetSnapshot} - 'snapshotSha256'
            and ${t.sealedTargetSnapshot}->>'snapshotSha256' =
              pg_catalog.encode(${t.targetSnapshotSha256}, 'hex')
          ) is true))
        and (${t.targetSnapshotSha256} is null
          or octet_length(${t.targetSnapshotSha256}) = 32)
        and (${t.expectedSnapshotSha256} is null
          or octet_length(${t.expectedSnapshotSha256}) = 32)
        and ${t.sensitivePayloadBytes} between 0 and 31457280`,
    ),
    check(
      "catalog_import_row_command_binding_ck",
      sql`${t.commandSnapshot} is null or ((
        ${t.commandSnapshot}->>'schemaVersion' = 'catalog-import-row-command.v1'
        and ${t.commandSnapshot}->>'operation' = ${t.operation}
        and ${t.commandSnapshot}->>'targetComponentId' = (${t.targetComponentId})::text
        and (${t.commandSnapshot}#>>'{source,rowNumber}')::integer = ${t.rowNumber}
        and ${t.commandSnapshot}#>>'{source,rowSha256}' =
          pg_catalog.encode(${t.rowSha256}, 'hex')
        and ${t.commandSnapshot}#>>'{source,sourceCommandSha256}' =
          pg_catalog.encode(${t.sourceCommandSha256}, 'hex')
        and ${t.commandSnapshot}->>'rowCommandSha256' =
          pg_catalog.encode(${t.rowCommandSha256}, 'hex')
        and ${t.commandSnapshot}#>>'{sourceCommand,internalSku}' = ${t.normalizedSku}
        and (
          (${t.operation} = 'create'
            and jsonb_typeof(${t.commandSnapshot}->'expected') = 'null')
          or (${t.operation} in ('revise', 'unchanged')
            and jsonb_typeof(${t.commandSnapshot}->'expected') = 'object'
            and ${t.commandSnapshot}#>>'{expected,componentId}' =
              (${t.expectedComponentId})::text
            and (${t.commandSnapshot}#>>'{expected,revision}')::integer =
              ${t.expectedRevision}
            and ${t.commandSnapshot}#>>'{expected,status}' = ${t.expectedStatus}
            and ${t.commandSnapshot}#>>'{expected,snapshotSha256}' =
              pg_catalog.encode(${t.expectedSnapshotSha256}, 'hex')
            and ${t.commandSnapshot}#>>'{expected,internalSku}' =
              ${t.commandSnapshot}#>>'{sourceCommand,internalSku}'
            and ${t.commandSnapshot}#>>'{expected,componentType}' =
              ${t.commandSnapshot}#>>'{sourceCommand,componentType}')
        )
        and (
          (${t.operation} = 'unchanged'
            and jsonb_typeof(${t.commandSnapshot}->'sealedTarget') = 'null')
          or (${t.operation} in ('create', 'revise')
            and jsonb_typeof(${t.commandSnapshot}->'sealedTarget') = 'object'
            and ${t.commandSnapshot}#>'{sealedTarget,snapshot}' =
              ${t.sealedTargetSnapshot}
            and pg_catalog.decode(
              ${t.commandSnapshot}#>>'{sealedTarget,bodyCanonicalBase64}',
              'base64'
            ) = ${t.sealedTargetBodyCanonical}
            and ${t.commandSnapshot}#>>'{sealedTarget,snapshotSha256}' =
              pg_catalog.encode(${t.targetSnapshotSha256}, 'hex')
            and ${t.commandSnapshot}#>>'{sealedTarget,snapshot,identity,componentId}' =
              (${t.targetComponentId})::text)
        )
      ) is true)`,
    ),
    check(
      "catalog_import_row_redaction_ck",
      sql`${t.snapshotRedactedAt} is null
        or (
          ${t.normalizedSku} is null
          and ${t.commandSnapshot} is null
          and ${t.previewRowBodyCanonical} is null
          and ${t.sourceCommandBodyCanonical} is null
          and ${t.rowCommandBodyCanonical} is null
          and ${t.sealedTargetSnapshot} is null
          and ${t.sealedTargetBodyCanonical} is null
          and ${t.sensitivePayloadBytes} = 0
          and (
            ${t.errorSnapshot} is null
            or not jsonb_path_exists(
              ${t.errorSnapshot},
              '$[*] ? (@.sourceHeader != null)'
            )
          )
        )`,
    ),
  ],
);

export const catalogImportRowResult = pgTable(
  "catalog_import_row_result",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    jobId: uuid("job_id").notNull(),
    rowNumber: integer("row_number").notNull(),
    resultState: text("result_state").$type<CatalogImportResultState>().notNull(),
    componentId: uuid("component_id"),
    revision: integer("revision"),
    snapshotSha256: bytea("snapshot_sha256"),
    errorCode: text("error_code").$type<CatalogCsvProcessingResultCode>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("catalog_import_row_result_ws_id_uq").on(t.workspaceId, t.id),
    unique("catalog_import_row_result_ws_job_row_uq").on(
      t.workspaceId,
      t.jobId,
      t.rowNumber,
    ),
    index("catalog_import_row_result_ws_job_idx").on(
      t.workspaceId,
      t.jobId,
      t.resultState,
      t.rowNumber,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "catalog_import_row_result_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.jobId, t.rowNumber],
      foreignColumns: [
        catalogImportRow.workspaceId,
        catalogImportRow.jobId,
        catalogImportRow.rowNumber,
      ],
      name: "catalog_import_row_result_row_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.componentId, t.revision, t.snapshotSha256],
      foreignColumns: [
        catalogComponentRevision.workspaceId,
        catalogComponentRevision.componentId,
        catalogComponentRevision.revision,
        catalogComponentRevision.snapshotSha256,
      ],
      name: "catalog_import_row_result_revision_fk",
    }),
    check(
      "catalog_import_row_result_state_ck",
      sql`${t.resultState} in ('created', 'revised', 'unchanged', 'conflict')`,
    ),
    check(
      "catalog_import_row_result_shape_ck",
      sql`(
          ${t.resultState} in ('created', 'revised', 'unchanged')
          and ${t.componentId} is not null
          and ${t.revision} is not null
          and ${t.revision} > 0
          and ${t.snapshotSha256} is not null
          and ${t.errorCode} is null
        ) or (
          ${t.resultState} = 'conflict'
          and ${t.componentId} is null
          and ${t.revision} is null
          and ${t.snapshotSha256} is null
          and ${t.errorCode} is not null
        )`,
    ),
    check(
      "catalog_import_row_result_error_ck",
      sql`${t.errorCode} is null or ${t.errorCode} in (
        'sku_created_since_preview', 'revision_drift', 'status_drift',
        'type_drift', 'archived_requires_manual_reactivation',
        'catalog_write_conflict'
      )`,
    ),
    check(
      "catalog_import_row_result_hash_ck",
      sql`${t.snapshotSha256} is null or octet_length(${t.snapshotSha256}) = 32`,
    ),
  ],
);

export const catalogImportDispatchReceipt = pgTable(
  "catalog_import_dispatch_receipt",
  {
    dispatchId: uuid("dispatch_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    jobId: uuid("job_id").notNull(),
    receiptKind: text("receipt_kind")
      .$type<CatalogImportDispatchReceiptKind>().notNull(),
    leaseGeneration: bigint("lease_generation", { mode: "bigint" }).notNull(),
    causeCode: text("cause_code").$type<CatalogCsvJobErrorCode>(),
    outcomeState: text("outcome_state").$type<CatalogImportJobState>().notNull(),
    outcomeFailureCount: integer("outcome_failure_count").notNull(),
    outcomeErrorCode: text("outcome_error_code").$type<CatalogCsvJobErrorCode>(),
    outcomeNextAttemptAt: timestamp("outcome_next_attempt_at", { withTimezone: true }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("catalog_import_dispatch_receipt_ws_job_dispatch_uq").on(
      t.workspaceId,
      t.jobId,
      t.dispatchId,
    ),
    index("catalog_import_dispatch_receipt_ws_job_idx").on(
      t.workspaceId,
      t.jobId,
      t.recordedAt,
      t.dispatchId,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "catalog_import_dispatch_receipt_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.jobId],
      foreignColumns: [catalogImportJob.workspaceId, catalogImportJob.id],
      name: "catalog_import_dispatch_receipt_job_fk",
    }).onDelete("cascade"),
    check(
      "catalog_import_dispatch_receipt_shape_ck",
      sql`(
        ${t.leaseGeneration} >= 0
        and ${t.outcomeFailureCount} between 0 and 3
        and (
          (((${t.receiptKind} = 'preclaim_failure'
              and ${t.causeCode} in ('enqueue_failed', 'queue_locator_invalid'))
            or (${t.receiptKind} = 'lease_failure'
              and ${t.causeCode} in (
                'lease_lost', 'enqueue_failed', 'queue_locator_invalid'
              )))
            and (
              (${t.outcomeState} = 'retry_wait'
                and ${t.outcomeFailureCount} between 1 and 2
                and ${t.outcomeErrorCode} = ${t.causeCode}
                and ${t.outcomeNextAttemptAt} is not null)
              or (${t.outcomeState} = 'failed_final'
                and ${t.outcomeFailureCount} = 3
                and ${t.outcomeErrorCode} = 'technical_retry_exhausted'
                and ${t.outcomeNextAttemptAt} is null)
            ))
          or (${t.receiptKind} = 'claim_terminal'
            and ${t.causeCode} in (
              'actor_revoked', 'capability_revoked', 'invalid_persisted_input'
            )
            and ${t.outcomeState} = 'failed_final'
            and ${t.outcomeFailureCount} = 0
            and ${t.outcomeErrorCode} = ${t.causeCode}
            and ${t.outcomeNextAttemptAt} is null)
          or (${t.receiptKind} = 'batch_complete'
            and ${t.causeCode} is null
            and ${t.outcomeFailureCount} = 0
            and (
              (${t.outcomeState} = 'queued'
                and ${t.outcomeErrorCode} is null
                and ${t.outcomeNextAttemptAt} is not null)
              or (${t.outcomeState} in ('succeeded', 'partial')
                and ${t.outcomeErrorCode} is null
                and ${t.outcomeNextAttemptAt} is null)
              or (${t.outcomeState} = 'failed_final'
                and ${t.outcomeErrorCode} = 'all_rows_conflicted'
                and ${t.outcomeNextAttemptAt} is null)
            ))
        )
      ) is true`,
    ),
  ],
);
