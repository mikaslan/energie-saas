import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import {
  withAuthorizedTenantOn,
  withSessionTenantOn,
  withTenantOn,
} from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { testPool } from "../setup/test-db";

interface ActorRow {
  actor_id: string | null;
  backend_pid: number;
  [key: string]: unknown;
}

interface MembershipRow {
  id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  capabilities: Record<string, unknown>;
  [key: string]: unknown;
}

interface PolicyRow {
  policyname: string;
  permissive: string;
  cmd: string;
  qual: string | null;
  with_check: string | null;
  [key: string]: unknown;
}

const wsA = randomUUID();
const wsB = randomUUID();

const adminA = randomUUID();
const viewerA = randomUUID();
const editorA = randomUUID();
const crossActor = randomUUID();

const authAdminA = `auth-admin-${randomUUID()}`;
const authViewerA = `auth-viewer-${randomUUID()}`;
const authEditorA = `auth-editor-${randomUUID()}`;
const authCross = `auth-cross-${randomUUID()}`;

async function insertIdentity(id: string, authUserId: string | null = null): Promise<void> {
  await withTenantOn(testPool, wsA, (tx) =>
    tx.execute(sql`
      insert into user_identity (id, email, auth_user_id)
      values (${id}::uuid, ${`${id}@membership.test`}, ${authUserId})
    `),
  );
}

async function insertMembership(
  workspaceId: string,
  userId: string,
  role: "viewer" | "editor" | "admin",
): Promise<void> {
  await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute(sql`
      insert into membership (workspace_id, user_id, role)
      values (${workspaceId}::uuid, ${userId}::uuid, ${role})
    `),
  );
}

async function newMember(
  workspaceId: string,
  role: "viewer" | "editor" | "admin" = "viewer",
): Promise<string> {
  const id = randomUUID();
  await insertIdentity(id);
  await insertMembership(workspaceId, id, role);
  return id;
}

async function membershipOf(workspaceId: string, userId: string): Promise<MembershipRow | undefined> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<MembershipRow>(sql`
      select id, workspace_id, user_id, role, capabilities
      from membership
      where workspace_id = ${workspaceId}::uuid and user_id = ${userId}::uuid
    `);
    return result.rows[0];
  });
}

function postgresCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === "string") return value.code;
    current = value.cause;
  }
  return undefined;
}

async function expectInsufficientPrivilege(operation: Promise<unknown>): Promise<void> {
  await expectPostgresCode(operation, "42501");
}

async function expectPostgresCode(operation: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect(postgresCode(caught)).toBe(code);
}

function twoPartyBarrier(): () => Promise<void> {
  let arrivals = 0;
  let release!: () => void;
  const bothArrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals += 1;
    if (arrivals === 2) release();
    await bothArrived;
  };
}

beforeAll(async () => {
  await withTenantOn(testPool, wsA, (tx) =>
    tx.execute(sql`insert into workspace (id, name) values (${wsA}::uuid, 'membership-a')`),
  );
  await withTenantOn(testPool, wsB, (tx) =>
    tx.execute(sql`insert into workspace (id, name) values (${wsB}::uuid, 'membership-b')`),
  );

  await insertIdentity(adminA, authAdminA);
  await insertIdentity(viewerA, authViewerA);
  await insertIdentity(editorA, authEditorA);
  await insertIdentity(crossActor, authCross);

  await insertMembership(wsA, adminA, "admin");
  await insertMembership(wsA, viewerA, "viewer");
  await insertMembership(wsA, editorA, "editor");
  await insertMembership(wsA, crossActor, "admin");
  await insertMembership(wsB, crossActor, "viewer");
});

describe("app.actor_id — verifizierter und transaktionslokaler Kontext", () => {
  it("ist auf dem Systempfad NULL", async () => {
    const row = await withTenantOn(testPool, wsA, async (tx) => {
      const result = await tx.execute<ActorRow>(sql`
        select public.app_actor_id() as actor_id, pg_backend_pid()::int as backend_pid
      `);
      return result.rows[0];
    });
    expect(row.actor_id).toBeNull();
  });

  it("trägt auf Session- und Trusted-Adapter-Pfad die verifizierte user_identity.id", async () => {
    const sessionActor = await withSessionTenantOn(testPool, authAdminA, wsA, async (tx) => {
      const result = await tx.execute<ActorRow>(sql`
        select public.app_actor_id() as actor_id, pg_backend_pid()::int as backend_pid
      `);
      return result.rows[0].actor_id;
    });
    const adapterActor = await withAuthorizedTenantOn(testPool, adminA, wsA, async (tx) => {
      const result = await tx.execute<ActorRow>(sql`
        select public.app_actor_id() as actor_id, pg_backend_pid()::int as backend_pid
      `);
      return result.rows[0].actor_id;
    });
    expect(sessionActor).toBe(adminA);
    expect(adapterActor).toBe(adminA);
    expect(sessionActor).not.toBe(authAdminA);
  });

  it("setzt bei fehlgeschlagener Membership-Auflösung keinen Actor", async () => {
    const pool = new Pool({ connectionString: process.env.POSTGRES_URL_TEST, max: 1 });
    try {
      await expect(
        withSessionTenantOn(pool, `auth-missing-${randomUUID()}`, wsA, async () => "unreachable"),
      ).rejects.toBeInstanceOf(PermissionDeniedError);
      const result = await pool.query<ActorRow>(
        "select public.app_actor_id() as actor_id, pg_backend_pid()::int as backend_pid",
      );
      expect(result.rows[0].actor_id).toBeNull();
    } finally {
      await pool.end();
    }
  });

  it("leckt nach COMMIT nicht über dieselbe Pool-Verbindung", async () => {
    const pool = new Pool({ connectionString: process.env.POSTGRES_URL_TEST, max: 1 });
    try {
      const inside = await withSessionTenantOn(pool, authAdminA, wsA, async (tx) => {
        const result = await tx.execute<ActorRow>(sql`
          select public.app_actor_id() as actor_id, pg_backend_pid()::int as backend_pid
        `);
        return result.rows[0];
      });
      const outside = await pool.query<ActorRow>(
        "select public.app_actor_id() as actor_id, pg_backend_pid()::int as backend_pid",
      );
      expect(inside.actor_id).toBe(adminA);
      expect(outside.rows[0].backend_pid).toBe(inside.backend_pid);
      expect(outside.rows[0].actor_id).toBeNull();
    } finally {
      await pool.end();
    }
  });

  it("leckt nach ROLLBACK nicht über dieselbe Pool-Verbindung", async () => {
    const pool = new Pool({ connectionString: process.env.POSTGRES_URL_TEST, max: 1 });
    let insidePid: number | undefined;
    try {
      await expect(
        withSessionTenantOn(pool, authAdminA, wsA, async (tx) => {
          const result = await tx.execute<ActorRow>(sql`
            select public.app_actor_id() as actor_id, pg_backend_pid()::int as backend_pid
          `);
          insidePid = result.rows[0].backend_pid;
          expect(result.rows[0].actor_id).toBe(adminA);
          throw new Error("rollback-probe");
        }),
      ).rejects.toThrow("rollback-probe");
      const outside = await pool.query<ActorRow>(
        "select public.app_actor_id() as actor_id, pg_backend_pid()::int as backend_pid",
      );
      expect(outside.rows[0].backend_pid).toBe(insidePid);
      expect(outside.rows[0].actor_id).toBeNull();
    } finally {
      await pool.end();
    }
  });

  it("neutralisiert innerhalb jedes verwalteten Starts einen sessionweit vergifteten Actor", async () => {
    const pool = new Pool({ connectionString: process.env.POSTGRES_URL_TEST, max: 1 });
    const poison = randomUUID();
    try {
      await pool.query("select set_config('app.actor_id', $1, false)", [poison]);
      const systemActor = await withTenantOn(pool, wsA, async (tx) => {
        const result = await tx.execute<ActorRow>(sql`
          select public.app_actor_id() as actor_id, pg_backend_pid()::int as backend_pid
        `);
        return result.rows[0].actor_id;
      });
      const verifiedActor = await withSessionTenantOn(pool, authAdminA, wsA, async (tx) => {
        const result = await tx.execute<ActorRow>(sql`
          select public.app_actor_id() as actor_id, pg_backend_pid()::int as backend_pid
        `);
        return result.rows[0].actor_id;
      });
      expect(systemActor).toBeNull();
      expect(verifiedActor).toBe(adminA);
      expect(verifiedActor).not.toBe(poison);
    } finally {
      await pool.query("reset app.actor_id").catch(() => undefined);
      await pool.end();
    }
  });

  it("erzwingt für jeden verwalteten Tenant-Start READ COMMITTED", async () => {
    const pool = new Pool({ connectionString: process.env.POSTGRES_URL_TEST, max: 1 });
    try {
      await pool.query("set default_transaction_isolation = 'repeatable read'");
      const isolation = await withTenantOn(pool, wsA, async (tx) => {
        const result = await tx.execute<{ isolation: string; [key: string]: unknown }>(sql`
          select current_setting('transaction_isolation') as isolation
        `);
        return result.rows[0].isolation;
      });
      expect(isolation).toBe("read committed");
    } finally {
      await pool.query("reset default_transaction_isolation").catch(() => undefined);
      await pool.end();
    }
  });
});

describe("Membership-Self-DML ist fail-closed", () => {
  it("Viewer kann die eigene Rolle nicht auf admin heben", async () => {
    const changed = await withSessionTenantOn(testPool, authViewerA, wsA, async (tx) => {
      const result = await tx.execute<{ role: string; [key: string]: unknown }>(sql`
        update membership set role = 'admin'
        where workspace_id = ${wsA}::uuid and user_id = ${viewerA}::uuid
        returning role
      `);
      return result.rows;
    });
    expect(changed).toHaveLength(0);
    expect((await membershipOf(wsA, viewerA))?.role).toBe("viewer");
  });

  it("Viewer kann die eigenen Capabilities nicht ändern", async () => {
    const changed = await withSessionTenantOn(testPool, authViewerA, wsA, async (tx) => {
      const result = await tx.execute(sql`
        update membership set capabilities = '{"manage_settings":true}'::jsonb
        where workspace_id = ${wsA}::uuid and user_id = ${viewerA}::uuid
        returning id
      `);
      return result.rows;
    });
    expect(changed).toHaveLength(0);
    expect((await membershipOf(wsA, viewerA))?.capabilities).toEqual({});
  });

  it("Admin kann sich nicht selbst herabstufen oder löschen", async () => {
    const result = await withSessionTenantOn(testPool, authAdminA, wsA, async (tx) => {
      const downgrade = await tx.execute(sql`
        update membership set role = 'viewer'
        where workspace_id = ${wsA}::uuid and user_id = ${adminA}::uuid
        returning id
      `);
      const remove = await tx.execute(sql`
        delete from membership
        where workspace_id = ${wsA}::uuid and user_id = ${adminA}::uuid
        returning id
      `);
      return { downgrade: downgrade.rows, remove: remove.rows };
    });
    expect(result.downgrade).toHaveLength(0);
    expect(result.remove).toHaveLength(0);
    expect((await membershipOf(wsA, adminA))?.role).toBe("admin");
  });

  it("Actor kann weder eine zweite eigene Membership anlegen noch user_id umhängen", async () => {
    const replacement = randomUUID();
    await insertIdentity(replacement);

    await expectInsufficientPrivilege(
      withSessionTenantOn(testPool, authViewerA, wsA, (tx) =>
        tx.execute(sql`
          insert into membership (workspace_id, user_id, role)
          values (${wsA}::uuid, ${viewerA}::uuid, 'admin')
        `),
      ),
    );

    const changed = await withSessionTenantOn(testPool, authViewerA, wsA, async (tx) => {
      const result = await tx.execute(sql`
        update membership set user_id = ${replacement}::uuid
        where workspace_id = ${wsA}::uuid and user_id = ${viewerA}::uuid
        returning id
      `);
      return result.rows;
    });
    expect(changed).toHaveLength(0);
    expect(await membershipOf(wsA, viewerA)).toBeDefined();
    expect(await membershipOf(wsA, replacement)).toBeUndefined();
  });

  it("INSERT ON CONFLICT kann den Self-Schutz nicht umgehen", async () => {
    await expectInsufficientPrivilege(
      withSessionTenantOn(testPool, authViewerA, wsA, (tx) =>
        tx.execute(sql`
          insert into membership (workspace_id, user_id, role)
          values (${wsA}::uuid, ${viewerA}::uuid, 'admin')
          on conflict (workspace_id, user_id)
          do update set role = excluded.role
        `),
      ),
    );
    expect((await membershipOf(wsA, viewerA))?.role).toBe("viewer");
  });
});

describe("Membership-Fremd-DML folgt der Actor-Rolle im Ziel-Workspace", () => {
  for (const [label, authUserId] of [
    ["Viewer", authViewerA],
    ["Editor", authEditorA],
  ] as const) {
    it(`${label} darf fremde Memberships weder anlegen, ändern noch löschen`, async () => {
      const target = await newMember(wsA);
      const insertTarget = randomUUID();
      await insertIdentity(insertTarget);

      await expectInsufficientPrivilege(
        withSessionTenantOn(testPool, authUserId, wsA, (tx) =>
          tx.execute(sql`
            update membership set role = 'admin'
            where workspace_id = ${wsA}::uuid and user_id = ${target}::uuid
          `),
        ),
      );
      await expectInsufficientPrivilege(
        withSessionTenantOn(testPool, authUserId, wsA, (tx) =>
          tx.execute(sql`
            insert into membership (workspace_id, user_id, role)
            values (${wsA}::uuid, ${insertTarget}::uuid, 'admin')
          `),
        ),
      );
      await expectInsufficientPrivilege(
        withSessionTenantOn(testPool, authUserId, wsA, (tx) =>
          tx.execute(sql`
            delete from membership
            where workspace_id = ${wsA}::uuid and user_id = ${target}::uuid
          `),
        ),
      );

      expect((await membershipOf(wsA, target))?.role).toBe("viewer");
      expect(await membershipOf(wsA, insertTarget)).toBeUndefined();
    });
  }

  it("ein Viewer-Bulk-UPDATE mit eigener und fremder Zeile ist vollständig atomar", async () => {
    const target = await newMember(wsA);
    await expectInsufficientPrivilege(
      withSessionTenantOn(testPool, authViewerA, wsA, (tx) =>
        tx.execute(sql`
          update membership set role = 'admin'
          where workspace_id = ${wsA}::uuid
            and user_id in (${viewerA}::uuid, ${target}::uuid)
        `),
      ),
    );
    expect((await membershipOf(wsA, viewerA))?.role).toBe("viewer");
    expect((await membershipOf(wsA, target))?.role).toBe("viewer");
  });

  it("Admin darf fremde Membership anlegen, ändern und löschen", async () => {
    const updateTarget = await newMember(wsA);
    const deleteTarget = await newMember(wsA);
    const insertTarget = randomUUID();
    await insertIdentity(insertTarget);

    await withSessionTenantOn(testPool, authAdminA, wsA, async (tx) => {
      await tx.execute(sql`
        insert into membership (workspace_id, user_id, role)
        values (${wsA}::uuid, ${insertTarget}::uuid, 'viewer')
      `);
      await tx.execute(sql`
        update membership set role = 'editor'
        where workspace_id = ${wsA}::uuid and user_id = ${updateTarget}::uuid
      `);
      await tx.execute(sql`
        delete from membership
        where workspace_id = ${wsA}::uuid and user_id = ${deleteTarget}::uuid
      `);
    });

    expect((await membershipOf(wsA, insertTarget))?.role).toBe("viewer");
    expect((await membershipOf(wsA, updateTarget))?.role).toBe("editor");
    expect(await membershipOf(wsA, deleteTarget)).toBeUndefined();
  });

  it("Admin in A, aber Viewer in B bleibt bei Membership-DML in B Viewer", async () => {
    const targetB = await newMember(wsB);
    await expectInsufficientPrivilege(
      withSessionTenantOn(testPool, authCross, wsB, (tx) =>
        tx.execute(sql`
          update membership set role = 'admin'
          where workspace_id = ${wsB}::uuid and user_id = ${targetB}::uuid
        `),
      ),
    );
    expect((await membershipOf(wsB, targetB))?.role).toBe("viewer");
  });

  it("Actor kann den Ziel-Workspace nicht per UPDATE-Wert wechseln", async () => {
    const target = await newMember(wsA);
    await expectInsufficientPrivilege(
      withSessionTenantOn(testPool, authAdminA, wsA, (tx) =>
        tx.execute(sql`
          update membership set workspace_id = ${wsB}::uuid
          where workspace_id = ${wsA}::uuid and user_id = ${target}::uuid
        `),
      ),
    );
    expect(await membershipOf(wsA, target)).toBeDefined();
    expect(await membershipOf(wsB, target)).toBeUndefined();
  });

  for (const operation of ["löschen", "herabstufen"] as const) {
    it(`zwei Admins können sich nicht gleichzeitig gegenseitig ${operation}`, async () => {
      const workspaceId = randomUUID();
      const adminOne = randomUUID();
      const adminTwo = randomUUID();
      const authOne = `auth-concurrent-one-${randomUUID()}`;
      const authTwo = `auth-concurrent-two-${randomUUID()}`;

      await withTenantOn(testPool, workspaceId, (tx) =>
        tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'membership-concurrent')`),
      );
      await insertIdentity(adminOne, authOne);
      await insertIdentity(adminTwo, authTwo);
      await insertMembership(workspaceId, adminOne, "admin");
      await insertMembership(workspaceId, adminTwo, "admin");

      const awaitBothActors = twoPartyBarrier();
      const mutate = (authUserId: string, targetUserId: string) =>
        withSessionTenantOn(testPool, authUserId, workspaceId, async (tx) => {
          await awaitBothActors();
          return operation === "löschen"
            ? tx.execute(sql`
                delete from membership
                where workspace_id = ${workspaceId}::uuid and user_id = ${targetUserId}::uuid
              `)
            : tx.execute(sql`
                update membership set role = 'viewer'
                where workspace_id = ${workspaceId}::uuid and user_id = ${targetUserId}::uuid
              `);
        });

      const results = await Promise.allSettled([
        mutate(authOne, adminTwo),
        mutate(authTwo, adminOne),
      ]);

      const adminCount = await withTenantOn(testPool, workspaceId, async (tx) => {
        const result = await tx.execute<{ count: number; [key: string]: unknown }>(sql`
          select count(*)::int as count
          from membership
          where workspace_id = ${workspaceId}::uuid and role = 'admin'
        `);
        return result.rows[0].count;
      });
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(
        fulfilled,
        `unerwartete Ergebnisse: ${results.map((result) => result.status).join(", ")}`,
      ).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(postgresCode(rejected[0].reason)).toBe("42501");
      expect(adminCount).toBe(1);
    });
  }

  it("weist Membership-DML unter REPEATABLE READ explizit ab", async () => {
    const workspaceId = randomUUID();
    const actor = randomUUID();
    const target = randomUUID();
    await withTenantOn(testPool, workspaceId, (tx) =>
      tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'membership-isolation')`),
    );
    await insertIdentity(actor);
    await insertIdentity(target);
    await insertMembership(workspaceId, actor, "admin");
    await insertMembership(workspaceId, target, "admin");

    const client = await testPool.connect();
    try {
      await client.query("begin isolation level repeatable read");
      await client.query("select set_config('app.workspace_id', $1, true)", [workspaceId]);
      await client.query("select set_config('app.actor_id', $1, true)", [actor]);
      await expectPostgresCode(
        client.query(
          "delete from membership where workspace_id = $1::uuid and user_id = $2::uuid",
          [workspaceId, target],
        ),
        "25001",
      );
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
    expect((await membershipOf(workspaceId, target))?.role).toBe("admin");
  });
});

describe("Privilegierter Systempfad und unveränderliche Membership-Identität", () => {
  it("Systempfad darf bootstrappen, Rolle/Capabilities ändern und löschen", async () => {
    const target = randomUUID();
    await insertIdentity(target);
    await withTenantOn(testPool, wsA, async (tx) => {
      await tx.execute(sql`
        insert into membership (workspace_id, user_id, role)
        values (${wsA}::uuid, ${target}::uuid, 'viewer')
      `);
      await tx.execute(sql`
        update membership
        set role = 'admin', capabilities = '{"manage_settings":true}'::jsonb
        where workspace_id = ${wsA}::uuid and user_id = ${target}::uuid
      `);
    });
    expect((await membershipOf(wsA, target))?.role).toBe("admin");
    expect((await membershipOf(wsA, target))?.capabilities).toEqual({ manage_settings: true });

    await withTenantOn(testPool, wsA, (tx) =>
      tx.execute(sql`
        delete from membership
        where workspace_id = ${wsA}::uuid and user_id = ${target}::uuid
      `),
    );
    expect(await membershipOf(wsA, target)).toBeUndefined();
  });

  it("auch der Systempfad darf Identitätsspalten nicht umhängen", async () => {
    const target = await newMember(wsA);
    const replacement = randomUUID();
    await insertIdentity(replacement);
    await expectInsufficientPrivilege(
      withTenantOn(testPool, wsA, (tx) =>
        tx.execute(sql`
          update membership set user_id = ${replacement}::uuid
          where workspace_id = ${wsA}::uuid and user_id = ${target}::uuid
        `),
      ),
    );
    expect(await membershipOf(wsA, target)).toBeDefined();
    expect(await membershipOf(wsA, replacement)).toBeUndefined();
  });
});

describe("Datenbankvertrag für Actor-Policies und Trigger", () => {
  it("hat genau drei befehlsspezifische RESTRICTIVE Membership-Policies", async () => {
    const result = await testPool.query<PolicyRow>(`
      select policyname, permissive, cmd, qual, with_check
      from pg_policies
      where schemaname = 'public'
        and tablename = 'membership'
        and policyname like 'membership_actor_%'
      order by policyname
    `);
    expect(result.rows.map((row) => [row.policyname, row.permissive, row.cmd])).toEqual([
      ["membership_actor_delete", "RESTRICTIVE", "DELETE"],
      ["membership_actor_insert", "RESTRICTIVE", "INSERT"],
      ["membership_actor_update", "RESTRICTIVE", "UPDATE"],
    ]);
    for (const row of result.rows) {
      expect(`${row.qual ?? ""} ${row.with_check ?? ""}`).toContain("app_actor_id");
      expect(`${row.qual ?? ""} ${row.with_check ?? ""}`).toContain("user_id");
    }
  });

  it("Funktionen sind SECURITY INVOKER mit festem search_path; Trigger sind aktiv", async () => {
    const functions = await testPool.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      provolatile: string;
      [key: string]: unknown;
    }>(`
      select p.proname, p.prosecdef, p.proconfig, p.provolatile
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.proname in ('app_actor_id', 'guard_membership_dml', 'guard_membership_statement')
      order by p.proname
    `);
    expect(functions.rows.map((row) => row.proname)).toEqual([
      "app_actor_id",
      "guard_membership_dml",
      "guard_membership_statement",
    ]);
    for (const fn of functions.rows) {
      expect(fn.prosecdef, `${fn.proname} darf nicht SECURITY DEFINER sein`).toBe(false);
      expect(fn.proconfig).toContain("search_path=pg_catalog");
    }
    expect(functions.rows.map((fn) => [fn.proname, fn.provolatile])).toEqual([
      ["app_actor_id", "s"],
      ["guard_membership_dml", "v"],
      ["guard_membership_statement", "v"],
    ]);

    const trigger = await testPool.query<{
      tgenabled: string;
      definition: string;
      [key: string]: unknown;
    }>(`
      select t.tgenabled, pg_get_triggerdef(t.oid) as definition
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname = 'membership'
        and t.tgname in ('membership_dml_guard', 'membership_dml_serialize')
        and not t.tgisinternal
      order by t.tgname
    `);
    expect(trigger.rows).toHaveLength(2);
    expect(trigger.rows.every((row) => row.tgenabled === "O")).toBe(true);
    expect(
      trigger.rows.find((row) => row.definition.includes("FOR EACH ROW"))?.definition,
    ).toMatch(
      /BEFORE INSERT OR DELETE OR UPDATE ON public\.membership FOR EACH ROW EXECUTE FUNCTION guard_membership_dml\(\)/,
    );
    expect(
      trigger.rows.find((row) => row.definition.includes("FOR EACH STATEMENT"))?.definition,
    ).toMatch(
      /BEFORE INSERT OR DELETE OR UPDATE ON public\.membership FOR EACH STATEMENT EXECUTE FUNCTION guard_membership_statement\(\)/,
    );
  });
});
