import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

// POSTGRES_URL_MIGRATE hat Vorrang: nach der Rollentrennung (ADR 0003) läuft
// der Migrationsjob als app_migrator und nimmt per Verbindungsoption
// `?options=-c%20role%3Dapp_owner` die Eigentümerrolle an, während die App
// weiterhin mit der Runtime-Rolle in POSTGRES_URL arbeitet. Solange die
// Trennung aussteht, ist der Fallback auf POSTGRES_URL genau der heutige
// Zustand — die dokumentierte M0-Limitation, kein Versehen.
const url = process.env.POSTGRES_URL_MIGRATE ?? process.env.POSTGRES_URL;
if (!url) throw new Error("Weder POSTGRES_URL_MIGRATE noch POSTGRES_URL ist gesetzt");
const pool = new Pool({ connectionString: url, max: 1 });

// Hard-Gate: Migrationen (und damit die App-Rolle, die dieselbe Verbindung
// nutzt) dürfen NIE als Superuser oder BYPASSRLS-Rolle laufen — beide
// umgehen Row Level Security bedingungslos, auch mit FORCE ROW LEVEL
// SECURITY (das schützt nur den Tabellen-Owner, sofern dieser kein
// Superuser ist). Läuft dieser Check als Superuser/BYPASSRLS durch, wären
// alle RLS-Policies aus drizzle/*_rls_*.sql wirkungslos, ohne dass irgendwo
// ein Fehler sichtbar würde. Kein Override-Flag — das ist absichtlich.
interface RoleFlags {
  rolsuper: boolean;
  rolbypassrls: boolean;
}
const { rows: roleRows } = await pool.query<RoleFlags>(
  "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
);
const role = roleRows[0];
if (!role || role.rolsuper || role.rolbypassrls) {
  await pool.end();
  throw new Error(
    "Migrationen/App dürfen nie als Superuser/BYPASSRLS-Rolle laufen — RLS wäre wirkungslos.",
  );
}

await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
await pool.end();
console.log("Migrationen angewendet:", url.replace(/:[^:@/]+@/, ":***@"));
