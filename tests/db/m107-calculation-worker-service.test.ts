import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import type { TenantTx } from "@/lib/db/types";
import {
  canonicalizeCalculationJson,
  hashPlanningCalculationInput,
  hashPlanningCalculationResult,
  validatePlanningCalculationRequest,
  validatePlanningCalculationResult,
  type PlanningCalculationRequestV1,
  type PlanningCalculationResultV1,
} from "@/lib/integrations/calculation/contract";
import {
  calculatePlanningEstimate,
} from "@/lib/integrations/calculation/engine";
import {
  buildPlanningCalculationInput,
} from "@/lib/integrations/calculation/prepare";
import {
  PLANNING_MODEL_SOURCE_REVISION,
} from "@/lib/integrations/calculation/versions";
import {
  claimProjectCalculationJob,
  finalizeProjectCalculationFailure,
  finalizeProjectCalculationSuccess,
  persistProjectCalculationInput,
  requeueDueProjectCalculationJobs,
} from "@/modules/energy/calculation-service";
import { getProjectEnergyContext } from "@/modules/energy/service";
import { createCalculationExecuteHandler } from "@/worker/calculation";
import { testPool } from "../setup/test-db";

const NOW = new Date("2026-08-29T12:00:00.000Z");
const MAX_LEASE_MS = 24 * 60 * 60_000;
const MAX_BACKOFF_MS = 24 * 60 * 60_000;
const SOURCE_REVISION = PLANNING_MODEL_SOURCE_REVISION;

const GOLDEN_REQUEST = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/planning-calculation.v1.new.request.json"),
  "utf8",
)) as PlanningCalculationRequestV1;

type CalculationFixture = {
  workspaceId: string;
  actorId: string;
  contactId: string;
  siteId: string;
  projectId: string;
  snapshotId: string;
  requirementId: string;
  profileId: string;
  jobId: string;
  request: PlanningCalculationRequestV1;
  result: PlanningCalculationResultV1;
  inputSha256: string;
};

type StoredCalculationInput = {
  inputSha256: string;
  inputSnapshot: PlanningCalculationRequestV1;
  providerSnapshot: PlanningCalculationRequestV1["yieldSnapshots"];
};

type CalculationClaim = {
  workspaceId: string;
  jobId: string;
  projectId: string;
  siteId: string;
  leaseToken: string;
  leaseExpiresAt: Date | string;
  startedAt: Date | string;
  attemptCount: number;
  input: StoredCalculationInput | null;
};

type PersistedCalculationInput = StoredCalculationInput & {
  replayed: boolean;
};

type CalculationFailure = {
  state: "retry_wait" | "failed_final";
  attemptCount: number;
  nextAttemptAt: Date | string;
};

type CalculationFailureCode =
  | "stale"
  | "provider_unavailable"
  | "provider_invalid"
  | "rate_limited"
  | "engine_unavailable"
  | "engine_invalid"
  | "retry_conflict";

type CalculationSuccess = {
  revisionId: string;
  revision: number;
  replayed: boolean;
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

type JobRow = {
  state: string;
  attempt_count: number;
  next_attempt_at: Date | string;
  lease_token: string | null;
  lease_expires_at: Date | string | null;
  input_sha256: string | null;
  input_snapshot: unknown;
  provider_snapshot: unknown;
  error_code: string | null;
  error_retryable: boolean | null;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  result_revision_id: string | null;
  [key: string]: unknown;
};

type Footprint = {
  job: JobRow;
  revisions: Array<{
    id: string;
    revision: number;
    job_id: string;
    input_sha256: string;
    result_sha256: string;
    quality: string;
    validation_status: string;
    [key: string]: unknown;
  }>;
  events: Array<{
    event_type: string;
    actor: string;
    payload: unknown;
    [key: string]: unknown;
  }>;
  audits: Array<{
    actor: string;
    action: string;
    resource: string;
    allowed: boolean;
    details: unknown;
    [key: string]: unknown;
  }>;
};

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: Deferred<T>["resolve"];
  let rejectPromise!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolveDeferred, rejectDeferred) => {
    resolvePromise = resolveDeferred;
    rejectPromise = rejectDeferred;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitForNamedSessionBlockedBy(
  applicationName: string,
  blockerPid: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const waiting = await testPool.query<{ waiting: boolean }>(`
      select exists (
        select 1
          from pg_catalog.pg_stat_activity
         where application_name = $1
           and state = 'active'
           and wait_event_type = 'Lock'
           and $2::integer = any(pg_catalog.pg_blocking_pids(pid))
      ) as waiting
    `, [applicationName, blockerPid]);
    if (waiting.rows[0]?.waiting === true) return;
  }
  throw new Error("Finalisierung erreichte den vom Project-Besitzer gehaltenen Lock nicht.");
}

function sha256Bytes(value: unknown): Buffer {
  return createHash("sha256")
    .update(canonicalizeCalculationJson(value), "utf8")
    .digest();
}

function boundContract(ids: {
  workspaceId: string;
  projectId: string;
  siteId: string;
  profileId: string;
  requirementId: string;
  snapshotId: string;
}): {
  request: PlanningCalculationRequestV1;
  result: PlanningCalculationResultV1;
  inputSha256: string;
} {
  const request = structuredClone(GOLDEN_REQUEST);
  request.bindings = {
    workspaceId: ids.workspaceId,
    projectId: ids.projectId,
    siteId: ids.siteId,
    addressRevision: 1,
    pinConfirmedAddressRevision: 1,
    energyProfileId: ids.profileId,
    energyProfileRevision: 1,
    confirmedEnergyProfileRevision: 1,
    confirmedEnergyProfileAddressRevision: 1,
    projectRequirementId: ids.requirementId,
    projectRequirementRevision: 1,
    sourceCalculatorSnapshotId: ids.snapshotId,
  };
  request.energyProfile.roofs = request.energyProfile.roofs.map((roof) => ({
    ...roof,
    source: "operator_reviewed" as const,
  }));

  const inputSha256 = hashPlanningCalculationInput(request);
  const result = calculatePlanningEstimate(request);

  const requestValidation = validatePlanningCalculationRequest(request);
  const resultValidation = validatePlanningCalculationResult(result);
  if (!requestValidation.ok) {
    throw new Error(`invalid bound request fixture: ${requestValidation.paths.join(", ")}`);
  }
  if (!resultValidation.ok) {
    throw new Error(`invalid bound result fixture: ${resultValidation.paths.join(", ")}`);
  }
  return { request, result, inputSha256 };
}

async function createFixture(options: {
  attemptCount?: number;
  sourceRevision?: string;
} = {}): Promise<CalculationFixture> {
  const ids = {
    workspaceId: randomUUID(),
    actorId: randomUUID(),
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobId: randomUUID(),
  };
  const contract = boundContract(ids);
  const calculatorSnapshot = {
    schemaVersion: "wmee-solar-snapshot.v1",
    calculatedAt: NOW.toISOString(),
    branch: "new_installation",
    questionnaireVariant: "short",
    resultIntegrity: "client_reported_unverified",
    inputs: {},
    provenance: { investment: "market_estimate" },
    result: { mode: "new_installation" },
  };
  const attemptCount = options.attemptCount ?? 0;
  const sourceRevision = options.sourceRevision ?? SOURCE_REVISION;
  const preparationSnapshot = {
    schemaVersion: "project-calculation-preparation.v1",
    latitude: contract.request.site.latitude,
    longitude: contract.request.site.longitude,
    profile: contract.request.energyProfile,
    requirements: contract.request.projectRequirements,
    sourceSnapshot: {
      schemaVersion: "wmee-solar-snapshot.v1",
      branch: contract.request.branch,
      inputs: {},
    },
  };

  await withTenantOn(testPool, ids.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${ids.workspaceId}::uuid, ${`M1-07 Worker ${ids.jobId}`})
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${ids.actorId}::uuid, ${`${ids.actorId}@calculation-worker.test`})
    `);
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values (${ids.workspaceId}::uuid, ${ids.actorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, email_primary, email_normalized
      ) values (
        ${ids.contactId}::uuid, ${ids.workspaceId}::uuid, 'Worker Secret Customer',
        'customer.secret@example.test', 'customer.secret@example.test'
      )
    `);
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address,
        address_fingerprint, address_fingerprint_version, address_mode,
        street, house_number, postal_code, city, country, lat, lng,
        geocode_source, geocode_precision, address_follow_up_required,
        address_revision, pin_confirmed, pin_confirmed_address_revision
      ) values (
        ${ids.siteId}::uuid, ${ids.workspaceId}::uuid, ${ids.contactId}::uuid,
        'Worker Site', 'Workerweg 7, 69190 Walldorf',
        decode(repeat('71', 32), 'hex'), 1, 'selected', 'Workerweg', '7',
        '69190', 'Walldorf', 'DE', ${contract.request.site.latitude},
        ${contract.request.site.longitude}, 'photon', 'house', false, 1, true, 1
      )
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${ids.projectId}::uuid, ${ids.workspaceId}::uuid,
             ${ids.contactId}::uuid, ${ids.siteId}::uuid,
             board.id, intake_column.id, 'Worker Calculation', 'fixture'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
       and intake_column.board_id = board.id
       and intake_column.is_intake = true
       and intake_column.archived_at is null
      where board.workspace_id = ${ids.workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null
    `);
    await tx.execute(sql`
      insert into inbound_receipt (
        id, workspace_id, source_key, submission_id, contract_version,
        body_sha256, auth_key_id, signed_at, submitted_at, received_at,
        producer_application, producer_git_revision, producer_environment,
        calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
        privacy_notice_version, privacy_notice_url, contact_resolution,
        contact_id, site_id, project_id
      ) values (
        ${ids.receiptId}::uuid, ${ids.workspaceId}::uuid, 'wmee-rechner-v3',
        ${randomUUID()}::uuid, 'rechner-intake.v1',
        decode(repeat('72', 32), 'hex'), 'worker-fixture-key', ${NOW}, ${NOW}, ${NOW},
        'wmee-rechner-v3', ${sourceRevision}, 'development', 'wmee-solar.v1',
        '{}'::jsonb, 'offer_request', 'art_6_1_b_precontractual', 'fixture',
        'https://example.test/privacy', 'created', ${ids.contactId}::uuid,
        ${ids.siteId}::uuid, ${ids.projectId}::uuid
      )
    `);
    await tx.execute(sql`
      insert into calculator_snapshot (
        id, workspace_id, receipt_id, project_id, schema_version,
        calculator_engine, result_integrity, investment_source,
        calculated_at, snapshot
      ) values (
        ${ids.snapshotId}::uuid, ${ids.workspaceId}::uuid, ${ids.receiptId}::uuid,
        ${ids.projectId}::uuid, 'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate', ${NOW},
        ${JSON.stringify(calculatorSnapshot)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into project_requirement (
        id, workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${ids.requirementId}::uuid, ${ids.workspaceId}::uuid,
        ${ids.projectId}::uuid, 1, 'project-requirements.rechner.v1',
        ${ids.snapshotId}::uuid,
        ${JSON.stringify(contract.request.projectRequirements)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into site_energy_profile (
        id, workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256, confirmed_profile_revision,
        confirmed_address_revision, confirmed_by, confirmed_at
      ) values (
        ${ids.profileId}::uuid, ${ids.workspaceId}::uuid, ${ids.siteId}::uuid, 1,
        'site-energy-profile.v1', 'consumption', 'rechner_snapshot',
        ${ids.snapshotId}::uuid, ${ids.projectId}::uuid, 1,
        ${JSON.stringify(contract.request.energyProfile)}::jsonb,
        ${sha256Bytes(contract.request.energyProfile)}, 1, 1,
        ${ids.actorId}::uuid, ${NOW}
      )
    `);
    await tx.execute(sql`
      insert into project_calculation_job (
        id, workspace_id, project_id, site_id, address_revision,
        pin_confirmed_address_revision, profile_id, profile_revision,
        confirmed_profile_revision, confirmed_address_revision,
        requirement_id, requirement_revision, source_snapshot_id,
        reservation_key, provider_recipe_version, contract_version,
        model_id, model_version, source_revision, defaults_version,
        preparation_snapshot, preparation_sha256, state, attempt_count,
        next_attempt_at, created_by
      ) values (
        ${ids.jobId}::uuid, ${ids.workspaceId}::uuid, ${ids.projectId}::uuid,
        ${ids.siteId}::uuid, 1, 1, ${ids.profileId}::uuid, 1, 1, 1,
        ${ids.requirementId}::uuid, 1, ${ids.snapshotId}::uuid,
        ${sha256Bytes({ reservation: ids.jobId })}, 'pvgis-5.3-sarah3-2020.v1',
        'planning-calculation.v1', 'wmee-solar', '1.0.0', ${sourceRevision},
        'wmee-planning-defaults.v1', ${JSON.stringify(preparationSnapshot)}::jsonb,
        ${sha256Bytes(preparationSnapshot)}, 'queued', ${attemptCount}, ${NOW},
        ${ids.actorId}::uuid
      )
    `);
  });

  return { ...ids, ...contract };
}

async function claim(
  fixture: CalculationFixture,
  leaseToken: string,
): Promise<CalculationClaim | null> {
  const value = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
    claimProjectCalculationJob(tx, {
      workspaceId: fixture.workspaceId,
      jobId: fixture.jobId,
      leaseToken,
    }));
  return value as CalculationClaim | null;
}

async function persistInput(
  fixture: CalculationFixture,
  leaseToken: string,
  attemptCount: number,
  request = fixture.request,
): Promise<PersistedCalculationInput> {
  const value = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
    persistProjectCalculationInput(tx, {
      workspaceId: fixture.workspaceId,
      jobId: fixture.jobId,
      leaseToken,
      attemptCount,
      inputSha256: hashPlanningCalculationInput(request),
      inputSnapshot: request,
      providerSnapshot: request.yieldSnapshots,
    }));
  return value as PersistedCalculationInput;
}

async function finalizeFailure(
  fixture: CalculationFixture,
  input: {
    leaseToken: string;
    attemptCount: number;
    errorCode: CalculationFailureCode;
    retryable: boolean;
    retryAfterMs?: number;
  },
): Promise<CalculationFailure> {
  const value = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
    finalizeProjectCalculationFailure(tx, {
      workspaceId: fixture.workspaceId,
      jobId: fixture.jobId,
      ...input,
    }));
  return value as CalculationFailure;
}

async function finalizeSuccess(
  fixture: CalculationFixture,
  input: {
    leaseToken: string;
    attemptCount: number;
    result: PlanningCalculationResultV1;
  },
): Promise<CalculationSuccess> {
  const value = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
    finalizeProjectCalculationSuccess(tx, {
      workspaceId: fixture.workspaceId,
      jobId: fixture.jobId,
      ...input,
    }));
  return value as CalculationSuccess;
}

async function requeueDue(
  fixture: CalculationFixture,
): Promise<string[]> {
  const value = await withTenantOn(testPool, fixture.workspaceId, (tx) =>
    requeueDueProjectCalculationJobs(tx, {
      workspaceId: fixture.workspaceId,
      limit: 10,
    }));
  return value as string[];
}

async function readJob(fixture: CalculationFixture): Promise<JobRow> {
  return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const result = await tx.execute<JobRow>(sql`
      select state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
             encode(input_sha256, 'hex') as input_sha256,
             input_snapshot, provider_snapshot, error_code, error_retryable,
             started_at, finished_at, result_revision_id
      from project_calculation_job
      where workspace_id = ${fixture.workspaceId}::uuid
        and id = ${fixture.jobId}::uuid
    `);
    const row = result.rows[0];
    if (!row) throw new Error("calculation job fixture disappeared");
    return row;
  });
}

async function footprint(fixture: CalculationFixture): Promise<Footprint> {
  return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const job = await readJobIn(tx, fixture);
    const revisions = await tx.execute<Footprint["revisions"][number]>(sql`
      select id, revision, job_id, encode(input_sha256, 'hex') as input_sha256,
             encode(result_sha256, 'hex') as result_sha256,
             quality, validation_status
      from project_calculation_revision
      where workspace_id = ${fixture.workspaceId}::uuid
        and job_id = ${fixture.jobId}::uuid
      order by revision
    `);
    const events = await tx.execute<Footprint["events"][number]>(sql`
      select event_type, actor, payload
      from domain_events
      where workspace_id = ${fixture.workspaceId}::uuid
        and event_type like 'project.calculation_%'
      order by occurred_at, id
    `);
    const audits = await tx.execute<Footprint["audits"][number]>(sql`
      select actor, action, resource, allowed, details
      from audit_log
      where workspace_id = ${fixture.workspaceId}::uuid
      order by occurred_at, id
    `);
    return {
      job,
      revisions: [...revisions.rows],
      events: [...events.rows],
      audits: [...audits.rows],
    };
  });
}

async function readJobIn(tx: TenantTx, fixture: CalculationFixture): Promise<JobRow> {
  const result = await tx.execute<JobRow>(sql`
    select state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
           encode(input_sha256, 'hex') as input_sha256,
           input_snapshot, provider_snapshot, error_code, error_retryable,
           started_at, finished_at, result_revision_id
    from project_calculation_job
    where workspace_id = ${fixture.workspaceId}::uuid
      and id = ${fixture.jobId}::uuid
  `);
  const row = result.rows[0];
  if (!row) throw new Error("calculation job fixture disappeared");
  return row;
}

function expectSanitizedMetadata(value: unknown, jobId: string): void {
  expect(value).not.toBeNull();
  expect(typeof value).toBe("object");
  expect(Array.isArray(value)).toBe(false);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return;
  expect(value).toMatchObject({ jobId });

  const allowed = new Set([
    "workspaceId",
    "projectId",
    "siteId",
    "profileId",
    "profileRevision",
    "addressRevision",
    "requirementId",
    "requirementRevision",
    "jobId",
    "attemptCount",
    "revisionId",
    "revision",
    "state",
    "status",
    "quality",
    "validationStatus",
    "errorCode",
    "retryable",
  ]);
  expect(Object.keys(value).every((key) => allowed.has(key))).toBe(true);
  expect(Object.values(value).every(
    (entry) => entry === null || ["string", "number", "boolean"].includes(typeof entry),
  )).toBe(true);

  const serialized = JSON.stringify(value);
  for (const forbidden of [
    "Workerweg",
    "customer.secret@example.test",
    "49.28463",
    "8.73821",
    "householdKwhPerYear",
    "electricityPriceCentsPerKwh",
    "yieldSnapshots",
    "hourlyPowerWPerKwp",
    "resultSha256",
    "rawResponseSha256",
    "https://",
  ]) expect(serialized).not.toContain(forbidden);
}

describe.sequential("M1-07 calculation worker DB service contract", () => {
  it("replays only the immutable reservation preparation after the live profile changes", async () => {
    const fixture = await createFixture();
    const changedProfile = structuredClone(fixture.request.energyProfile);
    changedProfile.roofs[0]!.tiltDeg += 1;

    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      update site_energy_profile
         set revision = revision + 1,
             profile = ${JSON.stringify(changedProfile)}::jsonb,
             profile_sha256 = ${sha256Bytes(changedProfile)},
             confirmed_profile_revision = null,
             confirmed_address_revision = null,
             confirmed_by = null,
             confirmed_at = null,
             updated_at = pg_catalog.clock_timestamp()
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.profileId}::uuid
    `));

    await expect(withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      update project_calculation_job
         set preparation_snapshot = jsonb_set(
           preparation_snapshot,
           '{latitude}',
           '0'::jsonb
         )
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.jobId}::uuid
    `))).rejects.toBeDefined();

    const claimed = await claim(fixture, randomUUID());
    expect(claimed).not.toBeNull();
    const runtimeClaim = claimed as CalculationClaim & {
      providerRequest: { roofs: Array<{ tiltDeg: number }> };
      preparation: { profile: PlanningCalculationRequestV1["energyProfile"] };
    };
    expect(runtimeClaim.preparation.profile).toEqual(fixture.request.energyProfile);
    expect(runtimeClaim.providerRequest.roofs[0]?.tiltDeg)
      .toBe(fixture.request.energyProfile.roofs[0]?.tiltDeg);
    expect(runtimeClaim.preparation.profile).not.toEqual(changedProfile);
  });

  it("claims one due job atomically, replays the same lease idempotently, and reclaims only expired leases", async () => {
    const fixture = await createFixture();
    const tokens = [randomUUID(), randomUUID()];
    const competingClaims = await Promise.all(tokens.map((token) => claim(fixture, token)));
    const winners = competingClaims.filter((value) => value !== null);

    expect(winners).toHaveLength(1);
    const winner = winners[0];
    expect(winner).toMatchObject({
      workspaceId: fixture.workspaceId,
      jobId: fixture.jobId,
      projectId: fixture.projectId,
      attemptCount: 1,
      input: null,
    });
    const winnerToken = winner?.leaseToken;
    expect(tokens).toContain(winnerToken);
    expect(asDate(winner!.leaseExpiresAt).getTime())
      .toBeGreaterThan(asDate(winner!.startedAt).getTime());
    expect(asDate(winner!.leaseExpiresAt).getTime()).toBeLessThanOrEqual(
      asDate(winner!.startedAt).getTime() + MAX_LEASE_MS,
    );

    const replay = await claim(fixture, winnerToken);
    expect(replay).toMatchObject({
      leaseToken: winnerToken,
      attemptCount: 1,
      leaseExpiresAt: winner!.leaseExpiresAt,
      input: null,
    });
    const losingToken = tokens.find((token) => token !== winnerToken)!;
    await expect(claim(fixture, losingToken))
      .resolves.toBeNull();

    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      update project_calculation_job
         set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 millisecond'
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.jobId}::uuid
    `));
    const reclaimToken = randomUUID();
    const reclaimed = await claim(fixture, reclaimToken);
    expect(reclaimed).toMatchObject({
      leaseToken: reclaimToken,
      attemptCount: 2,
      input: null,
    });
    expect(asDate(reclaimed!.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(asDate(reclaimed!.leaseExpiresAt).getTime()).toBeLessThanOrEqual(
      Date.now() + MAX_LEASE_MS,
    );

    const row = await readJob(fixture);
    expect(row).toMatchObject({
      state: "running",
      attempt_count: 2,
      lease_token: reclaimToken,
      error_code: null,
      error_retryable: null,
    });
    expect(asDate(row.started_at!).getTime()).toBe(asDate(winner!.startedAt).getTime());
  });

  it("rejects input persistence after the DB lease expired", async () => {
    const fixture = await createFixture();
    const leaseToken = randomUUID();
    await expect(claim(fixture, leaseToken)).resolves.toMatchObject({ attemptCount: 1 });
    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      update project_calculation_job
         set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 millisecond'
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.jobId}::uuid
    `));

    await expect(persistInput(fixture, leaseToken, 1)).rejects.toMatchObject({
      code: "stale",
    });
    expect(await readJob(fixture)).toMatchObject({
      state: "running",
      attempt_count: 1,
      input_sha256: null,
      input_snapshot: null,
      provider_snapshot: null,
    });
  });

  it("sets input once, preserves it across retry_wait -> queued, and caps retries/backoff", async () => {
    const fixture = await createFixture();
    const leaseToken = randomUUID();
    await claim(fixture, leaseToken);

    const stored = await persistInput(fixture, leaseToken, 1);
    expect(stored).toMatchObject({
      inputSha256: fixture.inputSha256,
      inputSnapshot: fixture.request,
      providerSnapshot: fixture.request.yieldSnapshots,
      replayed: false,
    });
    await expect(persistInput(fixture, leaseToken, 1)).resolves.toMatchObject({
      inputSha256: fixture.inputSha256,
      replayed: true,
    });

    const conflictingRequest = structuredClone(fixture.request);
    conflictingRequest.asOfDate = "2026-08-30";
    await expect(persistInput(fixture, leaseToken, 1, conflictingRequest)).rejects.toMatchObject({
      code: "retry_conflict",
    });

    const failureStartedAt = Date.now();
    const retry = await finalizeFailure(fixture, {
      leaseToken,
      attemptCount: 1,
      errorCode: "rate_limited",
      retryable: true,
      retryAfterMs: 90_000,
    });
    expect(retry).toMatchObject({ state: "retry_wait", attemptCount: 1 });
    const retryAt = asDate(retry.nextAttemptAt);
    expect(retryAt.getTime()).toBeGreaterThanOrEqual(failureStartedAt + 90_000);
    expect(retryAt.getTime()).toBeLessThanOrEqual(Date.now() + MAX_BACKOFF_MS);

    await expect(requeueDue(fixture)).resolves.toEqual([]);
    await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      update project_calculation_job
         set next_attempt_at = pg_catalog.clock_timestamp() - interval '1 millisecond'
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.jobId}::uuid
    `));
    await expect(requeueDue(fixture)).resolves.toEqual([fixture.jobId]);

    const queued = await readJob(fixture);
    expect(queued).toMatchObject({
      state: "queued",
      attempt_count: 1,
      lease_token: null,
      lease_expires_at: null,
      input_sha256: fixture.inputSha256,
      input_snapshot: fixture.request,
      provider_snapshot: fixture.request.yieldSnapshots,
      error_code: null,
      error_retryable: null,
    });
    const retryLease = randomUUID();
    const secondAttempt = await claim(fixture, retryLease);
    expect(secondAttempt).toMatchObject({
      attemptCount: 2,
      leaseToken: retryLease,
      input: {
        inputSha256: fixture.inputSha256,
        inputSnapshot: fixture.request,
        providerSnapshot: fixture.request.yieldSnapshots,
      },
    });

    const capped = await createFixture({ attemptCount: 9 });
    const cappedLease = randomUUID();
    await expect(claim(capped, cappedLease)).resolves.toMatchObject({ attemptCount: 10 });
    const terminal = await finalizeFailure(capped, {
      leaseToken: cappedLease,
      attemptCount: 10,
      errorCode: "provider_unavailable",
      retryable: true,
      retryAfterMs: 1,
    });
    expect(terminal).toMatchObject({ state: "failed_final", attemptCount: 10 });
    expect(await readJob(capped)).toMatchObject({
      state: "failed_final",
      attempt_count: 10,
      lease_token: null,
      error_code: "provider_unavailable",
      error_retryable: false,
      result_revision_id: null,
    });
  });

  it("rolls revision, succeeded job, event, and audit back or commits them as one CAS-bound unit", async () => {
    const fixture = await createFixture();
    const leaseToken = randomUUID();
    await claim(fixture, leaseToken);
    await persistInput(fixture, leaseToken, 1);
    const rollbackMarker = new Error("intentional outer transaction rollback");

    await expect(withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await finalizeProjectCalculationSuccess(tx, {
        workspaceId: fixture.workspaceId,
        jobId: fixture.jobId,
        leaseToken,
        attemptCount: 1,
        result: fixture.result,
      });
      throw rollbackMarker;
    })).rejects.toBe(rollbackMarker);

    let state = await footprint(fixture);
    expect(state.job).toMatchObject({
      state: "running",
      lease_token: leaseToken,
      attempt_count: 1,
      input_sha256: fixture.inputSha256,
      result_revision_id: null,
    });
    expect(state.revisions).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.audits).toEqual([]);

    const finalized = await finalizeSuccess(fixture, {
      leaseToken,
      attemptCount: 1,
      result: fixture.result,
    });
    expect(finalized).toMatchObject({ revision: 1, replayed: false });
    expect(finalized.revisionId).toMatch(/^[0-9a-f-]{36}$/u);

    state = await footprint(fixture);
    expect(state.job).toMatchObject({
      state: "succeeded",
      attempt_count: 1,
      lease_token: null,
      lease_expires_at: null,
      input_sha256: fixture.inputSha256,
      error_code: null,
      error_retryable: null,
      result_revision_id: finalized.revisionId,
    });
    expect(state.revisions).toEqual([expect.objectContaining({
      id: finalized.revisionId,
      revision: 1,
      job_id: fixture.jobId,
      input_sha256: fixture.inputSha256,
      result_sha256: fixture.result.resultSha256,
      quality: "server_reproduced_estimate",
      validation_status: "not_f4_reference_validated",
    })]);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      event_type: "project.calculation_succeeded",
      actor: fixture.actorId,
    });
    expect(state.audits).toHaveLength(1);
    expect(state.audits[0]).toMatchObject({ actor: fixture.actorId, allowed: true });
    expectSanitizedMetadata(state.events[0]!.payload, fixture.jobId);
    expectSanitizedMetadata(state.audits[0]!.details, fixture.jobId);

    const replay = await finalizeSuccess(fixture, {
      leaseToken,
      attemptCount: 1,
      result: fixture.result,
    });
    expect(replay).toEqual({ ...finalized, replayed: true });
    state = await footprint(fixture);
    expect(state.revisions).toHaveLength(1);
    expect(state.events).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
  });

  it("waits on Project before Job so a Project -> Profile -> Job owner cannot deadlock finalization", async () => {
    const fixture = await createFixture();
    const leaseToken = randomUUID();
    await claim(fixture, leaseToken);
    await persistInput(fixture, leaseToken, 1);

    const ownerReady = deferred<number>();
    const ownerMayTakeJob = deferred<void>();
    const projectOwner = withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`set local lock_timeout = '500ms'`);
      await tx.execute(sql`set local statement_timeout = '1500ms'`);
      const backend = await tx.execute<{ pid: number; [key: string]: unknown }>(sql`
        select pg_catalog.pg_backend_pid() as pid
      `);
      await tx.execute(sql`
        select id
          from project
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.projectId}::uuid
         for update
      `);
      await tx.execute(sql`
        select id
          from site_energy_profile
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.profileId}::uuid
         for update
      `);
      const ownerPid = backend.rows[0]?.pid;
      if (ownerPid === undefined) throw new Error("Project-Besitzer hat keine Backend-PID.");
      ownerReady.resolve(ownerPid);

      await ownerMayTakeJob.promise;
      const lockedJob = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
        select id
          from project_calculation_job
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.jobId}::uuid
         for update
      `);
      expect(lockedJob.rows).toEqual([{ id: fixture.jobId }]);
      return fixture.jobId;
    });
    void projectOwner.catch((error: unknown) => ownerReady.reject(error));

    const ownerPid = await ownerReady.promise;
    const applicationName = `m107-finalize-${randomUUID().slice(0, 8)}`;
    const finalizer = withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`select set_config('application_name', ${applicationName}, true)`);
      await tx.execute(sql`set local lock_timeout = '3s'`);
      await tx.execute(sql`set local statement_timeout = '4s'`);
      return finalizeProjectCalculationSuccess(tx, {
        workspaceId: fixture.workspaceId,
        jobId: fixture.jobId,
        leaseToken,
        attemptCount: 1,
        result: fixture.result,
      });
    });

    try {
      await waitForNamedSessionBlockedBy(applicationName, ownerPid);
      ownerMayTakeJob.resolve();

      // If finalization had already taken Job (the former Job -> Project order),
      // this Project -> Profile -> Job transaction would hit its 500 ms lock
      // timeout or PostgreSQL would detect a deadlock. It must commit first.
      await expect(projectOwner).resolves.toBe(fixture.jobId);
      const finalized = await finalizer;
      expect(finalized).toMatchObject({ revision: 1, replayed: false });

      await expect(finalizeSuccess(fixture, {
        leaseToken,
        attemptCount: 1,
        result: fixture.result,
      })).resolves.toEqual({ ...finalized, replayed: true });
      const state = await footprint(fixture);
      expect(state.job).toMatchObject({
        state: "succeeded",
        attempt_count: 1,
        lease_token: null,
        result_revision_id: finalized.revisionId,
      });
      expect(state.revisions).toHaveLength(1);
      expect(state.events).toHaveLength(1);
      expect(state.audits).toHaveLength(1);
    } finally {
      ownerMayTakeJob.resolve();
      await Promise.allSettled([projectOwner, finalizer]);
    }
  }, 10_000);

  it("rejects a generically valid result whose capacity contradicts its reserved request", async () => {
    const fixture = await createFixture();
    const leaseToken = randomUUID();
    await claim(fixture, leaseToken);
    await persistInput(fixture, leaseToken, 1);
    const mismatched = structuredClone(fixture.result);
    if (mismatched.branch !== "new_installation") {
      throw new Error("expected new-installation fixture");
    }
    mismatched.calculation.plannedStorageCapacityKwh += 1;
    mismatched.resultSha256 = hashPlanningCalculationResult(mismatched);
    expect(validatePlanningCalculationResult(mismatched).ok).toBe(true);

    await expect(finalizeSuccess(fixture, {
      leaseToken,
      attemptCount: 1,
      result: mismatched,
    })).rejects.toMatchObject({ code: "invalid_input" });
    const state = await footprint(fixture);
    expect(state.job).toMatchObject({
      state: "running",
      result_revision_id: null,
    });
    expect(state.revisions).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.audits).toEqual([]);
  });

  it("rejects a lost claim but stores an exact-claim result historically when current bindings moved", async () => {
    const fixture = await createFixture();
    const leaseToken = randomUUID();
    await claim(fixture, leaseToken);
    await persistInput(fixture, leaseToken, 1);

    const wrongLease = randomUUID();
    await expect(withTenantOn(testPool, fixture.workspaceId, (tx) =>
      finalizeProjectCalculationSuccess(tx, {
        workspaceId: fixture.workspaceId,
        jobId: fixture.jobId,
        leaseToken: wrongLease,
        attemptCount: 1,
        result: fixture.result,
      }))).rejects.toMatchObject({ code: "stale" });
    await expect(withTenantOn(testPool, fixture.workspaceId, (tx) =>
      finalizeProjectCalculationFailure(tx, {
        workspaceId: fixture.workspaceId,
        jobId: fixture.jobId,
        leaseToken: wrongLease,
        attemptCount: 1,
        errorCode: "provider_unavailable",
        retryable: true,
      }))).rejects.toMatchObject({ code: "stale" });

    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into project_requirement (
          id, workspace_id, project_id, revision, schema_version,
          source_snapshot_id, requirements
        ) values (
          ${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.projectId}::uuid, 2, 'project-requirements.rechner.v1',
          ${fixture.snapshotId}::uuid,
          ${JSON.stringify(fixture.request.projectRequirements)}::jsonb
        )
      `);
    });

    let state = await footprint(fixture);
    expect(state.job).toMatchObject({
      state: "running",
      lease_token: leaseToken,
      attempt_count: 1,
      result_revision_id: null,
    });
    expect(state.revisions).toEqual([]);
    expect(state.events).toEqual([]);
    expect(state.audits).toEqual([]);

    const historical = await finalizeSuccess(fixture, {
      leaseToken,
      attemptCount: 1,
      result: fixture.result,
    });
    state = await footprint(fixture);
    expect(state.job).toMatchObject({
      state: "succeeded",
      lease_token: null,
      error_code: null,
      error_retryable: null,
      result_revision_id: historical.revisionId,
    });
    expect(state.revisions).toEqual([expect.objectContaining({
      id: historical.revisionId,
      revision: 1,
      job_id: fixture.jobId,
    })]);
    expect(state.events).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    for (const event of state.events) expectSanitizedMetadata(event.payload, fixture.jobId);
    for (const audit of state.audits) expectSanitizedMetadata(audit.details, fixture.jobId);

    const context = await withAuthorizedTenantOn(
      testPool,
      fixture.actorId,
      fixture.workspaceId,
      (tx, serviceCtx) => getProjectEnergyContext(tx, serviceCtx, fixture.projectId),
    );
    expect(context?.calculation).toMatchObject({
      status: "stale",
      jobId: fixture.jobId,
      result: {
        id: historical.revisionId,
        revision: 1,
      },
    });
  });

  it("runs the real handler, builder, clean-room engine, and DB CAS end to end", async () => {
    const fixture = await createFixture({
      sourceRevision: PLANNING_MODEL_SOURCE_REVISION,
    });
    const leaseToken = randomUUID();
    const claimedJob = await claim(fixture, leaseToken);
    expect(claimedJob).not.toBeNull();
    const preparedPreview = buildPlanningCalculationInput({
      claim: claimedJob,
      providerSnapshot: fixture.request.yieldSnapshots,
    });
    expect(() => calculatePlanningEstimate(preparedPreview.inputSnapshot)).not.toThrow();
    const providerFetch = vi.fn(async () =>
      structuredClone(fixture.request.yieldSnapshots));
    const buildInput = vi.fn(buildPlanningCalculationInput);
    const engineCalculate = vi.fn(async (input: Record<string, unknown>) =>
      calculatePlanningEstimate(input));
    const handler = createCalculationExecuteHandler({
      database: {
        claim: (input) => withTenantOn(testPool, input.workspaceId, (tx) =>
          claimProjectCalculationJob(tx, input)),
        persistInput: (input) => withTenantOn(testPool, input.workspaceId, (tx) =>
          persistProjectCalculationInput(tx, input)),
        finalizeSuccess: (input) => withTenantOn(testPool, input.workspaceId, (tx) =>
          finalizeProjectCalculationSuccess(tx, input)),
        finalizeFailure: (input) => withTenantOn(testPool, input.workspaceId, (tx) =>
          finalizeProjectCalculationFailure(tx, input)),
      },
      provider: { fetch: providerFetch },
      buildInput,
      engine: { calculate: engineCalculate },
      createLeaseToken: () => leaseToken,
    });

    await expect(handler([{
      data: {
        schemaVersion: "project-calculation-dispatch.v1",
        workspaceId: fixture.workspaceId,
        jobId: fixture.jobId,
      },
    }])).resolves.toBeUndefined();

    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(buildInput).toHaveBeenCalledTimes(1);
    expect(engineCalculate).toHaveBeenCalledTimes(1);
    const state = await footprint(fixture);
    expect(state.job).toMatchObject({
      state: "succeeded",
      attempt_count: 1,
      lease_token: null,
      error_code: null,
      result_revision_id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(state.revisions).toHaveLength(1);
    expect(state.events).toHaveLength(1);
    expect(state.audits).toHaveLength(1);
    expectSanitizedMetadata(state.events[0]!.payload, fixture.jobId);
    expectSanitizedMetadata(state.audits[0]!.details, fixture.jobId);
  });
});
