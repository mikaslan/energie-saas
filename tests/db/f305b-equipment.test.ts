import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { testPool } from "../setup/test-db";

/**
 * F3-05b String-Equipment — DB-RED.
 * Vertrag: docs/spec/F3-05b-equipment.md (Tabelle fehlt → 42P01-RED).
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
      values (${editorId}::uuid, ${`editor-${editorId}@f305b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f305b.test`})
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
        ${`${contactId}@f305b.test`}, ${`${contactId}@f305b.test`})
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
        ${JSON.stringify([{ group_id: groupIds[0] }])}::jsonb, ${editorId}::uuid)
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
    groupIds,
    inverterId,
    stringId,
  };
}

describe("F3-05b String-Equipment — DB-Vertrag", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await seedFixture("F305b Fixture");
  });

  it("F305b-DB-01: Anlage Optimierer (scope=string) + Mikro (scope=panel)", async () => {
    const optimizer = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_string_equipment (
          workspace_id, string_id, scope, panel_ref_json, equipment, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${fx.stringId}::uuid, 'string', null,
          'optimizer', ${fx.editorId}::uuid)
        returning id
      `),
    );
    expect(optimizer.rows).toHaveLength(1);
    const panelRef = { group_id: fx.groupIds[0], row: 1, col: 1 };
    const micro = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_string_equipment (
          workspace_id, string_id, scope, panel_ref_json, equipment, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${fx.stringId}::uuid, 'panel',
          ${JSON.stringify(panelRef)}::jsonb,
          'micro_inverter', ${fx.editorId}::uuid)
        returning id
      `),
    );
    expect(micro.rows).toHaveLength(1);
    const reread = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ scope: string; panel_ref_json: unknown; equipment: string }>(sql`
        select scope, panel_ref_json, equipment from planning_string_equipment
         where workspace_id = ${fx.workspaceId}::uuid
           and string_id = ${fx.stringId}::uuid
         order by equipment
      `),
    );
    expect(reread.rows).toHaveLength(2);
    expect(reread.rows[0]).toEqual({
      scope: "panel",
      panel_ref_json: panelRef,
      equipment: "micro_inverter",
    });
    expect(reread.rows[1]).toEqual({
      scope: "string",
      panel_ref_json: null,
      equipment: "optimizer",
    });
  });

  it("F305b-DB-02: CHECK-Rejects (23514)", async () => {
    const panelRef = { group_id: fx.groupIds[0], row: 1, col: 1 };
    const attempt = (scope: string, equipment: string, panelRefJson: string | null) =>
      pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_string_equipment (
              workspace_id, string_id, scope, panel_ref_json, equipment, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${fx.stringId}::uuid, ${scope},
              ${panelRefJson}::jsonb,
              ${equipment}, ${fx.editorId}::uuid)
          `),
        ),
      );
    expect(await attempt("x", "optimizer", null), "scope 'x'").toBe("23514");
    expect(await attempt("string", "x", null), "equipment 'x'").toBe("23514");
    expect(
      await attempt("string", "optimizer", JSON.stringify(panelRef)),
      "string+panel_ref",
    ).toBe("23514");
    expect(await attempt("panel", "optimizer", null), "panel ohne panel_ref").toBe("23514");
    expect(await attempt("string", "micro_inverter", null), "micro+string").toBe("23514");
    expect(
      await attempt(
        "panel",
        "micro_inverter",
        JSON.stringify({ group_id: fx.groupIds[0], row: 0, col: 1 }),
      ),
      "row 0",
    ).toBe("23514");
  });

  it("F305b-DB-03: Fremd-Ref-Reject (FK 23503)", async () => {
    expect(
      await pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_string_equipment (
              workspace_id, string_id, scope, panel_ref_json, equipment, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${randomUUID()}::uuid, 'string', null,
              'optimizer', ${fx.editorId}::uuid)
          `),
        ),
      ),
      "Geist-String muss FK-Reject sein",
    ).toBe("23503");
  });

  it("F305b-DB-04: Service-Fläche (RED) — NotFound + RBAC", async () => {
    const equipment = await import("@/modules/planning/" + "string-equipment");
    await expect(
      withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
        equipment.attachEquipment(tx, ctx, {
          stringId: randomUUID(),
          scope: "string",
          equipment: "optimizer",
        })),
      "Geist-String muss NotFound sein",
    ).rejects.toMatchObject({ name: "PlanningStringEquipmentNotFoundError" });
    await expect(
      withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, (tx, ctx) =>
        equipment.attachEquipment(tx, ctx, {
          stringId: fx.stringId,
          scope: "string",
          equipment: "optimizer",
        })),
      "Viewer-Write muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
  });

  it("F305b-DB-05: Fremdtenant-Leere", async () => {
    await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute(sql`
        insert into planning_string_equipment (
          workspace_id, string_id, scope, panel_ref_json, equipment, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${fx.stringId}::uuid, 'string', null,
          'optimizer', ${fx.editorId}::uuid)
      `),
    );
    const foreign = await withTenantOn(testPool, fx.otherWorkspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from planning_string_equipment
         where workspace_id = ${fx.otherWorkspaceId}::uuid
      `),
    );
    expect(foreign.rows).toHaveLength(0);
  });
});
