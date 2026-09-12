import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  CHECKLIST_SCHEMA_VERSION,
  type ChecklistItemKindV1,
  type EditableChecklistBlocksV2,
  type ProjectChecklistDto,
  type SaveProjectChecklistCommand,
} from "@/lib/integrations/checklists/contract";
import {
  ChecklistValidationError,
  completeChecklistSegment,
  saveProjectChecklist,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

/**
 * F7-02C Anzeige-Punkte title/description (Katalog F7.2, Slice B).
 * Validator-Shape (Migration 0130), Mischbestand-Rejects, Gate-Neutralität.
 */

type Fixture = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  projectId: string;
};

function treeIds() {
  return {
    blockId: randomUUID(),
    segmentId: randomUUID(),
    taskId: randomUUID(),
    titleId: randomUUID(),
    textId: randomUUID(),
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
      values (${editorId}::uuid, ${`editor-${editorId}@f702c.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f702c.test`})
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
        ${`${contactId}@f702c.test`}, ${`${contactId}@f702c.test`})
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

function displayBlocks(ids: ReturnType<typeof treeIds>): EditableChecklistBlocksV2 {
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
          id: ids.taskId,
          title: "Dach geprüft",
          done: true,
          required: true,
          visible: true,
        },
        {
          id: ids.titleId,
          title: "Montageabschnitt",
          done: false,
          required: false,
          visible: true,
          kind: "title",
        },
        {
          id: ids.textId,
          title: "Hinweis",
          done: false,
          required: false,
          visible: true,
          kind: "description",
          description: "Vor Arbeitsbeginn freischalten lassen.",
        },
      ],
    }],
  }];
}

function saveBlocks(
  fixture: Fixture,
  blocks: EditableChecklistBlocksV2,
): Promise<ProjectChecklistDto> {
  const command: SaveProjectChecklistCommand = {
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    checklistId: null,
    projectId: fixture.projectId,
    phase: "site_documentation",
    title: "Baustellendokumentation",
    baseVersion: 0,
    blocks,
  };
  return withAuthorizedTenantOn(
    testPool, fixture.adminId, fixture.workspaceId,
    (tx, ctx) => saveProjectChecklist(tx, ctx, command),
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

describe("F7-02C Anzeige-Punkte (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7-02C Anzeige");
  });

  it("F702C-DB-01: Anzeige-Punkte persistieren und blockieren den Abschluss nie", async () => {
    const ids = treeIds();
    const created = await saveBlocks(fixture, displayBlocks(ids));
    expect(created.version).toBe(1);
    const items = created.blocks[0]!.segments[0]!.items;
    expect(items.find((item) => item.id === ids.titleId)?.kind).toBe("title");
    expect(items.find((item) => item.id === ids.textId)?.description)
      .toBe("Vor Arbeitsbeginn freischalten lassen.");

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

  it("F702C-DB-02: Mischbestände verweigert der Save-Guard", async () => {
    const ids = treeIds();
    const base = displayBlocks(ids);
    const mutate = (
      itemId: string,
      patch: { kind?: ChecklistItemKindV1 | null; description?: string | null; required?: boolean; done?: boolean },
    ): EditableChecklistBlocksV2 => {
      const copy = JSON.parse(JSON.stringify(base)) as EditableChecklistBlocksV2;
      const target = copy[0]!.segments[0]!.items.find((item) => item.id === itemId)!;
      Object.assign(target, patch);
      return copy;
    };
    await expect(saveBlocks(fixture, mutate(ids.titleId, { required: true })))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(saveBlocks(fixture, mutate(ids.titleId, { done: true })))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(saveBlocks(fixture, mutate(ids.taskId, { description: "Fremdtext" })))
      .rejects.toBeInstanceOf(ChecklistValidationError);
  });

  it("F702C-DB-03: DB-Validator weist defekte kind/description-Shapes direkt ab", async () => {
    const ids = treeIds();
    const created = await saveBlocks(fixture, displayBlocks(ids));
    const patch = (shape: unknown) => {
      const patched = JSON.parse(JSON.stringify(displayBlocks(ids))) as EditableChecklistBlocksV2;
      Object.assign(
        patched[0]!.segments[0]!.items[1]!,
        { kind: "title", description: null, ...(shape as Record<string, unknown>) },
      );
      return withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
        update project_checklist set blocks = ${JSON.stringify(patched)}::jsonb
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${created.checklistId}::uuid
      `));
    };
    await expect(patch({ kind: "radio" })).rejects.toThrow();
    await expect(patch({ kind: "title", required: true })).rejects.toThrow();
    await expect(patch({ kind: "task", description: "Fremdtext" })).rejects.toThrow();
    await expect(patch({ kind: "description", description: `x${"y".repeat(2000)}` })).rejects.toThrow();
    await patch({ kind: "title" });
    await patch({ kind: "description", description: "Gültiger Hinweis." });
    await patch({ kind: null, description: null });
  });
});
