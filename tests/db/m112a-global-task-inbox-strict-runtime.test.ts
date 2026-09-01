import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { applyRoleContract } from "../../scripts/db-role-contract.mjs";
import { bootstrapCalculationQueue } from "../../scripts/pgboss-bootstrap.mjs";
import { withAuthorizedTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  getGlobalTaskInboxPage,
  GLOBAL_TASK_INBOX_QUERY_VERSION,
  GLOBAL_TASK_INBOX_TIME_ZONE,
  type GlobalTaskInboxPageV1,
} from "@/modules/tasks";
import {
  startEmbeddedPostgres,
  type EmbeddedTestDatabase,
} from "../setup/embedded-postgres";

// ═══════════════════════════════════════════════════════════════════════
// M1-12a unter der echten, nicht besitzenden app_runtime-Rolle.
//
// Die reguläre Suite läuft über die historische Ein-Rollen-Testverbindung.
// Damit ist NICHT belegt, dass die Inbox auch dann funktioniert, wenn der
// Prozess weder Tabelleneigentümer noch Mitglied von app_owner ist und alle
// RESTRICTIVE Actor-Policies wirklich greifen. Zusätzlich prüft diese Suite
// zwei Funktionen, die der Inbox-Slice neu in den Leseweg gebracht hat:
// `normalize(..., NFKC)` und `jsonb_path_query`. Beide müssen unter der
// restriktiven Rolle ausführbar bleiben.
// ═══════════════════════════════════════════════════════════════════════

const DATABASE_NAME = "energie_saas_test";
const MIGRATOR_PASSWORD = "m112a_strict_migrator";
const RUNTIME_PASSWORD = "m112a_strict_runtime";
const WORKER_PASSWORD = "m112a_strict_worker";

const BODY_NEEDLE = "STRICTBESCHREIBUNG Zwoelf";
const DECOMPOSED_TITLE = "STRICT Mängelliste";

type Tenant = Readonly<{
  workspaceId: string;
  projectId: string;
  editorId: string;
  editorMembershipId: string;
  externalId: string;
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
  await bootstrapCalculationQueue(serviceUrl(embedded, "app_worker", WORKER_PASSWORD));
}

async function adminTransaction<T>(
  admin: Pool,
  workspaceId: string,
  actorId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await admin.connect();
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

async function seedTenant(admin: Pool, label: string): Promise<Tenant> {
  const tenant: Tenant = {
    workspaceId: randomUUID(),
    projectId: randomUUID(),
    editorId: randomUUID(),
    editorMembershipId: randomUUID(),
    externalId: randomUUID(),
  };
  const contactId = randomUUID();
  const siteId = randomUUID();
  const externalMembershipId = randomUUID();

  await adminTransaction(admin, tenant.workspaceId, "", async (client) => {
    await client.query(
      "insert into public.workspace (id, name) values ($1, $2)",
      [tenant.workspaceId, `M1-12a Strict ${label}`],
    );
    await client.query(
      "insert into public.user_identity (id, email) values ($1, $2), ($3, $4)",
      [
        tenant.editorId,
        `${tenant.editorId}@m112a-strict.test`,
        tenant.externalId,
        `${tenant.externalId}@m112a-strict.test`,
      ],
    );
    await client.query(
      `insert into public.membership (id, workspace_id, user_id, role, capabilities)
       values ($1, $2, $3, 'editor', '{}'::jsonb),
              ($4, $2, $5, 'editor', '{"external_only":true}'::jsonb)`,
      [
        tenant.editorMembershipId,
        tenant.workspaceId,
        tenant.editorId,
        externalMembershipId,
        tenant.externalId,
      ],
    );
    await client.query(
      `insert into public.contact (
         id, workspace_id, display_name, email_primary, email_normalized
       ) values ($1, $2, 'Strict Kontakt', $3, $3)`,
      [contactId, tenant.workspaceId, `c-${contactId}@m112a-strict.test`],
    );
    await client.query(
      `insert into public.site (id, workspace_id, contact_id, label)
       values ($1, $2, $3, 'Strict Site')`,
      [siteId, tenant.workspaceId, contactId],
    );
    await client.query(
      `insert into public.project (
         id, workspace_id, contact_id, site_id, kanban_board_id,
         kanban_column_id, name, source_key
       )
       select $1, $2, $3, $4, board.id, intake.id, $5, 'manual'
         from public.kanban_board board
         join public.kanban_column intake
           on intake.workspace_id = board.workspace_id
          and intake.board_id = board.id and intake.is_intake = true
          and intake.archived_at is null
        where board.workspace_id = $2 and board.scope = 'residential'
          and board.is_default = true and board.archived_at is null`,
      [tenant.projectId, tenant.workspaceId, contactId, siteId, `Strict Projekt ${label}`],
    );
  });

  await adminTransaction(
    admin,
    tenant.workspaceId,
    tenant.editorId,
    async (client) => {
      await client.query(
        `insert into public.project_task (
           id, workspace_id, project_id, title, body_version, body, due_at,
           status, revision, created_by, updated_by
         ) values
           ($1, $2, $3, $4, 'task-rich-text.v1',
             jsonb_build_object('type','doc','content', jsonb_build_array(
               jsonb_build_object('type','paragraph','content', jsonb_build_array(
                 jsonb_build_object('type','text','text', $5::text)
               ))
             )),
             null, 'open', 1, $6, $6),
           ($7, $2, $3, $8, 'task-rich-text.v1',
             '{"type":"doc","content":[]}'::jsonb,
             null, 'open', 1, $6, $6)`,
        [
          randomUUID(),
          tenant.workspaceId,
          tenant.projectId,
          `STRICT ${label} Beschreibungstraeger`,
          BODY_NEEDLE,
          tenant.editorId,
          randomUUID(),
          DECOMPOSED_TITLE,
        ],
      );
    },
  );

  return tenant;
}

function query(partial: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: GLOBAL_TASK_INBOX_QUERY_VERSION,
    filter: "all",
    state: "open",
    dueBucket: "any",
    query: "",
    timeZone: GLOBAL_TASK_INBOX_TIME_ZONE,
    asOf: null,
    cursor: null,
    ...partial,
  };
}

describe.sequential("M1-12a Aufgaben-Inbox unter strikter app_runtime-Rolle", () => {
  let embedded: EmbeddedTestDatabase | undefined;
  let admin: Pool | undefined;
  let migrator: Pool | undefined;
  let runtime: Pool | undefined;
  let home: Tenant;
  let foreign: Tenant;

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
    home = await seedTenant(admin, "Heim");
    foreign = await seedTenant(admin, "Fremd");
  }, 180_000);

  afterAll(async () => {
    await runtime?.end().catch(() => undefined);
    await migrator?.end().catch(() => undefined);
    await admin?.end().catch(() => undefined);
    await embedded?.stop().catch(() => undefined);
  });

  it("läuft wirklich als nicht besitzende, nicht privilegierte Rolle", async () => {
    if (!runtime) throw new Error("Strict-Runtime-Fixture fehlt.");
    const identity = await runtime.query<{
      currentUser: string;
      ownerMember: boolean;
      taskOwner: string;
      bypassrls: boolean;
      superuser: boolean;
    }>(`
      select current_user as "currentUser",
             pg_catalog.pg_has_role(current_user, 'app_owner', 'member') as "ownerMember",
             pg_catalog.pg_get_userbyid(relation.relowner) as "taskOwner",
             role_record.rolbypassrls as "bypassrls",
             role_record.rolsuper as "superuser"
        from pg_catalog.pg_class as relation
        join pg_catalog.pg_roles as role_record on role_record.rolname = current_user
       where relation.oid = 'public.project_task'::regclass
    `);
    expect(identity.rows).toEqual([{
      currentUser: "app_runtime",
      ownerMember: false,
      taskOwner: "app_owner",
      bypassrls: false,
      superuser: false,
    }]);
  });

  it("liefert dem internen Editor genau die Aufgaben des eigenen Workspace", async () => {
    if (!runtime) throw new Error("Strict-Runtime-Fixture fehlt.");
    const page: GlobalTaskInboxPageV1 = await withAuthorizedTenantOn(
      runtime,
      home.editorId,
      home.workspaceId,
      (tx, ctx) => getGlobalTaskInboxPage(tx, ctx, query()),
    );
    expect(page.items).toHaveLength(2);
    expect(page.items.every((item) => item.project.id === home.projectId)).toBe(true);
    expect(JSON.stringify(page)).not.toContain("Fremd");
  });

  it("führt `normalize(..., NFKC)` unter app_runtime aus und findet dekomponiert", async () => {
    if (!runtime) throw new Error("Strict-Runtime-Fixture fehlt.");
    const page = await withAuthorizedTenantOn(
      runtime,
      home.editorId,
      home.workspaceId,
      (tx, ctx) => getGlobalTaskInboxPage(tx, ctx, query({ query: "STRICT Mängelliste" })),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toBe(DECOMPOSED_TITLE);
  });

  it("führt `jsonb_path_query` unter app_runtime aus und findet den Beschreibungstext", async () => {
    if (!runtime) throw new Error("Strict-Runtime-Fixture fehlt.");
    const page = await withAuthorizedTenantOn(
      runtime,
      home.editorId,
      home.workspaceId,
      (tx, ctx) => getGlobalTaskInboxPage(tx, ctx, query({ query: "STRICTBESCHREIBUNG" })),
    );
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.title).toContain("Beschreibungstraeger");
    expect(JSON.stringify(page)).not.toContain(BODY_NEEDLE);
  });

  it("bleibt für Fremdtenant und External auch unter app_runtime fail-closed", async () => {
    if (!runtime) throw new Error("Strict-Runtime-Fixture fehlt.");
    expect(await rejected(withAuthorizedTenantOn(
      runtime,
      home.editorId,
      foreign.workspaceId,
      (tx, ctx) => getGlobalTaskInboxPage(tx, ctx, query()),
    ))).toBeInstanceOf(PermissionDeniedError);

    expect(await rejected(withAuthorizedTenantOn(
      runtime,
      home.externalId,
      home.workspaceId,
      (tx, ctx) => getGlobalTaskInboxPage(tx, ctx, query()),
    ))).toBeInstanceOf(PermissionDeniedError);
  });

  it("lässt RLS und die RESTRICTIVE Actor-Policy wirklich greifen", async () => {
    if (!runtime) throw new Error("Strict-Runtime-Fixture fehlt.");
    const client = await runtime.connect();
    try {
      await client.query("begin");
      // Nur der Workspace ist gesetzt, kein Actor: die RESTRICTIVE
      // Actor-Select-Policy muss jede Zeile zurückhalten.
      await client.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', '', true)`,
        [home.workspaceId],
      );
      const withoutActor = await client.query<{ count: string }>(
        "select count(*)::text as count from public.project_task",
      );
      expect(withoutActor.rows[0]?.count).toBe("0");

      await client.query(
        "select pg_catalog.set_config('app.actor_id', $1, true)",
        [home.editorId],
      );
      const withActor = await client.query<{ count: string }>(
        "select count(*)::text as count from public.project_task",
      );
      expect(withActor.rows[0]?.count).toBe("2");

      // Fremder Workspace im selben Prozess: Tenant-Isolation trennt hart.
      await client.query(
        `select pg_catalog.set_config('app.workspace_id', $1, true),
                pg_catalog.set_config('app.actor_id', $2, true)`,
        [foreign.workspaceId, home.editorId],
      );
      const crossTenant = await client.query<{ count: string }>(
        "select count(*)::text as count from public.project_task",
      );
      expect(crossTenant.rows[0]?.count).toBe("0");
      await client.query("commit");
    } finally {
      client.release();
    }
  });
});
