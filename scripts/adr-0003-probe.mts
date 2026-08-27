// EINMALIGE Gegenprobe der Grant-Skizze aus docs/adr/0003-db-rollen-trennung.md
// gegen die embedded-Test-DB. Kein Bestandteil von `npm run check` — wird bei
// Änderungen an der Skizze von Hand ausgeführt:
//   npx tsx scripts/adr-0003-probe.mts
import { execSync } from "node:child_process";
import { Pool } from "pg";
import { startEmbeddedPostgres } from "../tests/setup/embedded-postgres";

const DB = "energie_saas_test";
const embedded = await startEmbeddedPostgres();
const su = new Pool({ connectionString: embedded.superuserUrl, max: 2 });
const host = new URL(embedded.url).host;

let fehler = 0;
function ok(label: string, bedingung: boolean, detail = "") {
  if (!bedingung) fehler++;
  console.log(`${bedingung ? "OK  " : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
}

async function darf(pool: Pool, label: string, sql: string, params: unknown[] = []): Promise<void> {
  try {
    await pool.query(sql, params);
    ok(label, true);
  } catch (e) {
    ok(label, false, (e as Error).message);
  }
}

async function darfNicht(pool: Pool, label: string, sql: string, params: unknown[] = []): Promise<void> {
  try {
    await pool.query(sql, params);
    ok(label, false, "wurde ERLAUBT");
  } catch (e) {
    ok(label, true, (e as Error).message.split("\n")[0]);
  }
}

try {
  // ── Block 1 der ADR-Skizze: Rollen ───────────────────────────────────
  await su.query(`
    create role app_owner    nologin nosuperuser nobypassrls createrole;
    create role app_migrator login password 'mig' nosuperuser nobypassrls;
    create role app_runtime  login password 'run' nosuperuser nobypassrls;
    create role app_auth     login password 'aut' nosuperuser nobypassrls;
    create role app_worker   login password 'wrk' nosuperuser nobypassrls;
    grant app_owner to app_migrator with inherit false, set true;`);
  ok("Block 1: Rollen + eingeschränkte Mitgliedschaft", true);

  // ── Block 2: Schema-Ownership ────────────────────────────────────────
  await su.query(`
    alter schema public owner to app_owner;
    revoke all on schema public from public;
    grant usage on schema public to app_runtime, app_auth, app_worker;
    grant create on database ${DB} to app_owner;
    create schema if not exists pgboss authorization app_worker;`);
  ok("Block 2: Schema-Ownership + Usage-Grants", true);

  // ── Block 3: Migrationslauf als app_owner (per Connection-Option) ─────
  const migrateUrl = `postgres://app_migrator:mig@${host}/${DB}?options=-c%20role%3Dapp_owner`;
  execSync("npx tsx scripts/migrate.mts", {
    env: { ...process.env, POSTGRES_URL: migrateUrl },
    stdio: "inherit",
  });
  const ownerCheck = await su.query<{ n: number }>(
    `select count(*)::int as n from pg_class c join pg_roles r on r.oid = c.relowner
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and r.rolname <> 'app_owner'`,
  );
  ok("Block 3: alle public-Tabellen gehören app_owner", ownerCheck.rows[0].n === 0,
    `fremde Owner: ${ownerCheck.rows[0].n}`);

  // ── Block 4: Grant-Skript (nach JEDER Migration) ─────────────────────
  const ownerPool = new Pool({
    connectionString: `postgres://app_migrator:mig@${host}/${DB}?options=-c%20role%3Dapp_owner`,
    max: 2,
  });
  await ownerPool.query(`
    grant select, insert, update, delete on workspace, membership, site to app_runtime;
    grant select, insert on user_identity to app_runtime;
    grant select, insert on domain_events, audit_log to app_runtime;

    grant select, insert, update, delete on
      auth_user, auth_session, auth_account, auth_verification, auth_rate_limit
      to app_auth;

    grant identity_reconciler to app_owner with inherit false, set true;
    set role identity_reconciler;
    revoke execute on function reconcile_user_identity(text, text) from public;
    revoke execute on function reconcile_user_identity(text, text) from app_owner;
    grant  execute on function reconcile_user_identity(text, text) to app_auth;
    reset role;
    grant identity_reconciler to app_owner with inherit false, set false;`);
  ok("Block 4: Grant-Skript läuft als app_owner durch", true);

  // ── Nachweise ────────────────────────────────────────────────────────
  const runtime = new Pool({ connectionString: `postgres://app_runtime:run@${host}/${DB}`, max: 2 });
  const authRole = new Pool({ connectionString: `postgres://app_auth:aut@${host}/${DB}`, max: 2 });
  const worker = new Pool({ connectionString: `postgres://app_worker:wrk@${host}/${DB}`, max: 2 });

  await darf(runtime, "app_runtime darf Domänen-DML (unter RLS)", `select count(*) from site`);
  await darfNicht(runtime, "app_runtime sieht auth_user NICHT", `select count(*) from auth_user`);
  await darfNicht(runtime, "app_runtime darf kein TRUNCATE", `truncate site`);
  await darfNicht(runtime, "app_runtime darf user_identity nicht aendern",
    `update user_identity set auth_user_id = 'x'`);
  await darfNicht(runtime, "domain_events ist append-only (kein UPDATE-Recht)",
    `update domain_events set actor = 'x'`);
  await darfNicht(runtime, "audit_log ist append-only (kein DELETE-Recht)",
    `delete from audit_log`);
  await darfNicht(runtime, "app_runtime darf kein DDL in public", `create table verboten (x int)`);
  await darfNicht(runtime, "app_runtime darf reconcile NICHT ausführen",
    `select reconcile_user_identity('x@t.test', 'auth-x')`);

  await darf(authRole, "app_auth darf auth_user lesen", `select count(*) from auth_user`);
  await darfNicht(authRole, "app_auth sieht user_identity NICHT (kein Grant)",
    `select count(*) from user_identity`);
  await darf(authRole, "app_auth darf reconcile ausführen",
    `select reconcile_user_identity('adr@t.test', 'auth-adr')`);
  await darf(authRole, "reconcile ist idempotent",
    `select reconcile_user_identity('adr@t.test', 'auth-adr')`);
  const beleg = await su.query<{ n: number }>(
    `select count(*)::int as n from user_identity where email = 'adr@t.test' and auth_user_id = 'auth-adr'`,
  );
  ok("Kopplung liegt genau einmal in der DB", beleg.rows[0].n === 1, `n=${beleg.rows[0].n}`);

  // Härtung wirkt: app_runtime kann das Fenster NICHT mehr von Hand öffnen.
  const c = await runtime.connect();
  try {
    await c.query("begin");
    await c.query("select set_config('app.identity_reconcile_email', 'adr@t.test', true)");
    const gesehen = await c.query(`select count(*)::int as n from user_identity where email = 'adr@t.test'`);
    ok("app_runtime kann das Reconcile-Fenster nicht selbst öffnen", gesehen.rows[0].n === 0);
  } finally {
    await c.query("rollback").catch(() => {});
    c.release();
  }

  await darfNicht(ownerPool, "app_owner kommt nach dem Grant-Skript nicht mehr in die Definer-Rolle",
    `set role identity_reconciler`);
  await darfNicht(ownerPool, "app_owner darf reconcile nicht mehr ausfuehren",
    `select reconcile_user_identity('owner@t.test', 'auth-owner')`);
  await darfNicht(runtime, "app_runtime kommt nicht in die Definer-Rolle", `set role identity_reconciler`);
  await darfNicht(authRole, "app_auth kommt nicht in die Definer-Rolle", `set role identity_reconciler`);

  await darf(worker, "app_worker darf im pgboss-Schema anlegen", `create table pgboss.probe (x int)`);
  await darfNicht(worker, "app_worker sieht auth_user NICHT", `select count(*) from auth_user`);

  await Promise.all([runtime.end(), authRole.end(), worker.end(), ownerPool.end()]);
} finally {
  await su.end();
  await embedded.stop();
}

console.log(fehler === 0 ? "\nADR-0003-Skizze: alle Nachweise grün." : `\n${fehler} FEHLER`);
process.exit(fehler === 0 ? 0 : 1);
