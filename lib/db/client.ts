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

export function getPool(): Pool {
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
