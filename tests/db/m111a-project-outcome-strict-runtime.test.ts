import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyRoleContract } from "../../scripts/db-role-contract.mjs";
import { bootstrapCalculationQueue } from "../../scripts/pgboss-bootstrap.mjs";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";

const DATABASE_NAME = "energie_saas_test";
const MIGRATOR_PASSWORD = "m111a_strict_migrator";
const RUNTIME_PASSWORD = "m111a_strict_runtime";
const WORKER_PASSWORD = "m111a_strict_worker";

type Fixture = Readonly<{
  workspaceId: string;
  adminId: string;
  editorId: string;
  reasonId: string;
  activeProjectId: string;
  erasedContactId: string;
  erasedWonProjectId: string;
  erasedLostProjectId: string;
  erasedReopenProjectId: string;
}>;

type EvidenceSnapshot = Readonly<{
  outcome: string;
  outcomeRevision: number;
  wonEvents: number;
  lostEvents: number;
  reopenedEvents: number;
  audits: number;
}>;

function serviceUrl(
  embedded: EmbeddedTestDatabase,
  role: "app_migrator" | "app_runtime" | "app_worker",
  password: string,
): string {
  const url = new URL(embedded.url);
  url.username = role;
  url.password = password;
  return url.toString();
}

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function rejected(work: Promise<unknown>): Promise<unknown> {
  const error = await work.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).not.toBeNull();
  return error;
}

async function bootstrapStrictRoles(
  embedded: EmbeddedTestDatabase,
  admin: Pool,
): Promise<void> {
  await admin.query(`
    create role app_owner nologin noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
    create role app_migrator login password '${MIGRATOR_PASSWORD}'
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
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
    revoke app_membership_writer from app_test;
    revoke all privileges on database ${DATABASE_NAME} from app_test;
    grant connect on database ${DATABASE_NAME}
      to app_migrator, app_runtime, app_worker;
    alter schema public owner to app_owner;
    revoke all on schema public from public, app_test;
    create schema pgboss authorization app_worker;
  `);
  await bootstrapCalculationQueue(serviceUrl(
    embedded,
    "app_worker",
    WORKER_PASSWORD,
  ));
}

async function runtimeTransaction<T>(
  runtime: Pool,
  workspaceId: string,
  actorId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await runtime.connect();
  try {
    await client.query("begin");
    await client.query("set local transaction isolation level read committed");
    await client.query(
      `select pg_catalog.set_config('app.workspace_id', $1, true),
              pg_catalog.set_config('app.actor_id', $2, true)`,
      [workspaceId, actorId],
    );
    const value = await work(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function seedFixture(admin: Pool): Promise<Fixture> {
  const fixture: Fixture = {
    workspaceId: randomUUID(),
    adminId: randomUUID(),
    editorId: randomUUID(),
    reasonId: randomUUID(),
    activeProjectId: randomUUID(),
    erasedContactId: randomUUID(),
    erasedWonProjectId: randomUUID(),
    erasedLostProjectId: randomUUID(),
    erasedReopenProjectId: randomUUID(),
  };
  const activeContactId = randomUUID();
  const activeSiteId = randomUUID();
  const erasedSiteId = randomUUID();

  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query("set local transaction isolation level read committed");
    await client.query(
      `select pg_catalog.set_config('app.workspace_id', $1, true),
              pg_catalog.set_config('app.actor_id', '', true)`,
      [fixture.workspaceId],
    );
    await client.query(
      "insert into public.workspace (id, name) values ($1, 'M1-11a Strict Runtime')",
      [fixture.workspaceId],
    );
    await client.query(
      `insert into public.user_identity (id, email)
       values ($1, $2), ($3, $4)`,
      [
        fixture.adminId,
        `${fixture.adminId}@m111a-strict.test`,
        fixture.editorId,
        `${fixture.editorId}@m111a-strict.test`,
      ],
    );
    await client.query(
      `insert into public.membership (
         id, workspace_id, user_id, role, capabilities
       ) values
         ($1, $2, $3, 'admin', '{}'::jsonb),
         ($4, $2, $5, 'editor', '{}'::jsonb)`,
      [
        randomUUID(),
        fixture.workspaceId,
        fixture.adminId,
        randomUUID(),
        fixture.editorId,
      ],
    );
    await client.query(
      `insert into public.contact (
         id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
       ) values
         ($1, $2, 'Aktiver Strict Contact', 'Fixture', 'Contact', $3, $3),
         ($4, $2, 'Spaeter geloeschter Strict Contact', 'Fixture', 'Contact', $5, $5)`,
      [
        activeContactId,
        fixture.workspaceId,
        `${activeContactId}@m111a-strict.test`,
        fixture.erasedContactId,
        `${fixture.erasedContactId}@m111a-strict.test`,
      ],
    );
    await client.query(
      `insert into public.site (id, workspace_id, contact_id, label)
       values
         ($1, $2, $3, 'Aktiver Strict Standort'),
         ($4, $2, $5, 'Erasure Strict Standort')`,
      [
        activeSiteId,
        fixture.workspaceId,
        activeContactId,
        erasedSiteId,
        fixture.erasedContactId,
      ],
    );
    await client.query(
      "select pg_catalog.set_config('app.actor_id', $1, true)",
      [fixture.adminId],
    );
    await client.query(
      `insert into public.project_loss_reason (
         id, workspace_id, label, position
       ) values ($1, $2, 'Kein Budget', 1)`,
      [fixture.reasonId, fixture.workspaceId],
    );
    await client.query(
      `with target_column as (
         select board.id as board_id, intake.id as column_id
           from public.kanban_board as board
           join public.kanban_column as intake
             on intake.workspace_id = board.workspace_id
            and intake.board_id = board.id
            and intake.is_intake = true
            and intake.archived_at is null
          where board.workspace_id = $1
            and board.scope = 'residential'
            and board.is_default = true
            and board.archived_at is null
       ), project_seed(id, contact_id, site_id, name, source_key) as (
         values
           ($2::uuid, $3::uuid, $4::uuid, 'Aktiver Outcome-Pfad'::text, $5::text),
           ($6::uuid, $7::uuid, $8::uuid, 'Erasure Won blockiert'::text, $9::text),
           ($10::uuid, $7::uuid, $8::uuid, 'Erasure Lost blockiert'::text, $11::text),
           ($12::uuid, $7::uuid, $8::uuid, 'Erasure Reopen blockiert'::text, $13::text)
       )
       insert into public.project (
         id, workspace_id, contact_id, site_id, kanban_board_id,
         kanban_column_id, name, phase, outcome, source_key
       )
       select project_seed.id, $1, project_seed.contact_id, project_seed.site_id,
              target_column.board_id, target_column.column_id, project_seed.name,
              'request', 'open', project_seed.source_key
         from project_seed cross join target_column`,
      [
        fixture.workspaceId,
        fixture.activeProjectId,
        activeContactId,
        activeSiteId,
        `m111a-strict-${fixture.activeProjectId}`,
        fixture.erasedWonProjectId,
        fixture.erasedContactId,
        erasedSiteId,
        `m111a-strict-${fixture.erasedWonProjectId}`,
        fixture.erasedLostProjectId,
        `m111a-strict-${fixture.erasedLostProjectId}`,
        fixture.erasedReopenProjectId,
        `m111a-strict-${fixture.erasedReopenProjectId}`,
      ],
    );
    await client.query("commit");
    return fixture;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function snapshot(
  admin: Pool,
  workspaceId: string,
  projectId: string,
): Promise<EvidenceSnapshot> {
  const result = await admin.query<EvidenceSnapshot>(
    `select project_record.outcome,
            project_record.outcome_revision as "outcomeRevision",
            (select count(*)::int from public.domain_events as event
              where event.workspace_id = project_record.workspace_id
                and event.aggregate_id = project_record.id
                and event.event_type = 'project.outcome_won') as "wonEvents",
            (select count(*)::int from public.domain_events as event
              where event.workspace_id = project_record.workspace_id
                and event.aggregate_id = project_record.id
                and event.event_type = 'project.outcome_lost') as "lostEvents",
            (select count(*)::int from public.domain_events as event
              where event.workspace_id = project_record.workspace_id
                and event.aggregate_id = project_record.id
                and event.event_type = 'project.outcome_reopened') as "reopenedEvents",
            (select count(*)::int from public.audit_log as audit
              where audit.workspace_id = project_record.workspace_id
                and audit.action = 'project.outcome.write'
                and audit.details->>'projectId' = project_record.id::text) as audits
       from public.project as project_record
      where project_record.workspace_id = $1 and project_record.id = $2`,
    [workspaceId, projectId],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Strict-Runtime-Project fehlt.");
  return row;
}

describe.sequential("M1-11a Project-Outcome unter strikter app_runtime-Rolle", () => {
  let embedded: EmbeddedTestDatabase | undefined;
  let admin: Pool | undefined;
  let migrator: Pool | undefined;
  let runtime: Pool | undefined;
  let fixture: Fixture;

  beforeAll(async () => {
    embedded = await startEmbeddedPostgres();
    admin = new Pool({ connectionString: embedded.superuserUrl, max: 3 });
    await bootstrapStrictRoles(embedded, admin);
    migrator = new Pool({
      connectionString: serviceUrl(embedded, "app_migrator", MIGRATOR_PASSWORD),
      options: "-c role=app_owner",
      max: 1,
    });
    await migrate(drizzle(migrator), { migrationsFolder: resolve("drizzle") });
    const owner = await migrator.connect();
    try {
      await applyRoleContract(owner);
    } finally {
      owner.release();
    }
    runtime = new Pool({
      connectionString: serviceUrl(embedded, "app_runtime", RUNTIME_PASSWORD),
      max: 2,
    });
    fixture = await seedFixture(admin);
  }, 180_000);

  afterAll(async () => {
    await runtime?.end().catch(() => undefined);
    await migrator?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await embedded?.stop().catch(() => undefined);
  });

  it("erlaubt dem echten non-owner Editor Won, Reopen und Lost mit je exakt einer Evidenz", async () => {
    if (!runtime || !admin) throw new Error("Strict-Runtime-Fixture fehlt.");
    const identity = await runtime.query<{
      currentUser: string;
      sessionUser: string;
      ownerMember: boolean;
      projectOwner: string;
    }>(`
      select current_user as "currentUser", session_user as "sessionUser",
             pg_catalog.pg_has_role(current_user, 'app_owner', 'member') as "ownerMember",
             pg_catalog.pg_get_userbyid(relation.relowner) as "projectOwner"
        from pg_catalog.pg_class as relation
       where relation.oid = 'public.project'::regclass
    `);
    expect(identity.rows).toEqual([{
      currentUser: "app_runtime",
      sessionUser: "app_runtime",
      ownerMember: false,
      projectOwner: "app_owner",
    }]);

    await runtimeTransaction(runtime, fixture.workspaceId, fixture.editorId, (client) =>
      client.query(
        `update public.project
            set outcome = 'won', outcome_revision = 1,
                closed_at = transaction_timestamp(),
                loss_reason_id = null, loss_reason_text = null,
                updated_at = transaction_timestamp()
          where workspace_id = $1 and id = $2
            and phase = 'request' and outcome = 'open' and outcome_revision = 0`,
        [fixture.workspaceId, fixture.activeProjectId],
      ));
    expect(await snapshot(admin, fixture.workspaceId, fixture.activeProjectId)).toEqual({
      outcome: "won",
      outcomeRevision: 1,
      wonEvents: 1,
      lostEvents: 0,
      reopenedEvents: 0,
      audits: 1,
    });

    await runtimeTransaction(runtime, fixture.workspaceId, fixture.editorId, (client) =>
      client.query(
        `update public.project
            set outcome = 'open', outcome_revision = 2, closed_at = null,
                loss_reason_id = null, loss_reason_text = null,
                updated_at = transaction_timestamp()
          where workspace_id = $1 and id = $2
            and phase = 'request' and outcome = 'won' and outcome_revision = 1`,
        [fixture.workspaceId, fixture.activeProjectId],
      ));
    expect(await snapshot(admin, fixture.workspaceId, fixture.activeProjectId)).toEqual({
      outcome: "open",
      outcomeRevision: 2,
      wonEvents: 1,
      lostEvents: 0,
      reopenedEvents: 1,
      audits: 2,
    });

    await runtimeTransaction(runtime, fixture.workspaceId, fixture.editorId, (client) =>
      client.query(
        `update public.project
            set outcome = 'lost', outcome_revision = 3,
                closed_at = transaction_timestamp(), loss_reason_id = $3,
                loss_reason_text = 'Kunde wartet',
                updated_at = transaction_timestamp()
          where workspace_id = $1 and id = $2
            and phase = 'request' and outcome = 'open' and outcome_revision = 2`,
        [fixture.workspaceId, fixture.activeProjectId, fixture.reasonId],
      ));
    expect(await snapshot(admin, fixture.workspaceId, fixture.activeProjectId)).toEqual({
      outcome: "lost",
      outcomeRevision: 3,
      wonEvents: 1,
      lostEvents: 1,
      reopenedEvents: 1,
      audits: 3,
    });
  });

  it("hält den Erasure-Helfer für app_runtime katalogseitig und praktisch privat", async () => {
    if (!runtime || !admin) throw new Error("Strict-Runtime-Fixture fehlt.");
    const privilege = await admin.query<{ runtimeExecute: boolean }>(`
      select pg_catalog.has_function_privilege(
               'app_runtime',
               'public._m111a_erasure_scrub_allowed(uuid,uuid)',
               'EXECUTE'
             ) as "runtimeExecute"
    `);
    expect(privilege.rows).toEqual([{ runtimeExecute: false }]);

    const directCall = await rejected(runtimeTransaction(
      runtime,
      fixture.workspaceId,
      fixture.editorId,
      (client) => client.query(
        "select public._m111a_erasure_scrub_allowed($1, $2)",
        [fixture.workspaceId, fixture.activeProjectId],
      ),
    ));
    expect(postgresCode(directCall)).toBe("42501");
  });

  it("blockiert nach Contact-Erasure Won, Lost und Reopen ohne neuen State oder Evidenz", async () => {
    if (!runtime || !admin) throw new Error("Strict-Runtime-Fixture fehlt.");

    await runtimeTransaction(runtime, fixture.workspaceId, fixture.editorId, (client) =>
      client.query(
        `update public.project
            set outcome = 'won', outcome_revision = 1,
                closed_at = transaction_timestamp(),
                loss_reason_id = null, loss_reason_text = null,
                updated_at = transaction_timestamp()
          where workspace_id = $1 and id = $2
            and phase = 'request' and outcome = 'open' and outcome_revision = 0`,
        [fixture.workspaceId, fixture.erasedReopenProjectId],
      ));

    const before = new Map<string, EvidenceSnapshot>();
    for (const projectId of [
      fixture.erasedWonProjectId,
      fixture.erasedLostProjectId,
      fixture.erasedReopenProjectId,
    ]) {
      before.set(projectId, await snapshot(admin, fixture.workspaceId, projectId));
    }

    const erasure = await admin.connect();
    try {
      await erasure.query("begin");
      await erasure.query(
        `update public.project
            set name = 'geloescht-' || id::text,
                dedupe_review_required = false,
                updated_at = transaction_timestamp()
          where workspace_id = $1 and contact_id = $2`,
        [fixture.workspaceId, fixture.erasedContactId],
      );
      await erasure.query(
        `update public.contact
            set display_name = 'geloescht-' || id::text,
                email_primary = null, email_normalized = null,
                phone_raw = null, phone_e164 = null,
                marketing_consent = false, marketing_consent_at = null,
                marketing_consent_source = null,
                dedupe_review_required = false,
                deleted_at = transaction_timestamp(),
                updated_at = transaction_timestamp()
          where workspace_id = $1 and id = $2`,
        [fixture.workspaceId, fixture.erasedContactId],
      );
      await erasure.query("commit");
    } catch (error) {
      await erasure.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      erasure.release();
    }

    const deletedContact = await admin.query<{ deleted: boolean }>(
      `select deleted_at is not null as deleted
         from public.contact where workspace_id = $1 and id = $2`,
      [fixture.workspaceId, fixture.erasedContactId],
    );
    expect(deletedContact.rows).toEqual([{ deleted: true }]);

    const wonFailure = await rejected(runtimeTransaction(
      runtime,
      fixture.workspaceId,
      fixture.editorId,
      (client) => client.query(
        `update public.project
            set outcome = 'won', outcome_revision = 1,
                closed_at = transaction_timestamp(),
                loss_reason_id = null, loss_reason_text = null,
                updated_at = transaction_timestamp()
          where workspace_id = $1 and id = $2
            and phase = 'request' and outcome = 'open' and outcome_revision = 0`,
        [fixture.workspaceId, fixture.erasedWonProjectId],
      ),
    ));
    expect(postgresCode(wonFailure)).toBe("23514");

    const lostFailure = await rejected(runtimeTransaction(
      runtime,
      fixture.workspaceId,
      fixture.editorId,
      (client) => client.query(
        `update public.project
            set outcome = 'lost', outcome_revision = 1,
                closed_at = transaction_timestamp(), loss_reason_id = $3,
                loss_reason_text = 'Darf nicht persistieren',
                updated_at = transaction_timestamp()
          where workspace_id = $1 and id = $2
            and phase = 'request' and outcome = 'open' and outcome_revision = 0`,
        [fixture.workspaceId, fixture.erasedLostProjectId, fixture.reasonId],
      ),
    ));
    expect(postgresCode(lostFailure)).toBe("23514");

    const reopenFailure = await rejected(runtimeTransaction(
      runtime,
      fixture.workspaceId,
      fixture.editorId,
      (client) => client.query(
        `update public.project
            set outcome = 'open', outcome_revision = 2, closed_at = null,
                loss_reason_id = null, loss_reason_text = null,
                updated_at = transaction_timestamp()
          where workspace_id = $1 and id = $2
            and phase = 'request' and outcome = 'won' and outcome_revision = 1`,
        [fixture.workspaceId, fixture.erasedReopenProjectId],
      ),
    ));
    expect(postgresCode(reopenFailure)).toBe("23514");

    for (const [projectId, expected] of before) {
      expect(await snapshot(admin, fixture.workspaceId, projectId)).toEqual(expected);
    }
  });
});
