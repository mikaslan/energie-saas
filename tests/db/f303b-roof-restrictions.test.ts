import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { testPool } from "../setup/test-db";

/**
 * F3-03b Sperrzonen — DB-RED.
 * Vertrag: docs/spec/F3-03b-sperrzonen.md (Tabelle fehlt → 42P01-RED).
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
      values (${editorId}::uuid, ${`editor-${editorId}@f303b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f303b.test`})
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
        ${`${contactId}@f303b.test`}, ${`${contactId}@f303b.test`})
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
  return { workspaceId, otherWorkspaceId, editorId, viewerId, projectId, siteId, sourceId, roofId };
}

describe("F3-03b Dach-Sperrzonen — DB-Vertrag", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await seedFixture("F303b Fixture");
  });

  it("F303b-DB-01: Anlage Rechteck (alle Kinds)", async () => {
    for (const kind of ["chimney", "window", "other"]) {
      const created = await withTenantOn(testPool, fx.workspaceId, (tx) =>
        tx.execute<{ id: string }>(sql`
          insert into planning_roof_restriction (
            workspace_id, roof_id, kind, label, rect_json, height_m, created_by
          ) values (
            ${fx.workspaceId}::uuid, ${fx.roofId}::uuid, ${kind},
            ${`Sperre ${kind}`},
            ${JSON.stringify({ x: 1, y: 1, width: 2, height: 1 })}::jsonb,
            1.5, ${fx.editorId}::uuid)
          returning id
        `),
      );
      expect(created.rows).toHaveLength(1);
    }
  });

  it("F303b-DB-02: kind-/Maß-Rejects (23514)", async () => {
    const attempt = (kind: string, rect: object, height: number | null) =>
      pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_roof_restriction (
              workspace_id, roof_id, kind, label, rect_json, height_m, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${fx.roofId}::uuid, ${kind}, 'X',
              ${JSON.stringify(rect)}::jsonb, ${height}, ${fx.editorId}::uuid)
          `),
        ),
      );
    expect(await attempt("dormer", { x: 1, y: 1, width: 2, height: 1 }, null)).toBe("23514");
    expect(await attempt("chimney", { x: 1, y: 1, width: 0, height: 1 }, null)).toBe("23514");
    expect(await attempt("chimney", { x: 1, y: 1, width: 2, height: -1 }, null)).toBe("23514");
    expect(await attempt("chimney", { x: 1, y: 1, width: 2, height: 1 }, 51)).toBe("23514");
    expect(await attempt("chimney", { x: 1, y: 1, width: 2, height: 1 }, -1)).toBe("23514");
  });

  it("F303b-DB-03: Fremddach-Reject (FK 23503)", async () => {
    expect(
      await pgCodeOf(
        withTenantOn(testPool, fx.workspaceId, (tx) =>
          tx.execute(sql`
            insert into planning_roof_restriction (
              workspace_id, roof_id, kind, label, rect_json, created_by
            ) values (
              ${fx.workspaceId}::uuid, ${randomUUID()}::uuid, 'window', 'X',
              ${JSON.stringify({ x: 1, y: 1, width: 2, height: 1 })}::jsonb, ${fx.editorId}::uuid)
          `),
        ),
      ),
    ).toBe("23503");
  });

  it("F303b-DB-04: Service-Fläche (GREEN) — NotFound + RBAC", async () => {
    const restrictions = await import("@/modules/planning/" + "roof-restrictions");
    await expect(
      withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
        restrictions.createRestriction(tx, ctx, {
          roofId: randomUUID(),
          kind: "other",
          label: "Geist",
          rect: { x: 1, y: 1, width: 1, height: 1 },
        })),
      "Fremddach muss NotFound sein",
    ).rejects.toMatchObject({ name: "PlanningRoofRestrictionNotFoundError" });
    await expect(
      withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, (tx, ctx) =>
        restrictions.createRestriction(tx, ctx, {
          roofId: fx.roofId,
          kind: "other",
          label: "Viewer",
          rect: { x: 1, y: 1, width: 1, height: 1 },
        })),
      "Viewer-Write muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
  });

  it("F303b-DB-06: Service-Remove (GREEN) — Anlage, Loeschen, NotFound danach", async () => {
    const restrictions: typeof import("@/modules/planning/roof-restrictions") =
      await import("@/modules/planning/" + "roof-restrictions");
    const created = await withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
      restrictions.createRestriction(tx, ctx, {
        roofId: fx.roofId,
        kind: "window",
        label: "Weg damit",
        rect: { x: 1, y: 1, width: 2, height: 1 },
      }));
    expect(created.kind).toBe("window");
    const removed = await withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
      restrictions.removeRestriction(tx, ctx, { id: created.id }));
    expect(removed).toEqual({ id: created.id });
    await expect(
      withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
        restrictions.getRestriction(tx, ctx, { id: created.id })),
      "Geloeschte Sperrzone muss NotFound sein",
    ).rejects.toMatchObject({ name: "PlanningRoofRestrictionNotFoundError" });
    await expect(
      withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, (tx, ctx) =>
        restrictions.removeRestriction(tx, ctx, { id: created.id })),
      "Viewer-Remove muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
  });

  it("F303b-DB-05: Fremdtenant-Leere", async () => {
    await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute(sql`
        insert into planning_roof_restriction (
          workspace_id, roof_id, kind, label, rect_json, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${fx.roofId}::uuid, 'other', 'A',
          ${JSON.stringify({ x: 1, y: 1, width: 1, height: 1 })}::jsonb, ${fx.editorId}::uuid)
      `),
    );
    const foreign = await withTenantOn(testPool, fx.otherWorkspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        select id from planning_roof_restriction
         where workspace_id = ${fx.otherWorkspaceId}::uuid
      `),
    );
    expect(foreign.rows).toHaveLength(0);
  });
});
