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

    await expectRejection(reconcile(email, `auth-${randomUUID()}`), /identity already linked/);

    // Kein stilles Umbiegen: die ursprüngliche Kopplung steht unverändert.
    const rows = await identitiesOf(email);
    expect(rows).toHaveLength(1);
    expect(rows[0].auth_user_id).toBe(ersterAuthUser);
  });

  it("die Konflikt-Meldung verrät die bestehende Kopplung NICHT (drizzle/0016)", async () => {
    // Die Policies halten dicht, die Fehlermeldung tat es nicht: sie enthielt
    // die bestehende auth_user_id. Damit war der Fehlerkanal ein Leseweg auf
    // eine Tabelle, die der Aufrufer nie sehen darf.
    const email = `Leak-${randomUUID()}@example.test`;
    const geheimerAuthUser = `auth-geheim-${randomUUID()}`;
    await reconcile(email, geheimerAuthUser);

    let caught: unknown;
    try {
      await reconcile(email, `auth-${randomUUID()}`);
    } catch (error) {
      caught = error;
    }
    expect(caught, "Konflikt wurde nicht abgelehnt").toBeInstanceOf(Error);

    // Die GESAMTE Fehlerkette prüfen, nicht nur .message: Drizzle wrappt, und
    // ein Leck könnte auch in detail/hint/where stecken.
    const komplett = JSON.stringify(caught, Object.getOwnPropertyNames(Object(caught)));
    const ausCause = String((caught as { cause?: unknown }).cause);
    for (const text of [komplett, ausCause]) {
      expect(text, "Fehlermeldung verrät die bestehende auth_user_id").not.toContain(
        geheimerAuthUser,
      );
      expect(text, "Fehlermeldung verrät die E-Mail der Zielidentität").not.toContain(
        email.toLowerCase(),
      );
    }
    expect(ausCause).toMatch(/identity already linked/);
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

  // ═══════════════════════════════════════════════════════════════════
  // ANGRIFFSTEST (Codex-Finalcheck): in drizzle/0014 galten die
  // Fenster-Policies noch `TO PUBLIC` und vertrauten allein den GUCs — ein
  // beliebiger SQL-Caller konnte den Mandanten-Parameter leeren, die
  // E-Mail-GUC selbst setzen und darüber fremde Identitäten lesen bzw.
  // ungekoppelte claimen. Seit drizzle/0015 hängen sie an der Definer-Rolle
  // `identity_reconciler`. Dieser Test fährt genau den alten Angriff.
  // ═══════════════════════════════════════════════════════════════════
  it("ANGRIFF: ein SQL-Caller kann das Fenster nicht selbst öffnen", async () => {
    const email = `Opfer-${randomUUID()}@example.test`;
    const echterAuthUser = `auth-${randomUUID()}`;
    await reconcile(email, echterAuthUser);

    // Zweite, ungekoppelte Identität — das lohnendere Ziel: wer sie claimt,
    // übernimmt eine noch nicht eingelöste Einladung.
    const offenId = randomUUID();
    const offenEmail = `Offen-${randomUUID()}@example.test`;
    await withTenantOn(testPool, ws, (tx) =>
      tx.execute(
        sql`insert into user_identity (id, email) values (${offenId}::uuid, ${offenEmail.toLowerCase()})`,
      ),
    );

    const client = await testPool.connect();
    try {
      await client.query("begin");
      // Der Angreifer setzt exakt das, was die Policies aus 0014 geprüft haben.
      await client.query("select set_config('app.workspace_id', '', true)");
      await client.query("select set_config('app.identity_reconcile_email', $1, true)", [
        email.toLowerCase(),
      ]);
      const gelesen = await client.query<CountRow>(
        "select count(*)::int as n from user_identity where lower(email) = $1",
        [email.toLowerCase()],
      );
      expect(gelesen.rows[0].n, "LECK — fremde Identität lesbar").toBe(0);

      // Und der Claim auf die noch ungekoppelte Identität.
      await client.query("select set_config('app.identity_reconcile_email', $1, true)", [
        offenEmail.toLowerCase(),
      ]);
      const geclaimt = await client.query(
        "update user_identity set auth_user_id = $2 where lower(email) = $1",
        [offenEmail.toLowerCase(), `auth-angreifer-${randomUUID()}`],
      );
      expect(geclaimt.rowCount, "LECK — ungekoppelte Identität claimbar").toBe(0);
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }

    // Gegenprobe über den Superuser: nichts hat sich verändert.
    const nachher = await superuserPool().query<IdentityRow>(
      "select auth_user_id from user_identity where id = $1",
      [offenId],
    );
    expect(nachher.rows[0].auth_user_id, "Identität wurde doch geclaimt").toBeNull();
  });

  it("ANGRIFF: die App-Rolle kann nicht in die Definer-Rolle wechseln", async () => {
    // SET ROLE wäre der zweite Weg ins Fenster. Die Mitgliedschaft aus
    // drizzle/0015 steht deshalb auf `set false`.
    const client = await testPool.connect();
    try {
      let caught: unknown;
      try {
        await client.query("set role identity_reconciler");
      } catch (error) {
        caught = error;
      }
      expect(caught, "SET ROLE in die Definer-Rolle war möglich").toBeInstanceOf(Error);
      expect(String((caught as Error).message)).toMatch(/permission denied to set role/);
    } finally {
      client.release();
    }
  });

  it("die Definer-Rolle ist weder Owner noch privilegiert", async () => {
    const { rows } = await testPool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcanlogin: boolean;
    }>(
      `select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'identity_reconciler'`,
    );
    expect(rows, "Rolle identity_reconciler fehlt").toHaveLength(1);
    expect(rows[0].rolsuper, "Definer-Rolle ist Superuser").toBe(false);
    expect(rows[0].rolbypassrls, "Definer-Rolle umgeht RLS").toBe(false);
    expect(rows[0].rolcanlogin, "Definer-Rolle kann sich anmelden").toBe(false);

    // Sie besitzt keine einzige Tabelle — FORCE RLS gilt für sie also normal.
    const besitz = await testPool.query<CountRow>(
      `select count(*)::int as n from pg_class c join pg_roles r on r.oid = c.relowner
        where r.rolname = 'identity_reconciler' and c.relkind in ('r','p','m')`,
    );
    expect(besitz.rows[0].n, "Definer-Rolle besitzt Tabellen").toBe(0);

    // Aber sie besitzt die Funktion — sonst greift SECURITY DEFINER ins Leere.
    const fn = await testPool.query<{ rolname: string }>(
      `select r.rolname from pg_proc p join pg_roles r on r.oid = p.proowner
        where p.proname = 'reconcile_user_identity'`,
    );
    expect(fn.rows[0].rolname).toBe("identity_reconciler");
  });

  it("EXECUTE auf die Reconcile-Funktion ist nicht öffentlich", async () => {
    const { rows } = await testPool.query<{ oeffentlich: boolean }>(
      `select has_function_privilege('public', 'reconcile_user_identity(text, text)', 'execute')
              as oeffentlich`,
    );
    expect(rows[0].oeffentlich, "EXECUTE liegt bei PUBLIC").toBe(false);
  });

  it("die Kopplung ist auch OHNE RLS nicht umbiegbar (Trigger aus 0011 greift)", async () => {
    // Der Trigger user_identity_link_auth_only ist die Absicherung, die
    // unabhängig von RLS wirkt. Genau deshalb wird er hier über die
    // Superuser-Verbindung geprüft: sie umgeht RLS vollständig, der Trigger
    // muss trotzdem greifen. Über eine normale Verbindung ließe sich das gar
    // nicht mehr messen — dort verhindert seit drizzle/0015 schon die Policy
    // jedes UPDATE (siehe Angriffstest oben).
    const email = `Trigger-${randomUUID()}@example.test`;
    const authUserId = `auth-${randomUUID()}`;
    await reconcile(email, authUserId);

    let caught: unknown;
    try {
      await superuserPool().query(
        "update user_identity set auth_user_id = $2 where lower(email) = $1",
        [email.toLowerCase(), `auth-${randomUUID()}`],
      );
    } catch (error) {
      caught = error;
    }
    expect(caught, "Re-Pointing wurde NICHT abgelehnt").toBeInstanceOf(Error);
    expect(String((caught as Error).message)).toMatch(/bereits gesetzt und unveraenderlich/);
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
