import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { getRequestBoard } from "@/modules/boards";
import {
  FollowUpNotFoundError,
  FollowUpValidationError,
  getProjectFollowUp,
  setProjectFollowUp,
} from "@/modules/projects";
import { createManualLead } from "@/modules/projects/manual-lead-service";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-06 FollowUp')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f106.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f106.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return { workspaceId, editorId, viewerId };
}

const isoInDays = (days: number): string =>
  new Date(Date.now() + days * 86_400_000).toISOString();

describe("F1-06 Lead-Wiedervorlage (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;

  const seedLead = async (fx: Fixture, name: string): Promise<string> => {
    const lead = await asEditor(fx, (tx, ctx) =>
      createManualLead(tx, ctx, { scope: "residential", displayName: name, phone: "+49 171 1111111" }),
    );
    return lead.projectId;
  };

  const cardsById = (board: Awaited<ReturnType<typeof getRequestBoard>>) => {
    const map = new Map<string, (typeof board.columns)[number]["cards"][number]>();
    for (const column of board.columns) {
      for (const card of column.cards) map.set(card.id, card);
    }
    return map;
  };

  it("F106-DB-01: setzen, lesen, Bänder, löschen", async () => {
    const projectId = await seedLead(fixture, "Follow Lead");

    const set = await asEditor(fixture, (tx, ctx) =>
      setProjectFollowUp(tx, ctx, { projectId, followUpAt: isoInDays(10) }),
    );
    expect(set.projectId).toBe(projectId);
    expect(typeof set.followUpAt).toBe("string");

    const read = await asEditor(fixture, (tx, ctx) => getProjectFollowUp(tx, ctx, projectId));
    expect(read.followUpAt).toBe(set.followUpAt);

    const board = await asEditor(fixture, (tx, ctx) => getRequestBoard(tx, ctx, { scope: "residential" }));
    expect(cardsById(board).get(projectId)?.followUp?.band).toBe("scheduled");

    await asEditor(fixture, (tx, ctx) =>
      setProjectFollowUp(tx, ctx, { projectId, followUpAt: isoInDays(-10) }),
    );
    const escalated = await asEditor(fixture, (tx, ctx) =>
      getRequestBoard(tx, ctx, { scope: "residential" }),
    );
    const card = cardsById(escalated).get(projectId)?.followUp;
    expect(card?.band).toBe("escalated");
    expect(typeof card?.at).toBe("string");

    await asEditor(fixture, (tx, ctx) =>
      setProjectFollowUp(tx, ctx, { projectId, followUpAt: null }),
    );
    const cleared = await asEditor(fixture, (tx, ctx) => getProjectFollowUp(tx, ctx, projectId));
    expect(cleared.followUpAt).toBeNull();
    const clearedBoard = await asEditor(fixture, (tx, ctx) =>
      getRequestBoard(tx, ctx, { scope: "residential" }),
    );
    expect(cardsById(clearedBoard).get(projectId)?.followUp).toBeNull();
  });

  it("F106-DB-02: Filter-Presets anstehend/ueberfaellig", async () => {
    const overdueId = await seedLead(fixture, "Ueberfaellig Lead");
    const dueId = await seedLead(fixture, "Anstehend Lead");
    await asEditor(fixture, (tx, ctx) =>
      setProjectFollowUp(tx, ctx, { projectId: overdueId, followUpAt: isoInDays(-2) }),
    );
    await asEditor(fixture, (tx, ctx) =>
      setProjectFollowUp(tx, ctx, { projectId: dueId, followUpAt: isoInDays(3) }),
    );

    const overdue = await asEditor(fixture, (tx, ctx) =>
      getRequestBoard(tx, ctx, { scope: "residential", followUpFilter: "overdue" }),
    );
    const overdueIds = overdue.columns.flatMap((column) => column.cards.map((card) => card.id));
    expect(overdueIds).toEqual([overdueId]);

    const due = await asEditor(fixture, (tx, ctx) =>
      getRequestBoard(tx, ctx, { scope: "residential", followUpFilter: "due" }),
    );
    const dueIds = due.columns.flatMap((column) => column.cards.map((card) => card.id));
    expect(dueIds).toEqual([dueId]);
  });

  it("F106-DB-03: Validation, NotFound, RBAC und Tenant-Isolation", async () => {
    const projectId = await seedLead(fixture, "Guard Lead");

    await expect(
      asEditor(fixture, (tx, ctx) =>
        setProjectFollowUp(tx, ctx, { projectId, followUpAt: "kein-datum" }),
      ),
    ).rejects.toBeInstanceOf(FollowUpValidationError);

    await expect(
      asEditor(fixture, (tx, ctx) =>
        setProjectFollowUp(tx, ctx, { projectId: randomUUID(), followUpAt: isoInDays(1) }),
      ),
    ).rejects.toBeInstanceOf(FollowUpNotFoundError);

    // Viewer: weder setzen noch lesen ohne project-Schranke verletzt nichts —
    // Schreiben ist denied, Lesen bleibt read-only möglich.
    await expect(
      asViewer(fixture, (tx, ctx) =>
        setProjectFollowUp(tx, ctx, { projectId, followUpAt: isoInDays(1) }),
      ),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    const viewerRead = await asViewer(fixture, (tx, ctx) => getProjectFollowUp(tx, ctx, projectId));
    expect(viewerRead.followUpAt).toBeNull();

    // Fremdmandant sieht nichts (gleiche generische NotFound, kein Orakel).
    const other = await seedFixture();
    await expect(
      asEditor(other, (tx, ctx) =>
        setProjectFollowUp(tx, ctx, { projectId, followUpAt: isoInDays(1) }),
      ),
    ).rejects.toBeInstanceOf(FollowUpNotFoundError);

    await expect(
      asEditor(fixture, (tx, ctx) =>
        getRequestBoard(tx, ctx, { scope: "residential", followUpFilter: "bald" as never }),
      ),
    ).rejects.toThrow(/unknown follow-up filter/);
  });
});
