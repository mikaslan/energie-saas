import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { testPool } from "../setup/test-db";

/**
 * F3-05c String-Zell-Ranges — DB-RED.
 * vertrag: docs/spec/F3-05c-members.md (Tabelle fehlt → 42P01-RED).
 * tabelle (0277 zentral, exakt): planning_string_member
 * (workspace_id, string_id, group_id, row_from, row_to,
 *  col_from, col_to, created_by).
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
  groupId: string;
  inverterId: string;
  stringId: string;
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
      values (${editorId}::uuid, ${`editor-${editorId}@f305c.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f305c.test`})
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
        ${`${contactId}@f305c.test`}, ${`${contactId}@f305c.test`})
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
  const group = await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into planning_panel_group (
        workspace_id, roof_id, kind, label, origin_json,
        rows, cols, module_w_m, module_h_m, gap_m, created_by
      ) values (
        ${workspaceId}::uuid, ${roofId}::uuid, 'h',
        'Gruppe A',
        ${JSON.stringify({ x: 1, y: 1 })}::jsonb,
        4, 6, 1.1, 1.75, 0.02, ${editorId}::uuid)
      returning id
    `),
  );
  const groupId = group.rows[0]!.id;
  const inverter = await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into planning_inverter (
        workspace_id, project_id, label, mpp_trackers, max_string_modules, created_by
      ) values (
        ${workspaceId}::uuid, ${projectId}::uuid, 'WR 1',
        2, 24, ${editorId}::uuid)
      returning id
    `),
  );
  const inverterId = inverter.rows[0]!.id;
  const createdString = await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into planning_string (
        workspace_id, inverter_id, tracker_slot, label, member_json, created_by
      ) values (
        ${workspaceId}::uuid, ${inverterId}::uuid, 1, 'String 1',
        ${JSON.stringify([{ group_id: groupId }])}::jsonb, ${editorId}::uuid)
      returning id
    `),
  );
  const stringId = createdString.rows[0]!.id;
  return {
    workspaceId,
    otherWorkspaceId,
    editorId,
    viewerId,
    projectId,
    siteId,
    sourceId,
    roofId,
    groupId,
    inverterId,
    stringId,
  };
}

describe("F3-05c String-Zell-Ranges — DB-Vertrag", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await seedFixture("F305c Fixture");
  });

  it("F305c-DB-01: Anlage Range-Haelfte (rows 1-2, cols 1-6)", async () => {
    const created = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_string_member (
          workspace_id, string_id, group_id,
          row_from, row_to, col_from, col_to, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${fx.stringId}::uuid, ${fx.groupId}::uuid,
          1, 2, 1, 6, ${fx.editorId}::uuid)
        returning id
      `),
    );
    expect(created.rows).toHaveLength(1);
    const reread = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{
        row_from: number;
        row_to: number;
        col_from: number;
        col_to: number;
      }>(sql`
        select row_from, row_to, col_from, col_to from planning_string_member
         where workspace_id = ${fx.workspaceId}::uuid
           and id = ${created.rows[0]!.id}::uuid
      `),
    );
    expect(reread.rows[0]).toEqual({
      row_from: 1,
      row_to: 2,
      col_from: 1,
      col_to: 6,
    });
  });

  it("F305c-DB-02: CHECK-Rejects (23514) — row_from 0, row_from>row_to, col_to 0", async () => {
    const attempt = (rowFrom: number, rowTo: number, colFrom: number, colTo: number) =>
      pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_string_member (
              workspace_id, string_id, group_id,
              row_from, row_to, col_from, col_to, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${fx.stringId}::uuid, ${fx.groupId}::uuid,
              ${rowFrom}, ${rowTo}, ${colFrom}, ${colTo}, ${fx.editorId}::uuid)
          `),
        ),
      );
    expect(await attempt(0, 2, 1, 6), "row_from 0").toBe("23514");
    expect(await attempt(3, 2, 1, 6), "row_from>row_to").toBe("23514");
    expect(await attempt(1, 2, 1, 0), "col_to 0").toBe("23514");
  });

  it("F305c-DB-03: Fremd-Ref-Reject (FK 23503) — ghost-string, ghost-group", async () => {
    expect(
      await pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_string_member (
              workspace_id, string_id, group_id,
              row_from, row_to, col_from, col_to, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${randomUUID()}::uuid, ${fx.groupId}::uuid,
              1, 2, 1, 6, ${fx.editorId}::uuid)
          `),
        ),
      ),
      "Geist-String muss FK-Reject sein",
    ).toBe("23503");
    expect(
      await pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_string_member (
              workspace_id, string_id, group_id,
              row_from, row_to, col_from, col_to, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${fx.stringId}::uuid, ${randomUUID()}::uuid,
              1, 2, 1, 6, ${fx.editorId}::uuid)
          `),
        ),
      ),
      "Geist-Gruppe muss FK-Reject sein",
    ).toBe("23503");
  });

  it("F305c-DB-04: Service-Fläche (RED) — NotFound + RBAC + Regeln", async () => {
    const members = await import("@/modules/planning/" + "string-members");
    await expect(
      withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
        members.addMember(tx, ctx, {
          stringId: randomUUID(),
          groupId: fx.groupId,
          rowFrom: 1,
          rowTo: 2,
          colFrom: 1,
          colTo: 6,
        })),
      "Geist-String muss NotFound sein",
    ).rejects.toMatchObject({ name: "PlanningStringMemberNotFoundError" });
    await expect(
      withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, (tx, ctx) =>
        members.addMember(tx, ctx, {
          stringId: fx.stringId,
          groupId: fx.groupId,
          rowFrom: 1,
          rowTo: 2,
          colFrom: 1,
          colTo: 6,
        })),
      "Viewer-Write muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
    await expect(
      withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
        members.addMember(tx, ctx, {
          stringId: fx.stringId,
          groupId: fx.groupId,
          rowFrom: 1,
          rowTo: 99,
          colFrom: 1,
          colTo: 6,
        })),
      "Range ueber Raster muss ValidationError sein",
    ).rejects.toMatchObject({ name: "PlanningStringMemberValidationError" });
    await withTenantOn(testPool, fx.workspaceId, async (tx) => {
      for (let row = 3; row <= 4; row += 1) {
        for (let col = 1; col <= 6; col += 1) {
          await tx.execute(sql`
            insert into planning_panel_deselect (
              workspace_id, group_id, "row", "col", reason, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${fx.groupId}::uuid, ${row}, ${col},
              null, ${fx.editorId}::uuid)
          `);
        }
      }
    });
    await expect(
      withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
        members.addMember(tx, ctx, {
          stringId: fx.stringId,
          groupId: fx.groupId,
          rowFrom: 3,
          rowTo: 4,
          colFrom: 1,
          colTo: 6,
        })),
      "Voll-Deselect-Range muss ValidationError sein",
    ).rejects.toMatchObject({ name: "PlanningStringMemberValidationError" });
    await withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
      members.addMember(tx, ctx, {
        stringId: fx.stringId,
        groupId: fx.groupId,
        rowFrom: 1,
        rowTo: 2,
        colFrom: 1,
        colTo: 6,
      }),
    );
    await expect(
      withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
        members.addMember(tx, ctx, {
          stringId: fx.stringId,
          groupId: fx.groupId,
          rowFrom: 2,
          rowTo: 3,
          colFrom: 1,
          colTo: 6,
        })),
      "Overlap im String muss ValidationError sein",
    ).rejects.toMatchObject({ name: "PlanningStringMemberValidationError" });
  });

  it("F305c-DB-05: Fremdtenant-Leere", async () => {
    await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute(sql`
        insert into planning_string_member (
          workspace_id, string_id, group_id,
          row_from, row_to, col_from, col_to, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${fx.stringId}::uuid, ${fx.groupId}::uuid,
          1, 2, 1, 6, ${fx.editorId}::uuid)
      `),
    );
    const foreign = await withTenantOn(testPool, fx.otherWorkspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from planning_string_member
         where workspace_id = ${fx.otherWorkspaceId}::uuid
      `),
    );
    expect(foreign.rows).toHaveLength(0);
  });
});
