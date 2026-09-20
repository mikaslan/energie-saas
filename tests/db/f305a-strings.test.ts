import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { testPool } from "../setup/test-db";

/**
 * F3-05a Stringplanung — DB-RED.
 * Vertrag: docs/spec/F3-05a-strings.md (Tabellen fehlen → 42P01-RED).
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
      values (${editorId}::uuid, ${`editor-${editorId}@f305a.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f305a.test`})
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
        ${`${contactId}@f305a.test`}, ${`${contactId}@f305a.test`})
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
  return { workspaceId, otherWorkspaceId, editorId, viewerId, projectId, siteId, sourceId, roofId, groupIds };
}

describe("F3-05a Stringplanung — DB-Vertrag", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await seedFixture("F305a Fixture");
  });

  it("F305a-DB-01: Anlage WR + String (2 Members aus 2 Gruppen)", async () => {
    const inverter = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_inverter (
          workspace_id, project_id, label, mpp_trackers, max_string_modules, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${fx.projectId}::uuid, 'WR 1',
          2, 24, ${fx.editorId}::uuid)
        returning id
      `),
    );
    expect(inverter.rows).toHaveLength(1);
    const inverterId = inverter.rows[0]!.id;
    const members = [{ group_id: fx.groupIds[0] }, { group_id: fx.groupIds[1] }];
    const created = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_string (
          workspace_id, inverter_id, tracker_slot, label, member_json, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${inverterId}::uuid, 1, 'String 1',
          ${JSON.stringify(members)}::jsonb, ${fx.editorId}::uuid)
        returning id
      `),
    );
    expect(created.rows).toHaveLength(1);
    const reread = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ member_json: unknown }>(sql`
        select member_json from planning_string
         where workspace_id = ${fx.workspaceId}::uuid
           and id = ${created.rows[0]!.id}::uuid
      `),
    );
    expect(reread.rows[0]!.member_json).toEqual(members);
  });

  it("F305a-DB-02: CHECK-Rejects (23514)", async () => {
    const inverter = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_inverter (
          workspace_id, project_id, label, mpp_trackers, max_string_modules, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${fx.projectId}::uuid, 'WR gueltig',
          2, 24, ${fx.editorId}::uuid)
        returning id
      `),
    );
    const inverterId = inverter.rows[0]!.id;
    const validMembers = [{ group_id: fx.groupIds[0] }];

    const inverterAttempt = (mppTrackers: number, label: string) =>
      pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_inverter (
              workspace_id, project_id, label, mpp_trackers, max_string_modules, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${fx.projectId}::uuid, ${label},
              ${mppTrackers}, 24, ${fx.editorId}::uuid)
          `),
        ),
      );
    expect(await inverterAttempt(0, "WR mpp 0")).toBe("23514");
    expect(await inverterAttempt(13, "WR mpp 13")).toBe("23514");
    expect(await inverterAttempt(2, "")).toBe("23514");

    const stringAttempt = (trackerSlot: number, memberJson: unknown, label: string) =>
      pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_string (
              workspace_id, inverter_id, tracker_slot, label, member_json, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${inverterId}::uuid, ${trackerSlot}, ${label},
              ${JSON.stringify(memberJson)}::jsonb, ${fx.editorId}::uuid)
          `),
        ),
      );
    expect(await stringAttempt(0, validMembers, "String slot 0")).toBe("23514");
    expect(await stringAttempt(1, [], "String leer")).toBe("23514");
    expect(await stringAttempt(1, [{}], "String ohne group_id")).toBe("23514");
    expect(await stringAttempt(1, validMembers, "")).toBe("23514");
  });

  it("F305a-DB-03: Fremd-Ref-Reject (FK 23503)", async () => {
    expect(
      await pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_inverter (
              workspace_id, project_id, label, mpp_trackers, max_string_modules, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${randomUUID()}::uuid, 'WR Geist-Projekt',
              2, 24, ${fx.editorId}::uuid)
          `),
        ),
      ),
      "Geist-Projekt muss FK-Reject sein",
    ).toBe("23503");
    expect(
      await pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_string (
              workspace_id, inverter_id, tracker_slot, label, member_json, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${randomUUID()}::uuid, 1, 'String Geist-WR',
              ${JSON.stringify([{ group_id: fx.groupIds[0] }])}::jsonb,
              ${fx.editorId}::uuid)
          `),
        ),
      ),
      "Geist-WR muss FK-Reject sein",
    ).toBe("23503");
  });

  it("F305a-DB-04: Service-Fläche (RED) — NotFound + RBAC", async () => {
    const strings = await import("@/modules/planning/" + "strings");
    const inverter = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_inverter (
          workspace_id, project_id, label, mpp_trackers, max_string_modules, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${fx.projectId}::uuid, 'WR RBAC',
          2, 24, ${fx.editorId}::uuid)
        returning id
      `),
    );
    const inverterId = inverter.rows[0]!.id;
    await expect(
      withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
        strings.createString(tx, ctx, {
          inverterId: randomUUID(),
          trackerSlot: 1,
          label: "Geist",
          members: [{ groupId: fx.groupIds[0] }],
        })),
      "Geist-WR muss NotFound sein",
    ).rejects.toMatchObject({ name: "PlanningStringNotFoundError" });
    await expect(
      withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, (tx, ctx) =>
        strings.createInverter(tx, ctx, {
          projectId: fx.projectId,
          label: "Viewer-WR",
          mppTrackers: 2,
          maxStringModules: 24,
        })),
      "Viewer-WR-Write muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
    await expect(
      withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, (tx, ctx) =>
        strings.createString(tx, ctx, {
          inverterId,
          trackerSlot: 1,
          label: "Viewer-String",
          members: [{ groupId: fx.groupIds[0] }],
        })),
      "Viewer-String-Write muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
  });

  it("F305a-DB-05: Fremdtenant-Leere", async () => {
    const inverter = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_inverter (
          workspace_id, project_id, label, mpp_trackers, max_string_modules, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${fx.projectId}::uuid, 'WR 1',
          2, 24, ${fx.editorId}::uuid)
        returning id
      `),
    );
    await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute(sql`
        insert into planning_string (
          workspace_id, inverter_id, tracker_slot, label, member_json, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${inverter.rows[0]!.id}::uuid, 1, 'String 1',
          ${JSON.stringify([{ group_id: fx.groupIds[0] }])}::jsonb,
          ${fx.editorId}::uuid)
      `),
    );
    const foreignInverters = await withTenantOn(testPool, fx.otherWorkspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from planning_inverter
         where workspace_id = ${fx.otherWorkspaceId}::uuid
      `),
    );
    expect(foreignInverters.rows).toHaveLength(0);
    const foreignStrings = await withTenantOn(testPool, fx.otherWorkspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from planning_string
         where workspace_id = ${fx.otherWorkspaceId}::uuid
      `),
    );
    expect(foreignStrings.rows).toHaveLength(0);
  });
});
