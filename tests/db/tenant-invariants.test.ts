import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testPool } from "../setup/test-db";
import { withTenantOn } from "@/lib/db/tenant";
import { tenantFixtures, TENANT_EXEMPT, TENANT_EXEMPT_PREFIXES } from "../setup/tenant-fixtures";

interface TenantTable {
  name: string;
}

interface RlsFlagsRow {
  relrowsecurity: boolean;
  relforcerowsecurity: boolean;
}

interface NullableRow {
  is_nullable: string;
}

interface PolicyExistsRow {
  exists: number;
}

interface CountRow {
  n: number;
  [key: string]: unknown; // drizzle tx.execute<T>() verlangt T extends Record<string, unknown>
}

let tables: TenantTable[] = [];
const wsA = randomUUID();
const wsB = randomUUID();

beforeAll(async () => {
  const res = await testPool.query<TenantTable>(`
    select c.relname as name, c.relrowsecurity, c.relforcerowsecurity
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'`);
  tables = res.rows.filter(
    (t) => !TENANT_EXEMPT.has(t.name) && !TENANT_EXEMPT_PREFIXES.some((p) => t.name.startsWith(p)),
  );
  for (const ws of [wsA, wsB]) {
    await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`insert into workspace (id, name) values (${ws}::uuid, 'inv-test')`));
  }
});

describe("Tenant-Invarianten über ALLE Tabellen", () => {
  it("jede Mandantentabelle hat workspace_id NOT NULL (workspace: id als Tenant-Key)", async () => {
    for (const t of tables) {
      if (t.name === "workspace") continue;
      const col = await testPool.query<NullableRow>(
        `select is_nullable from information_schema.columns where table_name = $1 and column_name = 'workspace_id'`,
        [t.name]);
      expect(col.rows, `${t.name}: workspace_id fehlt`).toHaveLength(1);
      expect(col.rows[0].is_nullable, `${t.name}: workspace_id nullable`).toBe("NO");
    }
  });

  it("jede Mandantentabelle hat RLS enabled + forced und eine app.workspace_id-Policy", async () => {
    for (const t of tables) {
      const rls = await testPool.query<RlsFlagsRow>(
        `select relrowsecurity, relforcerowsecurity from pg_class where relname = $1`, [t.name]);
      expect(rls.rows[0].relrowsecurity, `${t.name}: RLS aus`).toBe(true);
      expect(rls.rows[0].relforcerowsecurity, `${t.name}: RLS nicht forced`).toBe(true);
      const pol = await testPool.query<PolicyExistsRow>(
        `select 1 as exists from pg_policies where tablename = $1 and (qual like '%app.workspace_id%' or with_check like '%app.workspace_id%')`,
        [t.name]);
      expect(pol.rows.length, `${t.name}: keine app.workspace_id-Policy`).toBeGreaterThan(0);
    }
  });

  it("jede Mandantentabelle hat eine Fixture-Factory registriert", () => {
    for (const t of tables) {
      expect(tenantFixtures[t.name], `${t.name}: Fixture fehlt in tenant-fixtures.ts`).toBeDefined();
    }
  });

  it("Zeilen aus Workspace A sind in Workspace B unsichtbar", async () => {
    for (const t of tables) {
      await withTenantOn(testPool, wsA, (tx) => tenantFixtures[t.name](tx, wsA));
      const inA = await withTenantOn(testPool, wsA, (tx) =>
        tx.execute<CountRow>(sql.raw(`select count(*)::int as n from ${t.name}`)));
      const inB = await withTenantOn(testPool, wsB, (tx) =>
        tx.execute<CountRow>(sql.raw(`select count(*)::int as n from ${t.name}`)));
      expect(inA.rows[0].n, `${t.name}: Fixture hat nichts angelegt`).toBeGreaterThan(0);
      const bBaseline = t.name === "workspace" ? 1 : 0; // B sieht nur die eigene workspace-Zeile
      expect(inB.rows[0].n, `${t.name}: LECK — B sieht Daten von A`).toBe(bBaseline);
    }
  });
});
