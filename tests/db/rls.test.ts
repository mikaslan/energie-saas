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
    // Bewusst eine FRISCHE UUID statt wsB: wsB existiert schon (aus beforeAll),
    // ein Insert mit id = wsB würde auch OHNE jede RLS am Primary Key
    // scheitern und den Test vacuum-green machen (bewiesen: unter vollem
    // Superuser-RLS-Bypass schlugen zuvor nur die anderen beiden Tests fehl,
    // dieser hier "bestand" trotz wirkungsloser RLS). Mit einer frischen UUID
    // kann NUR die RLS-with-check-Klausel den Insert verhindern.
    const foreignId = randomUUID();
    let caught: unknown;
    try {
      await withTenantOn(testPool, wsA, (tx) =>
        tx.execute(sql`insert into workspace (id, name) values (${foreignId}, 'boese')`),
      );
    } catch (error) {
      caught = error;
    }
    // Drizzle wrapt den echten Postgres-Fehler in DrizzleQueryError, dessen
    // .message nur "Failed query: ..." ist — die eigentliche Postgres-
    // Fehlermeldung ("new row violates row-level security policy ...")
    // steckt in .cause (empirisch verifiziert). Deshalb wird hier .cause
    // geprüft statt .message.
    expect(caught).toBeInstanceOf(Error);
    const cause = (caught as { cause?: unknown }).cause;
    expect(String(cause)).toMatch(/row-level security/);
  });
});

describe("RLS auf user_identity", () => {
  it("zeigt nur Identitäten mit Mitgliedschaft im aktuellen Workspace", async () => {
    const wsX = randomUUID();
    const wsY = randomUUID();
    const userX = randomUUID();
    const userY = randomUUID();

    await withTenantOn(testPool, wsX, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${wsX}, 'X')`);
      await tx.execute(
        sql`insert into user_identity (id, email) values (${userX}, ${`x-${userX}@example.test`})`,
      );
      await tx.execute(
        sql`insert into membership (id, workspace_id, user_id) values (${randomUUID()}, ${wsX}, ${userX})`,
      );
    });

    await withTenantOn(testPool, wsY, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${wsY}, 'Y')`);
      await tx.execute(
        sql`insert into user_identity (id, email) values (${userY}, ${`y-${userY}@example.test`})`,
      );
      await tx.execute(
        sql`insert into membership (id, workspace_id, user_id) values (${randomUUID()}, ${wsY}, ${userY})`,
      );
    });

    const result = await withTenantOn(testPool, wsX, (tx) =>
      tx.execute<WorkspaceIdRow>(sql`select id from user_identity`),
    );
    expect(result.rows.map((r) => r.id)).toEqual([userX]);
  });

  it("Insert mit Client-UUID funktioniert innerhalb einer Tenant-Transaktion", async () => {
    // Bewusst KEIN "insert ... returning" und keine Folge-SELECT: RETURNING
    // unterliegt der SELECT-Policy, die für eine frische Identität (noch
    // keine Membership) chicken-egg wäre. Der Insert selbst (mit
    // client-generierter UUID) darf trotzdem gelingen (with check (true)).
    const wsZ = randomUUID();
    const userZ = randomUUID();

    const result = await withTenantOn(testPool, wsZ, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${wsZ}, 'Z')`);
      return tx.execute(
        sql`insert into user_identity (id, email) values (${userZ}, ${`z-${userZ}@example.test`})`,
      );
    });

    expect(result.rowCount).toBe(1);
  });
});
