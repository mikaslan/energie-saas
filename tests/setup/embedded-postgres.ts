// Bootet eine echte, lokale Postgres-Instanz für Testläufe, wenn keine
// POSTGRES_URL_TEST von außen (CI, echtes Postgres) vorgegeben ist.
// Datenverzeichnis lebt unter .superpowers/pgdata (gitignored) und wird nach
// dem Stop wieder gelöscht (persistent: false).
import EmbeddedPostgres from "embedded-postgres";
import { createServer } from "node:net";
import path from "node:path";
import { Pool } from "pg";

const DATABASE_NAME = "energie_saas_test";
// initdb-Superuser: nur fürs Bootstrapping der Instanz/Datenbank verwendet,
// NIE als POSTGRES_URL_TEST exportiert (siehe APP_ROLE unten).
const SUPERUSER = "postgres";
const SUPERUSER_PASSWORD = "postgres";
// Row Level Security mit FORCE unterscheidet zwischen Tabellen-Owner (wird
// TROTZ Owner-Status restriktiert) und Superusern (umgehen RLS *immer*,
// FORCE hin oder her — siehe Postgres-Doku zu ALTER TABLE ... FORCE ROW
// LEVEL SECURITY). Würde die Testverbindung wie zuvor direkt als "postgres"
// laufen, wären alle RLS-Policies wirkungslos und die Tests in
// tests/db/rls.test.ts würden fälschlich "grün" ohne echte Durchsetzung.
// Diese Rolle bildet daher ab, wie die App-Verbindung in der echten Umgebung
// aussieht (z. B. Neon: die App-Rolle besitzt ihre Tabellen, ist aber kein
// Superuser) — nicht-superuser, ohne BYPASSRLS, Owner der selbst erzeugten
// Tabellen (via Migrationslauf).
const APP_ROLE = "app_test";
const APP_PASSWORD = "app_test";

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Konnte keinen freien Port für die Test-Postgres-Instanz ermitteln."));
        return;
      }
      const { port } = address;
      server.close((closeErr) => (closeErr ? reject(closeErr) : resolve(port)));
    });
  });
}

export interface EmbeddedTestDatabase {
  url: string;
  stop: () => Promise<void>;
}

export async function startEmbeddedPostgres(): Promise<EmbeddedTestDatabase> {
  const port = await findFreePort();
  const databaseDir = path.resolve(process.cwd(), ".superpowers", "pgdata", `test-${port}-${Date.now()}`);
  const logLines: string[] = [];

  const pg = new EmbeddedPostgres({
    databaseDir,
    port,
    user: SUPERUSER,
    password: SUPERUSER_PASSWORD,
    persistent: false, // stop() räumt das Datenverzeichnis vollständig ab
    onLog: (message) => logLines.push(message),
    onError: (messageOrError) => logLines.push(String(messageOrError)),
  });

  let started = false;

  try {
    await pg.initialise();
    await pg.start();
    started = true;
    await pg.createDatabase(DATABASE_NAME);

    // Nicht-superuser App-Rolle anlegen (s. Kommentar oben) und ihr die
    // Rechte geben, in "public" eigene (RLS-fähige) Tabellen anzulegen.
    const bootstrapPool = new Pool({
      connectionString: `postgres://${SUPERUSER}:${SUPERUSER_PASSWORD}@127.0.0.1:${port}/${DATABASE_NAME}`,
    });
    try {
      await bootstrapPool.query(
        `create role ${APP_ROLE} login password '${APP_PASSWORD}' nosuperuser nobypassrls`,
      );
      await bootstrapPool.query(`grant all privileges on schema public to ${APP_ROLE}`);
      await bootstrapPool.query(`grant all privileges on database ${DATABASE_NAME} to ${APP_ROLE}`);
    } finally {
      await bootstrapPool.end();
    }
  } catch (err) {
    // Test-Output bleibt im Erfolgsfall leise; bei einem Fehlschlag brauchen
    // wir die gepufferten initdb/postgres-Logs zur Diagnose.
    console.error("[embedded-postgres] Start fehlgeschlagen:\n" + logLines.join(""));
    if (started) {
      // start() lief bereits erfolgreich (z. B. createDatabase() ist danach
      // gescheitert) — ohne dieses Aufräumen blieben ein laufender
      // Postgres-Prozess und sein Datenverzeichnis verwaist zurück, weil
      // global-setup.ts sein `stopEmbedded` erst NACH dem Rückgabewert
      // dieser Funktion zuweist. Best-effort, damit ein Stop-Fehler den
      // eigentlichen Fehler nicht verdeckt.
      await pg.stop().catch((stopErr: unknown) => {
        console.error("[embedded-postgres] Aufräumen nach Fehlschlag ebenfalls fehlgeschlagen:", stopErr);
      });
    }
    throw err;
  }

  return {
    url: `postgres://${APP_ROLE}:${APP_PASSWORD}@127.0.0.1:${port}/${DATABASE_NAME}`,
    stop: () => pg.stop(),
  };
}
