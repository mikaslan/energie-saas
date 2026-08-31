import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { TenantTx } from "@/lib/db/types";
import {
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  canonicalizeCatalogJson,
  sealCatalogComponentRevision,
  validateCatalogComponentRevision,
  type CatalogComponentRevisionV1,
  type CatalogComponentStatus,
  type CatalogComponentType,
} from "@/lib/integrations/catalog/contract";
import {
  CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION,
  applyCatalogCsvPreviewCatalogConflicts,
  catalogCsvColumnMappingV1Schema,
  catalogCsvJobErrorCodeSchema,
  catalogCsvPreviewV1Schema,
  catalogCsvProcessingResultCodeSchema,
  catalogCsvRequestErrorCodeSchema,
  renderCatalogCsvErrorReport,
  catalogCsvRowErrorV1Schema,
  parseCatalogImportSourceCommand,
  sealCatalogImportPrepareV1,
  sealCatalogImportRowCommand,
  type CatalogCsvCatalogConflict,
  type CatalogCsvColumnMappingV1,
  type CatalogCsvPreviewV1,
  type CatalogCsvRowErrorV1,
  type CatalogImportExpectedComponentV1,
  type CatalogImportPrepareV1,
  type CatalogImportSourceCommandV1,
} from "@/lib/integrations/catalog/import-contract";
import { CATALOG_IMPORT_JOB_STATES } from "@/lib/integrations/catalog/import-wire";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type Action,
  type ServiceCtx,
} from "@/lib/permissions";

const uuidSchema = z.uuid().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
);
const jobStateSchema = z.enum(CATALOG_IMPORT_JOB_STATES);
const databaseInstantSchema = z.union([z.date(), z.string().min(1)])
  .transform((value, context) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) {
      context.addIssue({ code: "custom", message: "invalid database instant" });
      return z.NEVER;
    }
    return date.toISOString();
  });
const prepareCommandSchema = z.strictObject({
  intentId: uuidSchema,
  preview: catalogCsvPreviewV1Schema,
});
const startCommandSchema = z.strictObject({
  importId: uuidSchema,
  attestationVersion: z.literal(CATALOG_IMPORT_RIGHTS_ATTESTATION_VERSION),
});
const cancelCommandSchema = z.strictObject({ importId: uuidSchema });
const readCommandSchema = z.strictObject({ importId: uuidSchema });
const latestImportIdRowSchema = z.strictObject({
  latest_import_id: uuidSchema.nullable(),
});
const readRowsCommandSchema = readCommandSchema.extend({
  afterRow: z.int().safe().min(1).max(1_001),
  limit: z.int().safe().min(1).max(100),
});
const functionRowSchema = z.strictObject({ result: z.unknown() });
const dispatchGateSchema = z.strictObject({
  dispatch_signature: z.string().nullable(),
  current_role: z.string().min(1),
  session_role: z.string().min(1),
  database_name: z.string().min(1),
});
const countSchema = z.int().safe().min(0).max(1_000);
const prepareResultSchema = z.union([
  z.strictObject({
    status: jobStateSchema,
    importId: uuidSchema,
    intentId: uuidSchema,
    totalCount: z.int().safe().min(1).max(1_000),
    validCount: countSchema,
    invalidCount: countSchema,
    previewExpiresAt: databaseInstantSchema,
    replayed: z.boolean(),
  }).superRefine((value, context) => {
    if (value.validCount + value.invalidCount !== value.totalCount) {
      context.addIssue({ code: "custom", path: ["totalCount"], message: "count drift" });
    }
  }),
  z.strictObject({
    status: z.literal("conflict"),
    code: z.literal("intent_reused"),
  }),
]);
const startResultSchema = z.union([
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({
    status: z.literal("conflict"),
    code: z.enum(["invalid_attestation", "invalid_persisted_input"]),
  }),
  z.strictObject({
    status: z.literal("conflict"),
    state: jobStateSchema,
  }),
  z.strictObject({
    status: z.literal("replayed"),
    state: jobStateSchema,
    importId: uuidSchema,
    dispatchRequired: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("queued"),
    importId: uuidSchema,
    replayed: z.literal(false),
    dispatchRequired: z.literal(true),
    nextAttemptAt: databaseInstantSchema,
  }),
  z.strictObject({
    status: z.literal("cancelled_before_start"),
    importId: uuidSchema,
    cleanupDispatchAt: databaseInstantSchema,
  }),
]);
const cancelResultSchema = z.union([
  z.strictObject({ status: z.literal("not_found") }),
  z.strictObject({
    status: z.literal("conflict"),
    state: jobStateSchema,
  }),
  z.strictObject({
    status: z.literal("cancelled_before_start"),
    importId: uuidSchema,
    replayed: z.boolean(),
    cleanupDispatchAt: databaseInstantSchema,
  }),
]);
const jobReadRowSchema = z.strictObject({
  import_id: uuidSchema,
  intent_id: uuidSchema,
  file_name: z.string().min(1).max(180).nullable(),
  file_size_bytes: z.int().safe().min(1).max(1_048_576),
  encoding: z.enum(["utf-8", "windows-1252"]),
  delimiter: z.enum([";", ","]),
  mapping_snapshot: z.unknown().nullable(),
  total_count: z.int().safe().min(1).max(1_000),
  valid_count: countSchema,
  invalid_count: countSchema,
  state: jobStateSchema,
  consecutive_failure_count: z.int().safe().min(0).max(3),
  next_attempt_at: databaseInstantSchema.nullable(),
  error_code: catalogCsvJobErrorCodeSchema.nullable(),
  created_by: uuidSchema,
  execution_actor_id: uuidSchema.nullable(),
  attested_by: uuidSchema.nullable(),
  attested_at: databaseInstantSchema.nullable(),
  created_at: databaseInstantSchema,
  preview_expires_at: databaseInstantSchema,
  started_at: databaseInstantSchema.nullable(),
  terminal_at: databaseInstantSchema.nullable(),
  snapshot_cleanup_due_at: databaseInstantSchema.nullable(),
  snapshot_redacted_at: databaseInstantSchema.nullable(),
  created_result_count: countSchema,
  revised_result_count: countSchema,
  unchanged_result_count: countSchema,
  conflict_result_count: countSchema,
});
const importRowReadSchema = z.strictObject({
  row_number: z.int().safe().min(2).max(1_001),
  validation_status: z.enum(["valid", "invalid"]),
  normalized_sku: z.string().regex(/^[A-Z0-9][A-Z0-9._-]{0,63}$/u).nullable(),
  operation: z.enum(["create", "revise", "unchanged"]).nullable(),
  source_command: z.unknown().nullable(),
  error_snapshot: z.unknown().nullable(),
  target_component_id: uuidSchema.nullable(),
  expected_component_id: uuidSchema.nullable(),
  expected_revision: z.int().safe().min(1).max(2_147_483_647).nullable(),
  expected_status: z.enum(["draft", "active"]).nullable(),
  result_state: z.enum(["created", "revised", "unchanged", "conflict"]).nullable(),
  result_component_id: uuidSchema.nullable(),
  result_revision: z.int().safe().min(1).max(2_147_483_647).nullable(),
  result_error_code: catalogCsvProcessingResultCodeSchema.nullable(),
  result_created_at: databaseInstantSchema.nullable(),
});

export type CatalogImportPrepareResult = Exclude<
  z.infer<typeof prepareResultSchema>,
  { status: "conflict" }
>;
export type CatalogImportStartResult = z.infer<typeof startResultSchema>;
export type CatalogImportCancelResult = z.infer<typeof cancelResultSchema>;

export type CatalogImportDetails = Readonly<{
  importId: string;
  intentId: string;
  fileName: string | null;
  fileSizeBytes: number;
  encoding: "utf-8" | "windows-1252";
  delimiter: ";" | ",";
  mapping: CatalogCsvColumnMappingV1 | null;
  counts: Readonly<{ total: number; valid: number; invalid: number }>;
  state: z.infer<typeof jobStateSchema>;
  consecutiveFailureCount: number;
  nextAttemptAt: string | null;
  errorCode: z.infer<typeof catalogCsvJobErrorCodeSchema> | null;
  createdBy: string;
  executionActorId: string | null;
  attestedBy: string | null;
  attestedAt: string | null;
  createdAt: string;
  previewExpiresAt: string;
  startedAt: string | null;
  terminalAt: string | null;
  snapshotCleanupDueAt: string | null;
  snapshotRedactedAt: string | null;
  resultCounts: Readonly<{
    created: number;
    revised: number;
    unchanged: number;
    conflict: number;
  }>;
}>;

export type CatalogImportRowReadModel = Readonly<{
  rowNumber: number;
  validationStatus: "valid" | "invalid";
  normalizedSku: string | null;
  operation: "create" | "revise" | "unchanged" | null;
  sourceCommand: CatalogImportSourceCommandV1 | null;
  errors: CatalogCsvRowErrorV1[] | null;
  targetComponentId: string | null;
  expectedComponentId: string | null;
  expectedRevision: number | null;
  expectedStatus: "draft" | "active" | null;
  result: null | Readonly<{
    state: "created" | "revised" | "unchanged" | "conflict";
    componentId: string | null;
    revision: number | null;
    errorCode: z.infer<typeof catalogCsvProcessingResultCodeSchema> | null;
    createdAt: string;
  }>;
}>;

export type CatalogImportRowsPage = Readonly<{
  rows: readonly CatalogImportRowReadModel[];
  nextAfterRow: number | null;
}>;

type CurrentCatalogRow = {
  id: string;
  workspace_id: string;
  internal_sku: string;
  component_type: CatalogComponentType;
  status: CatalogComponentStatus;
  current_revision: number;
  revision_snapshot: unknown;
  snapshot_sha256_hex: string;
  [key: string]: unknown;
};

export class CatalogImportInputError extends Error {
  constructor(
    public readonly paths: string[],
    public readonly code: z.infer<typeof catalogCsvRequestErrorCodeSchema> = "invalid_file",
  ) {
    super("catalog import input is invalid");
    this.name = "CatalogImportInputError";
  }
}

export class CatalogImportConflictError extends Error {
  constructor(public readonly code: "catalog_changed" | "intent_reused") {
    super("catalog import conflicts with current state");
    this.name = "CatalogImportConflictError";
  }
}

export class CatalogImportIntegrityError extends Error {
  constructor() {
    super("catalog import database response failed integrity validation");
    this.name = "CatalogImportIntegrityError";
  }
}

export class CatalogImportPersistenceError extends Error {
  constructor() {
    super("catalog import persistence failed");
    this.name = "CatalogImportPersistenceError";
  }
}

export class CatalogImportDispatchError extends Error {
  constructor() {
    super("catalog import dispatch is unavailable");
    this.name = "CatalogImportDispatchError";
  }
}

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => (
    issue.path.length === 0 ? "/" : `/${issue.path.map(String).join("/")}`
  )))].slice(0, 20);
}

export function assertCatalogImportAccess(ctx: ServiceCtx): void {
  const requirements: ReadonlyArray<[Action, string]> = [
    ["catalog.manage", "catalog_import"],
    ["price.edit", "catalog_import_pricing"],
    ["price.read_purchase", "catalog_import_purchase_prices"],
  ];
  for (const [action, resource] of requirements) {
    if (!can(ctx, action)) {
      throw new PermissionDeniedError(action, resource, undefined, ctx.actor);
    }
  }
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      "catalog.manage",
      "catalog_import",
      "external_only",
      ctx.actor,
    );
  }
}

function sqlState(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  if (candidate.cause !== null && typeof candidate.cause === "object") {
    const cause = candidate.cause as { code?: unknown };
    if (typeof cause.code === "string") return cause.code;
  }
  return undefined;
}

async function executeFunction(
  tx: TenantTx,
  statement: ReturnType<typeof sql>,
  ctx: ServiceCtx,
): Promise<unknown> {
  try {
    const rows = (await tx.execute(statement)).rows;
    if (rows.length !== 1) throw new CatalogImportIntegrityError();
    const parsed = functionRowSchema.safeParse(rows[0]);
    if (!parsed.success) throw new CatalogImportIntegrityError();
    return parsed.data.result;
  } catch (error) {
    if (
      error instanceof CatalogImportIntegrityError
      || error instanceof PermissionDeniedError
    ) throw error;
    const state = sqlState(error);
    if (state === "42501") {
      throw new PermissionDeniedError(
        "catalog.manage",
        "catalog_import",
        "database_reauthorization",
        ctx.actor,
      );
    }
    if (state === "40001") throw new CatalogImportConflictError("catalog_changed");
    if (state === "22023" || state === "54000") {
      throw new CatalogImportInputError(
        ["/preview"],
        state === "54000" ? "snapshot_budget_exceeded" : "invalid_file",
      );
    }
    throw new CatalogImportPersistenceError();
  }
}

function currentSnapshot(row: CurrentCatalogRow, workspaceId: string) {
  const parsed = validateCatalogComponentRevision(row.revision_snapshot);
  if (
    !parsed.ok
    || row.workspace_id !== workspaceId
    || parsed.value.identity.workspaceId !== workspaceId
    || parsed.value.identity.componentId !== row.id
    || parsed.value.identity.revision !== row.current_revision
    || parsed.value.identity.internalSku !== row.internal_sku
    || parsed.value.identity.componentType !== row.component_type
    || parsed.value.snapshotSha256 !== row.snapshot_sha256_hex
  ) throw new CatalogImportIntegrityError();
  return parsed.value;
}

function catalogPayload(value: Pick<
  CatalogComponentRevisionV1,
  "presentation" | "technicalData" | "commercial" | "technicalProvenance"
>): string {
  return canonicalizeCatalogJson({
    presentation: value.presentation,
    technicalData: value.technicalData,
    commercial: value.commercial,
    technicalProvenance: value.technicalProvenance,
  });
}

async function readCurrentCatalogBySku(
  tx: TenantTx,
  workspaceId: string,
  preview: CatalogCsvPreviewV1,
): Promise<Map<string, CurrentCatalogRow>> {
  const skus = preview.rows.flatMap((row) => row.status === "valid"
    ? [row.normalizedSku.toLocaleLowerCase("en-US")]
    : []);
  if (skus.length === 0) return new Map();
  let result;
  try {
    result = await tx.execute<CurrentCatalogRow>(sql`
      select component.id, component.workspace_id, component.internal_sku,
             component.component_type, component.status,
             component.current_revision, revision.revision_snapshot,
             pg_catalog.encode(revision.snapshot_sha256, 'hex')
               as snapshot_sha256_hex
        from public.catalog_component as component
        join public.catalog_component_revision as revision
          on revision.workspace_id = component.workspace_id
         and revision.component_id = component.id
         and revision.revision = component.current_revision
       where component.workspace_id = ${workspaceId}::uuid
         and pg_catalog.lower(component.internal_sku) in (
           ${sql.join(skus.map((sku) => sql`${sku}`), sql`, `)}
         )
       order by component.id
    `);
  } catch {
    throw new CatalogImportPersistenceError();
  }
  const bySku = new Map<string, CurrentCatalogRow>();
  for (const row of result.rows) {
    const key = row.internal_sku.toLocaleUpperCase("en-US");
    if (bySku.has(key)) throw new CatalogImportIntegrityError();
    currentSnapshot(row, workspaceId);
    bySku.set(key, row);
  }
  return bySku;
}

function buildPreparedRows(
  workspaceId: string,
  preview: CatalogCsvPreviewV1,
  currentBySku: ReadonlyMap<string, CurrentCatalogRow>,
): { preview: CatalogCsvPreviewV1; prepare: CatalogImportPrepareV1 } {
  const conflicts: CatalogCsvCatalogConflict[] = [];
  for (const row of preview.rows) {
    if (row.status !== "valid") continue;
    const existing = currentBySku.get(row.normalizedSku);
    if (existing === undefined) continue;
    if (existing.component_type !== row.command.componentType) {
      conflicts.push({ rowNumber: row.rowNumber, code: "sku_type_conflict" });
    } else if (existing.status === "archived") {
      conflicts.push({
        rowNumber: row.rowNumber,
        code: "archived_requires_manual_reactivation",
      });
    }
  }
  const enriched = applyCatalogCsvPreviewCatalogConflicts(preview, conflicts);
  const rows = enriched.rows.map((row) => {
    if (row.status === "invalid") return row;
    const existing = currentBySku.get(row.normalizedSku);
    let operation: "create" | "revise" | "unchanged";
    let targetComponentId: string;
    let expected: CatalogImportExpectedComponentV1 | null;
    let sealedTarget: CatalogComponentRevisionV1 | null;
    if (existing === undefined) {
      operation = "create";
      targetComponentId = randomUUID();
      expected = null;
      sealedTarget = sealCatalogComponentRevision({
        schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
        canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
        identity: {
          workspaceId,
          componentId: targetComponentId,
          revision: 1,
          internalSku: row.command.internalSku,
          componentType: row.command.componentType,
        },
        presentation: row.command.presentation,
        technicalData: row.command.technicalData,
        commercial: row.command.commercial,
        technicalProvenance: row.command.technicalProvenance,
      });
    } else {
      const current = currentSnapshot(existing, workspaceId);
      targetComponentId = existing.id;
      expected = {
        componentId: existing.id,
        revision: existing.current_revision,
        status: existing.status as "draft" | "active",
        snapshotSha256: existing.snapshot_sha256_hex,
        internalSku: existing.internal_sku,
        componentType: existing.component_type,
      };
      operation = catalogPayload(current) === catalogPayload(row.command)
        ? "unchanged"
        : "revise";
      sealedTarget = operation === "unchanged" ? null : sealCatalogComponentRevision({
        schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
        canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
        identity: {
          ...current.identity,
          revision: current.identity.revision + 1,
        },
        presentation: row.command.presentation,
        technicalData: row.command.technicalData,
        commercial: row.command.commercial,
        technicalProvenance: row.command.technicalProvenance,
      });
    }
    return {
      status: "valid" as const,
      command: sealCatalogImportRowCommand({
        fileSha256: enriched.file.sha256,
        mappingSha256: enriched.mappingSha256,
        sourceRow: row,
        operation,
        targetComponentId,
        expected,
        sealedTarget,
      }),
    };
  });
  return {
    preview: enriched,
    prepare: sealCatalogImportPrepareV1({ workspaceId, preview: enriched, rows }),
  };
}

type DispatchKind = "import" | "cleanup";

async function enqueueCatalogImportDispatch(
  tx: TenantTx,
  workspaceId: string,
  importId: string,
  kind: DispatchKind,
): Promise<void> {
  const procedure = kind === "import"
    ? "pgboss.enqueue_catalog_import_v1(uuid,uuid,uuid)"
    : "pgboss.enqueue_catalog_import_cleanup_v1(uuid,uuid,uuid)";
  let rows: unknown[];
  try {
    rows = (await tx.execute(sql`
      select pg_catalog.to_regprocedure(${procedure})::text as dispatch_signature,
             current_user::text as current_role,
             session_user::text as session_role,
             pg_catalog.current_database()::text as database_name
    `)).rows;
  } catch {
    throw new CatalogImportDispatchError();
  }
  if (rows.length !== 1) throw new CatalogImportDispatchError();
  const gate = dispatchGateSchema.safeParse(rows[0]);
  if (!gate.success) throw new CatalogImportDispatchError();
  if (gate.data.dispatch_signature === null) {
    const explicitTestSkip = gate.data.current_role === gate.data.session_role
      && (gate.data.current_role === "app_test" || gate.data.current_role === "app_ci")
      && gate.data.database_name.includes("test");
    if (explicitTestSkip) return;
    throw new CatalogImportDispatchError();
  }
  if (gate.data.dispatch_signature !== procedure) {
    throw new CatalogImportDispatchError();
  }
  const dispatchId = randomUUID();
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
    throw new CatalogImportDispatchError();
  }
}

function dispatchKindForState(state: z.infer<typeof jobStateSchema>): DispatchKind | null {
  if (state === "queued" || state === "retry_wait" || state === "running") {
    return "import";
  }
  if (
    state === "ready_for_review"
    || state === "succeeded"
    || state === "partial"
    || state === "failed_final"
    || state === "cancelled_before_start"
  ) return "cleanup";
  return null;
}

export async function prepareCatalogImport(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<CatalogImportPrepareResult> {
  assertCatalogImportAccess(ctx);
  const parsed = prepareCommandSchema.safeParse(value);
  if (!parsed.success) throw new CatalogImportInputError(issuePaths(parsed.error));
  const currentBySku = await readCurrentCatalogBySku(tx, ctx.workspaceId, parsed.data.preview);
  const { preview: preparedPreview, prepare } = buildPreparedRows(
    ctx.workspaceId,
    parsed.data.preview,
    currentBySku,
  );
  const raw = await executeFunction(tx, sql`
    select public.prepare_catalog_import_v1(
      ${ctx.workspaceId}::uuid,
      ${parsed.data.intentId}::uuid,
      ${JSON.stringify(prepare)}::jsonb
    ) as result
  `, ctx);
  const result = prepareResultSchema.safeParse(raw);
  if (!result.success) throw new CatalogImportIntegrityError();
  if (result.data.status === "conflict") {
    throw new CatalogImportConflictError("intent_reused");
  }
  if (result.data.intentId !== parsed.data.intentId) {
    throw new CatalogImportIntegrityError();
  }
  if (
    result.data.totalCount !== preparedPreview.counts.total
    || result.data.validCount !== preparedPreview.counts.valid
    || result.data.invalidCount !== preparedPreview.counts.invalid
    || (!result.data.replayed && result.data.status !== "ready_for_review")
  ) throw new CatalogImportIntegrityError();
  const kind = result.data.replayed ? null : dispatchKindForState(result.data.status);
  if (kind !== null) {
    await enqueueCatalogImportDispatch(tx, ctx.workspaceId, result.data.importId, kind);
  }
  return result.data;
}

export async function startCatalogImport(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<CatalogImportStartResult> {
  assertCatalogImportAccess(ctx);
  const parsed = startCommandSchema.safeParse(value);
  if (!parsed.success) throw new CatalogImportInputError(issuePaths(parsed.error));
  const raw = await executeFunction(tx, sql`
    select public.start_catalog_import_v1(
      ${ctx.workspaceId}::uuid,
      ${parsed.data.importId}::uuid,
      ${parsed.data.attestationVersion}::text
    ) as result
  `, ctx);
  const result = startResultSchema.safeParse(raw);
  if (!result.success) throw new CatalogImportIntegrityError();
  if ("importId" in result.data && result.data.importId !== parsed.data.importId) {
    throw new CatalogImportIntegrityError();
  }
  if (result.data.status === "queued") {
    await enqueueCatalogImportDispatch(
      tx,
      ctx.workspaceId,
      result.data.importId,
      "import",
    );
  } else if (result.data.status === "cancelled_before_start") {
    await enqueueCatalogImportDispatch(
      tx,
      ctx.workspaceId,
      result.data.importId,
      "cleanup",
    );
  } else if (result.data.status === "replayed") {
    const dispatchExpected = result.data.state === "queued"
      || result.data.state === "retry_wait";
    if (result.data.dispatchRequired !== dispatchExpected) {
      throw new CatalogImportIntegrityError();
    }
    const kind = result.data.dispatchRequired
      ? dispatchKindForState(result.data.state)
      : null;
    if (result.data.dispatchRequired && kind !== "import") {
      throw new CatalogImportIntegrityError();
    }
    if (kind === "import") {
      await enqueueCatalogImportDispatch(tx, ctx.workspaceId, result.data.importId, "import");
    }
  }
  return result.data;
}

export async function cancelCatalogImport(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<CatalogImportCancelResult> {
  assertCatalogImportAccess(ctx);
  const parsed = cancelCommandSchema.safeParse(value);
  if (!parsed.success) throw new CatalogImportInputError(issuePaths(parsed.error));
  const raw = await executeFunction(tx, sql`
    select public.cancel_catalog_import_v1(
      ${ctx.workspaceId}::uuid,
      ${parsed.data.importId}::uuid
    ) as result
  `, ctx);
  const result = cancelResultSchema.safeParse(raw);
  if (!result.success) throw new CatalogImportIntegrityError();
  if ("importId" in result.data && result.data.importId !== parsed.data.importId) {
    throw new CatalogImportIntegrityError();
  }
  if (result.data.status === "cancelled_before_start" && !result.data.replayed) {
    await enqueueCatalogImportDispatch(
      tx,
      ctx.workspaceId,
      result.data.importId,
      "cleanup",
    );
  }
  return result.data;
}

export async function getCatalogImport(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<CatalogImportDetails | null> {
  assertCatalogImportAccess(ctx);
  const input = readCommandSchema.safeParse(value);
  if (!input.success) throw new CatalogImportInputError(issuePaths(input.error));
  let rows: unknown[];
  try {
    rows = (await tx.execute(sql`
      select *
        from public.read_catalog_import_v1(
          ${ctx.workspaceId}::uuid,
          ${input.data.importId}::uuid
        )
    `)).rows;
  } catch (error) {
    if (sqlState(error) === "42501") {
      throw new PermissionDeniedError(
        "catalog.manage",
        "catalog_import",
        "database_reauthorization",
        ctx.actor,
      );
    }
    throw new CatalogImportPersistenceError();
  }
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new CatalogImportIntegrityError();
  const parsed = jobReadRowSchema.safeParse(rows[0]);
  if (!parsed.success) throw new CatalogImportIntegrityError();
  const row = parsed.data;
  if (
    row.import_id !== input.data.importId
    || row.valid_count + row.invalid_count !== row.total_count
    || row.created_result_count + row.revised_result_count
      + row.unchanged_result_count + row.conflict_result_count > row.valid_count
  ) throw new CatalogImportIntegrityError();
  const mapping = row.mapping_snapshot === null
    ? null
    : catalogCsvColumnMappingV1Schema.safeParse(row.mapping_snapshot);
  if (mapping !== null && !mapping.success) throw new CatalogImportIntegrityError();
  if (
    (row.snapshot_redacted_at === null
      && (row.file_name === null || mapping === null))
    || (row.snapshot_redacted_at !== null
      && (row.file_name !== null || mapping !== null))
  ) throw new CatalogImportIntegrityError();
  return {
    importId: row.import_id,
    intentId: row.intent_id,
    fileName: row.file_name,
    fileSizeBytes: row.file_size_bytes,
    encoding: row.encoding,
    delimiter: row.delimiter,
    mapping: mapping === null ? null : mapping.data,
    counts: {
      total: row.total_count,
      valid: row.valid_count,
      invalid: row.invalid_count,
    },
    state: row.state,
    consecutiveFailureCount: row.consecutive_failure_count,
    nextAttemptAt: row.next_attempt_at,
    errorCode: row.error_code,
    createdBy: row.created_by,
    executionActorId: row.execution_actor_id,
    attestedBy: row.attested_by,
    attestedAt: row.attested_at,
    createdAt: row.created_at,
    previewExpiresAt: row.preview_expires_at,
    startedAt: row.started_at,
    terminalAt: row.terminal_at,
    snapshotCleanupDueAt: row.snapshot_cleanup_due_at,
    snapshotRedactedAt: row.snapshot_redacted_at,
    resultCounts: {
      created: row.created_result_count,
      revised: row.revised_result_count,
      unchanged: row.unchanged_result_count,
      conflict: row.conflict_result_count,
    },
  };
}

export async function getLatestCatalogImport(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<CatalogImportDetails | null> {
  assertCatalogImportAccess(ctx);
  let rows: unknown[];
  try {
    rows = (await tx.execute(sql`
      select public.read_latest_catalog_import_id_v1(
        ${ctx.workspaceId}::uuid
      ) as latest_import_id
    `)).rows;
  } catch (error) {
    if (sqlState(error) === "42501") {
      throw new PermissionDeniedError(
        "catalog.manage",
        "catalog_import",
        "database_reauthorization",
        ctx.actor,
      );
    }
    throw new CatalogImportPersistenceError();
  }
  if (rows.length !== 1) throw new CatalogImportIntegrityError();
  const parsed = latestImportIdRowSchema.safeParse(rows[0]);
  if (!parsed.success) throw new CatalogImportIntegrityError();
  if (parsed.data.latest_import_id === null) return null;
  return getCatalogImport(tx, ctx, {
    importId: parsed.data.latest_import_id,
  });
}

function mapCatalogImportRow(
  value: z.infer<typeof importRowReadSchema>,
): CatalogImportRowReadModel {
  let sourceCommand: CatalogImportSourceCommandV1 | null = null;
  if (value.source_command !== null) {
    try {
      sourceCommand = parseCatalogImportSourceCommand(value.source_command);
    } catch {
      throw new CatalogImportIntegrityError();
    }
  }
  const errors = value.error_snapshot === null
    ? null
    : z.array(catalogCsvRowErrorV1Schema).min(1).max(20)
      .safeParse(value.error_snapshot);
  if (errors !== null && !errors.success) throw new CatalogImportIntegrityError();
  if (value.validation_status === "valid") {
    if (
      value.operation === null
      || value.target_component_id === null
      || value.error_snapshot !== null
      || (value.source_command === null && value.normalized_sku !== null)
      || (value.source_command !== null && value.normalized_sku === null)
      || (sourceCommand !== null && sourceCommand.internalSku !== value.normalized_sku)
      || (value.operation === "create" && (
        value.expected_component_id !== null
        || value.expected_revision !== null
        || value.expected_status !== null
      ))
      || (value.operation !== "create" && (
        value.expected_component_id !== value.target_component_id
        || value.expected_revision === null
        || value.expected_status === null
      ))
    ) throw new CatalogImportIntegrityError();
  } else if (
    value.operation !== null
    || value.source_command !== null
    || value.target_component_id !== null
    || value.expected_component_id !== null
    || value.expected_revision !== null
    || value.expected_status !== null
    || errors === null
  ) throw new CatalogImportIntegrityError();

  const hasResult = value.result_state !== null;
  if (
    hasResult !== (value.result_created_at !== null)
    || (!hasResult && (
      value.result_component_id !== null
      || value.result_revision !== null
      || value.result_error_code !== null
    ))
    || (hasResult && value.result_state === "conflict" && (
      value.result_component_id !== null
      || value.result_revision !== null
      || value.result_error_code === null
    ))
    || (hasResult && value.result_state !== "conflict" && (
      value.result_component_id === null
      || value.result_revision === null
      || value.result_error_code !== null
    ))
  ) throw new CatalogImportIntegrityError();
  if (value.validation_status === "invalid" && hasResult) {
    throw new CatalogImportIntegrityError();
  }
  if (
    value.validation_status === "valid"
    && hasResult
    && value.result_state !== "conflict"
  ) {
    const expectedResultState = value.operation === "create"
      ? "created"
      : value.operation === "revise"
        ? "revised"
        : "unchanged";
    const expectedResultRevision = value.operation === "create"
      ? 1
      : value.operation === "revise"
        ? value.expected_revision! + 1
        : value.expected_revision!;
    if (
      value.result_state !== expectedResultState
      || value.result_component_id !== value.target_component_id
      || value.result_revision !== expectedResultRevision
    ) throw new CatalogImportIntegrityError();
  }

  return {
    rowNumber: value.row_number,
    validationStatus: value.validation_status,
    normalizedSku: value.normalized_sku,
    operation: value.operation,
    sourceCommand,
    errors: errors === null ? null : errors.data,
    targetComponentId: value.target_component_id,
    expectedComponentId: value.expected_component_id,
    expectedRevision: value.expected_revision,
    expectedStatus: value.expected_status,
    result: !hasResult ? null : {
      state: value.result_state!,
      componentId: value.result_component_id,
      revision: value.result_revision,
      errorCode: value.result_error_code,
      createdAt: value.result_created_at!,
    },
  };
}

export async function listCatalogImportRows(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<CatalogImportRowsPage> {
  assertCatalogImportAccess(ctx);
  const input = readRowsCommandSchema.safeParse(value);
  if (!input.success) throw new CatalogImportInputError(issuePaths(input.error));
  let rawRows: unknown[];
  try {
    rawRows = (await tx.execute(sql`
      select *
        from public.read_catalog_import_rows_v1(
          ${ctx.workspaceId}::uuid,
          ${input.data.importId}::uuid,
          ${input.data.afterRow}::integer,
          ${input.data.limit}::integer
        )
       order by row_number
    `)).rows;
  } catch (error) {
    if (sqlState(error) === "42501") {
      throw new PermissionDeniedError(
        "catalog.manage",
        "catalog_import",
        "database_reauthorization",
        ctx.actor,
      );
    }
    throw new CatalogImportPersistenceError();
  }
  if (rawRows.length > input.data.limit) throw new CatalogImportIntegrityError();
  const rows = rawRows.map((raw) => {
    const parsed = importRowReadSchema.safeParse(raw);
    if (!parsed.success) throw new CatalogImportIntegrityError();
    return mapCatalogImportRow(parsed.data);
  });
  for (let index = 0; index < rows.length; index += 1) {
    const previous = index === 0 ? input.data.afterRow : rows[index - 1]!.rowNumber;
    if (rows[index]!.rowNumber !== previous + 1) {
      throw new CatalogImportIntegrityError();
    }
  }
  return {
    rows,
    nextAfterRow: rows.length === input.data.limit
      ? rows.at(-1)?.rowNumber ?? null
      : null,
  };
}

export async function getCatalogImportErrorReport(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<string | null> {
  assertCatalogImportAccess(ctx);
  const input = readCommandSchema.safeParse(value);
  if (!input.success) throw new CatalogImportInputError(issuePaths(input.error));
  const details = await getCatalogImport(tx, ctx, input.data);
  if (details === null) return null;

  const reportRows = [];
  let afterRow = 1;
  for (let pageNumber = 0; pageNumber < 11; pageNumber += 1) {
    const page = await listCatalogImportRows(tx, ctx, {
      importId: input.data.importId,
      afterRow,
      limit: 100,
    });
    for (const row of page.rows) {
      for (const error of row.errors ?? []) {
        reportRows.push({ rowNumber: row.rowNumber, ...error });
      }
    }
    if (page.nextAfterRow === null) return renderCatalogCsvErrorReport(reportRows);
    if (page.nextAfterRow <= afterRow) throw new CatalogImportIntegrityError();
    afterRow = page.nextAfterRow;
  }
  throw new CatalogImportIntegrityError();
}
