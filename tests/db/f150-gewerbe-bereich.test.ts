import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { getRequestBoard } from "@/modules/boards";
import { testPool } from "../setup/test-db";
import { superuserPool } from "../setup/superuser-db";

type Fixture = { workspaceId: string; editorId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F15-01 Bereich')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f150.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId };
}

describe("F15-01 Gewerbe-Bereich (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const run = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;

  it("F150-DB-01: neue Workspaces erhalten Wohnbau- und Gewerbe-Board", async () => {
    const residential = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    expect(residential.name).toBe("Anfragen");
    expect(residential.scope).toBe("residential");
    expect(residential.columns).toHaveLength(4);
    expect(residential.columns.filter((column) => column.isIntake)).toHaveLength(1);

    const commercial = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "commercial" }));
    expect(commercial.name).toBe("Anfragen Gewerbe");
    expect(commercial.scope).toBe("commercial");
    expect(commercial.columns).toHaveLength(4);
    expect(commercial.columns.filter((column) => column.isIntake)).toHaveLength(1);
    expect(commercial.id).not.toBe(residential.id);
  });

  it("F150-DB-02: unbekannter Scope fail-closed — kein stiller Fallback", async () => {
    await expect(run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "industrie" as never })))
      .rejects.toThrow(/unknown board scope/);
  });

  it("F150-DB-03: fehlendes Gewerbe-Board fail-closed — kein Wohnbau-Fallback", async () => {
    // Strukturelle Archivierung via Superuser (Board-Write trägt
    // Actor-Policies, die der Tenant-Kontext allein nicht erfüllt).
    await superuserPool().query(
      `update kanban_board set archived_at = now(), is_default = false
        where workspace_id = $1::uuid
          and scope = 'commercial' and is_default = true`,
      [fixture.workspaceId],
    );
    await expect(run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "commercial" })))
      .rejects.toThrow(/default commercial request board is missing/);
    // Wohnbau bleibt unberührt erreichbar.
    const residential = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    expect(residential.scope).toBe("residential");
  });

  it("F150-DB-04: Tenant-Isolation — fremde Boards sind unsichtbar", async () => {
    const other = await seedFixture();
    const commercial = await run(other, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "commercial" }));
    const own = await run(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "commercial" }));
    expect(commercial.id).not.toBe(own.id);
  });
});
