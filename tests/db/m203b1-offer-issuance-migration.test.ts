import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgBoss } from "pg-boss";
import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";
import { withTenantOn } from "@/lib/db/tenant";
import {
  CATALOG_IMPORT_CLEANUP_QUEUE_OPTIONS,
  CATALOG_IMPORT_QUEUE_OPTIONS,
  CUSTOMER_NOTIFICATION_QUEUE_OPTIONS,
  LEGACY_CALCULATION_QUEUE_OPTIONS,
  OFFER_ISSUANCE_QUEUE_OPTIONS,
  OFFER_PDF_QUEUE_OPTIONS,
  OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS,
} from "../../scripts/pgboss-bootstrap.mjs";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";
import { superuserPool } from "../setup/superuser-db";
import { tenantFixtures } from "../setup/tenant-fixtures";
import { testPool } from "../setup/test-db";

type MigrationJournal = {
  entries: Array<{ idx: number; tag: string }>;
};

const TABLES = [
  "offer_issuance",
  "offer_issuance_approval",
  "offer_issuance_withdrawal",
] as const;

const PRE_M203B1_HISTORY_SHA256 =
  "1d53aaaa97bf6308b02374839c54416996b36433c143df0dba5c20ca501798fc";

const STRICT_MIGRATOR_PASSWORD = "m203b1_dispatch_migrator";
const STRICT_RUNTIME_PASSWORD = "m203b1_dispatch_runtime";
const STRICT_WORKER_PASSWORD = "m203b1_dispatch_worker";

function journal(): MigrationJournal {
  return JSON.parse(
    readFileSync(resolve("drizzle/meta/_journal.json"), "utf8"),
  ) as MigrationJournal;
}

function historyHashThrough(index: number): string {
  const material = journal().entries
    .filter((entry) => entry.idx <= index)
    .map((entry) => `${entry.idx}\0${entry.tag}\0${readFileSync(
      resolve("drizzle", `${entry.tag}.sql`),
      "utf8",
    )}`)
    .join("\0");
  return createHash("sha256").update(material).digest("hex");
}

function strictServiceUrl(
  embedded: EmbeddedTestDatabase,
  role: "app_migrator" | "app_runtime" | "app_worker",
  password: string,
): string {
  const url = new URL(embedded.url);
  url.username = role;
  url.password = password;
  return url.toString();
}

async function bootstrapStrictPgBossV38(
  embedded: EmbeddedTestDatabase,
  admin: Pool,
): Promise<void> {
  await admin.query(`
    create role app_owner nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_migrator login password '${STRICT_MIGRATOR_PASSWORD}'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_runtime login password '${STRICT_RUNTIME_PASSWORD}'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_system login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_auth login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_worker login password '${STRICT_WORKER_PASSWORD}'
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

    alter database energie_saas_test owner to app_owner;
    revoke all privileges on database energie_saas_test from app_test;
    grant connect on database energie_saas_test
      to app_migrator, app_runtime, app_worker;
    alter schema public owner to app_owner;
    revoke all on schema public from public, app_test;
    create schema pgboss authorization app_worker;
  `);

  const boss = new PgBoss({
    connectionString: strictServiceUrl(
      embedded,
      "app_worker",
      STRICT_WORKER_PASSWORD,
    ),
    schema: "pgboss",
    createSchema: false,
  });
  const asynchronousErrors: unknown[] = [];
  boss.on("error", (error) => asynchronousErrors.push(error));
  try {
    await boss.start();
    await boss.createQueue(
      "calculation.execute",
      LEGACY_CALCULATION_QUEUE_OPTIONS,
    );
    await boss.createQueue("catalog.import.v1", CATALOG_IMPORT_QUEUE_OPTIONS);
    await boss.createQueue(
      "catalog.import.cleanup.v1",
      CATALOG_IMPORT_CLEANUP_QUEUE_OPTIONS,
    );
    await boss.createQueue("pdf.render", OFFER_PDF_QUEUE_OPTIONS);
    await boss.createQueue(
      "offer.release-candidate.render",
      OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS,
    );
    await boss.createQueue(
      "offer-issuance.render.v1",
      OFFER_ISSUANCE_QUEUE_OPTIONS,
    );
    await boss.createQueue(
      "notification.customer",
      CUSTOMER_NOTIFICATION_QUEUE_OPTIONS,
    );
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
  if (asynchronousErrors.length > 0) {
    throw new Error(
      `pg-boss-v38-Bootstrap schlug fehl: ${asynchronousErrors.map(String).join(", ")}`,
    );
  }
}

async function strictTenantQuery<Row extends QueryResultRow = QueryResultRow>(
  pool: Pool,
  workspaceId: string,
  actorId: string | null,
  query: string,
  values: unknown[] = [],
): Promise<QueryResult<Row>> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select pg_catalog.set_config('app.workspace_id', $1, true)",
      [workspaceId],
    );
    await client.query(
      "select pg_catalog.set_config('app.actor_id', $1, true)",
      [actorId ?? ""],
    );
    const result = await client.query<Row>(query, values);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe("M2-03b1 offer-issuance migration contract", () => {
  it("ist additive 0035 und veraendert die Historie 0000..0034 nicht", () => {
    const entries = journal().entries;
    expect(entries.slice(0, 36).map((entry) => entry.idx)).toEqual(
      Array.from({ length: 36 }, (_, index) => index),
    );
    expect(entries[35]?.tag).toBe("0035_m2_03b1_offer_issuance");
    expect(historyHashThrough(34)).toBe(PRE_M203B1_HISTORY_SHA256);
  });

  it("enthaelt keinen Issued-, Archiv-, Storage- oder Versandpfad", () => {
    const migration = readFileSync(
      resolve("drizzle/0035_m2_03b1_offer_issuance.sql"),
      "utf8",
    );
    expect(migration).not.toMatch(
      /\b(issued_at|archive_(?:state|object|evidence)|storage_version_id|retention_until|sent_at|signed_at)\b/iu,
    );
    expect(migration).not.toMatch(/\bapp_archive_worker\b/iu);
  });

  it("erzwingt FORCE RLS und genau eine kanonische permissive Policy", async () => {
    const relations = await testPool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(`
      select relname, relrowsecurity, relforcerowsecurity
        from pg_catalog.pg_class
       where relnamespace = 'public'::regnamespace
         and relname = any($1::text[])
       order by relname
    `, [TABLES]);
    expect(relations.rows).toEqual([...TABLES].sort().map((relname) => ({
      relname,
      relrowsecurity: true,
      relforcerowsecurity: true,
    })));

    const policies = await testPool.query<{
      tablename: string;
      policyname: string;
      permissive: string;
      roles: string;
      cmd: string;
      same_predicate: boolean;
    }>(`
      select tablename, policyname, permissive, roles::text as roles, cmd,
             qual = with_check as same_predicate
        from pg_catalog.pg_policies
       where schemaname = 'public'
         and tablename = any($1::text[])
       order by tablename, policyname
    `, [TABLES]);
    expect(policies.rows).toEqual([...TABLES].sort().map((tablename) => ({
      tablename,
      policyname: "tenant_isolation",
      permissive: "PERMISSIVE",
      roles: "{public}",
      cmd: "ALL",
      same_predicate: true,
    })));
  });

  it("pinnt Append-only/CAS-Guards und die Zwei-Personen-Regel", async () => {
    const triggers = await testPool.query<{
      table_name: string;
      trigger_name: string;
      function_name: string;
    }>(`
      select relation.relname as table_name,
             trigger_row.tgname as trigger_name,
             routine.proname as function_name
        from pg_catalog.pg_trigger as trigger_row
        join pg_catalog.pg_class as relation on relation.oid = trigger_row.tgrelid
        join pg_catalog.pg_proc as routine on routine.oid = trigger_row.tgfoid
       where not trigger_row.tgisinternal
         and relation.relname = any($1::text[])
       order by relation.relname, trigger_row.tgname
    `, [TABLES]);
    expect(triggers.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        table_name: "offer_issuance",
        function_name: "_m203b1_guard_offer_issuance",
      }),
      expect.objectContaining({
        table_name: "offer_issuance_approval",
        function_name: "_m203b1_guard_offer_issuance_approval",
      }),
      expect.objectContaining({
        table_name: "offer_issuance_withdrawal",
        function_name: "_m203b1_guard_offer_issuance_append_only",
      }),
    ]));

    const approvalGuard = await testPool.query<{ source: string }>(`
      select routine.prosrc as source
        from pg_catalog.pg_proc as routine
       where routine.oid = 'public._m203b1_guard_offer_issuance_approval()'::regprocedure
    `);
    expect(approvalGuard.rows[0]?.source).toMatch(
      /pg_advisory_xact_lock[\s\S]*count[\s\S]*candidate_approved_by[\s\S]*maximal zwei/iu,
    );
  });

  it("stellt nur die vereinbarten schmalen Runtime-/Worker-Funktionen bereit", () => {
    const migration = readFileSync(
      resolve("drizzle/0035_m2_03b1_offer_issuance.sql"),
      "utf8",
    );
    for (const signature of [
      "prepare_offer_issuance",
      "approve_offer_issuance",
      "withdraw_offer_issuance",
      "read_offer_issuance_status",
      "read_offer_issuance_artifact",
      "claim_offer_issuance_render",
      "finalize_offer_issuance_render_success",
      "finalize_offer_issuance_render_failure",
      "recover_offer_issuance_renders",
      "list_offer_issuance_recovery_workspaces",
    ]) {
      expect(migration).toContain(`FUNCTION public.${signature}`);
    }
    expect(migration).not.toMatch(
      /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|TRUNCATE)[\s\S]{0,300}\bTO\s+(?:app_runtime|app_worker)\b/iu,
    );
    const statusRead = migration.slice(
      migration.indexOf("CREATE FUNCTION public.read_offer_issuance_status("),
      migration.indexOf("CREATE FUNCTION public.read_offer_issuance_artifact("),
    );
    expect(statusRead).toContain("viewer_has_approved boolean");
    expect(statusRead).toContain("can_current_actor_approve boolean");
    expect(statusRead).toContain("approval.approved_by = actor_id");
    expect(statusRead).not.toContain("approved_by uuid");
  });

  it("ordnet exakten Replay vor mutablem Drift und reserviert Attempt 4 nur als Running-Sentinel", () => {
    const migration = readFileSync(
      resolve("drizzle/0035_m2_03b1_offer_issuance.sql"),
      "utf8",
    );
    const prepareSource = migration.slice(
      migration.indexOf("CREATE FUNCTION public.prepare_offer_issuance("),
      migration.indexOf("CREATE FUNCTION public._m203b1_offer_issuance_source_is_current("),
    );
    const exactReplayAt = prepareSource.indexOf(
      "SELECT issuance.* INTO existing_issuance",
    );
    expect(exactReplayAt).toBeGreaterThan(0);
    expect(exactReplayAt).toBeLessThan(
      prepareSource.indexOf("candidate_record.valid_through <"),
    );
    const newReservationPath = prepareSource.slice(exactReplayAt);
    const lockOrder = [
      "SELECT profile.* INTO profile_head",
      "FROM public.project AS project_record",
      "SELECT candidate_offer.* INTO offer_record",
      "SELECT recipient.* INTO recipient_head",
      "SELECT variant.* INTO variant_head",
      "FROM public.offer_release_candidate AS candidate",
      "FROM public.offer_release_candidate_approval AS approval",
    ].map((needle) => newReservationPath.indexOf(needle));
    expect(lockOrder.every((position) => position >= 0)).toBe(true);
    expect(lockOrder).toEqual([...lockOrder].sort((left, right) => left - right));

    const dispatchSource = migration.slice(
      migration.indexOf(
        "CREATE FUNCTION public._m203b1_offer_issuance_dispatch_state(",
      ),
      migration.indexOf("DO $m203b1_issuance_dispatch_migration$"),
    );
    expect(dispatchSource).toContain(
      "(issuance.state IN ('queued', 'retry_wait')\n" +
      "          AND issuance.attempt_count < 3)",
    );
    expect(dispatchSource).toContain(
      "(issuance.state = 'running'\n" +
      "          AND issuance.attempt_count BETWEEN 1 AND 3)",
    );
    expect(migration).toContain(
      "dispatch_attempt := issuance_attempt_count + 1;",
    );

    const approvalSource = migration.slice(
      migration.indexOf("CREATE FUNCTION public.approve_offer_issuance("),
      migration.indexOf("CREATE FUNCTION public.withdraw_offer_issuance("),
    );
    const approvalLockOrder = [
      "FROM public.offer_release_profile AS profile",
      "FROM public.project AS project_record",
      "FROM public.offer AS offer_record",
      "FROM public.offer_recipient AS recipient",
      "FROM public.offer_variant AS variant",
      "FROM public.offer_release_candidate AS candidate",
      "FROM public.offer_release_candidate_approval AS candidate_approval",
      "FOR UPDATE;\n  IF NOT FOUND THEN",
    ].map((needle) => approvalSource.indexOf(needle));
    expect(approvalLockOrder.every((position) => position >= 0)).toBe(true);
    expect(approvalLockOrder).toEqual(
      [...approvalLockOrder].sort((left, right) => left - right),
    );
  });

  it("enqueue't im echten pg-boss-v38-Pfad fuer Running-Attempt 3 genau den :4-Sentinel", async () => {
    const embedded = await startEmbeddedPostgres();
    const admin = new Pool({ connectionString: embedded.superuserUrl, max: 2 });
    let owner: Pool | undefined;
    let runtime: Pool | undefined;
    let worker: Pool | undefined;
    try {
      await bootstrapStrictPgBossV38(embedded, admin);
      owner = new Pool({
        connectionString: strictServiceUrl(
          embedded,
          "app_migrator",
          STRICT_MIGRATOR_PASSWORD,
        ),
        options: "-c role=app_owner",
        max: 2,
      });
      await migrate(drizzle(owner), { migrationsFolder: resolve("drizzle") });
      runtime = new Pool({
        connectionString: strictServiceUrl(
          embedded,
          "app_runtime",
          STRICT_RUNTIME_PASSWORD,
        ),
        max: 2,
      });
      worker = new Pool({
        connectionString: strictServiceUrl(
          embedded,
          "app_worker",
          STRICT_WORKER_PASSWORD,
        ),
        max: 2,
      });

      const workspaceId = randomUUID();
      await withTenantOn(owner, workspaceId, async (tx) => {
        await tx.execute(sql`
          insert into public.workspace (id, name)
          values (${workspaceId}::uuid, 'M2-03b1 echter Attempt-4-Sentinel')
        `);
        const fixture = tenantFixtures.offer_release_candidate;
        if (!fixture) throw new Error("Release-Candidate-Fixture fehlt.");
        await fixture(tx, workspaceId);
      });

      const bindingRows = await strictTenantQuery<{
        actor_id: string;
        candidate_id: string;
        offer_id: string;
      }>(
        owner,
        workspaceId,
        null,
        `select approval.approved_by as actor_id,
                candidate.id as candidate_id,
                candidate.offer_id
           from public.offer_release_candidate as candidate
           join public.offer_release_candidate_approval as approval
             on approval.workspace_id = candidate.workspace_id
            and approval.candidate_id = candidate.id
          where candidate.workspace_id = $1::uuid
          order by approval.approved_at desc, approval.id desc
          limit 1`,
        [workspaceId],
      );
      const binding = bindingRows.rows[0];
      if (!binding) throw new Error("Freigegebener Candidate fehlt.");

      const preparedRows = await strictTenantQuery<{
        result: { issuanceId?: unknown; status?: unknown };
      }>(
        runtime,
        workspaceId,
        binding.actor_id,
        `select public.prepare_offer_issuance(
           $1::uuid, $2::uuid, $3::uuid
         ) as result`,
        [workspaceId, binding.offer_id, binding.candidate_id],
      );
      const prepared = preparedRows.rows[0]?.result;
      expect(prepared?.status).toBe("prepared");
      if (typeof prepared?.issuanceId !== "string") {
        throw new Error("Issuance-Reservation fehlt.");
      }
      const issuanceId = prepared.issuanceId;

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const leaseToken = randomUUID();
        const claimRows = await strictTenantQuery<{
          result: { attemptCount?: unknown; status?: unknown };
        }>(
          worker,
          workspaceId,
          null,
          `select public.claim_offer_issuance_render(
             $1::uuid, $2::uuid, $3::uuid, 120
           ) as result`,
          [workspaceId, issuanceId, leaseToken],
        );
        expect(claimRows.rows[0]?.result).toMatchObject({
          status: "claimed",
          attemptCount: attempt,
        });
        if (attempt === 3) break;

        const failureRows = await strictTenantQuery<{
          result: { attemptCount?: unknown; status?: unknown };
        }>(
          worker,
          workspaceId,
          null,
          `select public.finalize_offer_issuance_render_failure(
             $1::uuid, $2::uuid, $3::uuid, $4::integer,
             'browser_unavailable', true
           ) as result`,
          [workspaceId, issuanceId, leaseToken, attempt],
        );
        expect(failureRows.rows[0]?.result).toMatchObject({
          status: "retry_wait",
          attemptCount: attempt,
        });

        const clock = await admin.connect();
        try {
          await clock.query("begin");
          await clock.query("set local session_replication_role = replica");
          await clock.query(
            `update public.offer_issuance
                set next_attempt_at = pg_catalog.clock_timestamp()
                  - interval '1 second'
              where workspace_id = $1::uuid and id = $2::uuid`,
            [workspaceId, issuanceId],
          );
          await clock.query("commit");
        } catch (error) {
          await clock.query("rollback").catch(() => undefined);
          throw error;
        } finally {
          clock.release();
        }
      }

      const runningRows = await admin.query<{
        attempt_count: number;
        lease_expires_at: Date;
        state: string;
      }>(
        `select state, attempt_count, lease_expires_at
           from public.offer_issuance
          where workspace_id = $1::uuid and id = $2::uuid`,
        [workspaceId, issuanceId],
      );
      expect(runningRows.rows).toHaveLength(1);
      expect(runningRows.rows[0]).toMatchObject({
        state: "running",
        attempt_count: 3,
      });

      for (let replay = 0; replay < 2; replay += 1) {
        await strictTenantQuery(
          runtime,
          workspaceId,
          binding.actor_id,
          "select pgboss.enqueue_offer_issuance($1::uuid, $2::uuid)",
          [workspaceId, issuanceId],
        );
      }

      const jobs = await admin.query<{
        data: Record<string, unknown>;
        expire_seconds: number;
        policy: string;
        retry_backoff: boolean;
        retry_delay: number;
        retry_delay_max: number;
        retry_limit: number;
        singleton_key: string;
        start_after: Date;
        state: string;
      }>(
        `select job.data, job.state::text, job.singleton_key,
                job.policy::text, job.start_after, job.expire_seconds,
                job.retry_limit, job.retry_delay, job.retry_backoff,
                job.retry_delay_max
           from pgboss.job as job
          where job.name = 'offer-issuance.render.v1'
            and job.singleton_key = $1::text`,
        [`${issuanceId}:4`],
      );
      expect(jobs.rows).toHaveLength(1);
      expect(jobs.rows[0]).toMatchObject({
        data: {
          schemaVersion: "offer-issuance-dispatch.v1",
          workspaceId,
          issuanceId,
        },
        state: "created",
        singleton_key: `${issuanceId}:4`,
        policy: "exclusive",
        expire_seconds: 180,
        retry_limit: 10,
        retry_delay: 1,
        retry_backoff: true,
        retry_delay_max: 60,
      });
      expect(jobs.rows[0]?.start_after.toISOString()).toBe(
        runningRows.rows[0]?.lease_expires_at.toISOString(),
      );
    } finally {
      await worker?.end().catch(() => undefined);
      await runtime?.end().catch(() => undefined);
      await owner?.end().catch(() => undefined);
      await admin.end().catch(() => undefined);
      await embedded.stop().catch(() => undefined);
    }
  }, 120_000);

  it("haelt direkte Approval-Inserts source-first und findet strikt valide failed Jobs", async () => {
    const routines = await testPool.query<{ proname: string; source: string }>(`
      select routine.proname, routine.prosrc as source
        from pg_catalog.pg_proc as routine
       where routine.oid = any(array[
         'public._m203b1_guard_offer_issuance_approval()'::regprocedure,
         'public._m203b1_guard_offer_issuance_append_only()'::regprocedure,
         'public.list_offer_issuance_recovery_workspaces(uuid,integer)'::regprocedure
       ]::oid[])
       order by routine.proname
    `);
    const approvalGuard = routines.rows.find(
      (routine) => routine.proname === "_m203b1_guard_offer_issuance_approval",
    )?.source ?? "";
    const sourceLockAt = approvalGuard.indexOf(
      "FROM public.offer_release_profile AS profile",
    );
    const workspaceLockAt = approvalGuard.indexOf(
      "FROM public.workspace AS workspace_record",
    );
    const advisoryLockAt = approvalGuard.indexOf("pg_advisory_xact_lock");
    const finalIssuanceLockAt = approvalGuard.lastIndexOf(
      "FROM public.offer_issuance AS issuance",
    );
    expect(workspaceLockAt).toBeGreaterThan(0);
    expect(advisoryLockAt).toBeGreaterThan(workspaceLockAt);
    expect(sourceLockAt).toBeGreaterThan(0);
    expect(sourceLockAt).toBeGreaterThan(advisoryLockAt);
    expect(finalIssuanceLockAt).toBeGreaterThan(sourceLockAt);
    expect(approvalGuard).toContain("_m203b1_offer_issuance_source_is_current");

    const withdrawalGuard = routines.rows.find(
      (routine) => routine.proname === "_m203b1_guard_offer_issuance_append_only",
    )?.source ?? "";
    const withdrawalWorkspaceAt = withdrawalGuard.indexOf(
      "FROM public.workspace AS workspace_record",
    );
    const withdrawalAdvisoryAt = withdrawalGuard.indexOf("pg_advisory_xact_lock");
    const withdrawalIssuanceAt = withdrawalGuard.indexOf(
      "FROM public.offer_issuance AS issuance",
    );
    expect(withdrawalWorkspaceAt).toBeGreaterThan(0);
    expect(withdrawalAdvisoryAt).toBeGreaterThan(withdrawalWorkspaceAt);
    expect(withdrawalIssuanceAt).toBeGreaterThan(withdrawalAdvisoryAt);

    const recoveryLocator = routines.rows.find(
      (routine) => routine.proname === "list_offer_issuance_recovery_workspaces",
    )?.source ?? "";
    expect(recoveryLocator).toContain(
      "job.state::text IN ('created', 'retry', 'active', 'failed')",
    );
    expect(recoveryLocator).toContain(
      "locator.data - ARRAY[\n         'schemaVersion', 'workspaceId', 'issuanceId'",
    );
    expect(recoveryLocator).toContain("WITH locator_jobs AS MATERIALIZED");
    expect(recoveryLocator).toContain("pg_input_is_valid");
    expect(recoveryLocator).toContain("THEN (job.data->>'workspaceId')::uuid");
    expect(recoveryLocator).toContain("locator.safe_workspace_id > $1");
    expect(recoveryLocator).toContain("ORDER BY workspace_id");
    expect(recoveryLocator).toContain("LIMIT $2");
  });

  it("ueberlebt malformed failed Queue-Locators und paginiert nur sichere UUIDs", async () => {
    const admin = await superuserPool().connect();
    const firstWorkspaceId = "11111111-1111-4111-8111-111111111111";
    const secondWorkspaceId = "22222222-2222-4222-8222-222222222222";
    try {
      await admin.query("begin");
      const existing = await admin.query<{ relation_name: string | null }>(`
        select pg_catalog.to_regclass('pgboss.job')::text as relation_name
      `);
      expect(existing.rows[0]?.relation_name).toBeNull();
      await admin.query("create schema pgboss");
      await admin.query(`
        create table pgboss.job (
          name text not null,
          data jsonb,
          state text not null
        )
      `);
      const dispatch = (workspaceId: string, issuanceId: string = randomUUID()) => ({
        schemaVersion: "offer-issuance-dispatch.v1",
        workspaceId,
        issuanceId,
      });
      await admin.query(
        `insert into pgboss.job (name, data, state)
         select payload.name, payload.data, payload.state
           from pg_catalog.jsonb_to_recordset($1::jsonb) as payload(
             name text, data jsonb, state text
           )`,
        [JSON.stringify([
          {
            name: "offer-issuance.render.v1",
            data: dispatch(firstWorkspaceId),
            state: "failed",
          },
          {
            name: "offer-issuance.render.v1",
            data: dispatch(secondWorkspaceId),
            state: "failed",
          },
          {
            name: "offer-issuance.render.v1",
            data: dispatch("not-a-uuid"),
            state: "failed",
          },
          {
            name: "offer-issuance.render.v1",
            data: dispatch(firstWorkspaceId, "not-an-issuance-uuid"),
            state: "failed",
          },
          {
            name: "offer-issuance.render.v1",
            data: { ...dispatch(firstWorkspaceId), unexpected: true },
            state: "failed",
          },
          {
            name: "offer-issuance.render.v1",
            data: null,
            state: "failed",
          },
          {
            name: "other.queue",
            data: dispatch(firstWorkspaceId),
            state: "failed",
          },
          {
            name: "offer-issuance.render.v1",
            data: dispatch(firstWorkspaceId),
            state: "completed",
          },
        ])],
      );

      const firstPage = await admin.query<{ workspace_id: string }>(
        `select workspace_id
           from public.list_offer_issuance_recovery_workspaces(null, 1)`,
      );
      expect(firstPage.rows).toEqual([{ workspace_id: firstWorkspaceId }]);
      const secondPage = await admin.query<{ workspace_id: string }>(
        `select workspace_id
           from public.list_offer_issuance_recovery_workspaces($1::uuid, 100)`,
        [firstWorkspaceId],
      );
      expect(secondPage.rows).toEqual([{ workspace_id: secondWorkspaceId }]);
      await admin.query("rollback");
    } catch (error) {
      await admin.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      admin.release();
    }
  });

  it("erzwingt die exakte Rollen-, Definer- und search_path-Matrix", async () => {
    const runtimeSignatures = [
      "public.prepare_offer_issuance(uuid,uuid,uuid)",
      "public.approve_offer_issuance(uuid,uuid,boolean,boolean,boolean,boolean,boolean)",
      "public.withdraw_offer_issuance(uuid,uuid,text)",
      "public.read_offer_issuance_status(uuid,uuid,uuid)",
      "public.read_offer_issuance_artifact(uuid,uuid,uuid)",
    ];
    const workerDefinerSignatures = [
      "public.claim_offer_issuance_render(uuid,uuid,uuid,integer)",
      "public.finalize_offer_issuance_render_success(uuid,uuid,uuid,integer,bytea)",
      "public.finalize_offer_issuance_render_failure(uuid,uuid,uuid,integer,text,boolean)",
      "public.recover_offer_issuance_renders(uuid,integer)",
      "public._m203b1_offer_issuance_dispatch_state(uuid,uuid)",
    ];
    const workerInvokerSignatures = [
      "public.list_offer_issuance_recovery_workspaces(uuid,integer)",
    ];
    const allSignatures = [
      ...runtimeSignatures,
      ...workerDefinerSignatures,
      ...workerInvokerSignatures,
    ];
    const roles = [
      "app_runtime",
      "app_worker",
      "app_system",
      "app_auth",
      "app_erasure",
    ];
    const installedRoles = await testPool.query<{ rolname: string }>(`
      select role_row.rolname
        from pg_catalog.pg_roles as role_row
       where role_row.rolname = any($1::text[])
       order by role_row.rolname
    `, [roles]);
    const catalogRoles = installedRoles.rows.map((role) => role.rolname);
    const grants = await testPool.query<{
      role_name: string;
      signature: string;
      can_execute: boolean;
    }>(`
      select role_name, signature,
             pg_catalog.has_function_privilege(
               role_name, signature, 'EXECUTE'
             ) as can_execute
        from pg_catalog.unnest($1::text[]) as role_row(role_name)
        cross join pg_catalog.unnest($2::text[]) as routine_row(signature)
       order by role_name, signature
    `, [catalogRoles, allSignatures]);
    for (const grant of grants.rows) {
      expect(grant.can_execute).toBe(
        grant.role_name === "app_runtime"
          ? runtimeSignatures.includes(grant.signature)
          : grant.role_name === "app_worker"
            ? [...workerDefinerSignatures, ...workerInvokerSignatures]
              .includes(grant.signature)
            : false,
      );
    }

    const routineSecurity = await testPool.query<{
      signature: string;
      security_definer: boolean;
      proconfig: string[] | null;
      public_execute: boolean;
    }>(`
      select requested.signature,
             routine.prosecdef as security_definer,
             routine.proconfig,
             exists (
               select 1
                 from pg_catalog.aclexplode(coalesce(
                   routine.proacl,
                   pg_catalog.acldefault('f', routine.proowner)
                 )) as privilege
                where privilege.grantee = 0
                  and privilege.privilege_type = 'EXECUTE'
             ) as public_execute
        from pg_catalog.unnest($1::text[]) as requested(signature)
        join pg_catalog.pg_proc as routine
          on routine.oid = pg_catalog.to_regprocedure(requested.signature)
       order by requested.signature
    `, [allSignatures]);
    expect(routineSecurity.rows).toHaveLength(allSignatures.length);
    for (const routine of routineSecurity.rows) {
      expect(routine.public_execute).toBe(false);
      expect(routine.proconfig).toEqual(["search_path=pg_catalog"]);
      expect(routine.security_definer).toBe(
        !workerInvokerSignatures.includes(routine.signature),
      );
    }

    const tablePrivileges = await testPool.query<{
      role_name: string;
      table_name: string;
      privilege: string;
      allowed: boolean;
    }>(`
      select role_name, table_name, privilege,
             pg_catalog.has_table_privilege(
               role_name,
               'public.' || table_name,
               privilege
             ) as allowed
        from pg_catalog.unnest($1::text[]) as role_row(role_name)
        cross join pg_catalog.unnest($2::text[]) as table_row(table_name)
        cross join pg_catalog.unnest(
          array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']::text[]
        ) as privilege_row(privilege)
    `, [catalogRoles, TABLES]);
    expect(tablePrivileges.rows.every((privilege) => !privilege.allowed)).toBe(true);

    const migration = readFileSync(
      resolve("drizzle/0035_m2_03b1_offer_issuance.sql"),
      "utf8",
    );
    expect(migration).toMatch(
      /pgboss_owner <> 'app_worker'[\s\S]*SET LOCAL ROLE app_worker[\s\S]*CREATE FUNCTION pgboss\.enqueue_offer_issuance[\s\S]*SECURITY DEFINER/u,
    );
    expect(migration).toMatch(
      /REVOKE ALL ON FUNCTION pgboss\.enqueue_offer_issuance\(uuid, uuid\) FROM PUBLIC[\s\S]*GRANT EXECUTE ON FUNCTION pgboss\.enqueue_offer_issuance\(uuid, uuid\) TO app_runtime/u,
    );
    for (const principal of roles) {
      expect(migration).toContain(`'${principal}'`);
    }
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*prepare_offer_issuance[\s\S]*read_offer_issuance_artifact[\s\S]*TO app_runtime/u,
    );
    expect(migration).toMatch(
      /GRANT EXECUTE ON FUNCTION[\s\S]*claim_offer_issuance_render[\s\S]*list_offer_issuance_recovery_workspaces[\s\S]*TO app_worker/u,
    );
  });

  it("bindet alle vor-ausgestellten Bytes an den bestehenden Offer-Erasuregraphen", async () => {
    const routines = await testPool.query<{ proname: string; source: string }>(`
      select routine.proname, routine.prosrc as source
        from pg_catalog.pg_proc as routine
       where routine.oid = any(array[
         'public.guard_erasure_tombstone_worm()'::regprocedure,
         'public.build_inactive_lead_erasure_graph(uuid,uuid)'::regprocedure,
         'public.build_inactive_lead_erasure_graph_m203b1(uuid,uuid)'::regprocedure,
         'public.erase_inactive_lead(uuid,uuid,uuid)'::regprocedure
       ]::oid[])
       order by routine.proname
    `);
    const byName = new Map(routines.rows.map((row) => [row.proname, row.source]));
    expect(byName.get("guard_erasure_tombstone_worm")).toMatch(
      /offerIssuanceIds[\s\S]*offerIssuanceApprovalIds[\s\S]*offerIssuanceWithdrawalIds/u,
    );
    expect(byName.get("build_inactive_lead_erasure_graph")).toContain(
      "build_inactive_lead_erasure_graph_m204",
    );
    const graphSource = byName.get("build_inactive_lead_erasure_graph_m203b1");
    for (const binding of [
      "offerIssuanceIds",
      "offerIssuanceApprovalIds",
      "offerIssuanceWithdrawalIds",
      "public.offer_issuance AS issuance",
      "public.offer_issuance_approval AS approval",
      "public.offer_issuance_withdrawal AS withdrawal",
    ]) {
      expect(graphSource).toContain(binding);
    }
    expect(byName.get("erase_inactive_lead")).toMatch(
      /offerIssuanceIds[\s\S]*erasure_worker_active[\s\S]*DELETE FROM public\.offer_issuance_approval[\s\S]*DELETE FROM public\.offer_issuance_withdrawal[\s\S]*DELETE FROM public\.offer_issuance/u,
    );

    const privileges = await testPool.query<{
      erase_execute: boolean;
      issuance_table_write: boolean;
    }>(`
      select pg_catalog.has_function_privilege(
               'app_erasure',
               'public.erase_inactive_lead(uuid,uuid,uuid)',
               'EXECUTE'
             ) as erase_execute,
             pg_catalog.has_table_privilege(
               'app_erasure', 'public.offer_issuance',
               'INSERT,UPDATE,DELETE,TRUNCATE'
             ) as issuance_table_write
    `);
    expect(privileges.rows).toEqual([{
      erase_execute: true,
      issuance_table_write: false,
    }]);
  });
});
