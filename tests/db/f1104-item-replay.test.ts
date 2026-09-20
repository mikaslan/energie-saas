import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  CHECKLIST_SCHEMA_VERSION,
  toEditableChecklistBlocks,
  type EditableChecklistBlocksV2,
  type ProjectChecklistDto,
} from "@/lib/integrations/checklists/contract";
import {
  planItemSync,
  type ItemOutboxEntry,
} from "@/lib/integrations/checklists/item-outbox";
import {
  ChecklistConflictError,
  ChecklistValidationError,
  completeChecklistSegment,
  getProjectChecklist,
  saveProjectChecklist,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

/**
 * F11-04 Checklisten-Punkt-Outbox: Replay-Semantik gegen PostgreSQL.
 * Der Planer wendet Offline-Patches auf den frischen Serverbaum an; der
 * Save läuft als Editor mit aktueller Version (LWW je Punkt, Fremdhaken
 * bleiben, abgeschlossene Segmente nie überschreiben).
 */

type Fixture = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  projectId: string;
};

type TreeIds = { blockId: string; segmentId: string; aId: string; bId: string };

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1104.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f1104.test`})
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
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F11', 'Fixture',
        ${`${contactId}@f1104.test`}, ${`${contactId}@f1104.test`})
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

function blocksOf(ids: TreeIds, aDone: boolean, bDone: boolean): EditableChecklistBlocksV2 {
  return [{
    id: ids.blockId,
    name: "Montage",
    position: 0,
    visible: true,
    segments: [{
      id: ids.segmentId,
      name: "Dach",
      position: 0,
      visible: true,
      items: [
        { id: ids.aId, title: "Haken gesetzt", done: aDone, required: false, visible: true },
        { id: ids.bId, title: "Schienen montiert", done: bDone, required: false, visible: true },
      ],
    }],
  }];
}

function save(
  fixture: Fixture,
  actorId: string,
  blocks: EditableChecklistBlocksV2,
  checklistId: string | null,
  baseVersion: number,
): Promise<ProjectChecklistDto> {
  return withAuthorizedTenantOn(
    testPool, actorId, fixture.workspaceId,
    (tx, ctx) => saveProjectChecklist(tx, ctx, {
      schemaVersion: CHECKLIST_SCHEMA_VERSION,
      checklistId,
      projectId: fixture.projectId,
      phase: "site_documentation",
      title: "Baustellendokumentation",
      baseVersion,
      blocks,
    }),
  );
}

function read(fixture: Fixture, actorId: string): Promise<ProjectChecklistDto> {
  return withAuthorizedTenantOn(
    testPool, actorId, fixture.workspaceId,
    (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
  );
}

function queued(fixture: Fixture, checklistId: string, itemId: string, done: boolean): ItemOutboxEntry {
  return {
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    checklistId,
    itemId,
    done,
    queuedAt: "2026-09-20T10:00:00.000Z",
  };
}

function doneById(dto: ProjectChecklistDto): Record<string, boolean> {
  return Object.fromEntries(dto.blocks.flatMap((block) =>
    block.segments.flatMap((segment) => segment.items.map((item) => [item.id, item.done]))));
}

describe("F11-04 Checklisten-Punkt-Replay (PostgreSQL)", () => {
  let fixture: Fixture;
  let ids: TreeIds;
  let created: ProjectChecklistDto;
  beforeEach(async () => {
    fixture = await seedWorkspace("F11-04 Replay");
    ids = { blockId: randomUUID(), segmentId: randomUUID(), aId: randomUUID(), bId: randomUUID() };
    created = await save(fixture, fixture.adminId, blocksOf(ids, false, false), null, 0);
  });

  it("F1104-DB-01: Editor-Replay mit aktueller Version lässt den parallelen Fremdhaken stehen", async () => {
    // Offline wurde A abgehakt (Queue kennt nur Version 1); inzwischen hakt
    // ein Kollege online B ab.
    const entries = [queued(fixture, created.checklistId!, ids.aId, true)];
    const foreign = await save(fixture, fixture.adminId, blocksOf(ids, false, true), created.checklistId, created.version);
    expect(foreign.version).toBe(2);

    const fresh = await read(fixture, fixture.editorId);
    const plan = planItemSync(entries, fresh.blocks);
    expect(plan.applied).toEqual(entries);
    const replayed = await save(fixture, fixture.editorId, plan.blocks!, fresh.checklistId, fresh.version);

    expect(replayed.version).toBe(3);
    expect(doneById(replayed)).toEqual({ [ids.aId]: true, [ids.bId]: true });
  });

  it("F1104-DB-02: Replay mit veralteter Version ist ein Konflikt (kein Blind-Overwrite)", async () => {
    await save(fixture, fixture.adminId, blocksOf(ids, false, true), created.checklistId, created.version);
    const stale = planItemSync([queued(fixture, created.checklistId!, ids.aId, true)], created.blocks);
    await expect(
      save(fixture, fixture.editorId, stale.blocks!, created.checklistId, created.version),
    ).rejects.toBeInstanceOf(ChecklistConflictError);
    expect(doneById(await read(fixture, fixture.editorId))).toEqual({ [ids.aId]: false, [ids.bId]: true });
  });

  it("F1104-DB-03: abgeschlossenes Segment verwirft der Planer und weist der Server ab", async () => {
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        update project set phase = 'installation', updated_at = statement_timestamp()
         where workspace_id = ${fixture.workspaceId}::uuid and id = ${fixture.projectId}::uuid
      `);
      await tx.execute(sql`
        insert into installation (workspace_id, project_id, source, status)
        values (${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid, 'direct', 'active')
      `);
    });
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: created.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: created.version,
      }),
    );

    const sealed = await read(fixture, fixture.editorId);
    const plan = planItemSync([queued(fixture, created.checklistId!, ids.aId, true)], sealed.blocks);
    expect(plan.blocks).toBeNull();
    expect(plan.dropped.map((drop) => drop.reason)).toEqual(["sealed"]);

    const forced = toEditableChecklistBlocks(sealed.blocks);
    forced[0]!.segments[0]!.items[0]!.done = true;
    await expect(
      save(fixture, fixture.editorId, forced, sealed.checklistId, sealed.version),
    ).rejects.toBeInstanceOf(ChecklistValidationError);
    expect(doneById(await read(fixture, fixture.editorId))[ids.aId]).toBe(false);
  });
});
