import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { z } from "zod";

import { writeAudit } from "../lib/audit";
import { servicePoolConfig } from "../lib/db/role-env";
import { withTenantOn } from "../lib/db/tenant";
import type { TenantTx } from "../lib/db/types";
import { emitEvent } from "../lib/events";
import {
  INVOICE_PDF_CANONICALIZATION_VERSION,
  INVOICE_PDF_INPUT_VERSION,
  INVOICE_PDF_RENDERER_RECIPE_VERSION,
  INVOICE_PDF_TEMPLATE_VERSION,
  hashInvoicePdfInput,
  validateInvoicePdfInput,
  type InvoicePdfInputV1,
} from "../lib/integrations/invoicing/pdf-contract";
import { INVOICE_PDF_DISPATCH_SCHEMA_VERSION } from "./invoice-pdf";
import type {
  InvoicePdfClaim,
  InvoicePdfDatabase,
  InvoicePdfRecoveryWorkspacePage,
} from "./invoice-pdf";
import type { RenderedInvoicePdf } from "./invoice-pdf-renderer";

export const INVOICE_PDF_MAX_ATTEMPTS = 3 as const;
export const INVOICE_PDF_LEASE_MS = 2 * 60_000;
export const INVOICE_PDF_MAX_BACKOFF_MS = 15 * 60_000;
const INVOICE_PDF_BASE_BACKOFF_MS = 30_000;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const workerKeySchema = z.strictObject({
  workspaceId: z.uuid(),
  jobId: z.uuid(),
});

const claimSchema = workerKeySchema.extend({
  leaseToken: z.uuid(),
});

const finalizationKeySchema = claimSchema.extend({
  attemptCount: z.int().safe().min(1).max(INVOICE_PDF_MAX_ATTEMPTS),
});

const failureCodeSchema = z.enum([
  "browser_unavailable",
  "render_timeout",
  "storage_unavailable",
  "network_attempted",
  "invalid_input",
  "invalid_pdf",
  "pdf_too_large",
  "renderer_nondeterministic",
]);

const failureSchema = finalizationKeySchema.extend({
  errorCode: failureCodeSchema,
  retryable: z.boolean(),
});

const requeueSchema = z.strictObject({
  workspaceId: z.uuid(),
  limit: z.int().safe().min(1).max(100),
});

const recoveryWorkspaceSchema = z.strictObject({
  afterWorkspaceId: z.uuid().nullable(),
  limit: z.int().safe().min(1).max(100),
});

export type InvoicePdfWorkerErrorCode =
  | "invalid_input"
  | "stale"
  | "retry_conflict"
  | "dispatch_unavailable"
  | "invalid_pdf"
  | "renderer_nondeterministic";

export class InvoicePdfWorkerError extends Error {
  constructor(public readonly code: InvoicePdfWorkerErrorCode) {
    super("invoice PDF worker database operation failed");
    this.name = "InvoicePdfWorkerError";
  }
}

type JobRow = {
  id: string;
  workspace_id: string;
  document_id: string;
  template_version: string;
  renderer_recipe: string;
  input_json: unknown;
  input_sha256_hex: string;
  status: string;
  attempt_count: number;
  next_attempt_at: Date | string;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  error_code: string | null;
  error_retryable: boolean | null;
  artifact_mime_type: string | null;
  artifact_sha256_hex: string | null;
  artifact_size_bytes: number | null;
  artifact_bytes: unknown;
  created_by: string;
  db_now: Date | string;
  [key: string]: unknown;
};

type StateTrace = {
  id: string;
  workspace_id: string;
  document_id: string;
  attempt_count: number;
  created_by: string;
};

type RecoveryTrace = StateTrace & {
  recovery_state: "retry_wait" | "running";
};

export type InvoicePdfFailureResult = {
  state: "retry_wait" | "failed_final";
  attemptCount: number;
  nextAttemptAt: Date;
};

export type InvoicePdfSuccessResult = {
  state: "succeeded";
  attemptCount: number;
  replayed: boolean;
};

export type InvoicePdfDatabaseGateway = {
  database: InvoicePdfDatabase;
  listRecoveryWorkspaces(input: {
    afterWorkspaceId: string | null;
    limit: number;
  }): Promise<InvoicePdfRecoveryWorkspacePage>;
  requeueDue(input: { workspaceId: string; limit: number }): Promise<string[]>;
  probe(): Promise<void>;
  close(): Promise<void>;
};

type RecoveryWorkspaceRow = {
  workspace_id: string | null;
  contract_valid: boolean;
  [key: string]: unknown;
};

function invalidInput(): never {
  throw new InvoicePdfWorkerError("invalid_input");
}

function stale(): never {
  throw new InvoicePdfWorkerError("stale");
}

function retryConflict(): never {
  throw new InvoicePdfWorkerError("retry_conflict");
}

function databaseNow(row: Pick<JobRow, "db_now">): Date {
  const value = new Date(row.db_now);
  if (!Number.isFinite(value.getTime())) invalidInput();
  return value;
}

function parseDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalidInput();
  return parsed;
}

function parseStoredInput(row: JobRow): InvoicePdfInputV1 {
  const parsed = validateInvoicePdfInput(row.input_json);
  if (
    !parsed.ok
    || row.template_version !== INVOICE_PDF_TEMPLATE_VERSION
    || row.renderer_recipe !== INVOICE_PDF_RENDERER_RECIPE_VERSION
    || parsed.value.schemaVersion !== INVOICE_PDF_INPUT_VERSION
    || parsed.value.canonicalizationVersion !== INVOICE_PDF_CANONICALIZATION_VERSION
    || parsed.value.templateVersion !== row.template_version
    || parsed.value.rendererRecipeVersion !== row.renderer_recipe
    || !SHA256_PATTERN.test(row.input_sha256_hex)
    || hashInvoicePdfInput(parsed.value) !== row.input_sha256_hex
  ) invalidInput();
  return parsed.value;
}

function claimResult(row: JobRow, input = parseStoredInput(row)): InvoicePdfClaim {
  const leaseExpiresAt = parseDate(row.lease_expires_at);
  const startedAt = parseDate(row.started_at);
  if (
    row.status !== "running"
    || row.lease_token === null
    || leaseExpiresAt === null
    || startedAt === null
    || !Number.isSafeInteger(row.attempt_count)
    || row.attempt_count < 1
    || row.attempt_count > INVOICE_PDF_MAX_ATTEMPTS
  ) invalidInput();
  return {
    workspaceId: row.workspace_id,
    jobId: row.id,
    leaseToken: row.lease_token,
    attemptCount: row.attempt_count,
    inputVersion: INVOICE_PDF_INPUT_VERSION,
    templateVersion: row.template_version,
    rendererRecipeVersion: row.renderer_recipe,
    inputSha256: row.input_sha256_hex,
    input: structuredClone(input),
  };
}

async function lockedJob(
  tx: TenantTx,
  workspaceId: string,
  jobId: string,
): Promise<JobRow | null> {
  const result = await tx.execute<JobRow>(sql`
    select id, workspace_id, document_id,
           template_version, renderer_recipe, input_json,
           encode(input_sha256, 'hex') as input_sha256_hex,
           status, attempt_count, next_attempt_at, lease_token,
           lease_expires_at, started_at, finished_at, error_code,
           error_retryable, artifact_mime_type,
           encode(artifact_sha256, 'hex') as artifact_sha256_hex,
           artifact_size_bytes, artifact_bytes, created_by,
           pg_catalog.clock_timestamp() as db_now
      from commercial_document_render_job
     where workspace_id = ${workspaceId}::uuid
       and id = ${jobId}::uuid
     for update
  `);
  return result.rows[0] ?? null;
}

async function enqueueDispatch(
  tx: TenantTx,
  workspaceId: string,
  jobId: string,
): Promise<void> {
  const gate = await tx.execute<{
    dispatch_signature: string | null;
    current_role: string;
    session_role: string;
    database_name: string;
    [key: string]: unknown;
  }>(sql`
    select pg_catalog.to_regprocedure(
             'pgboss.enqueue_invoice_pdf_render(uuid,uuid)'
           )::text as dispatch_signature,
           current_user::text as current_role,
           session_user::text as session_role,
           pg_catalog.current_database()::text as database_name
  `);
  const row = gate.rows[0];
  if (!row?.dispatch_signature) {
    const explicitTestSkip = row !== undefined
      && row.current_role === row.session_role
      && (row.current_role === "app_test" || row.current_role === "app_ci")
      && row.database_name.includes("test");
    if (explicitTestSkip) return;
    throw new InvoicePdfWorkerError("dispatch_unavailable");
  }
  await tx.execute(sql`
    select pgboss.enqueue_invoice_pdf_render(
      ${workspaceId}::uuid,
      ${jobId}::uuid
    )
  `);
}

async function recordState(
  tx: TenantTx,
  row: StateTrace,
  status: "running" | "queued" | "retry_wait" | "succeeded" | "failed_final",
  errorCode: string | null = null,
): Promise<void> {
  const details = {
    documentId: row.document_id,
    jobId: row.id,
    attemptCount: row.attempt_count,
    status,
    ...(errorCode === null ? {} : { errorCode }),
  };
  await emitEvent(tx, {
    workspaceId: row.workspace_id,
    aggregateType: "commercial_document",
    aggregateId: row.document_id,
    eventType: `commercial_document.pdf_render_${status}`,
    actor: row.created_by,
    payload: details,
  });
  await writeAudit(tx, {
    workspaceId: row.workspace_id,
    actor: row.created_by,
    action: "invoicing.document.write",
    resource: "commercial_document_render_job",
    allowed: true,
    details,
  });
}

async function markInvalidInputFinal(
  tx: TenantTx,
  row: JobRow,
): Promise<void> {
  if (row.status !== "running" || row.lease_token === null) stale();
  const result = await tx.execute<StateTrace>(sql`
    update commercial_document_render_job
       set status = 'failed_final',
           next_attempt_at = pg_catalog.clock_timestamp(),
           lease_token = null,
           lease_expires_at = null,
           error_code = 'invalid_input',
           error_retryable = false,
           started_at = coalesce(started_at, pg_catalog.clock_timestamp()),
           finished_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     where workspace_id = ${row.workspace_id}::uuid
       and id = ${row.id}::uuid
       and status = 'running'
       and lease_token = ${row.lease_token}::uuid
       and attempt_count = ${row.attempt_count}
     returning id, workspace_id, document_id,
               attempt_count, created_by
  `);
  const finalized = result.rows[0];
  if (finalized) await recordState(tx, finalized, "failed_final", "invalid_input");
}

export async function claimInvoicePdfRenderJob(
  tx: TenantTx,
  value: unknown,
): Promise<InvoicePdfClaim | null> {
  const parsed = claimSchema.safeParse(value);
  if (!parsed.success) invalidInput();
  const input = parsed.data;
  const row = await lockedJob(tx, input.workspaceId, input.jobId);
  if (row === null) return null;
  const dbNow = databaseNow(row);
  const leaseExpiresAt = parseDate(row.lease_expires_at);
  const nextAttemptAt = parseDate(row.next_attempt_at);
  if (nextAttemptAt === null) invalidInput();

  const sameLiveLease = row.status === "running"
    && row.lease_token === input.leaseToken
    && leaseExpiresAt !== null
    && leaseExpiresAt.getTime() > dbNow.getTime();
  const dueRequested = row.status === "requested"
    && nextAttemptAt.getTime() <= dbNow.getTime();
  const dueQueued = row.status === "queued"
    && nextAttemptAt.getTime() <= dbNow.getTime();
  const dueRetry = row.status === "retry_wait"
    && nextAttemptAt.getTime() <= dbNow.getTime();
  const expiredRunning = row.status === "running"
    && leaseExpiresAt !== null
    && leaseExpiresAt.getTime() <= dbNow.getTime();

  if (sameLiveLease) {
    try {
      return claimResult(row);
    } catch (error) {
      if (error instanceof InvoicePdfWorkerError && error.code === "invalid_input") {
        await markInvalidInputFinal(tx, row);
        return null;
      }
      throw error;
    }
  }
  if (!dueRequested && !dueQueued && !dueRetry && !expiredRunning) return null;

  if (expiredRunning && row.attempt_count >= INVOICE_PDF_MAX_ATTEMPTS) {
    const result = await tx.execute<StateTrace>(sql`
      update commercial_document_render_job
         set status = 'failed_final',
             next_attempt_at = pg_catalog.clock_timestamp(),
             lease_token = null,
             lease_expires_at = null,
             error_code = 'lease_expired',
             error_retryable = false,
             finished_at = pg_catalog.clock_timestamp(),
             updated_at = pg_catalog.clock_timestamp()
       where workspace_id = ${input.workspaceId}::uuid
         and id = ${input.jobId}::uuid
         and status = 'running'
         and attempt_count = ${row.attempt_count}
         and lease_expires_at <= pg_catalog.clock_timestamp()
       returning id, workspace_id, document_id,
                 attempt_count, created_by
    `);
    const finalized = result.rows[0];
    if (finalized) await recordState(tx, finalized, "failed_final", "lease_expired");
    return null;
  }
  if (row.attempt_count >= INVOICE_PDF_MAX_ATTEMPTS) return null;

  const updated = await tx.execute<JobRow>(sql`
    update commercial_document_render_job
       set status = 'running',
           attempt_count = attempt_count + 1,
           next_attempt_at = pg_catalog.clock_timestamp(),
           lease_token = ${input.leaseToken}::uuid,
           lease_expires_at = pg_catalog.clock_timestamp()
             + ${INVOICE_PDF_LEASE_MS} * interval '1 millisecond',
           started_at = coalesce(started_at, pg_catalog.clock_timestamp()),
           finished_at = null,
           error_code = null,
           error_retryable = null,
           updated_at = pg_catalog.clock_timestamp()
     where workspace_id = ${input.workspaceId}::uuid
       and id = ${input.jobId}::uuid
       and attempt_count = ${row.attempt_count}
       and attempt_count < ${INVOICE_PDF_MAX_ATTEMPTS}
       and (
         (status = 'requested' and next_attempt_at <= pg_catalog.clock_timestamp())
         or (status = 'queued' and next_attempt_at <= pg_catalog.clock_timestamp())
         or (status = 'retry_wait' and next_attempt_at <= pg_catalog.clock_timestamp())
         or (status = 'running' and lease_expires_at <= pg_catalog.clock_timestamp())
       )
     returning id, workspace_id, document_id,
               template_version, renderer_recipe, input_json,
               encode(input_sha256, 'hex') as input_sha256_hex,
               status, attempt_count, next_attempt_at, lease_token,
               lease_expires_at, started_at, finished_at, error_code,
               error_retryable, artifact_mime_type,
               encode(artifact_sha256, 'hex') as artifact_sha256_hex,
               artifact_size_bytes, artifact_bytes, created_by,
               pg_catalog.clock_timestamp() as db_now
  `);
  const claimed = updated.rows[0];
  if (!claimed) return null;
  let result: InvoicePdfClaim;
  try {
    result = claimResult(claimed);
  } catch (error) {
    if (error instanceof InvoicePdfWorkerError && error.code === "invalid_input") {
      await markInvalidInputFinal(tx, claimed);
      return null;
    }
    throw error;
  }
  await enqueueDispatch(tx, input.workspaceId, input.jobId);
  await recordState(tx, claimed, "running");
  return result;
}

function assertClaim(
  row: JobRow | null,
  leaseToken: string,
  attemptCount: number,
): asserts row is JobRow {
  const leaseExpiresAt = row === null ? null : parseDate(row.lease_expires_at);
  if (
    row === null
    || row.status !== "running"
    || row.lease_token !== leaseToken
    || row.attempt_count !== attemptCount
    || leaseExpiresAt === null
    || leaseExpiresAt.getTime() <= databaseNow(row).getTime()
  ) stale();
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(
    INVOICE_PDF_BASE_BACKOFF_MS * (2 ** Math.max(0, attemptCount - 1)),
    INVOICE_PDF_MAX_BACKOFF_MS,
  );
}

function failureIsRetryable(code: z.infer<typeof failureCodeSchema>): boolean {
  return code === "browser_unavailable"
    || code === "render_timeout"
    || code === "storage_unavailable";
}

export async function finalizeInvoicePdfRenderFailure(
  tx: TenantTx,
  value: unknown,
): Promise<InvoicePdfFailureResult> {
  const parsed = failureSchema.safeParse(value);
  if (!parsed.success) invalidInput();
  const input = parsed.data;
  if (failureIsRetryable(input.errorCode) !== input.retryable) invalidInput();
  const row = await lockedJob(tx, input.workspaceId, input.jobId);
  assertClaim(row, input.leaseToken, input.attemptCount);

  const willRetry = input.retryable && row.attempt_count < INVOICE_PDF_MAX_ATTEMPTS;
  const status = willRetry ? "retry_wait" as const : "failed_final" as const;
  const delayMs = retryDelayMs(row.attempt_count);
  const result = await tx.execute<StateTrace & {
    next_attempt_at: Date | string;
    [key: string]: unknown;
  }>(sql`
    with database_clock as (
      select pg_catalog.clock_timestamp() as db_now
    )
    update commercial_document_render_job
       set status = ${status},
           next_attempt_at = case when ${willRetry}
             then database_clock.db_now + ${delayMs} * interval '1 millisecond'
             else database_clock.db_now
           end,
           lease_token = null,
           lease_expires_at = null,
           error_code = ${input.errorCode},
           error_retryable = ${willRetry},
           finished_at = case when ${willRetry} then null else database_clock.db_now end,
           updated_at = database_clock.db_now
      from database_clock
     where workspace_id = ${input.workspaceId}::uuid
       and id = ${input.jobId}::uuid
       and status = 'running'
       and lease_token = ${input.leaseToken}::uuid
       and attempt_count = ${input.attemptCount}
       and lease_expires_at > database_clock.db_now
     returning id, workspace_id, document_id,
               attempt_count, created_by, next_attempt_at
  `);
  const finalized = result.rows[0];
  if (!finalized) stale();
  if (willRetry) await enqueueDispatch(tx, input.workspaceId, input.jobId);
  await recordState(tx, finalized, status, input.errorCode);
  const nextAttemptAt = new Date(finalized.next_attempt_at);
  if (!Number.isFinite(nextAttemptAt.getTime())) invalidInput();
  return { state: status, attemptCount: finalized.attempt_count, nextAttemptAt };
}

function validatedArtifact(value: unknown): RenderedInvoicePdf {
  if (value === null || typeof value !== "object") {
    throw new InvoicePdfWorkerError("invalid_pdf");
  }
  const candidate = value as Partial<RenderedInvoicePdf>;
  if (
    Object.keys(candidate).some((key) => ![
      "bytes", "sha256", "sizeBytes", "mimeType",
    ].includes(key))
    || Object.keys(candidate).length !== 4
    ||
    candidate.mimeType !== "application/pdf"
    || !Buffer.isBuffer(candidate.bytes)
    || !Number.isSafeInteger(candidate.sizeBytes)
    || (candidate.sizeBytes as number) < 100
    || (candidate.sizeBytes as number) > MAX_ARTIFACT_BYTES
    || candidate.bytes.length !== candidate.sizeBytes
    || typeof candidate.sha256 !== "string"
    || !SHA256_PATTERN.test(candidate.sha256)
    || !candidate.bytes.subarray(0, 5).equals(Buffer.from("%PDF-"))
    || !candidate.bytes.subarray(Math.max(0, candidate.bytes.length - 1_024))
      .toString("latin1").includes("%%EOF")
  ) throw new InvoicePdfWorkerError("invalid_pdf");
  const actual = createHash("sha256").update(candidate.bytes).digest();
  const expected = Buffer.from(candidate.sha256, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new InvoicePdfWorkerError("invalid_pdf");
  }
  return {
    mimeType: "application/pdf",
    bytes: Buffer.from(candidate.bytes),
    sha256: candidate.sha256,
    sizeBytes: candidate.sizeBytes as number,
  };
}

function storedArtifact(row: JobRow): RenderedInvoicePdf {
  return validatedArtifact({
    mimeType: row.artifact_mime_type,
    bytes: row.artifact_bytes,
    sha256: row.artifact_sha256_hex,
    sizeBytes: row.artifact_size_bytes,
  });
}

function sameArtifact(left: RenderedInvoicePdf, right: RenderedInvoicePdf): boolean {
  return left.mimeType === right.mimeType
    && left.sizeBytes === right.sizeBytes
    && left.sha256 === right.sha256
    && left.bytes.equals(right.bytes);
}

export async function finalizeInvoicePdfRenderSuccess(
  tx: TenantTx,
  value: unknown,
): Promise<InvoicePdfSuccessResult> {
  if (value === null || typeof value !== "object") invalidInput();
  const candidate = value as Record<string, unknown>;
  const parsedKey = finalizationKeySchema.safeParse({
    workspaceId: candidate.workspaceId,
    jobId: candidate.jobId,
    leaseToken: candidate.leaseToken,
    attemptCount: candidate.attemptCount,
  });
  if (!parsedKey.success || !Object.hasOwn(candidate, "artifact")) invalidInput();
  if (Object.keys(candidate).some((key) => ![
    "workspaceId", "jobId", "leaseToken", "attemptCount", "artifact",
  ].includes(key))) invalidInput();
  const input = parsedKey.data;
  const artifact = validatedArtifact(candidate.artifact);
  const row = await lockedJob(tx, input.workspaceId, input.jobId);
  if (row?.status === "succeeded") {
    if (row.attempt_count !== input.attemptCount) retryConflict();
    parseStoredInput(row);
    const existing = storedArtifact(row);
    if (!sameArtifact(existing, artifact)) {
      throw new InvoicePdfWorkerError("renderer_nondeterministic");
    }
    return { state: "succeeded", attemptCount: row.attempt_count, replayed: true };
  }
  assertClaim(row, input.leaseToken, input.attemptCount);
  parseStoredInput(row);
  if (
    row.artifact_mime_type !== null
    || row.artifact_sha256_hex !== null
    || row.artifact_size_bytes !== null
    || row.artifact_bytes !== null
  ) retryConflict();

  const result = await tx.execute<StateTrace>(sql`
    update commercial_document_render_job
       set status = 'succeeded',
           next_attempt_at = pg_catalog.clock_timestamp(),
           lease_token = null,
           lease_expires_at = null,
           error_code = null,
           error_retryable = null,
           artifact_mime_type = 'application/pdf',
           artifact_sha256 = decode(${artifact.sha256}, 'hex'),
           artifact_size_bytes = ${artifact.sizeBytes},
           artifact_bytes = ${artifact.bytes},
           finished_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     where workspace_id = ${input.workspaceId}::uuid
       and id = ${input.jobId}::uuid
       and status = 'running'
       and lease_token = ${input.leaseToken}::uuid
       and attempt_count = ${input.attemptCount}
       and lease_expires_at > pg_catalog.clock_timestamp()
       and artifact_mime_type is null
       and artifact_sha256 is null
       and artifact_size_bytes is null
       and artifact_bytes is null
     returning id, workspace_id, document_id,
               attempt_count, created_by
  `);
  const finalized = result.rows[0];
  if (!finalized) stale();
  await recordState(tx, finalized, "succeeded");
  return { state: "succeeded", attemptCount: finalized.attempt_count, replayed: false };
}

export async function requeueDueInvoicePdfRenderJobs(
  tx: TenantTx,
  value: unknown,
): Promise<string[]> {
  const parsed = requeueSchema.safeParse(value);
  if (!parsed.success) invalidInput();
  const input = parsed.data;
  const result = await tx.execute<RecoveryTrace>(sql`
    with due as (
      select id, status as recovery_state
        from commercial_document_render_job
       where workspace_id = ${input.workspaceId}::uuid
         and (
           (status = 'retry_wait'
             and next_attempt_at <= pg_catalog.clock_timestamp())
           or (status = 'running'
             and lease_expires_at <= pg_catalog.clock_timestamp())
         )
       order by case
                  when status = 'retry_wait' then next_attempt_at
                  else lease_expires_at
                end,
                created_at, id
       limit ${input.limit}
       for update skip locked
    ), requeued as (
      update commercial_document_render_job draft
         set status = 'queued',
             next_attempt_at = pg_catalog.clock_timestamp(),
             error_code = null,
             error_retryable = null,
             updated_at = pg_catalog.clock_timestamp()
        from due
       where draft.workspace_id = ${input.workspaceId}::uuid
         and draft.id = due.id
         and due.recovery_state = 'retry_wait'
       returning draft.id, draft.workspace_id, draft.document_id,
                 draft.attempt_count, draft.created_by,
                 'retry_wait'::text as recovery_state
    ), expired_running as (
      select draft.id, draft.workspace_id, draft.document_id,
             draft.attempt_count, draft.created_by,
             'running'::text as recovery_state
        from commercial_document_render_job as draft
        join due on due.id = draft.id
       where draft.workspace_id = ${input.workspaceId}::uuid
         and due.recovery_state = 'running'
    )
    select * from requeued
    union all
    select * from expired_running
  `);
  const rows = [...result.rows].sort((left, right) => left.id.localeCompare(right.id));
  for (const row of rows) {
    if (row.recovery_state !== "retry_wait" && row.recovery_state !== "running") {
      invalidInput();
    }
    await enqueueDispatch(tx, input.workspaceId, row.id);
    if (row.recovery_state === "retry_wait") await recordState(tx, row, "queued");
  }
  return rows.map((row) => row.id);
}

async function tenantWorkspaceExists(
  pool: Pool,
  workspaceId: string,
): Promise<boolean> {
  return withTenantOn(pool, workspaceId, async (tx) => {
    const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      select id::text as id
        from workspace
       where id = ${workspaceId}::uuid
       limit 1
    `);
    return result.rows[0]?.id === workspaceId;
  });
}

async function listRecoveryWorkspaces(
  pool: Pool,
  value: unknown,
): Promise<InvoicePdfRecoveryWorkspacePage> {
  const parsed = recoveryWorkspaceSchema.safeParse(value);
  if (!parsed.success) invalidInput();
  const input = parsed.data;

  // pgboss is app_worker-owned and contains the strict ID-only dispatch. It is
  // used only to discover tenant candidates; every public-table read/update
  // below still runs with that workspace's FORCE-RLS context.
  const result = await pool.query<RecoveryWorkspaceRow>(`
    with dispatch as materialized (
      select case
               when pg_catalog.jsonb_typeof(job.data) = 'object'
                 then job.data->>'workspaceId'
               else null
             end as workspace_id,
             case
               when pg_catalog.jsonb_typeof(job.data) = 'object' then
                 coalesce(
                   job.data = pg_catalog.jsonb_build_object(
                     'schemaVersion', $2::text,
                     'workspaceId', job.data->>'workspaceId',
                     'jobId', job.data->>'jobId'
                   )
                   and job.data->>'schemaVersion' = $2::text
                   and job.data->>'workspaceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   and job.data->>'jobId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
                   false
                 )
               else false
             end as contract_valid
        from pgboss.job as job
       where job.name = $1::text
    ), integrity as (
      select coalesce(pg_catalog.bool_and(contract_valid), true)
               as contract_valid
        from dispatch
    ), candidates as (
      select distinct workspace_id
        from dispatch
       where contract_valid
         and ($3::text is null or workspace_id > $3::text)
       order by workspace_id
       limit $4::integer
    )
    select candidates.workspace_id, integrity.contract_valid
      from integrity
      left join candidates on true
      order by candidates.workspace_id nulls last
  `, [
    "invoice-pdf.render",
    INVOICE_PDF_DISPATCH_SCHEMA_VERSION,
    input.afterWorkspaceId,
    input.limit,
  ]);
  if (result.rows.some((row) => row.contract_valid !== true)) invalidInput();

  const candidateIds: string[] = [];
  for (const row of result.rows) {
    if (row.workspace_id === null) continue;
    const parsedWorkspaceId = z.uuid().safeParse(row.workspace_id);
    if (!parsedWorkspaceId.success) invalidInput();
    candidateIds.push(parsedWorkspaceId.data);
  }

  const workspaceIds: string[] = [];
  for (const workspaceId of candidateIds) {
    if (await tenantWorkspaceExists(pool, workspaceId)) workspaceIds.push(workspaceId);
  }
  return {
    workspaceIds,
    nextAfterWorkspaceId: candidateIds.length === input.limit
      ? candidateIds.at(-1) ?? null
      : null,
  };
}

/**
 * Dedicated app_worker pool for short tenant transactions. Rendering remains
 * outside every transaction and pg-boss keeps its independent adapter pool.
 */
export function createInvoicePdfDatabaseGateway(
  connectionString: string,
  onPoolError: (error: Error) => void,
  max = 2,
): InvoicePdfDatabaseGateway {
  const pool = new Pool(servicePoolConfig(connectionString, "app_worker", max));
  pool.on("error", onPoolError);
  let closePromise: Promise<void> | undefined;

  const database: InvoicePdfDatabase = {
    claim: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      claimInvoicePdfRenderJob(tx, input)),
    finalizeSuccess: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      finalizeInvoicePdfRenderSuccess(tx, input)),
    finalizeFailure: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      finalizeInvoicePdfRenderFailure(tx, input)),
  };

  return {
    database,
    listRecoveryWorkspaces: (input) => listRecoveryWorkspaces(pool, input),
    requeueDue: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      requeueDueInvoicePdfRenderJobs(tx, input)),
    async probe() {
      await pool.query("select 1");
    },
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
