import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testPool } from "../setup/test-db";
import { withTenantOn } from "@/lib/db/tenant";

// withTenantOn(pool, wsId, fn): Testvariante gegen die Test-DB; withTenant nutzt den App-Pool.
let wsA: string;
let wsB: string;

interface WorkspaceIdRow {
  id: string;
  [key: string]: unknown;
}

beforeAll(async () => {
  wsA = randomUUID();
  wsB = randomUUID();
  // Anlage über eine withTenant-Transaktion des jeweiligen Workspace (RLS with check erlaubt nur die eigene Zeile)
  await withTenantOn(testPool, wsA, (tx) =>
    tx.execute(sql`insert into workspace (id, name) values (${wsA}, 'A')`),
  );
  await withTenantOn(testPool, wsB, (tx) =>
    tx.execute(sql`insert into workspace (id, name) values (${wsB}, 'B')`),
  );
});

describe("RLS-Mandantentrennung", () => {
  it("sieht nur den eigenen Workspace", async () => {
    const result = await withTenantOn(testPool, wsA, (tx) =>
      tx.execute<WorkspaceIdRow>(sql`select id from workspace`),
    );
    expect(result.rows.map((r) => r.id)).toEqual([wsA]);
  });

  it("ohne withTenant ist nichts sichtbar", async () => {
    const { rows } = await testPool.query<{ n: number }>("select count(*)::int as n from workspace");
    expect(rows[0].n).toBe(0);
  });

  it("Cross-Tenant-Insert wird abgelehnt", async () => {
    await expect(
      withTenantOn(testPool, wsA, (tx) =>
        tx.execute(sql`insert into workspace (id, name) values (${wsB}, 'boese')`),
      ),
    ).rejects.toThrow();
  });
});
