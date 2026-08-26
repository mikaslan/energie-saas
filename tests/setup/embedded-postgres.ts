// Bootet eine echte, lokale Postgres-Instanz für Testläufe, wenn keine
// POSTGRES_URL_TEST von außen (CI, echtes Postgres) vorgegeben ist.
// Datenverzeichnis lebt unter .superpowers/pgdata (gitignored) und wird nach
// dem Stop wieder gelöscht (persistent: false).
import EmbeddedPostgres from "embedded-postgres";
import { createServer } from "node:net";
import path from "node:path";

const DATABASE_NAME = "energie_saas_test";
const USER = "postgres";
const PASSWORD = "postgres";

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
    user: USER,
    password: PASSWORD,
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
    url: `postgres://${USER}:${PASSWORD}@127.0.0.1:${port}/${DATABASE_NAME}`,
    stop: () => pg.stop(),
  };
}
