import { createHash, timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { z } from "zod";

import { writeAudit } from "../lib/audit";
import { servicePoolConfig } from "../lib/db/role-env";
import { withTenantOn } from "../lib/db/tenant";
import type { TenantTx } from "../lib/db/types";
import { emitEvent } from "../lib/events";
import { OFFER_CANONICALIZATION_VERSION } from "../lib/integrations/offers/contract";
import {
  OFFER_RELEASE_CANDIDATE_DISPATCH_VERSION,
  OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
  OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
  OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
  hashOfferReleaseCandidateInput,
  validateOfferReleaseCandidateInput,
  type OfferReleaseCandidateInputV1,
} from "../lib/integrations/offers/release-contract";
import type {
  OfferReleaseCandidateClaim,
  OfferReleaseCandidateDatabase,
  OfferReleaseCandidateRecoveryWorkspacePage,
} from "./offer-release-candidate";
import type { RenderedOfferPdf } from "./offer-pdf-renderer";

export const OFFER_RELEASE_CANDIDATE_MAX_ATTEMPTS = 3 as const;
export const OFFER_RELEASE_CANDIDATE_LEASE_MS = 2 * 60_000;
export const OFFER_RELEASE_CANDIDATE_MAX_BACKOFF_MS = 15 * 60_000;
const OFFER_RELEASE_CANDIDATE_BASE_BACKOFF_MS = 30_000;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

const workerKeySchema = z.strictObject({
  workspaceId: z.uuid(),
  candidateId: z.uuid(),
});
const claimSchema = workerKeySchema.extend({ leaseToken: z.uuid() });
const finalizationKeySchema = claimSchema.extend({
  attemptCount: z.int().safe().min(1).max(OFFER_RELEASE_CANDIDATE_MAX_ATTEMPTS),
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
  "lease_expired",
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

export type OfferReleaseCandidateWorkerErrorCode =
  | "invalid_input"
  | "stale"
  | "retry_conflict"
  | "dispatch_unavailable"
  | "invalid_pdf"
  | "renderer_nondeterministic";

export class OfferReleaseCandidateWorkerError extends Error {
  constructor(public readonly code: OfferReleaseCandidateWorkerErrorCode) {
    super("offer release candidate worker database operation failed");
    this.name = "OfferReleaseCandidateWorkerError";
  }
}

type CandidateRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  offer_id: string;
  variant_id: string;
  variant_revision: number;
  input_version: string;
  canonicalization_version: string;
  template_version: string;
  renderer_recipe_version: string;
  input_snapshot: unknown;
  input_sha256_hex: string;
  state: string;
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
  artifact_version: string | null;
  created_by: string;
  db_now: Date | string;
  [key: string]: unknown;
};

type StateTrace = {
  id: string;
  workspace_id: string;
  project_id: string;
  offer_id: string;
  variant_id: string;
  variant_revision: number;
  attempt_count: number;
  created_by: string;
};

type RecoveryTrace = StateTrace & {
  recovery_state: "retry_wait" | "running";
};

type RecoveryWorkspaceRow = {
  workspace_id: string | null;
  contract_valid: boolean;
  [key: string]: unknown;
};

export type OfferReleaseCandidateFailureResult = {
  state: "retry_wait" | "failed_final";
  attemptCount: number;
  nextAttemptAt: Date;
};

export type OfferReleaseCandidateSuccessResult = {
  state: "ready_for_approval";
  attemptCount: number;
  replayed: boolean;
};

export type OfferReleaseCandidateDatabaseGateway = {
  database: OfferReleaseCandidateDatabase;
  listRecoveryWorkspaces(input: {
    afterWorkspaceId: string | null;
    limit: number;
  }): Promise<OfferReleaseCandidateRecoveryWorkspacePage>;
  requeueDue(input: { workspaceId: string; limit: number }): Promise<string[]>;
  probe(): Promise<void>;
  close(): Promise<void>;
};

function invalidInput(): never {
  throw new OfferReleaseCandidateWorkerError("invalid_input");
}

function stale(): never {
  throw new OfferReleaseCandidateWorkerError("stale");
}

function retryConflict(): never {
  throw new OfferReleaseCandidateWorkerError("retry_conflict");
}

function parseDate(value: Date | string | null): Date | null {
  if (value === null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) invalidInput();
  return parsed;
}

function databaseNow(row: Pick<CandidateRow, "db_now">): Date {
  const value = new Date(row.db_now);
  if (!Number.isFinite(value.getTime())) invalidInput();
  return value;
}

function parseStoredInput(row: CandidateRow): OfferReleaseCandidateInputV1 {
  const parsed = validateOfferReleaseCandidateInput(row.input_snapshot);
  if (
    !parsed.ok
    || row.input_version !== OFFER_RELEASE_CANDIDATE_INPUT_VERSION
    || row.canonicalization_version !== OFFER_CANONICALIZATION_VERSION
    || row.template_version !== OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION
    || row.renderer_recipe_version
      !== OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION
    || parsed.value.schemaVersion !== row.input_version
    || parsed.value.canonicalizationVersion !== row.canonicalization_version
    || parsed.value.templateVersion !== row.template_version
    || parsed.value.rendererRecipeVersion !== row.renderer_recipe_version
    || parsed.value.variant.revision !== row.variant_revision
    || !SHA256_PATTERN.test(row.input_sha256_hex)
    || hashOfferReleaseCandidateInput(parsed.value) !== row.input_sha256_hex
  ) invalidInput();
  return parsed.value;
}

function claimResult(
  row: CandidateRow,
  input = parseStoredInput(row),
): OfferReleaseCandidateClaim {
  const leaseExpiresAt = parseDate(row.lease_expires_at);
  const startedAt = parseDate(row.started_at);
  if (
    row.state !== "running"
    || row.lease_token === null
    || row.artifact_version !== null
    || leaseExpiresAt === null
    || startedAt === null
    || !Number.isSafeInteger(row.attempt_count)
    || row.attempt_count < 1
    || row.attempt_count > OFFER_RELEASE_CANDIDATE_MAX_ATTEMPTS
  ) invalidInput();
  return {
    workspaceId: row.workspace_id,
    candidateId: row.id,
    leaseToken: row.lease_token,
    attemptCount: row.attempt_count,
    inputVersion: row.input_version,
    templateVersion: row.template_version,
    rendererRecipeVersion: row.renderer_recipe_version,
    inputSha256: row.input_sha256_hex,
    input: structuredClone(input),
  };
}

async function lockedCandidate(
  tx: TenantTx,
  workspaceId: string,
  candidateId: string,
): Promise<CandidateRow | null> {
  const result = await tx.execute<CandidateRow>(sql`
    select id, workspace_id, project_id, offer_id, variant_id,
           variant_revision, input_version, canonicalization_version,
           template_version, renderer_recipe_version, input_snapshot,
           encode(input_sha256, 'hex') as input_sha256_hex,
           state, attempt_count, next_attempt_at, lease_token,
           lease_expires_at, started_at, finished_at, error_code,
           error_retryable, artifact_mime_type,
           encode(artifact_sha256, 'hex') as artifact_sha256_hex,
           artifact_size_bytes, artifact_bytes, artifact_version, created_by,
           pg_catalog.clock_timestamp() as db_now
      from offer_release_candidate
     where workspace_id = ${workspaceId}::uuid
       and id = ${candidateId}::uuid
     for update
  `);
  return result.rows[0] ?? null;
}

async function enqueueDispatch(
  tx: TenantTx,
  workspaceId: string,
  candidateId: string,
): Promise<void> {
  const gate = await tx.execute<{
    dispatch_signature: string | null;
    current_role: string;
    session_role: string;
    database_name: string;
    [key: string]: unknown;
  }>(sql`
    select pg_catalog.to_regprocedure(
             'pgboss.enqueue_offer_release_candidate(uuid,uuid)'
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
    throw new OfferReleaseCandidateWorkerError("dispatch_unavailable");
  }
  await tx.execute(sql`
    select pgboss.enqueue_offer_release_candidate(
      ${workspaceId}::uuid,
      ${candidateId}::uuid
    )
  `);
}

async function recordState(
  tx: TenantTx,
  row: StateTrace,
  state: "running" | "queued" | "retry_wait" | "ready_for_approval" | "failed_final",
  errorCode: string | null = null,
): Promise<void> {
  const details = {
    projectId: row.project_id,
    offerId: row.offer_id,
    variantId: row.variant_id,
    variantRevision: row.variant_revision,
    candidateId: row.id,
    attemptCount: row.attempt_count,
    state,
    ...(errorCode === null ? {} : { errorCode }),
  };
  await emitEvent(tx, {
    workspaceId: row.workspace_id,
    aggregateType: "offer",
    aggregateId: row.offer_id,
    eventType: `offer.release_candidate_${state}`,
    actor: row.created_by,
    payload: details,
  });
  await writeAudit(tx, {
    workspaceId: row.workspace_id,
    actor: row.created_by,
    action: "offer.release.prepare",
    resource: "offer_release_candidate",
    allowed: true,
    details,
  });
}

async function markInvalidInputFinal(tx: TenantTx, row: CandidateRow): Promise<void> {
  if (row.state !== "running" || row.lease_token === null) stale();
  const result = await tx.execute<StateTrace>(sql`
    update offer_release_candidate
       set state = 'failed_final',
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
       and state = 'running'
       and lease_token = ${row.lease_token}::uuid
       and attempt_count = ${row.attempt_count}
     returning id, workspace_id, project_id, offer_id, variant_id,
               variant_revision, attempt_count, created_by
  `);
  const finalized = result.rows[0];
  if (finalized) await recordState(tx, finalized, "failed_final", "invalid_input");
}

export async function claimOfferReleaseCandidate(
  tx: TenantTx,
  value: unknown,
): Promise<OfferReleaseCandidateClaim | null> {
  const parsed = claimSchema.safeParse(value);
  if (!parsed.success) invalidInput();
  const input = parsed.data;
  const row = await lockedCandidate(tx, input.workspaceId, input.candidateId);
  if (row === null) return null;
  const dbNow = databaseNow(row);
  const leaseExpiresAt = parseDate(row.lease_expires_at);
  const nextAttemptAt = parseDate(row.next_attempt_at);
  if (nextAttemptAt === null) invalidInput();

  const sameLiveLease = row.state === "running"
    && row.lease_token === input.leaseToken
    && leaseExpiresAt !== null
    && leaseExpiresAt.getTime() > dbNow.getTime();
  const dueQueued = row.state === "queued"
    && nextAttemptAt.getTime() <= dbNow.getTime();
  const dueRetry = row.state === "retry_wait"
    && nextAttemptAt.getTime() <= dbNow.getTime();
  const expiredRunning = row.state === "running"
    && leaseExpiresAt !== null
    && leaseExpiresAt.getTime() <= dbNow.getTime();

  if (sameLiveLease) {
    try {
      return claimResult(row);
    } catch (error) {
      if (
        error instanceof OfferReleaseCandidateWorkerError
        && error.code === "invalid_input"
      ) {
        await markInvalidInputFinal(tx, row);
        return null;
      }
      throw error;
    }
  }
  if (!dueQueued && !dueRetry && !expiredRunning) return null;

  if (
    expiredRunning
    && row.attempt_count >= OFFER_RELEASE_CANDIDATE_MAX_ATTEMPTS
  ) {
    const result = await tx.execute<StateTrace>(sql`
      update offer_release_candidate
         set state = 'failed_final',
             next_attempt_at = pg_catalog.clock_timestamp(),
             lease_token = null,
             lease_expires_at = null,
             error_code = 'lease_expired',
             error_retryable = false,
             finished_at = pg_catalog.clock_timestamp(),
             updated_at = pg_catalog.clock_timestamp()
       where workspace_id = ${input.workspaceId}::uuid
         and id = ${input.candidateId}::uuid
         and state = 'running'
         and attempt_count = ${row.attempt_count}
         and lease_expires_at <= pg_catalog.clock_timestamp()
       returning id, workspace_id, project_id, offer_id, variant_id,
                 variant_revision, attempt_count, created_by
    `);
    const finalized = result.rows[0];
    if (finalized) {
      await recordState(tx, finalized, "failed_final", "lease_expired");
    }
    return null;
  }
  if (row.attempt_count >= OFFER_RELEASE_CANDIDATE_MAX_ATTEMPTS) return null;

  const updated = await tx.execute<CandidateRow>(sql`
    update offer_release_candidate
       set state = 'running',
           attempt_count = attempt_count + 1,
           next_attempt_at = pg_catalog.clock_timestamp(),
           lease_token = ${input.leaseToken}::uuid,
           lease_expires_at = pg_catalog.clock_timestamp()
             + ${OFFER_RELEASE_CANDIDATE_LEASE_MS} * interval '1 millisecond',
           started_at = coalesce(started_at, pg_catalog.clock_timestamp()),
           finished_at = null,
           error_code = null,
           error_retryable = null,
           updated_at = pg_catalog.clock_timestamp()
     where workspace_id = ${input.workspaceId}::uuid
       and id = ${input.candidateId}::uuid
       and attempt_count = ${row.attempt_count}
       and attempt_count < ${OFFER_RELEASE_CANDIDATE_MAX_ATTEMPTS}
       and (
         (state = 'queued' and next_attempt_at <= pg_catalog.clock_timestamp())
         or (state = 'retry_wait' and next_attempt_at <= pg_catalog.clock_timestamp())
         or (state = 'running' and lease_expires_at <= pg_catalog.clock_timestamp())
       )
     returning id, workspace_id, project_id, offer_id, variant_id,
               variant_revision, input_version, canonicalization_version,
               template_version, renderer_recipe_version, input_snapshot,
               encode(input_sha256, 'hex') as input_sha256_hex,
               state, attempt_count, next_attempt_at, lease_token,
               lease_expires_at, started_at, finished_at, error_code,
               error_retryable, artifact_mime_type,
               encode(artifact_sha256, 'hex') as artifact_sha256_hex,
               artifact_size_bytes, artifact_bytes, artifact_version, created_by,
               pg_catalog.clock_timestamp() as db_now
  `);
  const claimed = updated.rows[0];
  if (!claimed) return null;
  let result: OfferReleaseCandidateClaim;
  try {
    result = claimResult(claimed);
  } catch (error) {
    if (
      error instanceof OfferReleaseCandidateWorkerError
      && error.code === "invalid_input"
    ) {
      await markInvalidInputFinal(tx, claimed);
      return null;
    }
    throw error;
  }
  await enqueueDispatch(tx, input.workspaceId, input.candidateId);
  await recordState(tx, claimed, "running");
  return result;
}

function assertClaim(
  row: CandidateRow | null,
  leaseToken: string,
  attemptCount: number,
): asserts row is CandidateRow {
  const leaseExpiresAt = row === null ? null : parseDate(row.lease_expires_at);
  if (
    row === null
    || row.state !== "running"
    || row.lease_token !== leaseToken
    || row.attempt_count !== attemptCount
    || leaseExpiresAt === null
    || leaseExpiresAt.getTime() <= databaseNow(row).getTime()
  ) stale();
}

function retryDelayMs(attemptCount: number): number {
  return Math.min(
    OFFER_RELEASE_CANDIDATE_BASE_BACKOFF_MS
      * (2 ** Math.max(0, attemptCount - 1)),
    OFFER_RELEASE_CANDIDATE_MAX_BACKOFF_MS,
  );
}

function failureIsRetryable(code: z.infer<typeof failureCodeSchema>): boolean {
  return code === "browser_unavailable"
    || code === "render_timeout"
    || code === "storage_unavailable";
}

export async function finalizeOfferReleaseCandidateFailure(
  tx: TenantTx,
  value: unknown,
): Promise<OfferReleaseCandidateFailureResult> {
  const parsed = failureSchema.safeParse(value);
  if (!parsed.success) invalidInput();
  const input = parsed.data;
  if (failureIsRetryable(input.errorCode) !== input.retryable) invalidInput();
  const row = await lockedCandidate(tx, input.workspaceId, input.candidateId);
  assertClaim(row, input.leaseToken, input.attemptCount);

  const willRetry = input.retryable
    && row.attempt_count < OFFER_RELEASE_CANDIDATE_MAX_ATTEMPTS;
  const state = willRetry ? "retry_wait" as const : "failed_final" as const;
  const delayMs = retryDelayMs(row.attempt_count);
  const result = await tx.execute<StateTrace & {
    next_attempt_at: Date | string;
    [key: string]: unknown;
  }>(sql`
    with database_clock as (
      select pg_catalog.clock_timestamp() as db_now
    )
    update offer_release_candidate
       set state = ${state},
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
       and id = ${input.candidateId}::uuid
       and state = 'running'
       and lease_token = ${input.leaseToken}::uuid
       and attempt_count = ${input.attemptCount}
       and lease_expires_at > database_clock.db_now
     returning id, workspace_id, project_id, offer_id, variant_id,
               variant_revision, attempt_count, created_by, next_attempt_at
  `);
  const finalized = result.rows[0];
  if (!finalized) stale();
  if (willRetry) await enqueueDispatch(tx, input.workspaceId, input.candidateId);
  await recordState(tx, finalized, state, input.errorCode);
  const nextAttemptAt = new Date(finalized.next_attempt_at);
  if (!Number.isFinite(nextAttemptAt.getTime())) invalidInput();
  return { state, attemptCount: finalized.attempt_count, nextAttemptAt };
}

function validatedArtifact(value: unknown): RenderedOfferPdf {
  if (value === null || typeof value !== "object") {
    throw new OfferReleaseCandidateWorkerError("invalid_pdf");
  }
  const candidate = value as Partial<RenderedOfferPdf>;
  if (
    Object.keys(candidate).some((key) => ![
      "bytes", "sha256", "sizeBytes", "mimeType",
    ].includes(key))
    || Object.keys(candidate).length !== 4
    || candidate.mimeType !== "application/pdf"
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
  ) throw new OfferReleaseCandidateWorkerError("invalid_pdf");
  const actual = createHash("sha256").update(candidate.bytes).digest();
  const expected = Buffer.from(candidate.sha256, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new OfferReleaseCandidateWorkerError("invalid_pdf");
  }
  return {
    mimeType: "application/pdf",
    bytes: Buffer.from(candidate.bytes),
    sha256: candidate.sha256,
    sizeBytes: candidate.sizeBytes as number,
  };
}

function storedArtifact(row: CandidateRow): RenderedOfferPdf {
  return validatedArtifact({
    mimeType: row.artifact_mime_type,
    bytes: row.artifact_bytes,
    sha256: row.artifact_sha256_hex,
    sizeBytes: row.artifact_size_bytes,
  });
}

function sameArtifact(left: RenderedOfferPdf, right: RenderedOfferPdf): boolean {
  return left.mimeType === right.mimeType
    && left.sizeBytes === right.sizeBytes
    && left.sha256 === right.sha256
    && left.bytes.equals(right.bytes);
}

export async function finalizeOfferReleaseCandidateSuccess(
  tx: TenantTx,
  value: unknown,
): Promise<OfferReleaseCandidateSuccessResult> {
  if (value === null || typeof value !== "object") invalidInput();
  const candidate = value as Record<string, unknown>;
  const parsedKey = finalizationKeySchema.safeParse({
    workspaceId: candidate.workspaceId,
    candidateId: candidate.candidateId,
    leaseToken: candidate.leaseToken,
    attemptCount: candidate.attemptCount,
  });
  if (!parsedKey.success || !Object.hasOwn(candidate, "artifact")) invalidInput();
  if (Object.keys(candidate).some((key) => ![
    "workspaceId", "candidateId", "leaseToken", "attemptCount", "artifact",
  ].includes(key))) invalidInput();
  const input = parsedKey.data;
  const artifact = validatedArtifact(candidate.artifact);
  const row = await lockedCandidate(tx, input.workspaceId, input.candidateId);
  if (row?.state === "ready_for_approval") {
    if (row.attempt_count !== input.attemptCount) retryConflict();
    if (!z.uuid().safeParse(row.artifact_version).success) retryConflict();
    parseStoredInput(row);
    const existing = storedArtifact(row);
    if (!sameArtifact(existing, artifact)) {
      throw new OfferReleaseCandidateWorkerError("renderer_nondeterministic");
    }
    return {
      state: "ready_for_approval",
      attemptCount: row.attempt_count,
      replayed: true,
    };
  }
  assertClaim(row, input.leaseToken, input.attemptCount);
  parseStoredInput(row);
  if (
    row.artifact_mime_type !== null
    || row.artifact_sha256_hex !== null
    || row.artifact_size_bytes !== null
    || row.artifact_bytes !== null
    || row.artifact_version !== null
  ) retryConflict();

  const result = await tx.execute<StateTrace>(sql`
    update offer_release_candidate
       set state = 'ready_for_approval',
           next_attempt_at = pg_catalog.clock_timestamp(),
           lease_token = null,
           lease_expires_at = null,
           error_code = null,
           error_retryable = null,
           artifact_mime_type = 'application/pdf',
           artifact_sha256 = decode(${artifact.sha256}, 'hex'),
           artifact_size_bytes = ${artifact.sizeBytes},
           artifact_bytes = ${artifact.bytes},
           artifact_version = pg_catalog.gen_random_uuid(),
           finished_at = pg_catalog.clock_timestamp(),
           updated_at = pg_catalog.clock_timestamp()
     where workspace_id = ${input.workspaceId}::uuid
       and id = ${input.candidateId}::uuid
       and state = 'running'
       and lease_token = ${input.leaseToken}::uuid
       and attempt_count = ${input.attemptCount}
       and lease_expires_at > pg_catalog.clock_timestamp()
       and artifact_mime_type is null
       and artifact_sha256 is null
       and artifact_size_bytes is null
       and artifact_bytes is null
       and artifact_version is null
     returning id, workspace_id, project_id, offer_id, variant_id,
               variant_revision, attempt_count, created_by
  `);
  const finalized = result.rows[0];
  if (!finalized) stale();
  await recordState(tx, finalized, "ready_for_approval");
  return {
    state: "ready_for_approval",
    attemptCount: finalized.attempt_count,
    replayed: false,
  };
}

export async function requeueDueOfferReleaseCandidates(
  tx: TenantTx,
  value: unknown,
): Promise<string[]> {
  const parsed = requeueSchema.safeParse(value);
  if (!parsed.success) invalidInput();
  const input = parsed.data;
  const result = await tx.execute<RecoveryTrace>(sql`
    with due as (
      select id, state as recovery_state
        from offer_release_candidate
       where workspace_id = ${input.workspaceId}::uuid
         and (
           (state = 'retry_wait'
             and next_attempt_at <= pg_catalog.clock_timestamp())
           or (state = 'running'
             and lease_expires_at <= pg_catalog.clock_timestamp())
         )
       order by case
                  when state = 'retry_wait' then next_attempt_at
                  else lease_expires_at
                end,
                created_at, id
       limit ${input.limit}
       for update skip locked
    ), requeued as (
      update offer_release_candidate candidate
         set state = 'queued',
             next_attempt_at = pg_catalog.clock_timestamp(),
             error_code = null,
             error_retryable = null,
             updated_at = pg_catalog.clock_timestamp()
        from due
       where candidate.workspace_id = ${input.workspaceId}::uuid
         and candidate.id = due.id
         and due.recovery_state = 'retry_wait'
       returning candidate.id, candidate.workspace_id,
                 candidate.project_id, candidate.offer_id,
                 candidate.variant_id, candidate.variant_revision,
                 candidate.attempt_count, candidate.created_by,
                 'retry_wait'::text as recovery_state
    ), expired_running as (
      select candidate.id, candidate.workspace_id, candidate.project_id,
             candidate.offer_id, candidate.variant_id,
             candidate.variant_revision, candidate.attempt_count,
             candidate.created_by, 'running'::text as recovery_state
        from offer_release_candidate as candidate
        join due on due.id = candidate.id
       where candidate.workspace_id = ${input.workspaceId}::uuid
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
): Promise<OfferReleaseCandidateRecoveryWorkspacePage> {
  const parsed = recoveryWorkspaceSchema.safeParse(value);
  if (!parsed.success) invalidInput();
  const input = parsed.data;

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
                     'candidateId', job.data->>'candidateId'
                   )
                   and job.data->>'schemaVersion' = $2::text
                   and job.data->>'workspaceId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   and job.data->>'candidateId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
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
    "offer.release-candidate.render",
    OFFER_RELEASE_CANDIDATE_DISPATCH_VERSION,
    input.afterWorkspaceId,
    input.limit,
  ]);
  if (result.rows.some((row) => row.contract_valid !== true)) invalidInput();

  const candidateWorkspaceIds: string[] = [];
  for (const row of result.rows) {
    if (row.workspace_id === null) continue;
    const parsedWorkspaceId = z.uuid().safeParse(row.workspace_id);
    if (!parsedWorkspaceId.success) invalidInput();
    candidateWorkspaceIds.push(parsedWorkspaceId.data);
  }
  const workspaceIds: string[] = [];
  for (const workspaceId of candidateWorkspaceIds) {
    if (await tenantWorkspaceExists(pool, workspaceId)) workspaceIds.push(workspaceId);
  }
  return {
    workspaceIds,
    nextAfterWorkspaceId: candidateWorkspaceIds.length === input.limit
      ? candidateWorkspaceIds.at(-1) ?? null
      : null,
  };
}

/** Dedicated app_worker pool; rendering stays outside every transaction. */
export function createOfferReleaseCandidateDatabaseGateway(
  connectionString: string,
  onPoolError: (error: Error) => void,
  max = 2,
): OfferReleaseCandidateDatabaseGateway {
  const pool = new Pool(servicePoolConfig(connectionString, "app_worker", max));
  pool.on("error", onPoolError);
  let closePromise: Promise<void> | undefined;
  const database: OfferReleaseCandidateDatabase = {
    claim: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      claimOfferReleaseCandidate(tx, input)),
    finalizeSuccess: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      finalizeOfferReleaseCandidateSuccess(tx, input)),
    finalizeFailure: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      finalizeOfferReleaseCandidateFailure(tx, input)),
  };
  return {
    database,
    listRecoveryWorkspaces: (input) => listRecoveryWorkspaces(pool, input),
    requeueDue: (input) => withTenantOn(pool, input.workspaceId, (tx) =>
      requeueDueOfferReleaseCandidates(tx, input)),
    async probe() {
      await pool.query("select 1");
    },
    close() {
      closePromise ??= pool.end();
      return closePromise;
    },
  };
}
