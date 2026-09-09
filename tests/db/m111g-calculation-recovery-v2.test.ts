import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantOn } from "@/lib/db/tenant";
import { bootstrapCalculationQueue } from "../../scripts/pgboss-bootstrap.mjs";
import {
  claimProjectCalculationJob,
  finalizeProjectCalculationFailure,
  requeueDueProjectCalculationJobs,
} from "@/modules/energy/calculation-service";
import {
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_DEFAULTS_VERSION,
  CALCULATION_V2_MODEL_ID,
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
} from "@/lib/integrations/calculation/versions-v2";
import { PLANNING_CALCULATION_CONTRACT_VERSION } from "@/lib/integrations/calculation/contract";
import {
  PLANNING_DEFAULTS_VERSION,
  PLANNING_MODEL_ID,
  PLANNING_MODEL_SOURCE_REVISION,
  PLANNING_MODEL_VERSION,
  PLANNING_PROVIDER_RECIPE_VERSION,
} from "@/lib/integrations/calculation/versions";
import { applyRoleContract } from "../../scripts/db-role-contract.mjs";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";
import {
  createDrainTrackedPool,
  endPoolsAndStopEmbeddedPostgres,
} from "../setup/pg-pool-drain";

type MigrationJournal = {
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

const DISPATCH_MIGRATION_INDEX = 80;
const RECOVERY_MIGRATION_INDEX = 81;
const DELIVERY_QUEUE = "calculation.execute.v2";
const DELIVERY_SCHEMA_VERSION = "project-calculation-dispatch.v2";
const DATABASE_NAME = "energie_saas_test";
const MIGRATOR_PASSWORD = "m111g_dispatch_migrator";
const RUNTIME_PASSWORD = "m111g_dispatch_runtime";
const WORKER_PASSWORD = "m111g_dispatch_worker";
const PLANNING_REQUEST = JSON.parse(readFileSync(
  resolve("contracts/examples/planning-calculation.v1.new.request.json"),
  "utf8",
)) as {
  energyProfile: Record<string, unknown>;
  projectRequirements: Record<string, unknown>;
};

function migrationJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function requireDispatchMigration(): { idx: number; tag: string; [key: string]: unknown } {
  const entry = migrationJournal().entries.find(
    (candidate) => candidate.idx === DISPATCH_MIGRATION_INDEX,
  );
  expect(
    entry,
    "Die v2-Zustellung braucht eine additive 0080 nach dem v2-Tupel 0078 und Finalize 0079.",
  ).toBeDefined();
  expect(entry?.tag).toMatch(/^0080_[a-z0-9_]+$/);
  expect(() => readFileSync(resolve("drizzle", `${entry!.tag}.sql`), "utf8")).not.toThrow();
  return entry!;
}

function requireRecoveryMigration(): { idx: number; tag: string; [key: string]: unknown } {
  const entry = migrationJournal().entries.find(
    (candidate) => candidate.idx === RECOVERY_MIGRATION_INDEX,
  );
  expect(
    entry,
    "v2-Crash-Recovery/Retry-Redispatch muss additiv nach der initialen 0080-Zustellung folgen (analog 0026 fuer v1).",
  ).toBeDefined();
  expect(entry?.tag).toMatch(/^0081_[a-z0-9_]+$/u);
  expect(() => readFileSync(resolve("drizzle", `${entry!.tag}.sql`), "utf8")).not.toThrow();
  return entry!;
}

function serviceUrl(embedded: EmbeddedTestDatabase, role: string, password: string): string {
  const url = new URL(embedded.url);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function bootstrapStrictRoles(admin: Pool): Promise<void> {
  await admin.query(`
    create role app_owner nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_migrator login password '${MIGRATOR_PASSWORD}'
      noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_runtime login password '${RUNTIME_PASSWORD}'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_system login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_auth login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_worker login password '${WORKER_PASSWORD}'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_erasure nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role identity_reconciler nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;

    grant app_owner to app_migrator
      with admin false, inherit false, set true;
    grant app_worker to app_migrator
      with admin false, inherit false, set true;
    grant app_membership_writer to app_owner
      with admin false, inherit false, set false;
    grant app_membership_writer to app_system
      with admin false, inherit false, set false;
    grant identity_reconciler to app_owner
      with admin true, inherit false, set false;

    alter database ${DATABASE_NAME} owner to app_owner;
    alter schema public owner to app_owner;
    revoke all on schema public from public;
    create schema pgboss authorization app_worker;
    grant connect on database ${DATABASE_NAME} to app_runtime, app_worker;
  `);
}

async function installPgBoss(workerUrl: string): Promise<void> {
  await expect(bootstrapCalculationQueue(workerUrl)).resolves.toBe("create_legacy");
}

type DomainJob = {
  workspaceId: string;
  jobId: string;
  projectId: string;
  contractVersion?: "v1" | "v2";
  state?: "queued" | "running" | "retry_wait" | "failed_final";
  attemptCount?: number;
  nextAttemptAt?: Date;
  leaseExpiresAt?: Date;
  reservationHex?: string;
};

async function insertDomainJob(admin: Pool, job: DomainJob): Promise<void> {
  const client = await admin.connect();
  const contractV2 = (job.contractVersion ?? "v2") === "v2";
  const running = job.state === "running";
  const retryWaiting = job.state === "retry_wait";
  const failedFinal = job.state === "failed_final";
  const attemptCount = job.attemptCount ?? (job.state === undefined || job.state === "queued" ? 0 : 1);
  const siteId = randomUUID();
  const profileId = randomUUID();
  const requirementId = randomUUID();
  const contactId = randomUUID();
  const boardId = randomUUID();
  const columnId = randomUUID();
  const sourceSnapshotId = randomUUID();
  const startedAt = running || retryWaiting || failedFinal ? new Date() : null;
  const leaseToken = running ? randomUUID() : null;
  const leaseExpiresAt = running
    ? (job.leaseExpiresAt ?? new Date(Date.now() + 15 * 60_000))
    : null;
  const nextAttemptAt = job.nextAttemptAt ?? new Date();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    // Minimaler, aber fuer den echten Claim-Service lesbarer Fachgraph. Die
    // Snapshots bleiben absichtlich NULL (CHECK erlaubt all-null): Der Claim
    // liefert dann input/preparation null — fuer die Recovery-Semantik
    // (Watchdog pflanzen, Re-Claim nach Crash) genuegt das; die goldenen
    // Inhalte pruefen m111e/m111f und m1-11g.
    await client.query(
      `
        insert into public.site (id, workspace_id, lat, lng)
        values ($1::uuid, $2::uuid, 49.28463, 8.73821)
      `,
      [siteId, job.workspaceId],
    );
    await client.query(
      `
        insert into public.project (
          id, workspace_id, contact_id, site_id, kanban_board_id,
          kanban_column_id, name, source_key
        ) values ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid,
                  $6::uuid, 'Strict v2 Recovery Fixture', 'fixture')
      `,
      [job.projectId, job.workspaceId, contactId, siteId, boardId, columnId],
    );
    await client.query(
      `
        insert into public.site_energy_profile (
          id, workspace_id, site_id, revision, schema_version, input_mode,
          source_kind, address_revision, profile, profile_sha256,
          confirmed_profile_revision, confirmed_address_revision,
          confirmed_by, confirmed_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, 1, 'site-energy-profile.v1',
          'consumption', 'manual', 1, $4::jsonb, decode(repeat('11', 32), 'hex'),
          1, 1, $5::uuid, now()
        )
      `,
      [profileId, job.workspaceId, siteId, JSON.stringify(PLANNING_REQUEST.energyProfile), randomUUID()],
    );
    await client.query(
      `
        insert into public.project_requirement (
          id, workspace_id, project_id, revision, schema_version,
          source_snapshot_id, requirements
        ) values (
          $1::uuid, $2::uuid, $3::uuid, 1, 'project-requirements.rechner.v1',
          $4::uuid, $5::jsonb
        )
      `,
      [
        requirementId,
        job.workspaceId,
        job.projectId,
        sourceSnapshotId,
        JSON.stringify(PLANNING_REQUEST.projectRequirements),
      ],
    );
    await client.query(
      `
        insert into public.project_calculation_job (
          id, workspace_id, project_id, site_id,
          address_revision, pin_confirmed_address_revision,
          profile_id, profile_revision, confirmed_profile_revision,
          confirmed_address_revision, requirement_id, requirement_revision,
          source_snapshot_id, reservation_key, provider_recipe_version,
          contract_version, model_id, model_version, source_revision,
          defaults_version, state, attempt_count, next_attempt_at,
          lease_token, lease_expires_at, started_at, created_by,
          error_code, error_retryable, finished_at
        ) values (
          $1::uuid, $2::uuid, $3::uuid, $4::uuid,
          1, 1, $5::uuid, 1, 1, 1, $6::uuid, 1,
          null, decode($7, 'hex'), $8,
          $9, $10, $11, $12,
          $13, $14, $15, $16::timestamptz,
          $17::uuid, $18::timestamptz, $19::timestamptz, $20::uuid,
          $21, $22, $23::timestamptz
        )
      `,
      [
        job.jobId,
        job.workspaceId,
        job.projectId,
        siteId,
        profileId,
        requirementId,
        job.reservationHex ?? "31".repeat(32),
        contractV2 ? CALCULATION_V2_PROVIDER_RECIPE_VERSION : PLANNING_PROVIDER_RECIPE_VERSION,
        contractV2 ? CALCULATION_V2_CONTRACT_VERSION : PLANNING_CALCULATION_CONTRACT_VERSION,
        contractV2 ? CALCULATION_V2_MODEL_ID : PLANNING_MODEL_ID,
        contractV2 ? CALCULATION_V2_MODEL_VERSION : PLANNING_MODEL_VERSION,
        contractV2 ? CALCULATION_V2_SOURCE_REVISION : PLANNING_MODEL_SOURCE_REVISION,
        contractV2 ? CALCULATION_V2_DEFAULTS_VERSION : PLANNING_DEFAULTS_VERSION,
        job.state ?? "queued",
        attemptCount,
        nextAttemptAt,
        leaseToken,
        leaseExpiresAt,
        startedAt,
        randomUUID(),
        retryWaiting || failedFinal ? (retryWaiting ? "provider_unavailable" : "engine_invalid") : null,
        retryWaiting ? true : failedFinal ? false : null,
        failedFinal ? new Date() : null,
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function dispatch(runtime: Pool, workspaceId: string, jobId: string): Promise<void> {
  const client = await runtime.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_catalog.set_config('app.workspace_id', $1, true)",
      [workspaceId],
    );
    await client.query(
      "select pgboss.enqueue_project_calculation_v2($1::uuid, $2::uuid)",
      [workspaceId, jobId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function pgBossJobs(admin: Pool, jobId: string): Promise<Array<{
  id: string;
  name: string;
  data: Record<string, unknown>;
  singleton_key: string | null;
  state: string;
  start_after: Date | string;
}>> {
  const result = await admin.query<{
    id: string;
    name: string;
    data: Record<string, unknown>;
    singleton_key: string | null;
    state: string;
    start_after: Date | string;
  }>(`
    select id::text, name, data, singleton_key, state::text, start_after
      from pgboss.job
     where name = $1
       and data->>'jobId' = $2
     order by created_on, id
  `, [DELIVERY_QUEUE, jobId]);
  return result.rows;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function domainJobState(admin: Pool, jobId: string): Promise<{
  state: string;
  attempt_count: number;
}> {
  const result = await admin.query<{ state: string; attempt_count: number }>(`
    select state, attempt_count
      from public.project_calculation_job
     where id = $1::uuid
  `, [jobId]);
  const row = result.rows[0];
  if (!row) throw new Error("strict v2 recovery domain fixture disappeared");
  return row;
}

it("deklariert die v2-Zustellung additiv als 0080 nach dem v2-Praefix 0000..0079", () => {
  const journal = migrationJournal();
  expect(
    journal.entries
      .filter((entry) => entry.idx <= DISPATCH_MIGRATION_INDEX)
      .map((entry) => entry.idx),
  ).toEqual(Array.from({ length: DISPATCH_MIGRATION_INDEX + 1 }, (_, index) => index));
  requireDispatchMigration();
});

it("ergaenzt v2-Crash-Recovery und Retry-Redispatch additiv als 0081 (analog 0026)", () => {
  const journal = migrationJournal();
  expect(
    journal.entries
      .filter((entry) => entry.idx <= RECOVERY_MIGRATION_INDEX)
      .map((entry) => entry.idx),
  ).toEqual(Array.from({ length: RECOVERY_MIGRATION_INDEX + 1 }, (_, index) => index));
  requireRecoveryMigration();
});

describe.sequential("F4.1 v2: enge pg-boss-Crash-Recovery", () => {
  let embedded: EmbeddedTestDatabase;
  let admin: Pool;
  let ownerPool: Pool;
  let runtime: Pool;
  let worker: Pool;

  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const recoverable = {
    workspaceId: workspaceA,
    jobId: randomUUID(),
    projectId: randomUUID(),
  } satisfies DomainJob;
  const crashed = {
    workspaceId: workspaceA,
    jobId: randomUUID(),
    projectId: randomUUID(),
  } satisfies DomainJob;
  const running = {
    workspaceId: workspaceA,
    jobId: randomUUID(),
    projectId: randomUUID(),
    state: "running",
  } satisfies DomainJob;
  const retryWaiting = {
    workspaceId: workspaceA,
    jobId: randomUUID(),
    projectId: randomUUID(),
    state: "retry_wait",
    nextAttemptAt: new Date(Date.now() + 60_000),
  } satisfies DomainJob;
  const failed = {
    workspaceId: workspaceA,
    jobId: randomUUID(),
    projectId: randomUUID(),
    state: "failed_final",
  } satisfies DomainJob;
  const legacyV1 = {
    workspaceId: workspaceA,
    jobId: randomUUID(),
    projectId: randomUUID(),
    contractVersion: "v1",
  } satisfies DomainJob;
  const foreign = {
    workspaceId: workspaceB,
    jobId: randomUUID(),
    projectId: randomUUID(),
  } satisfies DomainJob;

  beforeAll(async () => {
    requireDispatchMigration();
    requireRecoveryMigration();
    embedded = await startEmbeddedPostgres();
    admin = createDrainTrackedPool({
      connectionString: embedded.superuserUrl,
      max: 2,
      idleTimeoutMillis: 0,
    });
    await bootstrapStrictRoles(admin);
    await installPgBoss(serviceUrl(embedded, "app_worker", WORKER_PASSWORD));

    ownerPool = createDrainTrackedPool({
      connectionString: serviceUrl(embedded, "app_migrator", MIGRATOR_PASSWORD),
      max: 1,
      idleTimeoutMillis: 0,
      options: "-c role=app_owner",
    });
    await migrate(drizzle(ownerPool), { migrationsFolder: resolve("drizzle") });

    // Der wiederholte Bootstrap nach 0081 ist ein No-op und darf die durch
    // Migration gepinnten Queues niemals auf Legacy zuruecksetzen.
    await expect(bootstrapCalculationQueue(
      serviceUrl(embedded, "app_worker", WORKER_PASSWORD),
    )).resolves.toBe("keep_current");

    const ownerClient = await ownerPool.connect();
    try {
      await applyRoleContract(ownerClient);
    } finally {
      ownerClient.release();
    }

    runtime = createDrainTrackedPool({
      connectionString: serviceUrl(embedded, "app_runtime", RUNTIME_PASSWORD),
      max: 4,
      idleTimeoutMillis: 0,
    });
    worker = createDrainTrackedPool({
      connectionString: serviceUrl(embedded, "app_worker", WORKER_PASSWORD),
      max: 4,
      idleTimeoutMillis: 0,
    });
    await Promise.all([
      insertDomainJob(admin, recoverable),
      insertDomainJob(admin, crashed),
      insertDomainJob(admin, running),
      insertDomainJob(admin, retryWaiting),
      insertDomainJob(admin, failed),
      insertDomainJob(admin, legacyV1),
      insertDomainJob(admin, foreign),
    ]);
  }, 180_000);

  afterAll(async () => {
    await endPoolsAndStopEmbeddedPostgres(
      [worker, runtime, ownerPool, admin],
      embedded,
      "F4.1 v2 recovery teardown failed",
    );
  });

  it("pinnt Definer-Owner, Suchpfadgrenze und Runtime-Grant der v2-Recovery-Routine", async () => {
    const routine = await admin.query<{
      owner: string;
      security_definer: boolean;
      config: string[] | null;
      source: string;
    }>(`
      select owner.rolname as owner,
             routine.prosecdef as security_definer,
             routine.proconfig as config,
             routine.prosrc as source
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        join pg_catalog.pg_roles owner on owner.oid = routine.proowner
       where namespace.nspname = 'pgboss'
         and routine.proname = 'enqueue_project_calculation_v2'
    `);
    expect(routine.rows).toHaveLength(1);
    expect(routine.rows[0]).toMatchObject({
      owner: "app_worker",
      security_definer: true,
    });
    expect(routine.rows[0]!.config ?? []).toContain("search_path=pg_catalog");
    expect(routine.rows[0]!.source).toContain("dispatch_key");
    const grants = await admin.query<{ grantee: string; privilege: string }>(`
      select grantee::text, privilege_type::text as privilege
        from information_schema.routine_privileges
       where specific_schema = 'pgboss'
         and routine_name = 'enqueue_project_calculation_v2'
         and grantee in ('app_runtime', 'PUBLIC')
    `);
    expect(grants.rows).toContainEqual({ grantee: "app_runtime", privilege: "EXECUTE" });
    expect(grants.rows).not.toContainEqual({ grantee: "PUBLIC", privilege: "EXECUTE" });
  });

  it("pflanzt beim v2-Claim den Watchdog, timt ihn bei Retry um und dupliziert ihn nicht", async () => {
    await dispatch(runtime, recoverable.workspaceId, recoverable.jobId);
    const initial = await pgBossJobs(admin, recoverable.jobId);
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      singleton_key: `${recoverable.jobId}:1`,
      state: "created",
      data: {
        schemaVersion: DELIVERY_SCHEMA_VERSION,
        workspaceId: recoverable.workspaceId,
        jobId: recoverable.jobId,
      },
    });
    expect(initial[0]!.data).toEqual({
      schemaVersion: DELIVERY_SCHEMA_VERSION,
      workspaceId: recoverable.workspaceId,
      jobId: recoverable.jobId,
    });

    // Replay und Parallelrace bleiben einfach (0081-Umbuchung statt Duplikat).
    await dispatch(runtime, recoverable.workspaceId, recoverable.jobId);
    expect(await pgBossJobs(admin, recoverable.jobId)).toEqual(initial);

    const leaseToken = randomUUID();
    const claim = await withTenantOn(worker, recoverable.workspaceId, (tx) =>
      claimProjectCalculationJob(tx, {
        workspaceId: recoverable.workspaceId,
        jobId: recoverable.jobId,
        leaseToken,
      }));
    expect(claim).toMatchObject({ attemptCount: 1, leaseToken });
    expect(await domainJobState(admin, recoverable.jobId)).toEqual({
      state: "running",
      attempt_count: 1,
    });

    // Der Claim pflanzt atomar den Watchdog `:2` mit Start am Lease-Ende —
    // stirbt der Worker jetzt, feuert pg-boss spaetestens dann erneut.
    const afterClaim = await pgBossJobs(admin, recoverable.jobId);
    expect(afterClaim).toHaveLength(2);
    const watchdog = afterClaim.find(
      (job) => job.singleton_key === `${recoverable.jobId}:2`,
    );
    expect(watchdog).toMatchObject({
      name: DELIVERY_QUEUE,
      state: "created",
      data: {
        schemaVersion: DELIVERY_SCHEMA_VERSION,
        workspaceId: recoverable.workspaceId,
        jobId: recoverable.jobId,
      },
    });
    expect(asDate(watchdog!.start_after).getTime()).toBe(
      asDate(claim!.leaseExpiresAt).getTime(),
    );

    const watchdogId = watchdog!.id;
    const retry = await withTenantOn(worker, recoverable.workspaceId, (tx) =>
      finalizeProjectCalculationFailure(tx, {
        workspaceId: recoverable.workspaceId,
        jobId: recoverable.jobId,
        leaseToken,
        attemptCount: 1,
        errorCode: "provider_unavailable",
        retryable: true,
        retryAfterMs: 30_000,
      }));
    expect(retry).toMatchObject({ state: "retry_wait", attemptCount: 1 });

    // Retry timt denselben Watchdog auf den Backoff um statt neu zuzustellen.
    const afterFailure = await pgBossJobs(admin, recoverable.jobId);
    expect(afterFailure).toHaveLength(2);
    const retimed = afterFailure.find(
      (job) => job.singleton_key === `${recoverable.jobId}:2`,
    );
    expect(retimed?.id).toBe(watchdogId);
    expect(asDate(retimed!.start_after).getTime()).toBe(retry.nextAttemptAt.getTime());

    // Der requeueDue-Sweep bleibt Backup-Pfad: faellig -> queued + Start jetzt.
    await admin.query(`
      update public.project_calculation_job
         set next_attempt_at = pg_catalog.clock_timestamp() - interval '1 millisecond'
       where id = $1::uuid
    `, [recoverable.jobId]);
    await expect(withTenantOn(worker, recoverable.workspaceId, (tx) =>
      requeueDueProjectCalculationJobs(tx, {
        workspaceId: recoverable.workspaceId,
        limit: 10,
      }))).resolves.toEqual([recoverable.jobId]);
    expect(await domainJobState(admin, recoverable.jobId)).toEqual({
      state: "queued",
      attempt_count: 1,
    });
    const afterRequeue = await pgBossJobs(admin, recoverable.jobId);
    expect(afterRequeue).toHaveLength(2);
    const requeued = afterRequeue.find(
      (job) => job.singleton_key === `${recoverable.jobId}:2`,
    );
    expect(requeued?.id).toBe(watchdogId);
    expect(asDate(requeued!.start_after).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("stellt einen abgestuerzten v2-Lauf nach Lease-Ende erneut zu (Crash-Recovery)", async () => {
    await dispatch(runtime, crashed.workspaceId, crashed.jobId);
    const firstLease = randomUUID();
    const first = await withTenantOn(worker, crashed.workspaceId, (tx) =>
      claimProjectCalculationJob(tx, {
        workspaceId: crashed.workspaceId,
        jobId: crashed.jobId,
        leaseToken: firstLease,
      }));
    expect(first).toMatchObject({ attemptCount: 1, leaseToken: firstLease });

    // Crash-Simulation: kein finalize — der Worker stirbt mit gehaltenem
    // Lease. Nach Lease-Ende feuert der Watchdog `:2` und der Re-Claim
    // gelingt ueber den expiredRunning-Pfad (statt failed_final).
    await admin.query(`
      update public.project_calculation_job
         set lease_expires_at = pg_catalog.clock_timestamp() - interval '1 millisecond'
       where id = $1::uuid
    `, [crashed.jobId]);

    const secondLease = randomUUID();
    const second = await withTenantOn(worker, crashed.workspaceId, (tx) =>
      claimProjectCalculationJob(tx, {
        workspaceId: crashed.workspaceId,
        jobId: crashed.jobId,
        leaseToken: secondLease,
      }));
    expect(second).toMatchObject({ attemptCount: 2, leaseToken: secondLease });
    expect(await domainJobState(admin, crashed.jobId)).toEqual({
      state: "running",
      attempt_count: 2,
    });

    // Jeder Re-Claim pflanzt den naechsten Watchdog (`:3`), kein Duplikat.
    const jobs = await pgBossJobs(admin, crashed.jobId);
    expect(jobs.map((job) => job.singleton_key).sort()).toEqual([
      `${crashed.jobId}:1`,
      `${crashed.jobId}:2`,
      `${crashed.jobId}:3`,
    ]);
    const next = jobs.find((job) => job.singleton_key === `${crashed.jobId}:3`);
    expect(next).toMatchObject({ name: DELIVERY_QUEUE, state: "created" });
    expect(asDate(next!.start_after).getTime()).toBe(
      asDate(second!.leaseExpiresAt).getTime(),
    );
  });

  it("akzeptiert exakt queued/running/retry_wait und weist v1, terminale, fremde oder kaputte Reservationen ab", async () => {
    await expect(dispatch(runtime, workspaceA, foreign.jobId)).rejects.toBeDefined();
    await expect(dispatch(runtime, workspaceB, running.jobId)).rejects.toBeDefined();
    // v1-Vertrag faellt fail-closed ab (eigene Queue, eigener Handler).
    await expect(dispatch(runtime, legacyV1.workspaceId, legacyV1.jobId)).rejects.toBeDefined();
    await expect(dispatch(runtime, running.workspaceId, running.jobId)).resolves.toBeUndefined();
    await expect(dispatch(runtime, retryWaiting.workspaceId, retryWaiting.jobId)).resolves.toBeUndefined();
    await expect(dispatch(runtime, failed.workspaceId, failed.jobId)).rejects.toBeDefined();
    await expect(dispatch(runtime, workspaceA, randomUUID())).rejects.toBeDefined();

    expect(await pgBossJobs(admin, foreign.jobId)).toEqual([]);
    expect(await pgBossJobs(admin, legacyV1.jobId)).toEqual([]);
    expect(await pgBossJobs(admin, failed.jobId)).toEqual([]);
    // running (attempt 1) -> Watchdog `:2` am Lease-Ende.
    expect(await pgBossJobs(admin, running.jobId)).toEqual([
      expect.objectContaining({
        singleton_key: `${running.jobId}:2`,
        data: {
          schemaVersion: DELIVERY_SCHEMA_VERSION,
          workspaceId: running.workspaceId,
          jobId: running.jobId,
        },
      }),
    ]);
    // retry_wait (attempt 1, spaeter faellig) -> `:2` am Backoff.
    const retried = await pgBossJobs(admin, retryWaiting.jobId);
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({
      singleton_key: `${retryWaiting.jobId}:2`,
    });
    expect(asDate(retried[0]!.start_after).getTime()).toBe(
      asDate(retryWaiting.nextAttemptAt!).getTime(),
    );

    await admin.query(`
      alter table public.project_calculation_job
        drop constraint project_calculation_job_reservation_hash_ck
    `);
    const malformed = {
      workspaceId: workspaceA,
      jobId: randomUUID(),
      projectId: randomUUID(),
      reservationHex: "01",
    } satisfies DomainJob;
    await insertDomainJob(admin, malformed);
    await expect(dispatch(runtime, malformed.workspaceId, malformed.jobId)).rejects.toBeDefined();
    expect(await pgBossJobs(admin, malformed.jobId)).toEqual([]);
  });
});
