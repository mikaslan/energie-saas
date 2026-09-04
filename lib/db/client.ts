import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";
import { requireServiceDatabaseUrl, servicePoolConfig } from "./role-env";

export type AppDb = ReturnType<typeof drizzle<typeof schema>>;

// Lazy: der App-Pool/Db wird erst bei der ERSTEN Nutzung aufgebaut, nicht beim
// Import dieses Moduls. Grund: Tests importieren transitiv von hier (über
// lib/db/tenant.ts) und laufen ohne POSTGRES_URL (sie nutzen POSTGRES_URL_TEST
// über einen eigenen Pool). Ein Import-Zeit-Throw würde also jeden Test-Import
// zum Absturz bringen, obwohl der App-Pool dort nie gebraucht wird.
let poolInstance: Pool | undefined;
let dbInstance: AppDb | undefined;

function requireUrl(): string {
  return requireServiceDatabaseUrl("POSTGRES_URL", "app_runtime");
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
    poolInstance = new Pool(servicePoolConfig(requireUrl(), "app_runtime"));
  }
  return poolInstance;
}

export function getDb(): AppDb {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema });
  }
  return dbInstance;
}

// Token-Pfad (F10.1; Bedarf baugleich M2-04b): Singleton-Pool AUSSCHLIESSLICH
// fuer SECURITY-DEFINER-Token-Kapseln (resolve_portal_public_view u.a.), die
// ohne Mandantenkontext arbeiten und ihren Actor selbst verwerfen. Einziger
// legaler Consumer ist lib/db/tenant.ts (runTokenCapsule); jeder andere
// Import verstoesst gegen die Depcruise-Regel db-client-nur-ueber-tenant.
// Direkte Tabellen-Queries ueber diesen Pool sind verboten: ohne gesetzte
// app.workspace_id greift keine Tenant-Policy.
export function getTokenPool(): Pool {
  return getPool();
}

// Für Tests und geordnetes Herunterfahren: schließt den App-Pool, ohne einen
// rohen Pool als Umgehungspfad an withTenant zu exportieren.
export async function closeDb(): Promise<void> {
  const pool = poolInstance;
  poolInstance = undefined;
  dbInstance = undefined;
  await pool?.end();
}
