import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantOn } from "@/lib/db/tenant";
import { bootstrapCalculationQueue } from "../../scripts/pgboss-bootstrap.mjs";
import {
  claimProjectCalculationJob,
  finalizeProjectCalculationFailure,
  requeueDueProjectCalculationJobs,
} from "@/modules/energy/calculation-service";
import { applyRoleContract } from "../../scripts/db-role-contract.mjs";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";

type MigrationJournal = {
  entries: Array<{ idx: number; tag: string; [key: string]: unknown }>;
  [key: string]: unknown;
};

type DomainJob = {
  workspaceId: string;
  jobId: string;
  projectId: string;
  state?: "queued" | "running" | "retry_wait" | "failed_final";
  attemptCount?: number;
  nextAttemptAt?: Date;
  leaseExpiresAt?: Date;
  reservationHex?: string;
};

const DELIVERY_MIGRATION_INDEX = 25;
const RECOVERY_MIGRATION_INDEX = 26;
const PREPARATION_MIGRATION_INDEX = 28;
const TECHNICAL_RETRY_MIGRATION_INDEX = 29;
const DELIVERY_QUEUE = "calculation.execute";
const DELIVERY_SCHEMA_VERSION = "project-calculation-dispatch.v1";
const DATABASE_NAME = "energie_saas_test";
const MIGRATOR_PASSWORD = "m107_dispatch_migrator";
const RUNTIME_PASSWORD = "m107_dispatch_runtime";
const WORKER_PASSWORD = "m107_dispatch_worker";
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

function requireDeliveryMigration(): { idx: number; tag: string; [key: string]: unknown } {
  const entry = migrationJournal().entries.find(
    (candidate) => candidate.idx === DELIVERY_MIGRATION_INDEX,
  );
  expect(
    entry,
    "Die technische M1-07-Zustellung braucht eine additive 0025 nach dem Fachschema 0024.",
  ).toBeDefined();
  expect(entry?.tag).toMatch(/^0025_[a-z0-9_]+$/);
  expect(() => readFileSync(resolve("drizzle", `${entry!.tag}.sql`), "utf8")).not.toThrow();
  return entry!;
}

function requireRecoveryMigration(): { idx: number; tag: string; [key: string]: unknown } {
  const entry = migrationJournal().entries.find(
    (candidate) => candidate.idx === RECOVERY_MIGRATION_INDEX,
  );
  expect(
    entry,
    "Crash-Recovery/Retry-Redispatch muss additiv nach der initialen 0025-Zustellung folgen.",
  ).toBeDefined();
  expect(entry?.tag).toMatch(/^0026_[a-z0-9_]+$/u);
  expect(() => readFileSync(resolve("drizzle", `${entry!.tag}.sql`), "utf8")).not.toThrow();
  return entry!;
}

function requireRuntimeIntegrityMigrations(): void {
  const journal = migrationJournal();
  const preparation = journal.entries.find(
    (candidate) => candidate.idx === PREPARATION_MIGRATION_INDEX,
  );
  const technicalRetry = journal.entries.find(
    (candidate) => candidate.idx === TECHNICAL_RETRY_MIGRATION_INDEX,
  );
  expect(preparation?.tag).toMatch(/^0028_[a-z0-9_]+$/u);
  expect(technicalRetry?.tag).toMatch(/^0029_[a-z0-9_]+$/u);
  expect(() => readFileSync(
    resolve("drizzle", `${preparation!.tag}.sql`),
    "utf8",
  )).not.toThrow();
  expect(() => readFileSync(
    resolve("drizzle", `${technicalRetry!.tag}.sql`),
    "utf8",
  )).not.toThrow();
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

async function insertDomainJob(admin: Pool, job: DomainJob): Promise<void> {
  const client = await admin.connect();
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
    // Strict-Delivery-Suite prueft Rollen/Transaktionen; FKs/JSON-Checks sind
    // bereits in den M1-07-Schema-Suites abgedeckt und werden hier bewusst
    // ueber den lokalen Superuser-Fixturepfad nicht dupliziert.
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
                  $6::uuid, 'Strict Dispatch Fixture', 'fixture')
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
          null, decode($7, 'hex'), 'pvgis-5.3-sarah3-2020.v1',
          'planning-calculation.v1', 'wmee-solar', '1.0.0', $8,
          'wmee-planning-defaults.v1', $9, $10, $11::timestamptz,
          $12::uuid, $13::timestamptz, $14::timestamptz, $15::uuid,
          $16, $17, $18::timestamptz
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
        "a".repeat(40),
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
      "select pgboss.enqueue_project_calculation($1::uuid, $2::uuid)",
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
  if (!row) throw new Error("strict delivery domain fixture disappeared");
  return row;
}

it("deklariert die Zustellung additiv als 0025 nach dem unveraenderten Praefix 0000..0024", () => {
  const journal = migrationJournal();
  expect(
    journal.entries
      .filter((entry) => entry.idx <= DELIVERY_MIGRATION_INDEX)
      .map((entry) => entry.idx),
  ).toEqual(Array.from({ length: DELIVERY_MIGRATION_INDEX + 1 }, (_, index) => index));
  requireDeliveryMigration();
});

it("ergaenzt Crash-Recovery und Retry-Redispatch additiv als 0026", () => {
  const journal = migrationJournal();
  expect(
    journal.entries
      .filter((entry) => entry.idx <= RECOVERY_MIGRATION_INDEX)
      .map((entry) => entry.idx),
  ).toEqual(Array.from({ length: RECOVERY_MIGRATION_INDEX + 1 }, (_, index) => index));
  requireRecoveryMigration();
});

it("ergaenzt Preparation und technische Retries additiv nach DSGVO-0027", () => {
  const journal = migrationJournal();
  expect(
    journal.entries
      .filter((entry) => entry.idx <= TECHNICAL_RETRY_MIGRATION_INDEX)
      .map((entry) => entry.idx),
  ).toEqual(Array.from(
    { length: TECHNICAL_RETRY_MIGRATION_INDEX + 1 },
    (_, index) => index,
  ));
  requireRuntimeIntegrityMigrations();
});

describe.sequential("M1-07: enge pg-boss-Zustellung", () => {
  let embedded: EmbeddedTestDatabase;
  let admin: Pool;
  let ownerPool: Pool;
  let runtime: Pool;
  let worker: Pool;

  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const accepted = {
    workspaceId: workspaceA,
    jobId: randomUUID(),
    projectId: randomUUID(),
  } satisfies DomainJob;
  const concurrent = {
    workspaceId: workspaceA,
    jobId: randomUUID(),
    projectId: randomUUID(),
  } satisfies DomainJob;
  const foreign = {
    workspaceId: workspaceB,
    jobId: randomUUID(),
    projectId: randomUUID(),
  } satisfies DomainJob;
  const running = {
    workspaceId: workspaceA,
    jobId: randomUUID(),
    projectId: randomUUID(),
    state: "running",
  } satisfies DomainJob;
  const recoverable = {
    workspaceId: workspaceA,
    jobId: randomUUID(),
    projectId: randomUUID(),
    nextAttemptAt: new Date("2026-08-29T11:59:00.000Z"),
  } satisfies DomainJob;
  const technicalRetry = {
    workspaceId: workspaceA,
    jobId: randomUUID(),
    projectId: randomUUID(),
  } satisfies DomainJob;
  const failed = {
    workspaceId: workspaceA,
    jobId: randomUUID(),
    projectId: randomUUID(),
    state: "failed_final",
  } satisfies DomainJob;

  beforeAll(async () => {
    requireDeliveryMigration();
    requireRecoveryMigration();
    requireRuntimeIntegrityMigrations();
    embedded = await startEmbeddedPostgres();
    admin = new Pool({ connectionString: embedded.superuserUrl, max: 2 });
    await bootstrapStrictRoles(admin);
    await installPgBoss(serviceUrl(embedded, "app_worker", WORKER_PASSWORD));

    // Der Superuser dient nur als lokaler Provisioning-Admin. Die Migration
    // selbst verbindet produktionsgleich als app_migrator, startet als
    // app_owner und darf ueber die gepinnte SET-only-Kante ausschliesslich
    // fuer worker-owned pg-boss-DDL zu app_worker wechseln.
    ownerPool = new Pool({
      connectionString: serviceUrl(embedded, "app_migrator", MIGRATOR_PASSWORD),
      max: 1,
      options: "-c role=app_owner",
    });
    await migrate(drizzle(ownerPool), { migrationsFolder: resolve("drizzle") });

    // Der wiederholte Bootstrap nach 0029 ist ein No-op und darf die durch
    // Migration gepinnten technischen Retries niemals auf Legacy 0 senken.
    await expect(bootstrapCalculationQueue(
      serviceUrl(embedded, "app_worker", WORKER_PASSWORD),
    )).resolves.toBe("keep_current");

    const ownerClient = await ownerPool.connect();
    try {
      await applyRoleContract(ownerClient);
    } finally {
      ownerClient.release();
    }

    runtime = new Pool({
      connectionString: serviceUrl(embedded, "app_runtime", RUNTIME_PASSWORD),
      max: 4,
    });
    worker = new Pool({
      connectionString: serviceUrl(embedded, "app_worker", WORKER_PASSWORD),
      max: 4,
    });
    await Promise.all([
      insertDomainJob(admin, accepted),
      insertDomainJob(admin, concurrent),
      insertDomainJob(admin, foreign),
      insertDomainJob(admin, running),
      insertDomainJob(admin, recoverable),
      insertDomainJob(admin, technicalRetry),
      insertDomainJob(admin, failed),
    ]);
  }, 180_000);

  afterAll(async () => {
    await worker?.end().catch(() => undefined);
    await runtime?.end().catch(() => undefined);
    await ownerPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await embedded?.stop().catch(() => undefined);
  });

  it("pinnt Definer-Owner, feste Suchpfadgrenze und einen statischen geschlossenen Funktionskoerper", async () => {
    const routine = await admin.query<{
      owner: string;
      language: string;
      security_definer: boolean;
      leakproof: boolean;
      config: string[] | null;
      identity_arguments: string;
      arguments: string;
      definition: string;
      source: string;
    }>(`
      select owner.rolname as owner,
             language.lanname as language,
             routine.prosecdef as security_definer,
             routine.proleakproof as leakproof,
             routine.proconfig as config,
             pg_catalog.oidvectortypes(routine.proargtypes) as identity_arguments,
             pg_catalog.pg_get_function_arguments(routine.oid) as arguments,
             pg_catalog.pg_get_functiondef(routine.oid) as definition,
             routine.prosrc as source
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        join pg_catalog.pg_roles owner on owner.oid = routine.proowner
        join pg_catalog.pg_language language on language.oid = routine.prolang
       where namespace.nspname = 'pgboss'
         and routine.proname = 'enqueue_project_calculation'
    `);
    expect(routine.rows).toHaveLength(1);
    const row = routine.rows[0]!;
    expect(row.owner).toBe("app_worker");
    expect(row.language).toMatch(/^(plpgsql|sql)$/);
    expect(row.security_definer).toBe(true);
    expect(row.leakproof).toBe(false);
    expect(row.config).toEqual(["search_path=pg_catalog"]);
    expect(row.identity_arguments).toBe("uuid, uuid");
    expect(row.arguments).toBe("workspace_id uuid, job_id uuid");
    expect(createHash("sha256").update(row.source).digest("hex"))
      .toBe("b4b87f16145bfbe691c2a5ad7db08a212e8254b3545660e0d6b063bb1d5a26f4");

    const definition = row.definition.replaceAll('"', "").replace(/\s+/g, " ").toLowerCase();
    expect(definition).toContain("security definer");
    expect(definition).toContain("public.project_calculation_job");
    expect(definition).toContain("pgboss.job");
    expect(definition).toContain(`'${DELIVERY_QUEUE}'`);
    expect(definition).toContain(`'${DELIVERY_SCHEMA_VERSION}'`);
    expect(definition).toContain("'queued'");
    expect(definition).toContain("'running'");
    expect(definition).toContain("'retry_wait'");
    expect(definition).toContain("attempt_count");
    expect(definition).toContain("lease_expires_at");
    expect(definition).toContain("next_attempt_at");
    expect(definition).toContain("retry_limit <> 10");
    expect(definition).toContain("retry_delay <> 1");
    expect(definition).toContain("octet_length");
    expect(definition).not.toMatch(/set\s+(?:local\s+)?row_security/);
    expect(definition).not.toContain("session_replication_role");
    expect(definition).not.toContain("reservationkey");
  });

  it("pinnt technische pg-boss-Retries getrennt vom Domain-attempt", async () => {
    const queue = await admin.query<{
      policy: string;
      retry_limit: number;
      retry_delay: number;
      retry_backoff: boolean;
      retry_delay_max: number | null;
      notify: boolean;
    }>(`
      select policy::text, retry_limit, retry_delay, retry_backoff,
             retry_delay_max, notify
        from pgboss.queue
       where name = $1
    `, [DELIVERY_QUEUE]);
    expect(queue.rows).toEqual([{
      policy: "exclusive",
      retry_limit: 10,
      retry_delay: 1,
      retry_backoff: true,
      retry_delay_max: 60,
      notify: false,
    }]);
  });

  it("haelt die Owner getrennt und erlaubt nur dem Migrator SET-only auf beide", async () => {
    const memberships = await admin.query<{
      granted_role: string;
      member_role: string;
      admin_option: boolean;
      inherit_option: boolean;
      set_option: boolean;
    }>(`
      select granted.rolname as granted_role,
             member.rolname as member_role,
             membership.admin_option,
             membership.inherit_option,
             membership.set_option
        from pg_catalog.pg_auth_members membership
        join pg_catalog.pg_roles granted on granted.oid = membership.roleid
        join pg_catalog.pg_roles member on member.oid = membership.member
       where (member.rolname = 'app_migrator'
              and granted.rolname in ('app_owner', 'app_worker'))
          or (granted.rolname = 'app_owner' and member.rolname = 'app_worker')
          or (granted.rolname = 'app_worker' and member.rolname = 'app_owner')
       order by granted.rolname, member.rolname
    `);
    expect(memberships.rows).toEqual([
      {
        granted_role: "app_owner",
        member_role: "app_migrator",
        admin_option: false,
        inherit_option: false,
        set_option: true,
      },
      {
        granted_role: "app_worker",
        member_role: "app_migrator",
        admin_option: false,
        inherit_option: false,
        set_option: true,
      },
    ]);
  });

  it("oeffnet fuer Runtime exakt Schema-USAGE und diese eine Routine, aber keine pg-boss-Relation", async () => {
    const schemaAcl = await admin.query<{
      grantee: string;
      grantor: string;
      privilege_type: string;
      is_grantable: boolean;
    }>(`
      select coalesce(grantee.rolname, 'PUBLIC') as grantee,
             grantor.rolname as grantor,
             acl.privilege_type,
             acl.is_grantable
        from pg_catalog.pg_namespace namespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(namespace.nspacl, pg_catalog.acldefault('n', namespace.nspowner))
        ) acl
        join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
        left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
       where namespace.nspname = 'pgboss'
         and acl.grantee <> namespace.nspowner
       order by grantee, privilege_type
    `);
    expect(schemaAcl.rows).toEqual([{
      grantee: "app_runtime",
      grantor: "app_worker",
      privilege_type: "USAGE",
      is_grantable: false,
    }]);

    const routineAcl = await admin.query<{
      grantee: string;
      grantor: string;
      signature: string;
      privilege_type: string;
      is_grantable: boolean;
    }>(`
      select coalesce(grantee.rolname, 'PUBLIC') as grantee,
             grantor.rolname as grantor,
             routine.proname || '(' || pg_catalog.oidvectortypes(routine.proargtypes) || ')'
               as signature,
             acl.privilege_type,
             acl.is_grantable
        from pg_catalog.pg_proc routine
        join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(routine.proacl, pg_catalog.acldefault('f', routine.proowner))
        ) acl
        join pg_catalog.pg_roles grantor on grantor.oid = acl.grantor
        left join pg_catalog.pg_roles grantee on grantee.oid = acl.grantee
       where namespace.nspname = 'pgboss'
         and acl.grantee <> routine.proowner
       order by grantee, signature, privilege_type
    `);
    expect(routineAcl.rows).toEqual([{
      grantee: "app_runtime",
      grantor: "app_worker",
      signature: "enqueue_project_calculation(uuid, uuid)",
      privilege_type: "EXECUTE",
      is_grantable: false,
    }]);

    const runtimeRelationAcl = await admin.query<{ relation_name: string }>(`
      select relation.relname as relation_name
        from pg_catalog.pg_class relation
        join pg_catalog.pg_namespace namespace on namespace.oid = relation.relnamespace
       where namespace.nspname = 'pgboss'
         and relation.relkind in ('r', 'p', 'S', 'v', 'm', 'f')
         and (
           pg_catalog.has_table_privilege('app_runtime', relation.oid, 'SELECT')
           or pg_catalog.has_table_privilege('app_runtime', relation.oid, 'INSERT')
           or pg_catalog.has_table_privilege('app_runtime', relation.oid, 'UPDATE')
           or pg_catalog.has_table_privilege('app_runtime', relation.oid, 'DELETE')
           or pg_catalog.has_table_privilege('app_runtime', relation.oid, 'TRUNCATE')
           or pg_catalog.has_table_privilege('app_runtime', relation.oid, 'REFERENCES')
           or pg_catalog.has_table_privilege('app_runtime', relation.oid, 'TRIGGER')
         )
       order by relation.relname
    `);
    expect(runtimeRelationAcl.rows).toEqual([]);

    await expect(runtime.query("select count(*) from pgboss.job")).rejects.toMatchObject({
      code: "42501",
    });
  });

  it("gibt app_worker fuer den atomaren Abschluss nur INSERT auf Event und Audit", async () => {
    const grants = await admin.query<{
      table_name: string;
      privilege_type: string;
      is_grantable: string;
    }>(`
      select table_name, privilege_type, is_grantable
        from information_schema.role_table_grants
       where grantee = 'app_worker'
         and table_schema = 'public'
         and table_name in ('audit_log', 'domain_events')
       order by table_name, privilege_type
    `);
    expect(grants.rows).toEqual([
      { table_name: "audit_log", privilege_type: "INSERT", is_grantable: "NO" },
      { table_name: "domain_events", privilege_type: "INSERT", is_grantable: "NO" },
    ]);
  });

  it("liefert einen vor dem Claim-Commit gerollbackten aktiven Handler technisch erneut aus", async () => {
    const deliveryErrors: unknown[] = [];
    const deliveryBoss = new PgBoss({
      connectionString: serviceUrl(embedded, "app_worker", WORKER_PASSWORD),
      schema: "pgboss",
      createSchema: false,
    });
    deliveryBoss.on("error", (error) => deliveryErrors.push(error));
    let deliveries = 0;
    const rollbackMarker = new Error("intentional pre-claim-commit rollback");

    try {
      await deliveryBoss.start();
      await deliveryBoss.work(DELIVERY_QUEUE, async (jobs) => {
        const job = jobs[0];
        const data = job?.data as { jobId?: unknown } | undefined;
        if (data?.jobId !== technicalRetry.jobId) return;
        deliveries += 1;
        const leaseToken = randomUUID();
        if (deliveries === 1) {
          await withTenantOn(worker, technicalRetry.workspaceId, async (tx) => {
            const claimed = await claimProjectCalculationJob(tx, {
              workspaceId: technicalRetry.workspaceId,
              jobId: technicalRetry.jobId,
              leaseToken,
            });
            expect(claimed).toMatchObject({ attemptCount: 1, leaseToken });
            throw rollbackMarker;
          });
          return;
        }
        const claimed = await withTenantOn(worker, technicalRetry.workspaceId, (tx) =>
          claimProjectCalculationJob(tx, {
            workspaceId: technicalRetry.workspaceId,
            jobId: technicalRetry.jobId,
            leaseToken,
          }));
        expect(claimed).toMatchObject({ attemptCount: 1, leaseToken });
      });

      await dispatch(
        runtime,
        technicalRetry.workspaceId,
        technicalRetry.jobId,
      );
      const deadline = Date.now() + 20_000;
      while (deliveries < 2 && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 100));
      }
      expect(deliveries).toBe(2);
    } finally {
      await deliveryBoss.stop({ graceful: true, timeout: 5_000 }).catch(() => undefined);
    }

    expect(deliveryErrors).toEqual([]);
    expect(await domainJobState(admin, technicalRetry.jobId)).toEqual({
      state: "running",
      attempt_count: 1,
    });
    const jobs = await admin.query<{
      state: string;
      retry_count: number;
      retry_limit: number;
    }>(`
      select state::text, retry_count, retry_limit
        from pgboss.job
       where name = $1
         and singleton_key = $2
    `, [DELIVERY_QUEUE, `${technicalRetry.jobId}:1`]);
    expect(jobs.rows).toEqual([{
      state: "completed",
      retry_count: 1,
      retry_limit: 10,
    }]);
  }, 30_000);

  it("stellt exakt das minimale Payload zu und bleibt bei Replay sowie Parallelrace einfach", async () => {
    await dispatch(runtime, accepted.workspaceId, accepted.jobId);
    const first = await pgBossJobs(admin, accepted.jobId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      name: DELIVERY_QUEUE,
      data: {
        schemaVersion: DELIVERY_SCHEMA_VERSION,
        workspaceId: accepted.workspaceId,
        jobId: accepted.jobId,
      },
      singleton_key: `${accepted.jobId}:1`,
      state: "created",
    });
    expect(first[0]!.data).toEqual({
      schemaVersion: DELIVERY_SCHEMA_VERSION,
      workspaceId: accepted.workspaceId,
      jobId: accepted.jobId,
    });

    await dispatch(runtime, accepted.workspaceId, accepted.jobId);
    expect(await pgBossJobs(admin, accepted.jobId)).toEqual(first);

    await Promise.all([
      dispatch(runtime, concurrent.workspaceId, concurrent.jobId),
      dispatch(runtime, concurrent.workspaceId, concurrent.jobId),
    ]);
    const raced = await pgBossJobs(admin, concurrent.jobId);
    expect(raced).toHaveLength(1);
    expect(raced[0]!.singleton_key).toBe(`${concurrent.jobId}:1`);
    expect(raced[0]!.data).toEqual({
      schemaVersion: DELIVERY_SCHEMA_VERSION,
      workspaceId: concurrent.workspaceId,
      jobId: concurrent.jobId,
    });
  });

  it("plant den naechsten Attempt atomar, zieht denselben Dispatch bei Retry vor und dupliziert ihn nicht", async () => {
    const rollbackLeaseToken = randomUUID();
    const rollbackMarker = new Error("intentional claim/dispatch rollback");

    await dispatch(runtime, recoverable.workspaceId, recoverable.jobId);
    const initial = await pgBossJobs(admin, recoverable.jobId);
    expect(initial).toHaveLength(1);
    expect(initial[0]).toMatchObject({
      singleton_key: `${recoverable.jobId}:1`,
      data: {
        schemaVersion: DELIVERY_SCHEMA_VERSION,
        workspaceId: recoverable.workspaceId,
        jobId: recoverable.jobId,
      },
    });

    await expect(withTenantOn(worker, recoverable.workspaceId, async (tx) => {
      const claim = await claimProjectCalculationJob(tx, {
        workspaceId: recoverable.workspaceId,
        jobId: recoverable.jobId,
        leaseToken: rollbackLeaseToken,
      });
      expect(claim).toMatchObject({ attemptCount: 1, leaseToken: rollbackLeaseToken });
      throw rollbackMarker;
    })).rejects.toBe(rollbackMarker);

    expect(await domainJobState(admin, recoverable.jobId)).toEqual({
      state: "queued",
      attempt_count: 0,
    });
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

    const afterClaim = await pgBossJobs(admin, recoverable.jobId);
    expect(afterClaim).toHaveLength(2);
    const recovery = afterClaim.find(
      (job) => job.singleton_key === `${recoverable.jobId}:2`,
    );
    expect(recovery).toMatchObject({
      name: DELIVERY_QUEUE,
      state: "created",
      data: {
        schemaVersion: DELIVERY_SCHEMA_VERSION,
        workspaceId: recoverable.workspaceId,
        jobId: recoverable.jobId,
      },
    });
    expect(recovery?.data).toEqual({
      schemaVersion: DELIVERY_SCHEMA_VERSION,
      workspaceId: recoverable.workspaceId,
      jobId: recoverable.jobId,
    });
    expect(asDate(recovery!.start_after).getTime()).toBe(
      asDate(claim!.leaseExpiresAt).getTime(),
    );

    const recoveryId = recovery!.id;
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
    expect(retry.nextAttemptAt.getTime()).toBeLessThan(
      asDate(claim!.leaseExpiresAt).getTime(),
    );

    const afterFailure = await pgBossJobs(admin, recoverable.jobId);
    expect(afterFailure).toHaveLength(2);
    const retimed = afterFailure.find(
      (job) => job.singleton_key === `${recoverable.jobId}:2`,
    );
    expect(retimed?.id).toBe(recoveryId);
    expect(asDate(retimed!.start_after).getTime()).toBe(retry.nextAttemptAt.getTime());

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
    expect(requeued?.id).toBe(recoveryId);
    expect(asDate(requeued!.start_after).getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("akzeptiert exakt queued/running/retry_wait und weist fremde, terminale, fehlende oder kaputte Reservationen ab", async () => {
    await expect(dispatch(runtime, workspaceA, foreign.jobId)).rejects.toBeDefined();
    await expect(dispatch(runtime, workspaceB, accepted.jobId)).rejects.toBeDefined();
    await expect(dispatch(runtime, running.workspaceId, running.jobId)).resolves.toBeUndefined();
    await expect(dispatch(runtime, failed.workspaceId, failed.jobId)).rejects.toBeDefined();
    await expect(dispatch(runtime, workspaceA, randomUUID())).rejects.toBeDefined();

    expect(await pgBossJobs(admin, foreign.jobId)).toEqual([]);
    expect(await pgBossJobs(admin, failed.jobId)).toEqual([]);
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
