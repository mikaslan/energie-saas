import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testPool } from "../setup/test-db";
import { withTenantOn } from "@/lib/db/tenant";
import { emitEvent } from "@/lib/events";
import { writeAudit } from "@/lib/audit";

const ws = randomUUID();

interface EventTypeRow {
  event_type: string;
  [key: string]: unknown;
}

// Drizzle wrapt Postgres-Fehler in DrizzleQueryError — die eigentliche
// Fehlermeldung ("... is append-only") steckt in .cause, nicht in .message
// (siehe tests/db/rls.test.ts:57-64, empirisch verifiziert).
async function expectAppendOnlyRejection(query: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await query;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  const cause = (caught as { cause?: unknown }).cause;
  expect(String(cause)).toMatch(/append-only/);
}

beforeAll(async () => {
  await withTenantOn(testPool, ws, (tx) =>
    tx.execute(sql`insert into workspace (id, name) values (${ws}::uuid, 'ev')`),
  );
});

describe("domain_events", () => {
  it("emitEvent schreibt in derselben Transaktion", async () => {
    const aggId = randomUUID();
    await withTenantOn(testPool, ws, async (tx) => {
      await emitEvent(tx, {
        workspaceId: ws,
        aggregateType: "workspace",
        aggregateId: aggId,
        eventType: "test.created",
        actor: "system",
      });
    });
    const rows = await withTenantOn(testPool, ws, (tx) =>
      tx.execute<EventTypeRow>(sql`select event_type from domain_events where aggregate_id = ${aggId}::uuid`),
    );
    expect(rows.rows[0].event_type).toBe("test.created");
  });

  it("Transaktions-Rollback nimmt das Event mit (Outbox-Garantie)", async () => {
    const aggId = randomUUID();
    await expect(
      withTenantOn(testPool, ws, async (tx) => {
        await emitEvent(tx, {
          workspaceId: ws,
          aggregateType: "workspace",
          aggregateId: aggId,
          eventType: "test.rollback",
          actor: "system",
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const rows = await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`select 1 from domain_events where aggregate_id = ${aggId}::uuid`),
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("UPDATE und DELETE auf domain_events schlagen fehl (append-only)", async () => {
    await expectAppendOnlyRejection(
      withTenantOn(testPool, ws, (tx) => tx.execute(sql`update domain_events set event_type = 'x'`)),
    );
    await expectAppendOnlyRejection(
      withTenantOn(testPool, ws, (tx) => tx.execute(sql`delete from domain_events`)),
    );
  });
});

describe("audit_log", () => {
  it("writeAudit schreibt in derselben Transaktion, auch für abgelehnte Zugriffe", async () => {
    await withTenantOn(testPool, ws, async (tx) => {
      await writeAudit(tx, {
        workspaceId: ws,
        actor: "system",
        action: "test.denied",
        resource: "workspace",
        allowed: false,
      });
    });
    const rows = await withTenantOn(testPool, ws, (tx) =>
      tx.execute(sql`select allowed from audit_log where action = 'test.denied' and workspace_id = ${ws}::uuid`),
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("UPDATE und DELETE auf audit_log schlagen fehl (append-only)", async () => {
    await expectAppendOnlyRejection(
      withTenantOn(testPool, ws, (tx) => tx.execute(sql`update audit_log set action = 'x'`)),
    );
    await expectAppendOnlyRejection(
      withTenantOn(testPool, ws, (tx) => tx.execute(sql`delete from audit_log`)),
    );
  });
});
