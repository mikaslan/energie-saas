import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import * as equipment from "@/modules/planning/string-equipment";
import * as strings from "@/modules/planning/strings";
import { testPool } from "../setup/test-db";

/**
 * F3-05d Effektive String-Advisories + Equipment×Deselect — DB-RED.
 * vertrag: docs/spec/F3-05d-effective.md (Stufe-0, migrationslos:
 * KEINE neue Tabelle, daher KEIN 42P01-RED — Assert-RED auf
 * Service-Verhalten via getString/listEquipment).
 * seed-kette: WR (mpp 2, max 5) + Gruppe h 2x3 (= 6 brutto) + String
 * + Range (volle 6: rows 1-2, cols 1-3) + 2 Deselects (1,1),(2,3)
 * → effektiv 4. Muster: tests/db/f305c-members.test.ts.
 * advisory-shape: { code, message } aus modules/planning/strings.ts
 * (aktuell), neuer Code 'equipment-on-deselected' aus F3-05d.
 * RED-Erwartung: DB-01 + DB-02 fallen (Brutto-Logik kennt weder
 * Deselect-Abzug noch Equipment-Code); DB-03 + DB-04 pinnen
 * Legacy-/RBAC-Verhalten und bleiben gruen.
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
  groupId: string;
  inverterId: string;
  stringId: string;
};

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
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f305d.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f305d.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f305d.test`})
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
        ${`${contactId}@f305d.test`}, ${`${contactId}@f305d.test`})
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
        2, 3, 1.1, 1.75, 0.02, ${editorId}::uuid)
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
        2, 5, ${editorId}::uuid)
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
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into planning_string_member (
        workspace_id, string_id, group_id,
        row_from, row_to, col_from, col_to, created_by
      ) values (
        ${workspaceId}::uuid, ${stringId}::uuid, ${groupId}::uuid,
        1, 2, 1, 3, ${editorId}::uuid)
    `);
    for (const [row, col] of [[1, 1], [2, 3]] as const) {
      await tx.execute(sql`
        insert into planning_panel_deselect (
          workspace_id, group_id, "row", "col", reason, created_by
        ) values (
          ${workspaceId}::uuid, ${groupId}::uuid, ${row}, ${col},
          null, ${editorId}::uuid)
      `);
    }
  });
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
    groupId,
    inverterId,
    stringId,
  };
}

function codesOf(dto: { advisories?: Array<{ code?: unknown }> | null }): string[] {
  return (dto.advisories ?? []).map((advisory) => String(advisory.code));
}

function equipmentCodes(item: unknown): string[] {
  const advisories = (item as { advisories?: Array<{ code?: unknown }> | null })
    .advisories;
  return (advisories ?? []).map((advisory) => String(advisory?.code));
}

describe("F3-05d Effektive Advisories — DB-Vertrag", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await seedFixture("F305d Fixture");
  });

  it("F305d-DB-01: Deselect in Range → kein 'over-length' (effektiv 4 ≤ 5)", async () => {
    const dto = await withAuthorizedTenantOn(
      testPool,
      fx.editorId,
      fx.workspaceId,
      (tx, ctx) => strings.getString(tx, ctx, fx.stringId),
    );
    expect(codesOf(dto)).not.toContain("over-length");
    // Kontrolle: engere Grenze → Code sichtbar (effektiv 4 > 3);
    // beweist, dass der Test 'over-length' sehen kann.
    await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute(sql`
        update planning_inverter set max_string_modules = 3
         where workspace_id = ${fx.workspaceId}::uuid
           and id = ${fx.inverterId}::uuid
      `),
    );
    const tight = await withAuthorizedTenantOn(
      testPool,
      fx.editorId,
      fx.workspaceId,
      (tx, ctx) => strings.getString(tx, ctx, fx.stringId),
    );
    expect(codesOf(tight)).toContain("over-length");
  });

  it("F305d-DB-02: Mikro auf abgewählter Zelle → 'equipment-on-deselected'", async () => {
    await withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, (tx, ctx) =>
      equipment.attachEquipment(tx, ctx, {
        stringId: fx.stringId,
        scope: "panel",
        panelRef: { groupId: fx.groupId, row: 1, col: 1 },
        equipment: "micro_inverter",
      }),
    );
    const dto = await withAuthorizedTenantOn(
      testPool,
      fx.editorId,
      fx.workspaceId,
      (tx, ctx) => strings.getString(tx, ctx, fx.stringId),
    );
    const items = await withAuthorizedTenantOn(
      testPool,
      fx.editorId,
      fx.workspaceId,
      (tx, ctx) => equipment.listEquipment(tx, ctx, fx.stringId),
    );
    const seen = [...codesOf(dto), ...items.flatMap(equipmentCodes)];
    expect(seen).toContain("equipment-on-deselected");
  });

  it("F305d-DB-03: Legacy-String ohne Ranges → volle Gruppe (6 > 5 → 'over-length')", async () => {
    const legacy = await withTenantOn(testPool, fx.workspaceId, (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into planning_string (
          workspace_id, inverter_id, tracker_slot, label, member_json, created_by
        ) values (
          ${fx.workspaceId}::uuid, ${fx.inverterId}::uuid, 2, 'String legacy',
          ${JSON.stringify([{ group_id: fx.groupId }])}::jsonb, ${fx.editorId}::uuid)
        returning id
      `),
    );
    const dto = await withAuthorizedTenantOn(
      testPool,
      fx.editorId,
      fx.workspaceId,
      (tx, ctx) => strings.getString(tx, ctx, legacy.rows[0]!.id),
    );
    expect(codesOf(dto)).toContain("over-length");
  });

  it("F305d-DB-04: RBAC — Viewer liest Advisories, External fail-closed", async () => {
    const dto = await withAuthorizedTenantOn(
      testPool,
      fx.viewerId,
      fx.workspaceId,
      (tx, ctx) => strings.getString(tx, ctx, fx.stringId),
    );
    expect(Array.isArray(dto.advisories)).toBe(true);
    const items = await withAuthorizedTenantOn(
      testPool,
      fx.viewerId,
      fx.workspaceId,
      (tx, ctx) => equipment.listEquipment(tx, ctx, fx.stringId),
    );
    expect(Array.isArray(items)).toBe(true);
    await expect(
      withAuthorizedTenantOn(testPool, fx.externalId, fx.workspaceId, (tx, ctx) =>
        strings.getString(tx, ctx, fx.stringId)),
      "External-Read muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
    await expect(
      withAuthorizedTenantOn(testPool, fx.externalId, fx.workspaceId, (tx, ctx) =>
        equipment.listEquipment(tx, ctx, fx.stringId)),
      "External-Read muss PermissionDenied sein",
    ).rejects.toMatchObject({ name: "PermissionDeniedError" });
  });
});
