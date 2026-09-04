import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgBoss } from "pg-boss";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyRoleContract } from "../../scripts/db-role-contract.mjs";
import {
  CATALOG_IMPORT_CLEANUP_QUEUE_OPTIONS,
  CATALOG_IMPORT_QUEUE_OPTIONS,
  CUSTOMER_NOTIFICATION_QUEUE_OPTIONS,
  OFFER_ISSUANCE_QUEUE_OPTIONS,
  OFFER_PDF_QUEUE_OPTIONS,
  OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS,
} from "../../scripts/pgboss-bootstrap.mjs";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";

const DATABASE_NAME = "energie_saas_test";
const MIGRATOR_PASSWORD = "m115_erasure_migrator";
const WORKER_PASSWORD = "m115_erasure_worker";

function serviceUrl(
  embedded: EmbeddedTestDatabase,
  role: string,
  password: string,
): string {
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
      noinherit nosuperuser nobypassrls nocreatedb nocreaterole noreplication;
    create role app_runtime login noinherit nosuperuser nobypassrls
      nocreatedb nocreaterole noreplication;
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
  const boss = new PgBoss({ connectionString: workerUrl, schema: "pgboss", createSchema: false });
  const errors: unknown[] = [];
  boss.on("error", (error) => errors.push(error));
  try {
    await boss.start();
    await boss.createQueue("calculation.execute", {
      policy: "exclusive",
      retryLimit: 0,
      expireInSeconds: 900,
    });
    await boss.createQueue("catalog.import.v1", CATALOG_IMPORT_QUEUE_OPTIONS);
    await boss.createQueue("catalog.import.cleanup.v1", CATALOG_IMPORT_CLEANUP_QUEUE_OPTIONS);
    await boss.createQueue("pdf.render", OFFER_PDF_QUEUE_OPTIONS);
    await boss.createQueue("offer.release-candidate.render", OFFER_RELEASE_CANDIDATE_QUEUE_OPTIONS);
    await boss.createQueue("offer-issuance.render.v1", OFFER_ISSUANCE_QUEUE_OPTIONS);
    await boss.createQueue("notification.customer", CUSTOMER_NOTIFICATION_QUEUE_OPTIONS);
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined);
  }
  expect(errors, `pg-boss-Bootstrap: ${errors.map(String).join(", ")}`).toEqual([]);
}

async function callAsErasure(
  admin: Pool,
  args: string[],
): Promise<string> {
  const client = await admin.connect();
  try {
    await client.query("begin");
    await client.query("set local role app_erasure");
    const placeholders = args.map((_, index) => `$${index + 1}::uuid`).join(", ");
    const result = await client.query<{ operation_id: string }>(
      `select public.erase_inactive_lead(${placeholders})::text as operation_id`,
      args,
    );
    await client.query("commit");
    return result.rows[0]!.operation_id;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

describe.sequential("M1-15 Appointment-Erasure (funktional)", () => {
  let embedded: EmbeddedTestDatabase;
  let admin: Pool;
  let ownerPool: Pool;

  beforeAll(async () => {
    embedded = await startEmbeddedPostgres();
    admin = new Pool({ connectionString: embedded.superuserUrl, max: 4 });
    await bootstrapStrictRoles(admin);
    await installPgBoss(serviceUrl(embedded, "app_worker", WORKER_PASSWORD));
    ownerPool = new Pool({
      connectionString: serviceUrl(embedded, "app_migrator", MIGRATOR_PASSWORD),
      options: "-c role=app_owner",
      max: 1,
    });
    await migrate(drizzle(ownerPool), { migrationsFolder: resolve("drizzle") });
    const owner = await ownerPool.connect();
    try {
      await applyRoleContract(owner);
    } finally {
      owner.release();
    }
  }, 180_000);

  afterAll(async () => {
    await ownerPool?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await embedded?.stop().catch(() => undefined);
  });

  it("löscht Termine und Teilnehmer bei erase_inactive_lead (kaskadierend)", async () => {
    const workspaceId = randomUUID();
    const projectId = randomUUID();
    const contactId = randomUUID();
    const siteId = randomUUID();
    const editorId = randomUUID();
    const membershipId = randomUUID();
    const operationId = randomUUID();
    const appointmentId = randomUUID();

    const seed = await admin.connect();
    try {
      await seed.query("begin");
      await seed.query(
        "select pg_catalog.set_config('app.workspace_id', $1, true)",
        [workspaceId],
      );
      await seed.query(`insert into public.workspace (id, name) values ($1::uuid, 'M1-15 Erasure')`, [workspaceId]);
      await seed.query(`insert into public.user_identity (id, email) values ($1::uuid, $2)`, [editorId, `erasure-editor-${editorId}@m115.test`]);
      await seed.query(
        `insert into public.membership (id, workspace_id, user_id, role, capabilities)
         values ($1::uuid, $2::uuid, $3::uuid, 'editor', '{}'::jsonb)`,
        [membershipId, workspaceId, editorId],
      );
      await seed.query(
        `insert into public.contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized, updated_at)
         values ($1::uuid, $2::uuid, 'ERASURE-CUSTOMER', 'Erasure', 'Customer', 'e@m115.test', 'e@m115.test', now() - interval '25 months')`,
        [contactId, workspaceId],
      );
      await seed.query(
        `insert into public.site (id, workspace_id, contact_id, label, updated_at)
         values ($1::uuid, $2::uuid, $3::uuid, 'Erasure Site', now() - interval '25 months')`,
        [siteId, workspaceId, contactId],
      );
      await seed.query(
        `insert into public.project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key, updated_at)
         select $1::uuid, $2::uuid, $3::uuid, $4::uuid, board.id, intake.id, 'Erasure Project', 'manual', now() - interval '25 months'
           from public.kanban_board board
           join public.kanban_column intake
             on intake.workspace_id = board.workspace_id and intake.board_id = board.id
            and intake.is_intake = true and intake.archived_at is null
          where board.workspace_id = $2::uuid and board.scope = 'residential'
            and board.is_default = true and board.archived_at is null`,
        [projectId, workspaceId, contactId, siteId],
      );
      await seed.query(
        "select pg_catalog.set_config('app.actor_id', $1, true)",
        [editorId],
      );
      await seed.query(
        `insert into public.calendar (id, workspace_id, name, calendar_type, created_by)
         values ($1::uuid, $2::uuid, 'Erasure Calendar', 'tenancy', $3::uuid)`,
        [randomUUID(), workspaceId, editorId],
      );
      await seed.query(
        `insert into public.project_appointment (id, workspace_id, project_id, title, start_at, end_at, appointment_type, revision, calendar_id, created_by)
         select $1::uuid, $2::uuid, $3::uuid, 'Zu löschen', now(), now() + interval '1 hour', 'phone', 1, calendar_record.id, $4::uuid
           from public.calendar calendar_record
          where calendar_record.workspace_id = $2::uuid and calendar_record.name = 'Erasure Calendar'
          limit 1`,
        [appointmentId, workspaceId, projectId, editorId],
      );
      await seed.query(
        `insert into public.project_appointment_attendee (workspace_id, appointment_id, membership_id)
         values ($1::uuid, $2::uuid, $3::uuid)`,
        [workspaceId, appointmentId, membershipId],
      );
      await seed.query("commit");
    } finally {
      seed.release();
    }

    await callAsErasure(admin, [workspaceId, contactId, operationId]);

    const appt = await admin.query<{ n: number }>(
      `select count(*)::int as n from public.project_appointment where workspace_id = $1::uuid`,
      [workspaceId],
    );
    const att = await admin.query<{ n: number }>(
      `select count(*)::int as n from public.project_appointment_attendee where workspace_id = $1::uuid`,
      [workspaceId],
    );
    const tomb = await admin.query<{ graph_ids: unknown }>(
      `select graph_ids from public.erasure_tombstone where operation_id = $1::uuid`,
      [operationId],
    );
    expect(appt.rows[0]!.n).toBe(0);
    expect(att.rows[0]!.n).toBe(0);
    expect(JSON.stringify(tomb.rows[0]?.graph_ids)).toContain(appointmentId);
  });
});
