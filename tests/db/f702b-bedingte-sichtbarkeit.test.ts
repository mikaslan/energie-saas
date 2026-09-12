import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  CHECKLIST_SCHEMA_VERSION,
  type ChecklistItemVisibleIfV1,
  type EditableChecklistBlocksV2,
  type ProjectChecklistDto,
  type SaveProjectChecklistCommand,
} from "@/lib/integrations/checklists/contract";
import {
  ChecklistSegmentIncompleteError,
  ChecklistValidationError,
  completeChecklistSegment,
  saveProjectChecklist,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

/**
 * F7-02B Bedingte Sichtbarkeit if/then (Katalog F7.2).
 * Regel persistiert im Whole-Tree-Save (Migration 0129), Complete-Gate
 * (SQL) und TS-Projektion werten identisch aus (Single-Hop RAW-done).
 */

type Fixture = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  projectId: string;
};

type TreeIds = {
  blockId: string;
  segmentId: string;
  firstItemId: string;
  secondItemId: string;
};

function treeIds(): TreeIds {
  return {
    blockId: randomUUID(),
    segmentId: randomUUID(),
    firstItemId: randomUUID(),
    secondItemId: randomUUID(),
  };
}

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f702b.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f702b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
              'admin', '{}'::jsonb)
    `);
  });
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F7', 'Fixture',
        ${`${contactId}@f702b.test`}, ${`${contactId}@f702b.test`})
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
  return { workspaceId, editorId, adminId, projectId };
}

function blocks(
  ids: TreeIds,
  secondRule: ChecklistItemVisibleIfV1 | null,
  secondRequired = true,
): EditableChecklistBlocksV2 {
  return [{
    id: ids.blockId,
    name: "PV",
    position: 0,
    visible: true,
    segments: [{
      id: ids.segmentId,
      name: "Basis",
      position: 0,
      visible: true,
      items: [
        {
          id: ids.firstItemId,
          title: "Dach geprüft",
          done: false,
          required: false,
          visible: true,
        },
        {
          id: ids.secondItemId,
          title: "Gaube vermessen",
          done: false,
          required: secondRequired,
          visible: true,
          visibleIf: secondRule,
        },
      ],
    }],
  }];
}

function saveCommand(
  fixture: Fixture,
  ids: TreeIds,
  rule: ChecklistItemVisibleIfV1 | null,
  secondRequired = true,
): SaveProjectChecklistCommand {
  return {
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    checklistId: null,
    projectId: fixture.projectId,
    phase: "site_documentation",
    title: "Baustellendokumentation",
    baseVersion: 0,
    blocks: blocks(ids, rule, secondRequired),
  };
}

async function save(
  fixture: Fixture,
  ids: TreeIds,
  rule: ChecklistItemVisibleIfV1 | null,
  secondRequired = true,
): Promise<ProjectChecklistDto> {
  return withAuthorizedTenantOn(
    testPool, fixture.adminId, fixture.workspaceId,
    (tx, ctx) => saveProjectChecklist(tx, ctx, saveCommand(fixture, ids, rule, secondRequired)),
  );
}

async function activateInstallation(fixture: Fixture): Promise<void> {
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      update project set phase = 'installation', updated_at = statement_timestamp()
       where workspace_id = ${fixture.workspaceId}::uuid
         and id = ${fixture.projectId}::uuid
    `);
    await tx.execute(sql`
      insert into installation (workspace_id, project_id, source, status)
      values (${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid, 'direct', 'active')
    `);
  });
}

describe("F7-02B Bedingte Sichtbarkeit (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7-02B Sichtbarkeit");
  });

  it("F702B-DB-01: gültige Regel persistiert und versteckter Pflichtpunkt blockiert nicht", async () => {
    const ids = treeIds();
    const created = await save(fixture, ids, { itemId: ids.firstItemId, equals: true });
    expect(created.version).toBe(1);
    expect(created.blocks[0]!.segments[0]!.items[1]!.visibleIf).toEqual({
      itemId: ids.firstItemId,
      equals: true,
    });

    await activateInstallation(fixture);
    const completed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: created.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: created.version,
      }),
    );
    expect(completed.version).toBe(2);
  });

  it("F702B-DB-02: sichtbar gewordener Pflichtpunkt blockiert wieder", async () => {
    const ids = treeIds();
    // equals false + Referenz unerledigt => Ziel sichtbar und pflichtig.
    const created = await save(fixture, ids, { itemId: ids.firstItemId, equals: false });
    expect(created.version).toBe(1);

    await activateInstallation(fixture);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: created.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: created.version,
      }),
    )).rejects.toBeInstanceOf(ChecklistSegmentIncompleteError);
  });

  it("F702B-DB-03: baumelnde und Selbst-Referenzen verweigert der Save-Guard", async () => {
    const ids = treeIds();
    await expect(save(fixture, ids, { itemId: randomUUID(), equals: true }))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    const ids2 = treeIds();
    await expect(save(fixture, ids2, { itemId: ids2.secondItemId, equals: true }))
      .rejects.toBeInstanceOf(ChecklistValidationError);
  });

  it("F702B-DB-04: DB-Validator weist defekte visibleIf-Shapes direkt ab", async () => {
    const ids = treeIds();
    const created = await save(fixture, ids, null);
    // Roh-Update im Editable-Shape (wie es der Save-Pfad schreibt: ohne
    // DTO-Anzeigekeys assignedTeams/completedAt).
    const patch = (shape: unknown) => {
      const patched = JSON.parse(JSON.stringify(blocks(ids, null))) as EditableChecklistBlocksV2;
      (patched[0]!.segments[0]!.items[1]! as unknown as Record<string, unknown>).visibleIf = shape;
      return withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
        update project_checklist set blocks = ${JSON.stringify(patched)}::jsonb
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${created.checklistId}::uuid
      `));
    };
    const badShapes = [
      { itemId: ids.firstItemId },
      { itemId: ids.firstItemId, equals: "ja" },
      { itemId: "keine-uuid", equals: true },
      { itemId: ids.firstItemId, equals: true, extra: 1 },
    ];
    for (const shape of badShapes) {
      await expect(patch(shape)).rejects.toThrow();
    }
    await patch(null);
    await patch({ itemId: ids.firstItemId, equals: true });
  });
});
