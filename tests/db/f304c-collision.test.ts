import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import * as groups from "@/modules/planning/panel-groups";
import * as restrictions from "@/modules/planning/roof-restrictions";
import { testPool } from "../setup/test-db";

/**
 * F3-04c Belegung-vs-Sperrzonen-Kollision — DB-RED.
 * vertrag: docs/spec/F3-04c-collision.md (Stufe-0, advisory-only,
 * migrationslos: KEINE neue Tabelle, daher KEIN 42P01-RED —
 * Assert-RED auf DTO-Felder, heute undefined).
 * Muster: tests/db/f305d-effective.test.ts (Assert-RED-Stil,
 * Fixture-Kette, withAuthorizedTenantOn/withTenantOn).
 * gelesene Signaturen (modules/planning/panel-groups.ts):
 * - listPanelGroups(tx, ctx, roofId: string)
 * - getPanelGroup(tx, ctx, id: string)
 * gelesene Signaturen (modules/planning/roof-restrictions.ts):
 * - listRestrictions(tx, ctx, query: { roofId: string })
 *   (heisst listRestrictions, nicht listRoofRestrictions)
 * heute-DTOs ohne F3-04c-Felder: PlanningPanelGroupDto hat KEIN
 * `collisions`, PlanningRoofRestrictionDto hat KEIN `collidingGroups`.
 * ziel (GREEN): collisions [{restrictionId, kind, label}] +
 * collidingGroups [{groupId, label}], Schnitt > 0 auf Rechteck-Ebene.
 * seed-kette: Dach 10x6 + Sperrzone Schornstein {x:1,y:1,w:2,h:1}
 * (belegt x 1..3, y 1..2) + Gruppe Kollision (h, Origin 0/0, rows 4,
 * cols 6, Modul 1.1/1.75, gap 0.02 → groupRect w 6.7 / h 7.06, also
 * x 0..6.7, y 0..7.06 schneidet Zone; Raw-SQL-Seed umgeht bewusst
 * die Polygon-Validierung) + Gruppe sauber (h, Origin 8/4, 1x1,
 * Modul 1.1/1.75 → x 8..9.1, y 4..5.75: innerhalb Dach-Polygon,
 * kein Schnitt mit Zone).
 * RED-Erwartung: DB-01 + DB-02 + DB-03 fallen (Felder undefined);
 * DB-04 faellt im Viewer-Teil, External-Teil pinnt Legacy-Verhalten
 * (PermissionDeniedError) und bleibt gruen.
 */

type Fixture = {
  workspaceId: string;
  otherWorkspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  projectId: string;
  siteId: string;
  sourceId: string;
  roofId: string;
  restrictionId: string;
  groupId: string;
  cleanGroupId: string;
};

type CollisionEntry = {
  restrictionId: string;
  kind: string;
  label: string;
};

type CollidingGroupEntry = {
  groupId: string;
  label: string;
};

const RECTANGLE = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 6 },
  { x: 0, y: 6 },
];

const CHIMNEY_RECT = { x: 1, y: 1, width: 2, height: 1 };
const CHIMNEY_LABEL = "Schornstein";
const HIT_LABEL = "Gruppe Kollision";
const CLEAN_LABEL = "Gruppe sauber";

async function seedFixture(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f304c.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f304c.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f304c.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
              'viewer', '{"external_only":true}'::jsonb)
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
        ${`${contactId}@f304c.test`}, ${`${contactId}@f304c.test`})
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
  const restriction = await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into planning_roof_restriction (
        workspace_id, roof_id, kind, label, rect_json, height_m, created_by
      ) values (
        ${workspaceId}::uuid, ${roofId}::uuid, 'chimney',
        ${CHIMNEY_LABEL},
        ${JSON.stringify(CHIMNEY_RECT)}::jsonb,
        1.5, ${editorId}::uuid)
      returning id
    `),
  );
  const restrictionId = restriction.rows[0]!.id;
  const hit = await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into planning_panel_group (
        workspace_id, roof_id, kind, label, origin_json,
        rows, cols, module_w_m, module_h_m, gap_m, created_by
      ) values (
        ${workspaceId}::uuid, ${roofId}::uuid, 'h',
        ${HIT_LABEL},
        ${JSON.stringify({ x: 0, y: 0 })}::jsonb,
        4, 6, 1.1, 1.75, 0.02, ${editorId}::uuid)
      returning id
    `),
  );
  const groupId = hit.rows[0]!.id;
  const clean = await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute<{ id: string }>(sql`
      insert into planning_panel_group (
        workspace_id, roof_id, kind, label, origin_json,
        rows, cols, module_w_m, module_h_m, gap_m, created_by
      ) values (
        ${workspaceId}::uuid, ${roofId}::uuid, 'h',
        ${CLEAN_LABEL},
        ${JSON.stringify({ x: 8, y: 4 })}::jsonb,
        1, 1, 1.1, 1.75, 0.02, ${editorId}::uuid)
      returning id
    `),
  );
  const cleanGroupId = clean.rows[0]!.id;
  return {
    workspaceId,
    otherWorkspaceId,
    editorId,
    viewerId,
    externalId,
    projectId,
    siteId,
    sourceId,
    roofId,
    restrictionId,
    groupId,
    cleanGroupId,
  };
}

function collisionsRaw(dto: unknown): unknown {
  return (dto as { collisions?: unknown }).collisions;
}

function collidingGroupsRaw(dto: unknown): unknown {
  return (dto as { collidingGroups?: unknown }).collidingGroups;
}

describe("F3-04c Belegung-vs-Sperrzonen-Kollision — DB-Vertrag", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await seedFixture("F304c Fixture");
  });

  it("F304c-DB-01: listPanelGroups → Gruppe über Zone meldet collisions, saubere Gruppe leer", async () => {
    const items = await withAuthorizedTenantOn(
      testPool,
      fx.editorId,
      fx.workspaceId,
      (tx, ctx) => groups.listPanelGroups(tx, ctx, fx.roofId),
    );
    const hit = items.find((item) => item.id === fx.groupId);
    const clean = items.find((item) => item.id === fx.cleanGroupId);
    expect(hit).toBeDefined();
    expect(clean).toBeDefined();
    const hitCollisions = collisionsRaw(hit);
    expect(Array.isArray(hitCollisions)).toBe(true);
    expect(hitCollisions as CollisionEntry[]).toContainEqual({
      restrictionId: fx.restrictionId,
      kind: "chimney",
      label: CHIMNEY_LABEL,
    });
    const cleanCollisions = collisionsRaw(clean);
    expect(Array.isArray(cleanCollisions)).toBe(true);
    expect(cleanCollisions as CollisionEntry[]).toHaveLength(0);
  });

  it("F304c-DB-02: getPanelGroup → dto.collisions befüllt (Kollision) bzw. leer (sauber)", async () => {
    const hit = await withAuthorizedTenantOn(
      testPool,
      fx.editorId,
      fx.workspaceId,
      (tx, ctx) => groups.getPanelGroup(tx, ctx, fx.groupId),
    );
    const hitCollisions = collisionsRaw(hit);
    expect(Array.isArray(hitCollisions)).toBe(true);
    expect(hitCollisions as CollisionEntry[]).toContainEqual({
      restrictionId: fx.restrictionId,
      kind: "chimney",
      label: CHIMNEY_LABEL,
    });
    const clean = await withAuthorizedTenantOn(
      testPool,
      fx.editorId,
      fx.workspaceId,
      (tx, ctx) => groups.getPanelGroup(tx, ctx, fx.cleanGroupId),
    );
    const cleanCollisions = collisionsRaw(clean);
    expect(Array.isArray(cleanCollisions)).toBe(true);
    expect(cleanCollisions as CollisionEntry[]).toHaveLength(0);
  });

  it("F304c-DB-03: listRestrictions → Zone meldet collidingGroups symmetrisch", async () => {
    const zones = await withAuthorizedTenantOn(
      testPool,
      fx.editorId,
      fx.workspaceId,
      (tx, ctx) => restrictions.listRestrictions(tx, ctx, { roofId: fx.roofId }),
    );
    const zone = zones.find((entry) => entry.id === fx.restrictionId);
    expect(zone).toBeDefined();
    const raw = collidingGroupsRaw(zone);
    expect(Array.isArray(raw)).toBe(true);
    const list = raw as CollidingGroupEntry[];
    expect(list).toContainEqual({ groupId: fx.groupId, label: HIT_LABEL });
    expect(
      list.find((entry) => entry.groupId === fx.cleanGroupId),
      "saubere Gruppe darf nicht als kollidierend gemeldet werden",
    ).toBeUndefined();
  });

  it("F304c-DB-04: RBAC — Viewer liest collisions/collidingGroups, External fail-closed", async () => {
    const items = await withAuthorizedTenantOn(
      testPool,
      fx.viewerId,
      fx.workspaceId,
      (tx, ctx) => groups.listPanelGroups(tx, ctx, fx.roofId),
    );
    const hit = items.find((item) => item.id === fx.groupId);
    expect(hit).toBeDefined();
    expect(Array.isArray(collisionsRaw(hit))).toBe(true);
    const dto = await withAuthorizedTenantOn(
      testPool,
      fx.viewerId,
      fx.workspaceId,
      (tx, ctx) => groups.getPanelGroup(tx, ctx, fx.groupId),
    );
    expect(Array.isArray(collisionsRaw(dto))).toBe(true);
    const zones = await withAuthorizedTenantOn(
      testPool,
      fx.viewerId,
      fx.workspaceId,
      (tx, ctx) => restrictions.listRestrictions(tx, ctx, { roofId: fx.roofId }),
    );
    const zone = zones.find((entry) => entry.id === fx.restrictionId);
    expect(zone).toBeDefined();
    expect(Array.isArray(collidingGroupsRaw(zone))).toBe(true);
    await expect(
      withAuthorizedTenantOn(testPool, fx.externalId, fx.workspaceId, (tx, ctx) =>
        groups.listPanelGroups(tx, ctx, fx.roofId)),
      "External-Read muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
    await expect(
      withAuthorizedTenantOn(testPool, fx.externalId, fx.workspaceId, (tx, ctx) =>
        groups.getPanelGroup(tx, ctx, fx.groupId)),
      "External-Read muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
    await expect(
      withAuthorizedTenantOn(testPool, fx.externalId, fx.workspaceId, (tx, ctx) =>
        restrictions.listRestrictions(tx, ctx, { roofId: fx.roofId })),
      "External-Read muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
  });
});
