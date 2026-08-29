import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as authSchema from "./schema/auth";
import { requireServiceDatabaseUrl, servicePoolConfig } from "./role-env";

// ═══════════════════════════════════════════════════════════════════════
// Eigener DB-Client für better-auth (Codex-Review #19 + MUSS-Punkt „getPool
// entfernen + Importverbote"):
//
// 1. Grenze: lib/db/client.ts ist ab jetzt AUSSCHLIESSLICH die Tür für
//    lib/db/tenant.ts (dependency-cruiser-Regel `db-client-nur-ueber-tenant`).
//    Auth ist kein Mandantenpfad — es braucht bewusst eine Verbindung OHNE
//    app.workspace_id — und bekommt deshalb einen eigenen, klar benannten
//    Client statt eine Ausnahme in der Grenzregel.
// 2. Schema: dieser Client kennt NUR die auth_*-Tabellen. Ein vergessenes
//    WHERE in Auth-Code kann damit keine Domänentabelle treffen, und der
//    Drizzle-Adapter löst seine Modelle (`auth_user`, `auth_session`, …)
//    gegen genau dieses Schema auf.
// 3. Rolle: POSTGRES_URL_AUTH ist die einzige erlaubte Verbindung. Ein
//    Fallback auf POSTGRES_URL würde die M1-03-Rollentrennung lautlos wieder
//    aufheben und ist deshalb fail-closed entfernt.
//
// Lazy wie lib/db/client.ts: Tests importieren transitiv von hier und laufen
// ohne POSTGRES_URL. Ein Import-Zeit-Throw würde jeden solchen Import killen.
// ═══════════════════════════════════════════════════════════════════════
export type AuthDb = ReturnType<typeof drizzle<typeof authSchema>>;

let poolInstance: Pool | undefined;
let dbInstance: AuthDb | undefined;

function requireUrl(): string {
  return requireServiceDatabaseUrl("POSTGRES_URL_AUTH", "app_auth");
}

export function getAuthDb(): AuthDb {
  if (!dbInstance) {
    poolInstance ??= new Pool(servicePoolConfig(requireUrl(), "app_auth"));
    dbInstance = drizzle(poolInstance, { schema: authSchema });
  }
  return dbInstance;
}

// Für Tests und geordnetes Herunterfahren: schließt den Auth-Pool, damit der
// Prozess (bzw. der Vitest-Worker) keine offenen Handles zurücklässt.
export async function closeAuthDb(): Promise<void> {
  const pool = poolInstance;
  poolInstance = undefined;
  dbInstance = undefined;
  await pool?.end();
}
