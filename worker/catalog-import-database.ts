import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { z } from "zod";

import { servicePoolConfig } from "../lib/db/role-env";
import { withTenantOn } from "../lib/db/tenant";
import type { TenantTx } from "../lib/db/types";
import {
  catalogCsvJobErrorCodeSchema,
  catalogCsvProcessingResultCodeSchema,
} from "../lib/integrations/catalog/import-contract";

const uuidSchema = z.uuid().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
);
const POSTGRES_BIGINT_MAX = BigInt("9223372036854775807");
function postgresBigintDecimal(pattern: RegExp) {
  return z.string().regex(pattern).refine((value) => {
    try {
      return BigInt(value) <= POSTGRES_BIGINT_MAX;
    } catch {
      return false;
    }
  }, "lease generation exceeds PostgreSQL bigint");
}
const leaseGenerationSchema = postgresBigintDecimal(/^(?:0|[1-9][0-9]*)$/u);
const positiveLeaseGenerationSchema = postgresBigintDecimal(/^[1-9][0-9]*$/u);
const databaseInstantSchema = z.union([z.date(), z.string().min(1)])
  .transform((value, context) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      context.addIssue({ code: "custom", message: "invalid database instant" });
      return z.NEVER;
    }
    return date;
  });
const workerKeySchema = z.strictObject({
  workspaceId: uuidSchema,
  importId: uuidSchema,
});
const claimInputSchema = workerKeySchema.extend({
  dispatchId: uuidSchema,
  batchLimit: z.int().safe().min(1).max(25),
});
const leaseKeySchema = workerKeySchema.extend({
  leaseToken: uuidSchema,
  leaseGeneration: positiveLeaseGenerationSchema,
});
const applyInputSchema = leaseKeySchema.extend({
  rowNumber: z.int().safe().min(2).max(1_001),
});
const leaseFailureInputSchema = leaseKeySchema.extend({
  errorCode: z.enum(["lease_lost", "enqueue_failed", "queue_locator_invalid"]),
});
const preclaimFailureInputSchema = workerKeySchema.extend({
  dispatchId: uuidSchema,
  errorCode: z.enum(["enqueue_failed", "queue_locator_invalid"]),
});
const dispatchFailureInputSchema = preclaimFailureInputSchema;
const tenantSweepInputSchema = z.strictObject({
  workspaceId: uuidSchema,
  limit: z.int().safe().min(1).max(100),
});
const locatorPageInputSchema = z.strictObject({
  afterJobId: uuidSchema.nullable(),
  limit: z.int().safe().min(1).max(100),
});
const functionRowSchema = z.strictObject({ result: z.unknown() });
const dispatchGateSchema = z.strictObject({
  dispatch_signature: z.string().nullable(),
  current_role: z.string().min(1),
  session_role: z.string().min(1),
  database_name: z.string().min(1),
});
const notClaimableSchema = z.strictObject({ status: z.literal("not_claimable") });
const claimedSchema = z.strictObject({
  status: z.literal("claimed"),
  importId: uuidSchema,
  leaseToken: uuidSchema,
  leaseGeneration: positiveLeaseGenerationSchema,
  rowNumbers: z.array(z.int().safe().min(2).max(1_001)).min(1).max(25),
  leaseExpiresAt: databaseInstantSchema,
  replayed: z.boolean(),
}).superRefine((value, context) => {
  for (let index = 0; index < value.rowNumbers.length; index += 1) {
    if (index > 0 && value.rowNumbers[index]! <= value.rowNumbers[index - 1]!) {
      context.addIssue({ code: "custom", path: ["rowNumbers", index], message: "row order drift" });
    }
  }
});
const receiptReplaySchema = z.strictObject({
  status: z.enum(["queued", "retry_wait", "succeeded", "partial", "failed_final"]),
  importId: uuidSchema,
  leaseGeneration: leaseGenerationSchema,
  failureCount: z.int().safe().min(0).max(3),
  errorCode: catalogCsvJobErrorCodeSchema.nullable(),
  nextAttemptAt: databaseInstantSchema.nullable(),
  dispatchRequired: z.boolean(),
  replayed: z.literal(true),
}).superRefine((value, context) => {
  const retriable = value.errorCode === "lease_lost"
    || value.errorCode === "enqueue_failed"
    || value.errorCode === "queue_locator_invalid";
  const technicalTerminal = value.failureCount === 3
    && value.errorCode === "technical_retry_exhausted";
  const domainTerminal = value.failureCount === 0
    && (
      value.errorCode === "actor_revoked"
      || value.errorCode === "capability_revoked"
      || value.errorCode === "invalid_persisted_input"
      || value.errorCode === "all_rows_conflicted"
    );
  const valid = value.status === "queued"
    ? value.failureCount === 0 && value.errorCode === null
      && value.nextAttemptAt !== null && value.dispatchRequired
    : value.status === "retry_wait"
      ? (value.failureCount === 1 || value.failureCount === 2) && retriable
        && value.nextAttemptAt !== null && value.dispatchRequired
      : value.status === "succeeded" || value.status === "partial"
        ? value.failureCount === 0 && value.errorCode === null
          && value.nextAttemptAt === null && !value.dispatchRequired
        : (technicalTerminal || domainTerminal)
          && value.nextAttemptAt === null && !value.dispatchRequired;
  if (!valid) context.addIssue({ code: "custom", message: "receipt state drift" });
});
const freshPreclaimFailureSchema = z.strictObject({
  status: z.enum(["retry_wait", "failed_final"]),
  importId: uuidSchema,
  failureCount: z.int().safe().min(1).max(3),
  errorCode: catalogCsvJobErrorCodeSchema,
  nextAttemptAt: databaseInstantSchema.nullable(),
  dispatchRequired: z.boolean(),
  replayed: z.literal(false),
}).superRefine((value, context) => {
  const retriable = value.errorCode === "enqueue_failed"
    || value.errorCode === "queue_locator_invalid";
  const valid = value.status === "retry_wait"
    ? (value.failureCount === 1 || value.failureCount === 2) && retriable
      && value.nextAttemptAt !== null && value.dispatchRequired
    : value.failureCount === 3
      && value.errorCode === "technical_retry_exhausted"
      && value.nextAttemptAt === null
      && !value.dispatchRequired;
  if (!valid) context.addIssue({ code: "custom", message: "preclaim state drift" });
});
const freshLeaseFailureSchema = z.strictObject({
  status: z.enum(["retry_wait", "failed_final"]),
  importId: uuidSchema,
  failureCount: z.int().safe().min(1).max(3),
  errorCode: catalogCsvJobErrorCodeSchema,
  nextAttemptAt: databaseInstantSchema.nullable(),
  dispatchRequired: z.boolean(),
  replayed: z.literal(false),
  leaseGeneration: positiveLeaseGenerationSchema,
}).superRefine((value, context) => {
  const retriable = value.errorCode === "lease_lost"
    || value.errorCode === "enqueue_failed"
    || value.errorCode === "queue_locator_invalid";
  const valid = value.status === "retry_wait"
    ? (value.failureCount === 1 || value.failureCount === 2) && retriable
      && value.nextAttemptAt !== null && value.dispatchRequired
    : value.failureCount === 3
      && value.errorCode === "technical_retry_exhausted"
      && value.nextAttemptAt === null
      && !value.dispatchRequired;
  if (!valid) context.addIssue({ code: "custom", message: "lease state drift" });
});
const freshBatchSchema = z.strictObject({
  status: z.enum(["queued", "succeeded", "partial", "failed_final"]),
  importId: uuidSchema,
  leaseGeneration: positiveLeaseGenerationSchema,
  resultCount: z.int().safe().min(0).max(1_000),
  successCount: z.int().safe().min(0).max(1_000),
  conflictCount: z.int().safe().min(0).max(1_000),
  errorCode: catalogCsvJobErrorCodeSchema.nullable(),
  nextAttemptAt: databaseInstantSchema.nullable(),
  dispatchRequired: z.boolean(),
  replayed: z.literal(false),
}).superRefine((value, context) => {
  const countsMatch = value.resultCount === value.successCount + value.conflictCount;
  const valid = countsMatch && (value.status === "queued"
    ? value.errorCode === null && value.nextAttemptAt !== null
      && value.dispatchRequired
    : value.status === "succeeded"
      ? value.errorCode === null && value.nextAttemptAt === null
        && !value.dispatchRequired && value.conflictCount === 0
        && value.successCount === value.resultCount
      : value.status === "partial"
        ? value.errorCode === null && value.nextAttemptAt === null
          && !value.dispatchRequired && value.successCount > 0
        : value.errorCode === "all_rows_conflicted"
          && value.nextAttemptAt === null && !value.dispatchRequired
          && value.successCount === 0 && value.conflictCount === value.resultCount);
  if (!valid) context.addIssue({ code: "custom", message: "batch state drift" });
});
const terminalClaimSchema = z.strictObject({
  status: z.literal("failed_final"),
  importId: uuidSchema,
  failureCount: z.literal(0),
  errorCode: z.enum(["actor_revoked", "capability_revoked", "invalid_persisted_input"]),
  replayed: z.literal(false),
});
const controlConflictSchema = z.union([
  z.strictObject({ status: z.literal("conflict"), code: z.literal("stale_lease") }),
  z.strictObject({ status: z.literal("conflict"), code: z.literal("batch_incomplete") }),
  z.strictObject({ status: z.literal("conflict"), code: z.literal("invalid_result_set") }),
  z.strictObject({
    status: z.literal("conflict"),
    code: z.literal("dispatch_reused"),
    replayed: z.literal(true),
  }),
  z.strictObject({ status: z.literal("conflict"), code: z.literal("not_due") }),
]);
const claimControlSchema = z.union([
  receiptReplaySchema,
  freshLeaseFailureSchema,
  freshBatchSchema,
  terminalClaimSchema,
  controlConflictSchema,
]);
const successfulApplySchema = z.strictObject({
  status: z.enum(["created", "revised", "unchanged"]),
  importId: uuidSchema,
  rowNumber: z.int().safe().min(2).max(1_001),
  componentId: uuidSchema,
  revision: z.int().safe().min(1).max(2_147_483_647),
  errorCode: z.null(),
  snapshotHashRef: z.string().regex(/^[0-9a-f]{16}$/u),
  replayed: z.boolean(),
});
const conflictApplySchema = z.strictObject({
  status: z.literal("conflict"),
  importId: uuidSchema,
  rowNumber: z.int().safe().min(2).max(1_001),
  componentId: z.null(),
  revision: z.null(),
  errorCode: catalogCsvProcessingResultCodeSchema,
  snapshotHashRef: z.null(),
  replayed: z.boolean(),
});
const staleApplySchema = z.strictObject({
  status: z.literal("conflict"),
  code: z.literal("stale_lease"),
});
const terminalApplySchema = z.strictObject({
  status: z.literal("failed_final"),
  importId: uuidSchema,
  rowNumber: z.int().safe().min(2).max(1_001),
  errorCode: z.enum(["actor_revoked", "capability_revoked", "invalid_persisted_input"]),
  replayed: z.literal(false),
});
const applyOutcomeSchema = z.union([
  successfulApplySchema,
  conflictApplySchema,
  staleApplySchema,
  terminalApplySchema,
]);
const batchOutcomeSchema = z.union([
  freshBatchSchema,
  receiptReplaySchema,
  controlConflictSchema,
]);
const leaseFailureOutcomeSchema = z.union([
  freshLeaseFailureSchema,
  receiptReplaySchema,
  controlConflictSchema,
]);
const preclaimFailureOutcomeSchema = z.union([
  freshPreclaimFailureSchema,
  receiptReplaySchema,
  controlConflictSchema,
]);
const supersededDispatchFailureSchema = z.strictObject({
  status: z.literal("superseded"),
  state: z.enum([
    "missing",
    "ready_for_review",
    "queued",
    "running",
    "retry_wait",
    "succeeded",
    "partial",
    "failed_final",
    "cancelled_before_start",
  ]),
  importId: uuidSchema,
});
const dispatchFailureOutcomeSchema = z.union([
  receiptReplaySchema,
  freshPreclaimFailureSchema,
  freshLeaseFailureSchema,
  controlConflictSchema,
  supersededDispatchFailureSchema,
]);
const recoveryRowSchema = z.strictObject({
  import_id: uuidSchema,
  recovery_action: z.enum(["dispatch_required", "retry_scheduled", "cleanup_required"]),
  dispatch_id: uuidSchema,
});
const cleanupRowSchema = z.strictObject({
  import_id: uuidSchema,
  redacted_at: databaseInstantSchema,
});
const locatorRowSchema = z.union([
  z.strictObject({
    locator_job_id: uuidSchema,
    workspace_id: uuidSchema,
    import_id: uuidSchema,
    locator_status: z.literal("valid"),
  }),
  z.strictObject({
    locator_job_id: uuidSchema,
    workspace_id: uuidSchema.nullable(),
    import_id: uuidSchema.nullable(),
    locator_status: z.literal("queue_locator_invalid"),
  }),
]);
const quarantineRowSchema = z.strictObject({ quarantined: z.boolean() });

export type CatalogImportClaim = Readonly<{
  workspaceId: string;
  importId: string;
  leaseToken: string;
  leaseGeneration: string;
  rowNumbers: readonly number[];
  leaseExpiresAt: Date;
  replayed: boolean;
}>;
export type CatalogImportApplyOutcome = z.infer<typeof applyOutcomeSchema>;
export type CatalogImportBatchOutcome = z.infer<typeof batchOutcomeSchema>;
export type CatalogImportFailureOutcome = z.infer<
  typeof leaseFailureOutcomeSchema | typeof preclaimFailureOutcomeSchema
>;
export type CatalogImportDispatchFailureOutcome = z.infer<
  typeof dispatchFailureOutcomeSchema
>;
export type CatalogImportRecoveryAction = Readonly<{
  importId: string;
  recoveryAction: "dispatch_required" | "retry_scheduled" | "cleanup_required";
  dispatchId: string;
}>;
export type CatalogImportCleanupResult = Readonly<{
  importId: string;
  redactedAt: Date;
}>;
export type CatalogImportLocator = Readonly<{
  status: "valid";
  locatorJobId: string;
  workspaceId: string;
  importId: string;
}>;
export type CatalogImportInvalidLocator = Readonly<{
  status: "queue_locator_invalid";
  locatorJobId: string;
  workspaceId: string | null;
  importId: string | null;
}>;
export type CatalogImportLocatorEntry =
  | CatalogImportLocator
  | CatalogImportInvalidLocator;
export type CatalogImportLocatorPage = Readonly<{
  locators: readonly CatalogImportLocatorEntry[];
  nextAfterJobId: string | null;
}>;

export type CatalogImportDatabase = Readonly<{
  claim(input: {
    workspaceId: string;
    importId: string;
    dispatchId: string;
    batchLimit: number;
  }): Promise<CatalogImportClaim | null>;
  applyRow(input: {
    workspaceId: string;
    importId: string;
    rowNumber: number;
    leaseToken: string;
    leaseGeneration: string;
  }): Promise<CatalogImportApplyOutcome>;
  completeBatch(input: {
    workspaceId: string;
    importId: string;
    leaseToken: string;
    leaseGeneration: string;
  }): Promise<CatalogImportBatchOutcome>;
  finalizeFailure(input: {
    workspaceId: string;
    importId: string;
    leaseToken: string;
    leaseGeneration: string;
    errorCode: "lease_lost" | "enqueue_failed" | "queue_locator_invalid";
  }): Promise<CatalogImportFailureOutcome>;
  recordPreclaimFailure(input: {
    workspaceId: string;
    importId: string;
    dispatchId: string;
    errorCode: "enqueue_failed" | "queue_locator_invalid";
  }): Promise<CatalogImportFailureOutcome>;
  recordDispatchFailure(input: {
    workspaceId: string;
    importId: string;
    dispatchId: string;
    errorCode: "enqueue_failed" | "queue_locator_invalid";
  }): Promise<CatalogImportDispatchFailureOutcome>;
}>;

export type CatalogImportDatabaseGateway = Readonly<{
  database: CatalogImportDatabase;
  listRecoveryLocators(input: {
    afterJobId: string | null;
    limit: number;
  }): Promise<CatalogImportLocatorPage>;
  listCleanupLocators(input: {
    afterJobId: string | null;
    limit: number;
  }): Promise<CatalogImportLocatorPage>;
  recoverDue(input: {
    workspaceId: string;
    limit: number;
  }): Promise<readonly CatalogImportRecoveryAction[]>;
  cleanupDue(input: {
    workspaceId: string;
    limit: number;
  }): Promise<readonly CatalogImportCleanupResult[]>;
  handleInvalidLocator(input: CatalogImportInvalidLocator): Promise<void>;
  probe(): Promise<void>;
  close(): Promise<void>;
}>;

export type CatalogImportWorkerDatabaseErrorCode =
  | "invalid_input"
  | "persistence_unavailable"
  | "enqueue_failed";

export class CatalogImportWorkerDatabaseError extends Error {
  constructor(public readonly code: CatalogImportWorkerDatabaseErrorCode) {
    super("catalog import worker database operation failed");
    this.name = "CatalogImportWorkerDatabaseError";
  }
}

function workerError(code: CatalogImportWorkerDatabaseErrorCode): never {
  throw new CatalogImportWorkerDatabaseError(code);
}

async function executeFunction(
  tx: TenantTx,
  statement: ReturnType<typeof sql>,
): Promise<unknown> {
  let rows: unknown[];
  try {
    rows = (await tx.execute(statement)).rows;
  } catch (error) {
    const state = error !== null && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    return workerError(
      state === "22023" || state === "22003"
        ? "invalid_input"
        : "persistence_unavailable",
    );
  }
  if (rows.length !== 1) return workerError("invalid_input");
  const parsed = functionRowSchema.safeParse(rows[0]);
  if (!parsed.success) return workerError("invalid_input");
  return parsed.data.result;
}

type DispatchKind = "import" | "cleanup";

async function enqueueDispatch(
  tx: TenantTx,
  workspaceId: string,
  importId: string,
  kind: DispatchKind,
  dispatchId: string = randomUUID(),
): Promise<void> {
  const procedure = kind === "import"
    ? "pgboss.enqueue_catalog_import_v1(uuid,uuid,uuid)"
    : "pgboss.enqueue_catalog_import_cleanup_v1(uuid,uuid,uuid)";
  let rows: unknown[];
  try {
    rows = (await tx.execute(sql`
      select case
               when pg_catalog.to_regnamespace('pgboss') is null then null
               else pg_catalog.to_regprocedure(${procedure})::text
             end as dispatch_signature,
             current_user::text as current_role,
             session_user::text as session_role,
             pg_catalog.current_database()::text as database_name
    `)).rows;
  } catch {
    return workerError("enqueue_failed");
  }
  if (rows.length !== 1) return workerError("enqueue_failed");
  const gate = dispatchGateSchema.safeParse(rows[0]);
  if (!gate.success) return workerError("enqueue_failed");
  if (gate.data.dispatch_signature === null) {
    const explicitTestSkip = gate.data.current_role === gate.data.session_role
      && (gate.data.current_role === "app_test" || gate.data.current_role === "app_ci")
      && gate.data.database_name.includes("test");
    if (explicitTestSkip) return;
    return workerError("enqueue_failed");
  }
  if (gate.data.dispatch_signature !== procedure) return workerError("enqueue_failed");
  try {
    if (kind === "import") {
      await tx.execute(sql`
        select pgboss.enqueue_catalog_import_v1(
          ${workspaceId}::uuid,
          ${importId}::uuid,
          ${dispatchId}::uuid
        )
      `);
    } else {
      await tx.execute(sql`
        select pgboss.enqueue_catalog_import_cleanup_v1(
          ${workspaceId}::uuid,
          ${importId}::uuid,
          ${dispatchId}::uuid
        )
      `);
    }
  } catch {
    workerError("enqueue_failed");
  }
}

function assertBoundImportId(value: object, importId: string): void {
  if ("importId" in value && value.importId !== importId) {
    workerError("invalid_input");
  }
}

async function dispatchFreshControlOutcome(
  tx: TenantTx,
  key: { workspaceId: string; importId: string },
  value: { status: string; replayed?: boolean },
): Promise<void> {
  if (value.replayed === true) return;
  if (value.status === "queued" || value.status === "retry_wait") {
    await enqueueDispatch(tx, key.workspaceId, key.importId, "import");
  } else if (
    value.status === "succeeded"
    || value.status === "partial"
    || value.status === "failed_final"
  ) {
    await enqueueDispatch(tx, key.workspaceId, key.importId, "cleanup");
  }
}

export async function claimCatalogImport(
  tx: TenantTx,
  value: unknown,
): Promise<CatalogImportClaim | null> {
  const input = claimInputSchema.safeParse(value);
  if (!input.success) return workerError("invalid_input");
  const key = input.data;
  const raw = await executeFunction(tx, sql`
    select public.claim_catalog_import_v1(
      ${key.workspaceId}::uuid,
      ${key.importId}::uuid,
      ${key.dispatchId}::uuid,
      ${key.batchLimit}::integer
    ) as result
  `);
  if (notClaimableSchema.safeParse(raw).success) return null;
  const claimed = claimedSchema.safeParse(raw);
  if (claimed.success) {
    if (
      claimed.data.importId !== key.importId
      || claimed.data.leaseToken !== key.dispatchId
      || claimed.data.rowNumbers.length > key.batchLimit
    ) return workerError("invalid_input");
    await enqueueDispatch(tx, key.workspaceId, key.importId, "import");
    return {
      workspaceId: key.workspaceId,
      importId: claimed.data.importId,
      leaseToken: claimed.data.leaseToken,
      leaseGeneration: claimed.data.leaseGeneration,
      rowNumbers: [...claimed.data.rowNumbers],
      leaseExpiresAt: claimed.data.leaseExpiresAt,
      replayed: claimed.data.replayed,
    };
  }
  const control = claimControlSchema.safeParse(raw);
  if (!control.success) return workerError("invalid_input");
  assertBoundImportId(control.data, key.importId);
  await dispatchFreshControlOutcome(tx, key, control.data);
  return null;
}

export async function applyCatalogImportRow(
  tx: TenantTx,
  value: unknown,
): Promise<CatalogImportApplyOutcome> {
  const input = applyInputSchema.safeParse(value);
  if (!input.success) return workerError("invalid_input");
  const key = input.data;
  const raw = await executeFunction(tx, sql`
    select public.apply_catalog_import_row_v1(
      ${key.workspaceId}::uuid,
      ${key.importId}::uuid,
      ${key.rowNumber}::integer,
      ${key.leaseToken}::uuid,
      ${key.leaseGeneration}::bigint
    ) as result
  `);
  const parsed = applyOutcomeSchema.safeParse(raw);
  if (!parsed.success) return workerError("invalid_input");
  assertBoundImportId(parsed.data, key.importId);
  if ("rowNumber" in parsed.data && parsed.data.rowNumber !== key.rowNumber) {
    return workerError("invalid_input");
  }
  if (parsed.data.status === "failed_final") {
    await enqueueDispatch(tx, key.workspaceId, key.importId, "cleanup");
  }
  return parsed.data;
}

export async function completeCatalogImportBatch(
  tx: TenantTx,
  value: unknown,
): Promise<CatalogImportBatchOutcome> {
  const input = leaseKeySchema.safeParse(value);
  if (!input.success) return workerError("invalid_input");
  const key = input.data;
  const raw = await executeFunction(tx, sql`
    select public.complete_catalog_import_batch_v1(
      ${key.workspaceId}::uuid,
      ${key.importId}::uuid,
      ${key.leaseToken}::uuid,
      ${key.leaseGeneration}::bigint
    ) as result
  `);
  const parsed = batchOutcomeSchema.safeParse(raw);
  if (!parsed.success) return workerError("invalid_input");
  assertBoundImportId(parsed.data, key.importId);
  if (
    "leaseGeneration" in parsed.data
    && parsed.data.leaseGeneration !== key.leaseGeneration
  ) return workerError("invalid_input");
  await dispatchFreshControlOutcome(tx, key, parsed.data);
  return parsed.data;
}

export async function finalizeCatalogImportFailure(
  tx: TenantTx,
  value: unknown,
): Promise<CatalogImportFailureOutcome> {
  const input = leaseFailureInputSchema.safeParse(value);
  if (!input.success) return workerError("invalid_input");
  const key = input.data;
  const raw = await executeFunction(tx, sql`
    select public.finalize_catalog_import_failure_v1(
      ${key.workspaceId}::uuid,
      ${key.importId}::uuid,
      ${key.leaseToken}::uuid,
      ${key.leaseGeneration}::bigint,
      ${key.errorCode}::text
    ) as result
  `);
  const parsed = leaseFailureOutcomeSchema.safeParse(raw);
  if (!parsed.success) return workerError("invalid_input");
  assertBoundImportId(parsed.data, key.importId);
  if (
    "leaseGeneration" in parsed.data
    && parsed.data.leaseGeneration !== key.leaseGeneration
  ) return workerError("invalid_input");
  await dispatchFreshControlOutcome(tx, key, parsed.data);
  return parsed.data;
}

export async function recordCatalogImportPreclaimFailure(
  tx: TenantTx,
  value: unknown,
): Promise<CatalogImportFailureOutcome> {
  const input = preclaimFailureInputSchema.safeParse(value);
  if (!input.success) return workerError("invalid_input");
  const key = input.data;
  const raw = await executeFunction(tx, sql`
    select public.record_catalog_import_preclaim_failure_v1(
      ${key.workspaceId}::uuid,
      ${key.importId}::uuid,
      ${key.dispatchId}::uuid,
      ${key.errorCode}::text
    ) as result
  `);
  const parsed = preclaimFailureOutcomeSchema.safeParse(raw);
  if (!parsed.success) return workerError("invalid_input");
  assertBoundImportId(parsed.data, key.importId);
  await dispatchFreshControlOutcome(tx, key, parsed.data);
  return parsed.data;
}

export async function recordCatalogImportDispatchFailure(
  tx: TenantTx,
  value: unknown,
): Promise<CatalogImportDispatchFailureOutcome> {
  const input = dispatchFailureInputSchema.safeParse(value);
  if (!input.success) return workerError("invalid_input");
  const key = input.data;
  const raw = await executeFunction(tx, sql`
    select public.record_catalog_import_dispatch_failure_v1(
      ${key.workspaceId}::uuid,
      ${key.importId}::uuid,
      ${key.dispatchId}::uuid,
      ${key.errorCode}::text
    ) as result
  `);
  const parsed = dispatchFailureOutcomeSchema.safeParse(raw);
  if (!parsed.success) return workerError("invalid_input");
  assertBoundImportId(parsed.data, key.importId);
  if (parsed.data.status === "conflict") return workerError("invalid_input");
  await dispatchFreshControlOutcome(tx, key, parsed.data);
  return parsed.data;
}

export async function recoverDueCatalogImports(
  tx: TenantTx,
  value: unknown,
): Promise<readonly CatalogImportRecoveryAction[]> {
  const input = tenantSweepInputSchema.safeParse(value);
  if (!input.success) return workerError("invalid_input");
  let rows: unknown[];
  try {
    rows = (await tx.execute(sql`
      select import_id, recovery_action, dispatch_id
        from public.recover_catalog_imports_v1(
          ${input.data.workspaceId}::uuid,
          ${input.data.limit}::integer
        )
       order by import_id
    `)).rows;
  } catch {
    return workerError("persistence_unavailable");
  }
  if (rows.length > input.data.limit) return workerError("invalid_input");
  const results = rows.map((row) => {
    const parsed = recoveryRowSchema.safeParse(row);
    if (!parsed.success) return workerError("invalid_input");
    return {
      importId: parsed.data.import_id,
      recoveryAction: parsed.data.recovery_action,
      dispatchId: parsed.data.dispatch_id,
    };
  });
  for (const result of results) {
    await enqueueDispatch(
      tx,
      input.data.workspaceId,
      result.importId,
      result.recoveryAction === "cleanup_required" ? "cleanup" : "import",
      result.dispatchId,
    );
  }
  return results;
}

export async function cleanupDueCatalogImports(
  tx: TenantTx,
  value: unknown,
): Promise<readonly CatalogImportCleanupResult[]> {
  const input = tenantSweepInputSchema.safeParse(value);
  if (!input.success) return workerError("invalid_input");
  let rows: unknown[];
  try {
    rows = (await tx.execute(sql`
      select import_id, redacted_at
        from public.cleanup_catalog_import_snapshots_v1(
          ${input.data.workspaceId}::uuid,
          ${input.data.limit}::integer
        )
       order by import_id
    `)).rows;
  } catch {
    return workerError("persistence_unavailable");
  }
  if (rows.length > input.data.limit) return workerError("invalid_input");
  return rows.map((row) => {
    const parsed = cleanupRowSchema.safeParse(row);
    if (!parsed.success) return workerError("invalid_input");
    return { importId: parsed.data.import_id, redactedAt: parsed.data.redacted_at };
  });
}

async function listLocators(
  pool: Pool,
  value: unknown,
  kind: DispatchKind,
): Promise<CatalogImportLocatorPage> {
  const input = locatorPageInputSchema.safeParse(value);
  if (!input.success) return workerError("invalid_input");
  const functionName = kind === "import"
    ? "pgboss.list_catalog_import_recovery_locator_jobs_v1"
    : "pgboss.list_catalog_import_cleanup_locator_jobs_v1";
  let rows: unknown[];
  try {
    rows = (await pool.query(
      `select locator_job_id, workspace_id, import_id
              , locator_status
         from ${functionName}($1::uuid, $2::integer)
        order by locator_job_id`,
      [input.data.afterJobId, input.data.limit],
    )).rows;
  } catch (error) {
    const state = error !== null && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    return workerError(state === "22023" ? "invalid_input" : "persistence_unavailable");
  }
  if (rows.length > input.data.limit) return workerError("invalid_input");
  const locators = rows.map((row) => {
    const parsed = locatorRowSchema.safeParse(row);
    if (!parsed.success) return workerError("invalid_input");
    if (parsed.data.locator_status === "valid") {
      return {
        status: "valid" as const,
        locatorJobId: parsed.data.locator_job_id,
        workspaceId: parsed.data.workspace_id,
        importId: parsed.data.import_id,
      };
    }
    return {
      status: "queue_locator_invalid" as const,
      locatorJobId: parsed.data.locator_job_id,
      workspaceId: parsed.data.workspace_id,
      importId: parsed.data.import_id,
    };
  });
  for (let index = 0; index < locators.length; index += 1) {
    const previous = index === 0
      ? input.data.afterJobId
      : locators[index - 1]!.locatorJobId;
    if (previous !== null && locators[index]!.locatorJobId.localeCompare(previous) <= 0) {
      return workerError("invalid_input");
    }
  }
  return {
    locators,
    nextAfterJobId: locators.length === input.data.limit
      ? locators.at(-1)?.locatorJobId ?? null
      : null,
  };
}

async function quarantineInvalidLocator(pool: Pool, locatorJobId: string): Promise<void> {
  let rows: unknown[];
  try {
    rows = (await pool.query(
      `select pgboss.quarantine_catalog_import_locator_job_v1($1::uuid)
         as quarantined`,
      [locatorJobId],
    )).rows;
  } catch (error) {
    const state = error !== null && typeof error === "object"
      ? (error as { code?: unknown }).code
      : undefined;
    return workerError(state === "22023" ? "invalid_input" : "persistence_unavailable");
  }
  if (rows.length !== 1 || !quarantineRowSchema.safeParse(rows[0]).success) {
    return workerError("invalid_input");
  }
}

/** Dedicated least-privilege app_worker pool; row application stays in SQL. */
export function createCatalogImportDatabaseGateway(
  connectionString: string,
  onPoolError: (error: Error) => void,
  max = 2,
): CatalogImportDatabaseGateway {
  const pool = new Pool(servicePoolConfig(connectionString, "app_worker", max));
  pool.on("error", onPoolError);
  let closePromise: Promise<void> | undefined;
  const database: CatalogImportDatabase = {
    claim: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      claimCatalogImport(tx, input)),
    applyRow: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      applyCatalogImportRow(tx, input)),
    completeBatch: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      completeCatalogImportBatch(tx, input)),
    finalizeFailure: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      finalizeCatalogImportFailure(tx, input)),
    recordPreclaimFailure: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      recordCatalogImportPreclaimFailure(tx, input)),
    recordDispatchFailure: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      recordCatalogImportDispatchFailure(tx, input)),
  };
  return {
    database,
    listRecoveryLocators: (input) => listLocators(pool, input, "import"),
    listCleanupLocators: (input) => listLocators(pool, input, "cleanup"),
    recoverDue: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      recoverDueCatalogImports(tx, input)),
    cleanupDue: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      cleanupDueCatalogImports(tx, input)),
    async handleInvalidLocator(input) {
      let shouldQuarantine = input.workspaceId === null || input.importId === null;
      if (!shouldQuarantine) {
        const outcome = await database.recordDispatchFailure({
          workspaceId: input.workspaceId!,
          importId: input.importId!,
          dispatchId: input.locatorJobId,
          errorCode: "queue_locator_invalid",
        });
        shouldQuarantine = outcome.status !== "superseded"
          || outcome.state === "missing"
          || outcome.state === "succeeded"
          || outcome.state === "partial"
          || outcome.state === "failed_final"
          || outcome.state === "cancelled_before_start";
      }
      if (shouldQuarantine) {
        await quarantineInvalidLocator(pool, input.locatorJobId);
      }
    },
    async probe() {
      await pool.query("select 1");
    },
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
