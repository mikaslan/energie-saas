import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  canonicalizeCalculationJson,
  hashPlanningCalculationInput,
  validatePlanningCalculationRequest,
  validatePlanningCalculationResult,
  type PlanningCalculationRequestV1,
} from "@/lib/integrations/calculation/contract";
import { validatePlanningCalculationResultExactlyForRequest } from
  "@/lib/integrations/calculation/validate-result";
import {
  hashProjectCalculationPreparation,
  projectCalculationPreparationV1Schema,
  type ProjectCalculationPreparationV1,
} from "@/lib/integrations/calculation/preparation";

const LEASE_MS = 15 * 60_000;
const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 60 * 60_000;
const BASE_BACKOFF_MS = 30_000;

type CalculationServiceErrorCode =
  | "dispatch_unavailable"
  | "invalid_input"
  | "retry_conflict"
  | "stale";

class CalculationServiceError extends Error {
  constructor(public readonly code: CalculationServiceErrorCode) {
    super("calculation worker operation failed");
  }
}

const workerKeySchema = z.strictObject({
  workspaceId: z.uuid(),
  jobId: z.uuid(),
});

const claimInputSchema = workerKeySchema.extend({
  leaseToken: z.uuid(),
});

const storedInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  jobId: z.uuid(),
  leaseToken: z.uuid(),
  attemptCount: z.int().min(1).max(MAX_ATTEMPTS),
  inputSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  inputSnapshot: z.unknown(),
  providerSnapshot: z.unknown(),
});

const failureCodeSchema = z.enum([
  "stale",
  "provider_unavailable",
  "provider_invalid",
  "rate_limited",
  "engine_unavailable",
  "engine_invalid",
  "retry_conflict",
]);

const failureInputSchema = claimInputSchema.extend({
  attemptCount: z.int().min(1).max(MAX_ATTEMPTS),
  errorCode: failureCodeSchema,
  retryable: z.boolean(),
  retryAfterMs: z.number().finite().min(0).max(MAX_BACKOFF_MS).optional(),
});

const successInputSchema = claimInputSchema.extend({
  attemptCount: z.int().min(1).max(MAX_ATTEMPTS),
  result: z.unknown(),
});

const requeueInputSchema = z.strictObject({
  workspaceId: z.uuid(),
  limit: z.int().min(1).max(100),
});

function invalidInput(): never {
  throw new CalculationServiceError("invalid_input");
}

function stale(): never {
  throw new CalculationServiceError("stale");
}

function retryConflict(): never {
  throw new CalculationServiceError("retry_conflict");
}

export async function enqueueProjectCalculationDispatch(
  tx: TenantTx,
  workspaceId: string,
  jobId: string,
): Promise<void> {
  const keys = workerKeySchema.safeParse({ workspaceId, jobId });
  if (!keys.success) invalidInput();
  const gate = await tx.execute<{
    dispatch_signature: string | null;
    current_role: string;
    session_role: string;
    database_name: string;
    [key: string]: unknown;
  }>(sql`
    select pg_catalog.to_regprocedure(
             'pgboss.enqueue_project_calculation(uuid,uuid)'
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
    throw new CalculationServiceError("dispatch_unavailable");
  }
  await tx.execute(sql`
    select pgboss.enqueue_project_calculation(
      ${workspaceId}::uuid,
      ${jobId}::uuid
    )
  `);
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeCalculationJson(left) === canonicalizeCalculationJson(right);
  } catch {
    return false;
  }
}

type StoredCalculationInput = {
  inputSha256: string;
  inputSnapshot: PlanningCalculationRequestV1;
  providerSnapshot: PlanningCalculationRequestV1["yieldSnapshots"];
};

type ClaimRow = {
  workspace_id: string;
  id: string;
  project_id: string;
  site_id: string;
  address_revision: number;
  pin_confirmed_address_revision: number;
  profile_id: string;
  profile_revision: number;
  confirmed_profile_revision: number;
  confirmed_address_revision: number;
  requirement_id: string;
  requirement_revision: number;
  source_snapshot_id: string | null;
  contract_version: string;
  provider_recipe_version: string;
  model_id: string;
  model_version: string;
  source_revision: string;
  defaults_version: string;
  state: string;
  attempt_count: number;
  next_attempt_at: Date | string;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  started_at: Date | string | null;
  input_sha256: string | null;
  input_snapshot: unknown;
  provider_snapshot: unknown;
  preparation_snapshot: unknown;
  preparation_sha256: string | null;
  db_now: Date | string;
  [key: string]: unknown;
};

export type ProjectCalculationClaim = {
  workspaceId: string;
  jobId: string;
  projectId: string;
  siteId: string;
  addressRevision: number;
  pinConfirmedAddressRevision: number;
  energyProfileId: string;
  energyProfileRevision: number;
  confirmedEnergyProfileRevision: number;
  confirmedEnergyProfileAddressRevision: number;
  projectRequirementId: string;
  projectRequirementRevision: number;
  sourceCalculatorSnapshotId: string | null;
  contractVersion: string;
  providerRecipeVersion: string;
  modelId: string;
  modelVersion: string;
  sourceRevision: string;
  defaultsVersion: string;
  leaseToken: string;
  leaseExpiresAt: Date;
  startedAt: Date;
  attemptCount: number;
  providerRequest: {
    latitude: number;
    longitude: number;
    roofs: Array<{ roofId: string; tiltDeg: number; azimuthDeg: number }>;
  } | null;
  input: StoredCalculationInput | null;
  preparation: ProjectCalculationPreparationV1 | null;
};

function parseStoredInput(row: ClaimRow): StoredCalculationInput | null {
  if (
    row.input_sha256 === null
    && row.input_snapshot === null
    && row.provider_snapshot === null
  ) return null;
  if (
    row.input_sha256 === null
    || row.input_snapshot === null
    || row.provider_snapshot === null
  ) invalidInput();

  const request = validatePlanningCalculationRequest(row.input_snapshot);
  if (
    !request.ok
    || hashPlanningCalculationInput(request.value) !== row.input_sha256
    || !sameJson(request.value.yieldSnapshots, row.provider_snapshot)
  ) invalidInput();
  return {
    inputSha256: row.input_sha256,
    inputSnapshot: request.value,
    providerSnapshot: request.value.yieldSnapshots,
  };
}

function parsePreparation(row: ClaimRow): ProjectCalculationPreparationV1 | null {
  if (row.preparation_snapshot === null && row.preparation_sha256 === null) return null;
  if (row.preparation_snapshot === null || row.preparation_sha256 === null) return null;
  const parsed = projectCalculationPreparationV1Schema.safeParse(
    row.preparation_snapshot,
  );
  if (
    !parsed.success
    || hashProjectCalculationPreparation(parsed.data) !== row.preparation_sha256
  ) return null;
  return parsed.data;
}

function claimResult(row: ClaimRow): ProjectCalculationClaim {
  const leaseExpiresAt = new Date(row.lease_expires_at as Date | string);
  const startedAt = new Date(row.started_at as Date | string);
  if (!Number.isFinite(leaseExpiresAt.getTime()) || !Number.isFinite(startedAt.getTime())) {
    invalidInput();
  }
  const stored = parseStoredInput(row);
  const preparation = parsePreparation(row);
  return {
    workspaceId: row.workspace_id,
    jobId: row.id,
    projectId: row.project_id,
    siteId: row.site_id,
    addressRevision: row.address_revision,
    pinConfirmedAddressRevision: row.pin_confirmed_address_revision,
    energyProfileId: row.profile_id,
    energyProfileRevision: row.profile_revision,
    confirmedEnergyProfileRevision: row.confirmed_profile_revision,
    confirmedEnergyProfileAddressRevision: row.confirmed_address_revision,
    projectRequirementId: row.requirement_id,
    projectRequirementRevision: row.requirement_revision,
    sourceCalculatorSnapshotId: row.source_snapshot_id,
    contractVersion: row.contract_version,
    providerRecipeVersion: row.provider_recipe_version,
    modelId: row.model_id,
    modelVersion: row.model_version,
    sourceRevision: row.source_revision,
    defaultsVersion: row.defaults_version,
    leaseToken: row.lease_token as string,
    leaseExpiresAt,
    startedAt,
    attemptCount: row.attempt_count,
    providerRequest: preparation === null ? null : {
      latitude: preparation.latitude,
      longitude: preparation.longitude,
      roofs: preparation.profile.roofs.map((roof) => ({
        roofId: roof.id,
        tiltDeg: roof.tiltDeg,
        azimuthDeg: roof.azimuthDeg,
      })),
    },
    input: stored,
    preparation: preparation === null ? null : structuredClone(preparation),
  };
}

function claimDatabaseNow(row: ClaimRow): Date {
  const value = new Date(row.db_now);
  if (!Number.isFinite(value.getTime())) invalidInput();
  return value;
}

async function lockedClaimRow(
  tx: TenantTx,
  workspaceId: string,
  jobId: string,
): Promise<ClaimRow | null> {
  const result = await tx.execute<ClaimRow>(sql`
    select job.workspace_id, job.id, job.project_id, job.site_id,
           job.address_revision, job.pin_confirmed_address_revision,
           job.profile_id, job.profile_revision, job.confirmed_profile_revision,
           job.confirmed_address_revision, job.requirement_id,
           job.requirement_revision, job.source_snapshot_id,
           job.contract_version, job.provider_recipe_version, job.model_id,
           job.model_version, job.source_revision, job.defaults_version, job.state,
           job.attempt_count, job.next_attempt_at, job.lease_token,
           job.lease_expires_at, job.started_at,
           encode(job.input_sha256, 'hex') as input_sha256,
           job.input_snapshot, job.provider_snapshot,
           job.preparation_snapshot,
           encode(job.preparation_sha256, 'hex') as preparation_sha256,
           pg_catalog.clock_timestamp() as db_now
      from project_calculation_job job
     where job.workspace_id = ${workspaceId}::uuid
       and job.id = ${jobId}::uuid
     for update
  `);
  return result.rows[0] ?? null;
}

export async function claimProjectCalculationJob(
  tx: TenantTx,
  input: z.input<typeof claimInputSchema>,
): Promise<ProjectCalculationClaim | null> {
  const parsed = claimInputSchema.safeParse(input);
  if (!parsed.success) invalidInput();
  const value = parsed.data;
  const row = await lockedClaimRow(tx, value.workspaceId, value.jobId);
  if (row === null) return null;
  const databaseNow = claimDatabaseNow(row);

  if (
    row.state === "running"
    && row.lease_token === value.leaseToken
    && row.lease_expires_at !== null
    && new Date(row.lease_expires_at).getTime() > databaseNow.getTime()
  ) {
    return claimResult(row);
  }
  const dueRetryWait = row.state === "retry_wait"
    && new Date(row.next_attempt_at).getTime() <= databaseNow.getTime();
  const dueQueued = row.state === "queued"
    && new Date(row.next_attempt_at).getTime() <= databaseNow.getTime();
  const expiredRunning = row.state === "running"
    && row.lease_expires_at !== null
    && new Date(row.lease_expires_at).getTime() <= databaseNow.getTime();
  if (!dueRetryWait && !dueQueued && !expiredRunning) return null;

  if (expiredRunning && row.attempt_count >= MAX_ATTEMPTS) {
    await tx.execute(sql`
      update project_calculation_job
         set state = 'failed_final',
             next_attempt_at = pg_catalog.clock_timestamp(),
             lease_token = null,
             lease_expires_at = null,
             error_code = 'worker_unavailable',
             error_retryable = false,
             finished_at = pg_catalog.clock_timestamp()
       where workspace_id = ${value.workspaceId}::uuid
         and id = ${value.jobId}::uuid
         and state = 'running'
         and attempt_count = ${row.attempt_count}
         and lease_expires_at <= pg_catalog.clock_timestamp()
    `);
    return null;
  }
  if (row.attempt_count >= MAX_ATTEMPTS) return null;

  if (dueRetryWait) {
    const requeued = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      update project_calculation_job
         set state = 'queued',
             next_attempt_at = pg_catalog.clock_timestamp(),
             error_code = null,
             error_retryable = null
       where workspace_id = ${value.workspaceId}::uuid
         and id = ${value.jobId}::uuid
         and state = 'retry_wait'
         and attempt_count = ${row.attempt_count}
         and next_attempt_at <= pg_catalog.clock_timestamp()
       returning id
    `);
    if (requeued.rows.length !== 1) return null;
  }

  const updated = await tx.execute<ClaimRow>(sql`
    update project_calculation_job
       set state = 'running',
           attempt_count = attempt_count + 1,
           next_attempt_at = pg_catalog.clock_timestamp(),
           lease_token = ${value.leaseToken}::uuid,
           lease_expires_at = pg_catalog.clock_timestamp()
             + ${LEASE_MS} * interval '1 millisecond',
           started_at = coalesce(started_at, pg_catalog.clock_timestamp()),
           error_code = null,
           error_retryable = null
     where workspace_id = ${value.workspaceId}::uuid
       and id = ${value.jobId}::uuid
       and attempt_count = ${row.attempt_count}
     returning workspace_id, id, project_id, site_id, address_revision,
               pin_confirmed_address_revision, profile_id, profile_revision,
               confirmed_profile_revision, confirmed_address_revision,
               requirement_id, requirement_revision, source_snapshot_id,
               contract_version, provider_recipe_version, model_id,
               model_version, source_revision, defaults_version, state, attempt_count,
               next_attempt_at, lease_token, lease_expires_at, started_at,
               encode(input_sha256, 'hex') as input_sha256,
               input_snapshot, provider_snapshot, preparation_snapshot,
               encode(preparation_sha256, 'hex') as preparation_sha256,
               pg_catalog.clock_timestamp() as db_now
  `);
  const claimed = updated.rows[0];
  if (!claimed) return null;
  await enqueueProjectCalculationDispatch(tx, value.workspaceId, value.jobId);
  return claimResult(claimed);
}

export type PersistedProjectCalculationInput = StoredCalculationInput & {
  replayed: boolean;
};

export async function persistProjectCalculationInput(
  tx: TenantTx,
  input: z.input<typeof storedInputSchema>,
): Promise<PersistedProjectCalculationInput> {
  const parsed = storedInputSchema.safeParse(input);
  if (!parsed.success) invalidInput();
  const value = parsed.data;
  const request = validatePlanningCalculationRequest(value.inputSnapshot);
  if (
    !request.ok
    || hashPlanningCalculationInput(request.value) !== value.inputSha256
    || !sameJson(request.value.yieldSnapshots, value.providerSnapshot)
  ) invalidInput();

  const row = await lockedClaimRow(tx, value.workspaceId, value.jobId);
  if (
    row === null
    || row.state !== "running"
    || row.lease_token !== value.leaseToken
    || row.attempt_count !== value.attemptCount
    || row.lease_expires_at === null
    || new Date(row.lease_expires_at).getTime()
      <= claimDatabaseNow(row).getTime()
  ) stale();
  const existing = parseStoredInput(row);
  if (existing !== null) {
    if (
      existing.inputSha256 !== value.inputSha256
      || !sameJson(existing.inputSnapshot, request.value)
      || !sameJson(existing.providerSnapshot, value.providerSnapshot)
    ) retryConflict();
    return { ...existing, replayed: true };
  }

  const updated = await tx.execute<{
    input_sha256: string;
    input_snapshot: unknown;
    provider_snapshot: unknown;
    [key: string]: unknown;
  }>(sql`
    update project_calculation_job
       set input_sha256 = decode(${value.inputSha256}, 'hex'),
           input_snapshot = ${JSON.stringify(request.value)}::jsonb,
           provider_snapshot = ${JSON.stringify(value.providerSnapshot)}::jsonb
     where workspace_id = ${value.workspaceId}::uuid
       and id = ${value.jobId}::uuid
       and state = 'running'
       and lease_token = ${value.leaseToken}::uuid
       and attempt_count = ${value.attemptCount}
       and lease_expires_at > pg_catalog.clock_timestamp()
       and input_sha256 is null
       and input_snapshot is null
       and provider_snapshot is null
     returning encode(input_sha256, 'hex') as input_sha256,
               input_snapshot, provider_snapshot
  `);
  const stored = updated.rows[0];
  if (!stored) stale();
  return {
    inputSha256: stored.input_sha256,
    inputSnapshot: request.value,
    providerSnapshot: request.value.yieldSnapshots,
    replayed: false,
  };
}

type FinalizationJobRow = {
  workspace_id: string;
  id: string;
  project_id: string;
  site_id: string;
  address_revision: number;
  pin_confirmed_address_revision: number;
  profile_id: string;
  profile_revision: number;
  confirmed_profile_revision: number;
  confirmed_address_revision: number;
  requirement_id: string;
  requirement_revision: number;
  source_snapshot_id: string | null;
  contract_version: string;
  model_id: string;
  model_version: string;
  source_revision: string;
  defaults_version: string;
  state: string;
  attempt_count: number;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  input_sha256: string | null;
  input_snapshot: unknown;
  provider_snapshot: unknown;
  created_by: string;
  result_revision_id: string | null;
  db_now: Date | string;
  [key: string]: unknown;
};

async function lockFinalizationJob(
  tx: TenantTx,
  workspaceId: string,
  jobId: string,
): Promise<FinalizationJobRow | null> {
  const result = await tx.execute<FinalizationJobRow>(sql`
    select workspace_id, id, project_id, site_id, address_revision,
           pin_confirmed_address_revision, profile_id, profile_revision,
           confirmed_profile_revision, confirmed_address_revision,
           requirement_id, requirement_revision, source_snapshot_id,
           contract_version, model_id, model_version, source_revision,
           defaults_version, state, attempt_count, lease_token, lease_expires_at,
           encode(input_sha256, 'hex') as input_sha256,
           input_snapshot, provider_snapshot, created_by, result_revision_id,
           pg_catalog.clock_timestamp() as db_now
      from project_calculation_job
     where workspace_id = ${workspaceId}::uuid
       and id = ${jobId}::uuid
     for update
  `);
  return result.rows[0] ?? null;
}

async function lockFinalizationProject(
  tx: TenantTx,
  workspaceId: string,
  jobId: string,
): Promise<string | null> {
  const result = await tx.execute<{
    project_id: string | null;
    [key: string]: unknown;
  }>(sql`
    select public.lock_project_calculation_finalization(
      ${workspaceId}::uuid,
      ${jobId}::uuid
    ) as project_id
  `);
  return result.rows[0]?.project_id ?? null;
}

function assertClaim(
  row: FinalizationJobRow | null,
  leaseToken: string,
  attemptCount: number,
): asserts row is FinalizationJobRow {
  if (
    row === null
    || row.state !== "running"
    || row.lease_token !== leaseToken
    || row.attempt_count !== attemptCount
    || row.lease_expires_at === null
    || new Date(row.lease_expires_at).getTime()
      <= new Date(row.db_now).getTime()
  ) stale();
}

function retryDelayMs(attemptCount: number, retryAfterMs?: number): number {
  const exponential = Math.min(
    BASE_BACKOFF_MS * (2 ** Math.max(0, attemptCount - 1)),
    MAX_BACKOFF_MS,
  );
  return Math.min(Math.max(exponential, retryAfterMs ?? 0), MAX_BACKOFF_MS);
}

export async function finalizeProjectCalculationFailure(
  tx: TenantTx,
  input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
    attemptCount: number;
    errorCode: string;
    retryable: boolean;
    retryAfterMs?: number;
  },
): Promise<{
  state: "retry_wait" | "failed_final";
  attemptCount: number;
  nextAttemptAt: Date;
}> {
  const parsed = failureInputSchema.safeParse(input);
  if (!parsed.success) invalidInput();
  const value = parsed.data;
  const row = await lockFinalizationJob(tx, value.workspaceId, value.jobId);
  assertClaim(row, value.leaseToken, value.attemptCount);

  const willRetry = value.retryable && row.attempt_count < MAX_ATTEMPTS;
  const state = willRetry ? "retry_wait" as const : "failed_final" as const;
  const delayMs = retryDelayMs(row.attempt_count, value.retryAfterMs);
  const updated = await tx.execute<{
    id: string;
    next_attempt_at: Date | string;
    [key: string]: unknown;
  }>(sql`
    with database_clock as (
      select pg_catalog.clock_timestamp() as db_now
    )
    update project_calculation_job
       set state = ${state},
           next_attempt_at = case when ${willRetry}
             then database_clock.db_now + ${delayMs} * interval '1 millisecond'
             else database_clock.db_now
           end,
           lease_token = null,
           lease_expires_at = null,
           error_code = ${value.errorCode},
           error_retryable = ${willRetry},
           finished_at = case when ${willRetry}
             then null
             else database_clock.db_now
           end
      from database_clock
     where workspace_id = ${value.workspaceId}::uuid
       and id = ${value.jobId}::uuid
       and state = 'running'
       and lease_token = ${value.leaseToken}::uuid
       and attempt_count = ${value.attemptCount}
       and lease_expires_at > database_clock.db_now
     returning id, next_attempt_at
  `);
  const finalized = updated.rows[0];
  if (!finalized) stale();
  if (willRetry) {
    await enqueueProjectCalculationDispatch(tx, value.workspaceId, value.jobId);
  }
  return {
    state,
    attemptCount: row.attempt_count,
    nextAttemptAt: new Date(finalized.next_attempt_at),
  };
}

export async function requeueDueProjectCalculationJobs(
  tx: TenantTx,
  input: z.input<typeof requeueInputSchema>,
): Promise<string[]> {
  const parsed = requeueInputSchema.safeParse(input);
  if (!parsed.success) invalidInput();
  const value = parsed.data;
  const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    with due as (
      select id
        from project_calculation_job
       where workspace_id = ${value.workspaceId}::uuid
         and state = 'retry_wait'
         and next_attempt_at <= pg_catalog.clock_timestamp()
       order by next_attempt_at, created_at, id
       limit ${value.limit}
       for update skip locked
    )
    update project_calculation_job job
       set state = 'queued',
           next_attempt_at = pg_catalog.clock_timestamp(),
           error_code = null,
           error_retryable = null
      from due
     where job.workspace_id = ${value.workspaceId}::uuid
       and job.id = due.id
     returning job.id
  `);
  const jobIds = result.rows.map((row) => row.id).sort();
  for (const jobId of jobIds) {
    await enqueueProjectCalculationDispatch(tx, value.workspaceId, jobId);
  }
  return jobIds;
}

function inputMatchesJob(
  request: PlanningCalculationRequestV1,
  job: FinalizationJobRow,
): boolean {
  const binding = request.bindings;
  return binding.workspaceId === job.workspace_id
    && binding.projectId === job.project_id
    && binding.siteId === job.site_id
    && binding.addressRevision === job.address_revision
    && binding.pinConfirmedAddressRevision === job.pin_confirmed_address_revision
    && binding.energyProfileId === job.profile_id
    && binding.energyProfileRevision === job.profile_revision
    && binding.confirmedEnergyProfileRevision === job.confirmed_profile_revision
    && binding.confirmedEnergyProfileAddressRevision === job.confirmed_address_revision
    && binding.projectRequirementId === job.requirement_id
    && binding.projectRequirementRevision === job.requirement_revision
    && binding.sourceCalculatorSnapshotId === job.source_snapshot_id
    && request.contractVersion === job.contract_version;
}

export async function finalizeProjectCalculationSuccess(
  tx: TenantTx,
  input: z.input<typeof successInputSchema>,
): Promise<{ revisionId: string; revision: number; replayed: boolean }> {
  const parsed = successInputSchema.safeParse(input);
  if (!parsed.success) invalidInput();
  const value = parsed.data;
  const validatedResult = validatePlanningCalculationResult(value.result);
  if (!validatedResult.ok) invalidInput();

  // Confirmation and catalog invalidation already use Project -> Job. Take
  // the Project lock through the narrowly granted definer function before
  // touching the worker-owned Job row, otherwise success finalization can
  // deadlock as Job -> Project inside the calculation-revision trigger.
  const lockedProjectId = await lockFinalizationProject(
    tx,
    value.workspaceId,
    value.jobId,
  );
  if (lockedProjectId === null) stale();
  const job = await lockFinalizationJob(tx, value.workspaceId, value.jobId);
  if (job !== null && job.project_id !== lockedProjectId) stale();
  if (job?.state === "succeeded" && job.result_revision_id !== null) {
    const existing = await tx.execute<{
      id: string;
      revision: number;
      result: unknown;
      [key: string]: unknown;
    }>(sql`
      select id, revision, result
        from project_calculation_revision
       where workspace_id = ${value.workspaceId}::uuid
         and id = ${job.result_revision_id}::uuid
         and job_id = ${value.jobId}::uuid
    `);
    const revision = existing.rows[0];
    if (
      revision === undefined
      || job.attempt_count !== value.attemptCount
      || !sameJson(revision.result, validatedResult.value)
    ) retryConflict();
    return { revisionId: revision.id, revision: revision.revision, replayed: true };
  }
  assertClaim(job, value.leaseToken, value.attemptCount);
  if (
    job.input_sha256 === null
    || job.input_snapshot === null
    || job.provider_snapshot === null
  ) invalidInput();
  const request = validatePlanningCalculationRequest(job.input_snapshot);
  const pairedResult = request.ok
    ? validatePlanningCalculationResultExactlyForRequest(request.value, validatedResult.value)
    : null;
  if (
    !request.ok
    || pairedResult === null
    || !pairedResult.ok
    || hashPlanningCalculationInput(request.value) !== job.input_sha256
    || !sameJson(request.value.yieldSnapshots, job.provider_snapshot)
    || !inputMatchesJob(request.value, job)
    || validatedResult.value.inputSha256 !== job.input_sha256
    || validatedResult.value.contractVersion !== job.contract_version
    || validatedResult.value.model.id !== job.model_id
    || validatedResult.value.model.version !== job.model_version
    || validatedResult.value.model.sourceRevision !== job.source_revision
  ) invalidInput();
  const trustedResult = pairedResult.value;
  const revisionId = randomUUID();
  const finalized = await tx.execute<{
    outcome: "created" | "replayed" | "stale" | "conflict";
    revision_id: string | null;
    revision_number: number | null;
    [key: string]: unknown;
  }>(sql`
    select outcome, revision_id, revision_number
      from public.finalize_project_calculation_success(
        ${job.workspace_id}::uuid,
        ${job.id}::uuid,
        ${value.leaseToken}::uuid,
        ${value.attemptCount},
        ${revisionId}::uuid,
        ${JSON.stringify(trustedResult)}::jsonb
      )
  `);
  const finalizedRow = finalized.rows[0];
  if (!finalizedRow || finalizedRow.outcome === "stale") stale();
  if (finalizedRow.outcome === "conflict") retryConflict();
  if (
    finalizedRow.revision_id === null
    || finalizedRow.revision_number === null
  ) invalidInput();
  if (finalizedRow.outcome === "replayed") {
    return {
      revisionId: finalizedRow.revision_id,
      revision: finalizedRow.revision_number,
      replayed: true,
    };
  }
  const committedRevisionId = finalizedRow.revision_id;
  const revision = finalizedRow.revision_number;

  const trace = {
    projectId: job.project_id,
    siteId: job.site_id,
    profileId: job.profile_id,
    profileRevision: job.profile_revision,
    addressRevision: job.address_revision,
    requirementId: job.requirement_id,
    requirementRevision: job.requirement_revision,
    jobId: job.id,
    attemptCount: job.attempt_count,
    revisionId: committedRevisionId,
    revision,
    status: "succeeded",
    quality: trustedResult.quality,
    validationStatus: trustedResult.validationStatus,
  };
  await emitEvent(tx, {
    workspaceId: job.workspace_id,
    aggregateType: "project",
    aggregateId: job.project_id,
    eventType: "project.calculation_succeeded",
    actor: job.created_by,
    payload: trace,
  });
  await writeAudit(tx, {
    workspaceId: job.workspace_id,
    actor: job.created_by,
    action: "project.write",
    resource: "calculation_result",
    allowed: true,
    details: trace,
  });
  return { revisionId: committedRevisionId, revision, replayed: false };
}
