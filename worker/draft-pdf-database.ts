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
  DRAFT_PDF_INPUT_VERSION,
  DRAFT_PDF_RENDERER_RECIPE_VERSION,
  DRAFT_PDF_TEMPLATE_VERSION,
  INVOICE_PDF_CANONICALIZATION_VERSION,
  hashDraftPdfInput,
  validateDraftPdfInput,
  type DraftPdfInputV1,
} from "../lib/integrations/invoicing/pdf-contract";
import type {
  DraftPdfClaim,
  DraftPdfDatabase,
} from "./draft-pdf";
import type { RenderedDraftPdf } from "./draft-pdf-renderer";

// F8-24c: schlanker Spiegel der invoice-pdf-Statusmaschine (shape_ck):
// gleiche Lease-/Retry-Semantik, eigenes Draft-Tripel, kein pgboss-Gate
// (Vorschau ist on-demand, kein Versand-Artefakt), kein Recovery-Sweep.
export const DRAFT_PDF_MAX_ATTEMPTS = 3 as const;
export const DRAFT_PDF_LEASE_MS = 2 * 60_000;
export const DRAFT_PDF_MAX_BACKOFF_MS = 15 * 60_000;
const DRAFT_PDF_BASE_BACKOFF_MS = 30_000;
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
  attemptCount: z.int().safe().min(1).max(DRAFT_PDF_MAX_ATTEMPTS),
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

export type DraftPdfWorkerErrorCode =
  | "invalid_input"
  | "stale"
  | "retry_conflict"
  | "invalid_pdf"
  | "renderer_nondeterministic";

export class DraftPdfWorkerError extends Error {
  constructor(public readonly code: DraftPdfWorkerErrorCode) {
    super("draft PDF worker database operation failed");
    this.name = "DraftPdfWorkerError";
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

export type DraftPdfFailureResult = {
  state: "retry_wait" | "failed_final";
  attemptCount: number;
  nextAttemptAt: Date;
};

export type DraftPdfSuccessResult = {
  state: "succeeded";
  attemptCount: number;
  replayed: boolean;
};

export type DraftPdfDatabaseGateway = {
  database: DraftPdfDatabase;
  probe(): Promise<void>;
  close(): Promise<void>;
};

function invalidInput(): never {
  throw new DraftPdfWorkerError("invalid_input");
}

function stale(): never {
  throw new DraftPdfWorkerError("stale");
}

function retryConflict(): never {
  throw new DraftPdfWorkerError("retry_conflict");
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

function parseStoredInput(row: JobRow): DraftPdfInputV1 {
  // F8-24c: exakt das Draft-Tripel; alles andere (inkl. Kreuzmix)
  // fail-closed invalid_input.
  if (
    row.template_version !== DRAFT_PDF_TEMPLATE_VERSION
    || row.renderer_recipe !== DRAFT_PDF_RENDERER_RECIPE_VERSION
  ) invalidInput();
  const parsed = validateDraftPdfInput(row.input_json);
  if (
    !parsed.ok
    || parsed.value.schemaVersion !== DRAFT_PDF_INPUT_VERSION
    || parsed.value.canonicalizationVersion !== INVOICE_PDF_CANONICALIZATION_VERSION
    || parsed.value.templateVersion !== row.template_version
    || parsed.value.rendererRecipeVersion !== row.renderer_recipe
    || !SHA256_PATTERN.test(row.input_sha256_hex)
    || hashDraftPdfInput(parsed.value) !== row.input_sha256_hex
  ) invalidInput();
  return parsed.value;
}

function claimResult(row: JobRow, input = parseStoredInput(row)): DraftPdfClaim {
  const leaseExpiresAt = parseDate(row.lease_expires_at);
  const startedAt = parseDate(row.started_at);
  if (
    row.status !== "running"
    || row.lease_token === null
    || leaseExpiresAt === null
    || startedAt === null
    || !Number.isSafeInteger(row.attempt_count)
    || row.attempt_count < 1
    || row.attempt_count > DRAFT_PDF_MAX_ATTEMPTS
  ) invalidInput();
  return {
    workspaceId: row.workspace_id,
    jobId: row.id,
    leaseToken: row.lease_token,
    attemptCount: row.attempt_count,
    inputVersion: input.schemaVersion,
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
    eventType: `commercial_document.draft_pdf_render_${status}`,
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

export async function claimDraftPdfRenderJob(
  tx: TenantTx,
  value: unknown,
): Promise<DraftPdfClaim | null> {
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
      if (error instanceof DraftPdfWorkerError && error.code === "invalid_input") {
        await markInvalidInputFinal(tx, row);
        return null;
      }
      throw error;
    }
  }
  if (!dueRequested && !dueQueued && !dueRetry && !expiredRunning) return null;

  if (expiredRunning && row.attempt_count >= DRAFT_PDF_MAX_ATTEMPTS) {
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
  if (row.attempt_count >= DRAFT_PDF_MAX_ATTEMPTS) return null;

  const updated = await tx.execute<JobRow>(sql`
    update commercial_document_render_job
       set status = 'running',
           attempt_count = attempt_count + 1,
           next_attempt_at = pg_catalog.clock_timestamp(),
           lease_token = ${input.leaseToken}::uuid,
           lease_expires_at = pg_catalog.clock_timestamp()
             + ${DRAFT_PDF_LEASE_MS} * interval '1 millisecond',
           started_at = coalesce(started_at, pg_catalog.clock_timestamp()),
           finished_at = null,
           error_code = null,
           error_retryable = null,
           updated_at = pg_catalog.clock_timestamp()
     where workspace_id = ${input.workspaceId}::uuid
       and id = ${input.jobId}::uuid
       and attempt_count = ${row.attempt_count}
       and attempt_count < ${DRAFT_PDF_MAX_ATTEMPTS}
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
  let result: DraftPdfClaim;
  try {
    result = claimResult(claimed);
  } catch (error) {
    if (error instanceof DraftPdfWorkerError && error.code === "invalid_input") {
      await markInvalidInputFinal(tx, claimed);
      return null;
    }
    throw error;
  }
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
    DRAFT_PDF_BASE_BACKOFF_MS * (2 ** Math.max(0, attemptCount - 1)),
    DRAFT_PDF_MAX_BACKOFF_MS,
  );
}

function failureIsRetryable(code: z.infer<typeof failureCodeSchema>): boolean {
  return code === "browser_unavailable"
    || code === "render_timeout"
    || code === "storage_unavailable";
}

export async function finalizeDraftPdfRenderFailure(
  tx: TenantTx,
  value: unknown,
): Promise<DraftPdfFailureResult> {
  const parsed = failureSchema.safeParse(value);
  if (!parsed.success) invalidInput();
  const input = parsed.data;
  if (failureIsRetryable(input.errorCode) !== input.retryable) invalidInput();
  const row = await lockedJob(tx, input.workspaceId, input.jobId);
  assertClaim(row, input.leaseToken, input.attemptCount);

  const willRetry = input.retryable && row.attempt_count < DRAFT_PDF_MAX_ATTEMPTS;
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
  await recordState(tx, finalized, status, input.errorCode);
  const nextAttemptAt = new Date(finalized.next_attempt_at);
  if (!Number.isFinite(nextAttemptAt.getTime())) invalidInput();
  return { state: status, attemptCount: finalized.attempt_count, nextAttemptAt };
}

function validatedArtifact(value: unknown): RenderedDraftPdf {
  if (value === null || typeof value !== "object") {
    throw new DraftPdfWorkerError("invalid_pdf");
  }
  const candidate = value as Partial<RenderedDraftPdf>;
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
  ) throw new DraftPdfWorkerError("invalid_pdf");
  const actual = createHash("sha256").update(candidate.bytes).digest();
  const expected = Buffer.from(candidate.sha256, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new DraftPdfWorkerError("invalid_pdf");
  }
  return {
    mimeType: "application/pdf",
    bytes: Buffer.from(candidate.bytes),
    sha256: candidate.sha256,
    sizeBytes: candidate.sizeBytes as number,
  };
}

function storedArtifact(row: JobRow): RenderedDraftPdf {
  return validatedArtifact({
    mimeType: row.artifact_mime_type,
    bytes: row.artifact_bytes,
    sha256: row.artifact_sha256_hex,
    sizeBytes: row.artifact_size_bytes,
  });
}

function sameArtifact(left: RenderedDraftPdf, right: RenderedDraftPdf): boolean {
  return left.mimeType === right.mimeType
    && left.sizeBytes === right.sizeBytes
    && left.sha256 === right.sha256
    && left.bytes.equals(right.bytes);
}

export async function finalizeDraftPdfRenderSuccess(
  tx: TenantTx,
  value: unknown,
): Promise<DraftPdfSuccessResult> {
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
      throw new DraftPdfWorkerError("renderer_nondeterministic");
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

/**
 * Dedicated app_worker pool for short tenant transactions. Rendering remains
 * outside every transaction and pg-boss keeps its independent adapter pool.
 */
export function createDraftPdfDatabaseGateway(
  connectionString: string,
  onPoolError: (error: Error) => void,
  max = 2,
): DraftPdfDatabaseGateway {
  const pool = new Pool(servicePoolConfig(connectionString, "app_worker", max));
  pool.on("error", onPoolError);
  let closePromise: Promise<void> | undefined;

  const database: DraftPdfDatabase = {
    claim: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      claimDraftPdfRenderJob(tx, input)),
    finalizeSuccess: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      finalizeDraftPdfRenderSuccess(tx, input)),
    finalizeFailure: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      finalizeDraftPdfRenderFailure(tx, input)),
  };

  return {
    database,
    async probe() {
      await pool.query("select 1");
    },
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
