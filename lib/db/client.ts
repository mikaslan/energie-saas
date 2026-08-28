import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

// Lazy: der App-Pool/Db wird erst bei der ERSTEN Nutzung aufgebaut, nicht beim
// Import dieses Moduls. Grund: Tests importieren transitiv von hier (über
// lib/db/tenant.ts) und laufen ohne POSTGRES_URL (sie nutzen POSTGRES_URL_TEST
// über einen eigenen Pool). Ein Import-Zeit-Throw würde also jeden Test-Import
// zum Absturz bringen, obwohl der App-Pool dort nie gebraucht wird.
let poolInstance: Pool | undefined;
let dbInstance: AppDb | undefined;

function requireUrl(): string {
  const url = process.env.POSTGRES_URL;
  if (!url) throw new Error("POSTGRES_URL ist nicht gesetzt");
  return url;
}

// BEWUSST NICHT exportiert (Codex-Review, MUSS vor Merge): ein öffentlicher
// getPool() ist ein direkter Umgehungspfad an withTenant, den Services, der
// Outbox und dem Audit vorbei — mit einem rohen Pool lässt sich ohne
// app.workspace_id und ohne Autorisierung auf JEDE Mandantentabelle zugreifen.
// Der einzige Consumer war lib/db/tenant.ts, das getDb() nutzt. Wer künftig
// wirklich einen Pool braucht, muss diese Datei anfassen — und damit die
// Entscheidung sichtbar machen.
function getPool(): Pool {
  if (!poolInstance) {
    poolInstance = new Pool({ connectionString: requireUrl(), max: 5 });
  }
  return poolInstance;
}

export function getDb(): AppDb {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema });
  }
  return dbInstance;
}

// Für Tests und geordnetes Herunterfahren: schließt den App-Pool, ohne einen
// rohen Pool als Umgehungspfad an withTenant zu exportieren.
export async function closeDb(): Promise<void> {
  const pool = poolInstance;
  poolInstance = undefined;
  dbInstance = undefined;
  await pool?.end();
}
