import { Pool } from "pg";
import { tmpdir } from "node:os";
import { resolve, sep } from "node:path";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  assertDestructiveTestDatabase,
  assertNoAmbientPostgresOverrides,
  parsePostgresConnectionUrl,
  postgresConnectionTransport,
} from "../lib/db/postgres-url.js";
import {
  applyDefaultPrivilegeContract,
  applyRoleContract,
  dbRoleProvisioningTopologyFromEnvironment,
  STRICT_DB_ROLE_MODE,
  TEST_DB_ROLE_MODE,
  type DbRoleMode,
  verifyDefaultPrivilegeContract,
  verifyMigrationPrincipalBoundary,
  verifyRoleContract,
} from "./db-role-contract.mjs";
import { verifyAppliedMigrationHistory } from "./migration-history.mjs";

function requireMigrationUrl(): string {
  const url = process.env.POSTGRES_URL_MIGRATE;
  if (!url) {
    throw new Error(
      "POSTGRES_URL_MIGRATE ist nicht gesetzt. Der Migrator fällt niemals auf POSTGRES_URL zurück.",
    );
  }
  return url;
}

function roleMode(url: URL): DbRoleMode {
  const value = process.env.DB_ROLE_MODE ?? STRICT_DB_ROLE_MODE;
  if (value === STRICT_DB_ROLE_MODE) return value;
  if (value !== TEST_DB_ROLE_MODE) {
    throw new Error(`Unbekannter DB_ROLE_MODE: ${value}`);
  }

  assertDestructiveTestDatabase(TEST_DB_ROLE_MODE, url);
  if (process.env.NODE_ENV !== "test" && process.env.VITEST !== "true") {
    throw new Error(`${TEST_DB_ROLE_MODE} ist ausschließlich unter NODE_ENV=test/Vitest erlaubt.`);
  }
  return value;
}

function migrationsFolder(mode: DbRoleMode): string {
  const configured = process.env.TEST_MIGRATIONS_FOLDER;
  if (!configured) return "./drizzle";
  if (mode !== TEST_DB_ROLE_MODE || process.env.NODE_ENV !== "test") {
    throw new Error("TEST_MIGRATIONS_FOLDER ist nur im expliziten Test-Rollenmodus erlaubt.");
  }
  const folder = resolve(configured);
  const temporaryRoot = resolve(tmpdir());
  if (folder !== temporaryRoot && !folder.startsWith(`${temporaryRoot}${sep}`)) {
    throw new Error("TEST_MIGRATIONS_FOLDER muss unter dem Betriebssystem-Tempverzeichnis liegen.");
  }
  return folder;
}

function assertDirectStrictUrl(url: URL): void {
  if (decodeURIComponent(url.username) !== "app_migrator") {
    throw new Error("POSTGRES_URL_MIGRATE muss im Strict-Modus als app_migrator verbinden.");
  }
  if (url.hostname.toLowerCase().includes("-pooler")) {
    throw new Error("Migrationen brauchen den direkten, ungepoolten Postgres-/Neon-Endpunkt.");
  }
}

function redact(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.password) url.password = "***";
  url.search = "";
  return url.toString();
}

const url = requireMigrationUrl();
assertNoAmbientPostgresOverrides("POSTGRES_URL_MIGRATE");
const parsedUrl = parsePostgresConnectionUrl("POSTGRES_URL_MIGRATE", url);
const mode = roleMode(parsedUrl);
const migrationFolder = migrationsFolder(mode);
if (mode === STRICT_DB_ROLE_MODE) assertDirectStrictUrl(parsedUrl);
const provisioningTopology =
  mode === STRICT_DB_ROLE_MODE
    ? dbRoleProvisioningTopologyFromEnvironment(process.env)
    : undefined;

const pool = new Pool({
  ...postgresConnectionTransport("POSTGRES_URL_MIGRATE", url),
  max: 1,
  connectionTimeoutMillis: 10_000,
  lock_timeout: 5_000,
  statement_timeout: 300_000,
  idle_in_transaction_session_timeout: 60_000,
  // SET ROLE als Startup-Option braucht eine direkte Verbindung. app_migrator
  // trägt die Owner-Rechte dadurch nicht dauerhaft und kann ohne diesen
  // expliziten Rollenwechsel weder DDL noch Fach-DML ausführen.
  options: mode === STRICT_DB_ROLE_MODE ? "-c role=app_owner" : undefined,
});

const client = await pool.connect();
let locked = false;
try {
  if (mode === STRICT_DB_ROLE_MODE) {
    await verifyMigrationPrincipalBoundary(client, provisioningTopology);
  } else {
    const identity = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>(`
      select r.rolsuper, r.rolbypassrls
      from pg_catalog.pg_roles r
      where r.rolname = current_user
    `);
    const role = identity.rows[0];
    if (!role || role.rolsuper || role.rolbypassrls) {
      throw new Error("Migrationen dürfen nie als Superuser/BYPASSRLS-Rolle laufen.");
    }
  }

  // Sessionweiter Lock: genau ein Migrationslauf pro Datenbank. Der feste
  // Zweier-Schlüssel ist repo-spezifisch und wird im finally freigegeben.
  await client.query("select pg_catalog.pg_advisory_lock(1701734769, 3)");
  locked = true;

  if (mode === STRICT_DB_ROLE_MODE) {
    // Nach eventuellem Warten erneut prüfen. So kann kein paralleler Release
    // zwischen Preflight und Lock eine fremde/neue Journalzeile einschieben,
    // die dieser Lauf anschließend nur anhand des Zeitstempels überspringt.
    await verifyMigrationPrincipalBoundary(client, provisioningTopology);
    await verifyAppliedMigrationHistory(client);

    // Default-ACLs müssen VOR Drizzle sauber sein. Sonst könnte eine spätere
    // Migration ein neues Objekt zunächst mit driftenden Runtime-Rechten
    // anlegen und sie erst im Post-Manifest wieder entziehen.
    await client.query("begin");
    try {
      await applyDefaultPrivilegeContract(client);
      await verifyDefaultPrivilegeContract(client);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  }

  await migrate(drizzle(client), { migrationsFolder: migrationFolder });

  if (mode === STRICT_DB_ROLE_MODE) {
    await client.query("begin");
    try {
      await applyDefaultPrivilegeContract(client);
      await applyRoleContract(client);
      await verifyRoleContract(client, provisioningTopology);
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    }
  }

  console.log("Migrationen angewendet:", redact(url));
} finally {
  if (locked) {
    await client.query("select pg_catalog.pg_advisory_unlock(1701734769, 3)").catch(() => undefined);
  }
  client.release();
  await pool.end();
}
