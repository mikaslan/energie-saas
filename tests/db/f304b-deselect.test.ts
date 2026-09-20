import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { testPool } from "../setup/test-db";

/**
 * F3-04b Einzelmodul-Abwahl — DB-RED.
 * vertrag: docs/spec/F3-04b-deselect.md (Tabelle fehlt → 42P01-RED).
 * tabelle (0276 zentral, exakt): planning_panel_deselect
 * (workspace_id, group_id, row, col, reason, created_by)
 * + UNIQUE(group_id, row, col).
 */

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
  siteId: string;
  sourceId: string;
  roofId: string;
  groupIds: string[];
};

function pgCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function pgCodeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return pgCode(error);
  }
}

const RECTANGLE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 6 },
  { x: 0, y: 6 },
];

async function seedFixture(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f304b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f304b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
  });
  await withTenantOn(testPool, otherWorkspaceId, async (tx) => {
    await tx.execute(
      sql`insert into workspace (id, name) values (${otherWorkspaceId}::uuid, ${`${label}-fremd`})`,
    );
  });
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F3', 'Fixture',
        ${`${contactId}@f304b.test`}, ${`${contactId}@f304b.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${`${label} Site`})
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             ${label}, 'fixture'
      from kanban_board board
      join kanban_column intake_column
        on intake_column.workspace_id = board.workspace_id
        and intake_column.board_id = board.id
        and intake_column.is_intake = true
        and intake_column.archived_at is null
      where board.workspace_id = ${workspaceId}::uuid
        and board.scope = 'residential'
        and board.is_default = true
        and board.archived_at is null
    `);
  });
  const sourceId = randomUUID();
  const roofId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into planning_source (id, workspace_id, project_id, site_id, kind, created_by)
      values (${sourceId}::uuid, ${workspaceId}::uuid, ${projectId}::uuid,
        ${siteId}::uuid, 'self_drawn', ${editorId}::uuid)
    `);
    await tx.execute(sql`
      insert into planning_roof_min (id, workspace_id, source_id, polygon_json, flat_single_tilt, created_by)
      values (${roofId}::uuid, ${workspaceId}::uuid, ${sourceId}::uuid,
        ${JSON.stringify(RECTANGLE)}::jsonb, 30, ${editorId}::uuid)
    `);
  });
  const groupIds: string[] = [];
  await withTenantOn(testPool, workspaceId, async (tx) => {
    for (const [index, origin] of [{ x: 1, y: 1 }, { x: 2, y: 2 }].entries()) {
      const created = await tx.execute<{ id: string }>(sql`
        insert into planning_panel_group (
          workspace_id, roof_id, kind, label, origin_json,
          rows, cols, module_w_m, module_h_m, gap_m, created_by
        ) values (
          ${workspaceId}::uuid, ${roofId}::uuid, 'h',
          ${`Gruppe ${index === 0 ? "A" : "B"}`},
          ${JSON.stringify(origin)}::jsonb,
          4, 6, 1.1, 1.75, 0.02, ${editorId}::uuid)
        returning id
      `);
      groupIds.push(created.rows[0]!.id);
    }
  });
  return {
    workspaceId,
    otherWorkspaceId,
    editorId,
    viewerId,
    projectId,
    siteId,
    sourceId,
    roofId,
    groupIds,
  };
}

describe("F3-04b Panel-Deselect — DB-Vertrag", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await seedFixture("F304b Fixture");
  });

  it("F304b-DB-01: Anlage 2 Zellen + reason", async () => {
    const groupId = fx.groupIds[0]!;
    const first = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_panel_deselect (
          workspace_id, group_id, "row", "col", reason, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${groupId}::uuid, 1, 1,
          'Verschattung durch Gaube', ${fx.editorId}::uuid)
        returning id
      `),
    );
    expect(first.rows).toHaveLength(1);
    const second = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_panel_deselect (
          workspace_id, group_id, "row", "col", reason, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${groupId}::uuid, 2, 3,
          null, ${fx.editorId}::uuid)
        returning id
      `),
    );
    expect(second.rows).toHaveLength(1);
    const reread = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ row: number; col: number; reason: string | null }>(sql`
        select "row", "col", reason from planning_panel_deselect
         where workspace_id = ${fx.workspaceId}::uuid
           and group_id = ${groupId}::uuid
         order by "row", "col"
      `),
    );
    expect(reread.rows).toHaveLength(2);
    expect(reread.rows[0]).toEqual({
      row: 1,
      col: 1,
      reason: "Verschattung durch Gaube",
    });
    expect(reread.rows[1]).toEqual({ row: 2, col: 3, reason: null });
  });

  it("F304b-DB-02: CHECK-Rejects (23514) — row 0, col -1", async () => {
    const groupId = fx.groupIds[0]!;
    const attempt = (row: number, col: number) =>
      pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_panel_deselect (
              workspace_id, group_id, "row", "col", reason, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${groupId}::uuid, ${row}, ${col},
              null, ${fx.editorId}::uuid)
          `),
        ),
      );
    expect(await attempt(0, 1), "row 0").toBe("23514");
    expect(await attempt(1, -1), "col -1").toBe("23514");
  });

  it("F304b-DB-03: UNIQUE-Reject (23505) — Doppel-Abwahl gleiche Zelle", async () => {
    const groupId = fx.groupIds[0]!;
    await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute(sql`
        insert into planning_panel_deselect (
          workspace_id, group_id, "row", "col", reason, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${groupId}::uuid, 1, 1,
          null, ${fx.editorId}::uuid)
      `),
    );
    expect(
      await pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_panel_deselect (
              workspace_id, group_id, "row", "col", reason, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${groupId}::uuid, 1, 1,
              'zweite Begruendung', ${fx.editorId}::uuid)
          `),
        ),
      ),
      "Doppel-Abwahl derselben Zelle muss UNIQUE-Reject sein",
    ).toBe("23505");
  });

  it("F304b-DB-04: Fremd-Ref-Reject (FK 23503) — ghost-group", async () => {
    expect(
      await pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_panel_deselect (
              workspace_id, group_id, "row", "col", reason, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${randomUUID()}::uuid, 1, 1,
              null, ${fx.editorId}::uuid)
          `),
        ),
      ),
      "Geist-Gruppe muss FK-Reject sein",
    ).toBe("23503");
  });

  it("F304b-DB-05: Service-Fläche (RED) — NotFound + RBAC + Idempotenz", async () => {
    const deselectModule = await import("@/modules/planning/" + "panel-deselect");
    const groupId = fx.groupIds[0]!;
    await expect(
      withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
        deselectModule.deselect(tx, ctx, {
          groupId: randomUUID(),
          row: 1,
          col: 1,
        })),
      "Geist-Gruppe muss NotFound sein",
    ).rejects.toMatchObject({ name: "PlanningPanelDeselectNotFoundError" });
    await expect(
      withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, (tx, ctx) =>
        deselectModule.deselect(tx, ctx, {
          groupId,
          row: 1,
          col: 1,
        })),
      "Viewer-Write muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
    await withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
      deselectModule.deselect(tx, ctx, { groupId, row: 2, col: 2 }),
    );
    await withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
      deselectModule.deselect(tx, ctx, { groupId, row: 2, col: 2 }),
    );
    const counted = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ n: string }>(sql`
        select count(*)::text as n from planning_panel_deselect
         where workspace_id = ${fx.workspaceId}::uuid
           and group_id = ${groupId}::uuid
           and "row" = 2 and "col" = 2
      `),
    );
    expect(counted.rows[0]!.n).toBe("1");
  });

  it("F304b-DB-06: Fremdtenant-Leere", async () => {
    const groupId = fx.groupIds[0]!;
    await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute(sql`
        insert into planning_panel_deselect (
          workspace_id, group_id, "row", "col", reason, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${groupId}::uuid, 1, 1,
          null, ${fx.editorId}::uuid)
      `),
    );
    const foreign = await withTenantOn(testPool, fx.otherWorkspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from planning_panel_deselect
         where workspace_id = ${fx.otherWorkspaceId}::uuid
      `),
    );
    expect(foreign.rows).toHaveLength(0);
  });
});
