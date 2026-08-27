import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testPool, testDb } from "../setup/test-db";
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
  // user_identity hat AUSSERHALB des Reconcile-Fensters weiterhin keine
  // wirksame UPDATE-Policy und gar keine DELETE-Policy. RLS mit FORCE
  // verbietet beides vollständig — auch für den Tabellen-Owner. Seit
  // drizzle/0014 existiert eine UPDATE-Policy, deren Prädikat aber an
  // `app.identity_reconcile_email` hängt; ohne gesetzten Parameter ist sie
  // fail-closed (nullif(…, '') -> NULL). Diese Tests halten genau das fest.
  // ═══════════════════════════════════════════════════════════════════
  it("UPDATE ist ohne offenes Reconcile-Fenster wirkungslos (auch für den Owner)", async () => {
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

});

// ═══════════════════════════════════════════════════════════════════════
// F11: idempotenter, eng privilegierter Identity-Reconcile
// (drizzle/0014_identity_reconcile.sql, aufgerufen aus lib/auth.ts).
//
// Hier stand vorher ein eingefrorener ROTER Test, der festhielt, dass ein
// Backfill unter der user_identity-RLS unmöglich sei. Er ist ersetzt: der
// Pfad existiert jetzt und wird hier grün nachgewiesen.
//
// Aufgerufen wird über testDb (kein Mandantenkontext) — genau so läuft der
// Auth-Hook. Nachgewiesen wird über die Superuser-Verbindung, weil die
// SELECT-Policy von user_identity eine Membership verlangt, die es beim
// Erst-Login per Definition nicht gibt.
// ═══════════════════════════════════════════════════════════════════════
interface IdentityRow {
  id: string;
  email: string;
  auth_user_id: string | null;
  [key: string]: unknown;
}

async function identitiesOf(email: string): Promise<IdentityRow[]> {
  const { rows } = await superuserPool().query<IdentityRow>(
    "select id, email, auth_user_id from user_identity where lower(email) = $1",
    [email.toLowerCase()],
  );
  return rows;
}

function reconcile(email: string, authUserId: string): Promise<unknown> {
  return testDb.execute(sql`select reconcile_user_identity(${email}, ${authUserId})`);
}

describe("reconcile_user_identity (F11)", () => {
  it("koppelt eine BEREITS EXISTIERENDE Identität, statt sie zu duplizieren", async () => {
    // Ausgangslage wie nach einer M1-Einladung: Identität da, noch nie eingeloggt.
    const email = `Invited-${randomUUID()}@Example.TEST`;
    const id = randomUUID();
    await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`insert into user_identity (id, email) values (${id}::uuid, ${email.toLowerCase()})`),
    );

    const authUserId = `auth-${randomUUID()}`;
    await reconcile(email, authUserId);

    const rows = await identitiesOf(email);
    expect(rows, "es hätte GENAU EINE Identität bleiben müssen").toHaveLength(1);
    expect(rows[0].id, "die bestehende Identität wurde ersetzt statt gekoppelt").toBe(id);
    expect(rows[0].auth_user_id).toBe(authUserId);
  });

  it("legt eine neue Identität an, wenn die E-Mail unbekannt ist (Erst-Login)", async () => {
    const email = `Fresh-${randomUUID()}@Example.TEST`;
    const authUserId = `auth-${randomUUID()}`;
    await reconcile(email, authUserId);

    const rows = await identitiesOf(email);
    expect(rows).toHaveLength(1);
    // Kanonisch kleingeschrieben GESPEICHERT, nicht nur eindeutig (Codex #18).
    expect(rows[0].email).toBe(email.toLowerCase());
    expect(rows[0].auth_user_id).toBe(authUserId);
  });

  it("ist idempotent — der zweite Aufruf ändert nichts", async () => {
    const email = `Idem-${randomUUID()}@example.test`;
    const authUserId = `auth-${randomUUID()}`;

    await reconcile(email, authUserId);
    const [ersterLauf] = await identitiesOf(email);

    await reconcile(email, authUserId);
    const nachher = await identitiesOf(email);

    expect(nachher, "der zweite Aufruf hat eine zweite Zeile erzeugt").toHaveLength(1);
    expect(nachher[0].id, "der zweite Aufruf hat die id verändert").toBe(ersterLauf.id);
    expect(nachher[0].auth_user_id).toBe(authUserId);
  });

  it("wirft, wenn die Identität bereits an einen ANDEREN auth_user gekoppelt ist", async () => {
    const email = `Konflikt-${randomUUID()}@example.test`;
    const ersterAuthUser = `auth-${randomUUID()}`;
    await reconcile(email, ersterAuthUser);

    await expectRejection(reconcile(email, `auth-${randomUUID()}`), /bereits an auth_user .* gekoppelt/);

    // Kein stilles Umbiegen: die ursprüngliche Kopplung steht unverändert.
    const rows = await identitiesOf(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].auth_user_id).toBe(ersterAuthUser);
  });

  it("verweigert den Dienst INNERHALB eines Mandantenkontexts", async () => {
    // Das Reconcile-Fenster darf aus einer laufenden Mandantentransaktion
    // heraus grundsätzlich nicht aufgehen — der Auth-Hook läuft ohne
    // app.workspace_id, jeder normale Request-Pfad mit.
    await expectRejection(
      withTenantOn(testPool, ws, (tx) =>
        tx.execute(sql`select reconcile_user_identity(${`ctx-${randomUUID()}@t.test`}, ${`auth-${randomUUID()}`})`),
      ),
      /nur ausserhalb eines Mandantenkontexts/,
    );
  });

  it("schließt das Fenster wieder: nach dem Reconcile bleibt die Zeile unsichtbar und unveränderlich", async () => {
    const email = `Fenster-${randomUUID()}@example.test`;
    await reconcile(email, `auth-${randomUUID()}`);

    // (a) Weiterhin unsichtbar ohne Membership — die Reconcile-SELECT-Policy
    //     ist ohne gesetzten Parameter fail-closed.
    const sichtbar = await testPool.query<CountRow>(
      "select count(*)::int as n from user_identity where lower(email) = $1",
      [email.toLowerCase()],
    );
    expect(sichtbar.rows[0].n, "LECK — Identität ohne Membership sichtbar").toBe(0);

    // (b) Ein handgeschriebenes UPDATE außerhalb der Funktion bleibt wirkungslos.
    const res = await testPool.query(
      "update user_identity set auth_user_id = $2 where lower(email) = $1",
      [email.toLowerCase(), `auth-${randomUUID()}`],
    );
    expect(res.rowCount, "UPDATE außerhalb des Reconcile-Fensters hat gegriffen").toBe(0);
  });

  it("die Kopplung ist auch im offenen Fenster nicht umbiegbar (Trigger aus 0011 greift)", async () => {
    // Der Trigger user_identity_link_auth_only war bislang unerreichbar, weil
    // RLS jedes UPDATE verbot. Mit der neuen UPDATE-Policy ist er erstmals
    // scharf — hier wird das nachgewiesen: Fenster von Hand öffnen und
    // versuchen, eine bestehende Kopplung umzubiegen.
    const email = `Trigger-${randomUUID()}@example.test`;
    const authUserId = `auth-${randomUUID()}`;
    await reconcile(email, authUserId);

    const client = await testPool.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.identity_reconcile_email', $1, true)", [
        email.toLowerCase(),
      ]);
      let caught: unknown;
      try {
        await client.query("update user_identity set auth_user_id = $2 where lower(email) = $1", [
          email.toLowerCase(),
          `auth-${randomUUID()}`,
        ]);
      } catch (error) {
        caught = error;
      }
      expect(caught, "Re-Pointing wurde NICHT abgelehnt").toBeInstanceOf(Error);
      expect(String((caught as Error).message)).toMatch(/bereits gesetzt und unveraenderlich/);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
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
