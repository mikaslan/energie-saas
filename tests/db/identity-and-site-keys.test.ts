import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testPool } from "../setup/test-db";
import { withTenantOn } from "@/lib/db/tenant";
import { superuserPool } from "../setup/superuser-db";

// Codex-Review #7 (site tenant-sicher verknüpfbar) und #18 (E-Mail kanonisch)
// sowie die Kopplung aus #17a (user_identity.auth_user_id).

const ws = randomUUID();

interface CountRow {
  n: number;
  [key: string]: unknown;
}

async function expectRejection(query: Promise<unknown>, pattern: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await query;
  } catch (error) {
    caught = error;
  }
  expect(caught, "Statement hätte scheitern MÜSSEN").toBeInstanceOf(Error);
  // Drizzle wrapt Postgres-Fehler in DrizzleQueryError; die echte Meldung
  // steckt in .cause, nicht in .message (siehe tests/db/rls.test.ts).
  const cause = (caught as { cause?: unknown }).cause;
  expect(String(cause)).toMatch(pattern);
}

beforeAll(async () => {
  await withTenantOn(testPool, ws, (tx) =>
    tx.execute(sql`insert into workspace (id, name) values (${ws}::uuid, 'keys')`),
  );
});

describe("user_identity: E-Mail kanonisch eindeutig (Codex #18)", () => {
  it("zwei Schreibweisen derselben Mail ergeben EINE Identity", async () => {
    const local = randomUUID();
    const mixed = `Alice-${local}@Example.COM`;
    const lower = mixed.toLowerCase();

    await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`insert into user_identity (id, email) values (${randomUUID()}::uuid, ${mixed})`),
    );
    await expectRejection(
      withTenantOn(testPool, ws, (tx) =>
        tx.execute(sql`insert into user_identity (id, email) values (${randomUUID()}::uuid, ${lower})`),
      ),
      /user_identity_email_lower_uq/,
    );

    // Gegenprobe ohne RLS-Sichtschranke (user_identity ist unter der
    // membership-basierten SELECT-Policy sonst unsichtbar).
    const { rows } = await superuserPool().query<CountRow>(
      "select count(*)::int as n from user_identity where lower(email) = $1",
      [lower],
    );
    expect(rows[0].n).toBe(1);
  });

  it("der alte case-sensitive UNIQUE-Constraint ist weg", async () => {
    const { rows } = await testPool.query<CountRow>(
      `select count(*)::int as n from pg_constraint where conname = 'user_identity_email_unique'`,
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("user_identity.auth_user_id: einmalige Kopplung (Codex #17a)", () => {
  it("auth_user_id ist UNIQUE — ein auth_user hängt nie an zwei Identitäten", async () => {
    const authUserId = `auth-${randomUUID()}`;
    await withTenantOn(testPool, ws, (tx) =>
      tx.execute(
        sql`insert into user_identity (id, email, auth_user_id) values (${randomUUID()}::uuid, ${`${randomUUID()}@t.test`}, ${authUserId})`,
      ),
    );
    await expectRejection(
      withTenantOn(testPool, ws, (tx) =>
        tx.execute(
          sql`insert into user_identity (id, email, auth_user_id) values (${randomUUID()}::uuid, ${`${randomUUID()}@t.test`}, ${authUserId})`,
        ),
      ),
      /user_identity_auth_user_id_unique/,
    );
  });

  // ═══════════════════════════════════════════════════════════════════
  // Dokumentierter BEFUND (siehe drizzle/0011 und final-fix-report.md, F11):
  // user_identity hat KEINE UPDATE- und KEINE DELETE-Policy. RLS mit FORCE
  // verbietet damit beides vollständig — auch für den Tabellen-Owner. Diese
  // Tests halten genau das fest, damit eine spätere Aufweichung auffällt.
  // ═══════════════════════════════════════════════════════════════════
  it("UPDATE ist ohne Policy vollständig wirkungslos (auch für den Owner)", async () => {
    const id = randomUUID();
    await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`insert into user_identity (id, email) values (${id}::uuid, ${`${randomUUID()}@t.test`})`),
    );
    const res = await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`update user_identity set auth_user_id = ${`auth-${randomUUID()}`} where id = ${id}::uuid`),
    );
    expect(res.rowCount).toBe(0);
  });

  it("DELETE ist ohne Policy vollständig wirkungslos", async () => {
    const id = randomUUID();
    await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`insert into user_identity (id, email) values (${id}::uuid, ${`${randomUUID()}@t.test`})`),
    );
    const res = await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`delete from user_identity where id = ${id}::uuid`),
    );
    expect(res.rowCount).toBe(0);
  });

  it("der Unveränderlichkeits-Trigger ist installiert (Tripwire für eine künftige UPDATE-Policy)", async () => {
    const { rows } = await testPool.query<{ tgname: string }>(
      `select tgname from pg_trigger
        where tgrelid = 'user_identity'::regclass and not tgisinternal
          and tgname = 'user_identity_link_auth_only'`,
    );
    expect(rows).toHaveLength(1);
  });

  it("BEFUND: on-conflict ist auf user_identity RLS-seitig unmöglich (kein Backfill-Pfad)", async () => {
    // PostgreSQL verlangt für jedes `insert ... on conflict ...` — auch DO
    // NOTHING — dass die kollidierende Zeile unter den SELECT-Policies
    // sichtbar ist (WCO_RLS_CONFLICT_CHECK). Beim Erst-Login gibt es weder
    // Membership noch app.workspace_id. Dieser Test hält den Befund fest:
    // fällt er künftig um (z. B. weil eine Bootstrap-Policy eingeführt wird),
    // MUSS der Hook in lib/auth.ts auf idempotentes Upsert umgestellt und
    // der BLOCKED-Punkt F11 geschlossen werden.
    await expectRejection(
      withTenantOn(testPool, ws, (tx) =>
        tx.execute(
          sql`insert into user_identity (id, email) values (${randomUUID()}::uuid, ${`oc-${randomUUID()}@t.test`})
              on conflict (lower(email)) do nothing`,
        ),
      ),
      /row-level security/,
    );
  });
});

describe("site: tenantgebundene Schlüssel (Codex #7)", () => {
  it("UNIQUE (workspace_id, id) existiert als Ziel für zusammengesetzte FKs", async () => {
    const { rows } = await testPool.query<{ indexdef: string }>(
      `select indexdef from pg_indexes where tablename = 'site' and indexname = 'site_ws_id_uq'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toMatch(/UNIQUE/);
    expect(rows[0].indexdef).toMatch(/workspace_id/);
    expect(rows[0].indexdef).toMatch(/\bid\b/);
  });

  it("workspace_id ist ein echter FK auf workspace.id", async () => {
    const { rows } = await testPool.query<{ n: number }>(
      `select count(*)::int as n from pg_constraint
        where conrelid = 'site'::regclass and contype = 'f' and conname = 'site_workspace_id_fk'`,
    );
    expect(rows[0].n).toBe(1);
  });

  it("Site in einem nicht existierenden Workspace wird abgelehnt (FK, nicht nur RLS)", async () => {
    // Der Tenant-Kontext ist konsistent gesetzt, die RLS-with-check-Klausel
    // greift also NICHT — nur der neue FK kann diesen Insert verhindern.
    const geist = randomUUID();
    await expectRejection(
      withTenantOn(testPool, geist, (tx) =>
        tx.execute(sql`insert into site (workspace_id, city) values (${geist}::uuid, 'geisterstadt')`),
      ),
      /site_workspace_id_fk|foreign key/i,
    );
  });
});
