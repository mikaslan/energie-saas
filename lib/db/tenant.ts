import type { Pool } from "pg";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { getDb } from "./client";
import * as schema from "./schema";

type Db = ReturnType<typeof drizzle<typeof schema>>;
export type TenantTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function run<T>(d: Db, workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return d.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return fn(tx);
  });
}

// Der einzige legale Weg zu Mandantendaten: setzt app.workspace_id innerhalb
// einer Transaktion, gegen die die RLS-Policies (siehe drizzle/*_rls_core.sql)
// greifen. Alle Service-Funktionen ab M1 nehmen TenantTx als erstes Argument.
export function withTenant<T>(workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return run(getDb(), workspaceId, fn);
}

// Für Tests: gleiche Semantik gegen einen beliebigen Pool (Test-DB). Nutzt
// NICHT den App-Client (lib/db/client.ts), damit Tests ohne POSTGRES_URL laufen.
export function withTenantOn<T>(p: Pool, workspaceId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return run(drizzle(p, { schema }), workspaceId, fn);
}
