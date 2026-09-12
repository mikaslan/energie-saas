import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CHECKLIST_SCHEMA_VERSION,
  segmentRequiredRemaining,
  type EditableChecklistBlocksV2,
  type ProjectChecklistDto,
  type SaveProjectChecklistCommand,
  type SetChecklistItemIrrelevantCommand,
} from "@/lib/integrations/checklists/contract";
import {
  ChecklistConflictError,
  ChecklistNotFoundError,
  ChecklistSegmentIncompleteError,
  ChecklistSegmentStateError,
  ChecklistValidationError,
  completeChecklistSegment,
  getProjectChecklist,
  saveProjectChecklist,
  setChecklistItemIrrelevant,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

/**
 * F7-04b Punkt-als-irrelevant (Katalog F7.2, mit Begründung).
 * Dedizierte Kapsel-Op (Migration 0127): Begründungspflicht, CAS,
 * Gate-Skip im Segmentabschluss, Event/Audit, State-Fehler.
 */

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
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
  const viewerId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f704b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f704b.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f704b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
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
        ${`${contactId}@f704b.test`}, ${`${contactId}@f704b.test`})
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
  return { workspaceId, editorId, viewerId, adminId, projectId };
}

function blocks(ids: TreeIds, firstRequired = true): EditableChecklistBlocksV2 {
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
          required: firstRequired,
          visible: true,
        },
        {
          id: ids.secondItemId,
          title: "Zählerschrank dokumentiert",
          done: false,
          required: false,
          visible: true,
        },
      ],
    }],
  }];
}

function markCommand(
  checklist: ProjectChecklistDto,
  itemId: string,
  reason: string | null,
): SetChecklistItemIrrelevantCommand {
  return {
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    checklistId: checklist.checklistId!,
    projectId: checklist.projectId,
    segmentId: checklist.blocks[0]!.segments[0]!.id,
    itemId,
    baseVersion: checklist.version,
    reason,
  };
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

describe("F7-04b Punkt-als-irrelevant (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7-04b Irrelevant");
  });

  it("F704B-DB-01: Markierung mit Begründung hebt die Abschlusssperre auf", async () => {
    const ids = treeIds();
    const created = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: null,
        projectId: fixture.projectId,
        phase: "site_documentation",
        title: "Baustellendokumentation",
        baseVersion: 0,
        blocks: blocks(ids),
      } satisfies SaveProjectChecklistCommand),
    );
    expect(created.version).toBe(1);

    const marked = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setChecklistItemIrrelevant(tx, ctx, markCommand(created, ids.firstItemId, "Flachdach ohne Ziegel")),
    );
    expect(marked.version).toBe(2);
    expect(marked.blocks[0]!.segments[0]!.items[0]!.irrelevant).toMatchObject({
      reason: "Flachdach ohne Ziegel",
      by: fixture.editorId,
    });
    expect(typeof marked.blocks[0]!.segments[0]!.items[0]!.irrelevant!.at).toBe("string");
    expect(segmentRequiredRemaining(marked.blocks[0]!.segments[0]!)).toBe(0);

    await activateInstallation(fixture);
    const completed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: marked.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: marked.version,
      }),
    );
    expect(completed.version).toBe(3);

    const evidence = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      event_type: string;
      count: string;
    }>(sql`
      select event_type, count(*)::text as count
        from domain_events
       where workspace_id = ${fixture.workspaceId}::uuid
         and aggregate_id = ${marked.checklistId}::uuid
         and event_type in ('checklist.item_marked_irrelevant', 'checklist.segment_completed')
       group by event_type
       order by event_type
    `));
    expect(evidence.rows).toEqual([
      { event_type: "checklist.item_marked_irrelevant", count: "1" },
      { event_type: "checklist.segment_completed", count: "1" },
    ]);
    const audit = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute<{
      count: string;
    }>(sql`
      select count(*)::text as count
        from audit_log
       where workspace_id = ${fixture.workspaceId}::uuid
         and action = 'checklist.write'
         and resource = 'project_checklist_item'
         and details->>'itemId' = ${ids.firstItemId}
    `));
    expect(audit.rows).toEqual([{ count: "1" }]);
  });

  it("F704B-DB-02: Begründungspflicht, Pflichtpunkt-Bindung und Mandantenschranke", async () => {
    const ids = treeIds();
    const created = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: null,
        projectId: fixture.projectId,
        phase: "site_documentation",
        title: "Baustellendokumentation",
        baseVersion: 0,
        blocks: blocks(ids),
      } satisfies SaveProjectChecklistCommand),
    );
    const mark = (itemId: string, reason: string | null) =>
      withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => setChecklistItemIrrelevant(tx, ctx, markCommand(created, itemId, reason)),
      );

    await expect(mark(ids.firstItemId, "")).rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(mark(ids.firstItemId, "   ")).rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(mark(ids.firstItemId, "x".repeat(501))).rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(mark(ids.firstItemId, "mit\u200bSteuerzeichen")).rejects.toBeInstanceOf(ChecklistValidationError);
    // Optionaler Punkt: keine beobachtbare Wirkung, fail-closed.
    await expect(mark(ids.secondItemId, "egal")).rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(mark(randomUUID(), "egal")).rejects.toBeInstanceOf(ChecklistNotFoundError);

    const foreign = await seedWorkspace("F7-04b Fremd");
    // Fremder Editor mit Schreibrecht sieht die fremde Checkliste trotzdem
    // nicht (Kapsel-Schranke, kein Orakel).
    await expect(withAuthorizedTenantOn(
      testPool, foreign.editorId, foreign.workspaceId,
      (tx, ctx) => setChecklistItemIrrelevant(tx, ctx, {
        ...markCommand(created, ids.firstItemId, "egal"),
        projectId: fixture.projectId,
      }),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
  });

  it("F704B-DB-03: Aufheben stellt die Sperre wieder her; Siegel und CAS gelten", async () => {
    const ids = treeIds();
    const created = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: null,
        projectId: fixture.projectId,
        phase: "site_documentation",
        title: "Baustellendokumentation",
        baseVersion: 0,
        blocks: blocks(ids),
      } satisfies SaveProjectChecklistCommand),
    );
    const marked = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setChecklistItemIrrelevant(tx, ctx, markCommand(created, ids.firstItemId, "entfällt")),
    );
    // Veraltete Version verliert das CAS-Rennen.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setChecklistItemIrrelevant(tx, ctx, markCommand(created, ids.firstItemId, "spaet")),
    )).rejects.toBeInstanceOf(ChecklistConflictError);

    const unmarked = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setChecklistItemIrrelevant(tx, ctx, markCommand(marked, ids.firstItemId, null)),
    );
    expect(unmarked.version).toBe(3);
    expect(unmarked.blocks[0]!.segments[0]!.items[0]!.irrelevant).toBeUndefined();
    expect(segmentRequiredRemaining(unmarked.blocks[0]!.segments[0]!)).toBe(1);

    // Idempotentes Aufheben ohne Markierung: kein Versionsverbrauch.
    const noop = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setChecklistItemIrrelevant(tx, ctx, markCommand(unmarked, ids.firstItemId, null)),
    );
    expect(noop.version).toBe(3);

    await activateInstallation(fixture);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: unmarked.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: unmarked.version,
      }),
    )).rejects.toBeInstanceOf(ChecklistSegmentIncompleteError);

    const completed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setChecklistItemIrrelevant(tx, ctx, markCommand(unmarked, ids.firstItemId, "doch egal")),
    );
    const sealed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: completed.checklistId!,
        projectId: fixture.projectId,
        segmentId: ids.segmentId,
        baseVersion: completed.version,
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => setChecklistItemIrrelevant(tx, ctx, markCommand(sealed, ids.firstItemId, null)),
    )).rejects.toBeInstanceOf(ChecklistSegmentStateError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => setChecklistItemIrrelevant(tx, ctx, markCommand(sealed, ids.firstItemId, "viewer")),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F704B-DB-04: Verborgene Punkte sind nicht markierbar; Saves erhalten Markierungen", async () => {
    const ids = treeIds();
    const tree = blocks(ids);
    tree[0]!.segments[0]!.items[1]!.required = true;
    tree[0]!.segments[0]!.items[1]!.visible = false;
    const created = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: null,
        projectId: fixture.projectId,
        phase: "site_documentation",
        title: "Baustellendokumentation",
        baseVersion: 0,
        blocks: tree,
      } satisfies SaveProjectChecklistCommand),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setChecklistItemIrrelevant(tx, ctx, markCommand(created, ids.secondItemId, "unsichtbar")),
    )).rejects.toBeInstanceOf(ChecklistSegmentStateError);

    const marked = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setChecklistItemIrrelevant(tx, ctx, markCommand(created, ids.firstItemId, "bleibt erhalten")),
    );
    // Whole-Tree-Save mit Markierung: Validator 0127 akzeptiert, Read projiziert.
    const reread = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    expect(reread.blocks[0]!.segments[0]!.items[0]!.irrelevant).toMatchObject({
      reason: "bleibt erhalten",
      by: fixture.editorId,
    });
    expect(marked.version).toBe(2);
  });
});
