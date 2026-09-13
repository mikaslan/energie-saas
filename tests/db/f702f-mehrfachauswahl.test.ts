import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  CHECKLIST_SCHEMA_VERSION,
  type EditableChecklistBlocksV2,
  type MutateChecklistSegmentCommand,
  type ProjectChecklistDto,
  type SaveProjectChecklistCommand,
} from "@/lib/integrations/checklists/contract";
import {
  ChecklistNotFoundError,
  completeChecklistSegment,
  saveProjectChecklist,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

/**
 * F7-02F Mehrfachauswahl (Katalog F7.2, Slice B).
 * kind=multi abhakbar wie Aufgabe, mehrere erledigte Multi-Punkte je
 * Segment sind gueltig (Validator 0143 + Zod, Gegenstueck zu F7-02D),
 * Pflicht-/Gate-Neutralitaet, Tenant-Schranke.
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
    multiAId: randomUUID(),
    multiBId: randomUUID(),
    taskId: randomUUID(),
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
      values (${editorId}::uuid, ${`editor-${editorId}@f702f.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f702f.test`})
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
        ${`${contactId}@f702f.test`}, ${`${contactId}@f702f.test`})
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

function multiBlocks(
  ids: ReturnType<typeof treeIds>,
  doneA: boolean,
  doneB: boolean,
): EditableChecklistBlocksV2 {
  return [{
    id: ids.blockId,
    name: "PV",
    position: 0,
    visible: true,
    segments: [{
      id: ids.segmentId,
      name: "Auswahl",
      position: 0,
      visible: true,
      items: [
        {
          id: ids.multiAId,
          title: "Option A",
          done: doneA,
          required: true,
          visible: true,
          kind: "multi",
        },
        {
          id: ids.multiBId,
          title: "Option B",
          done: doneB,
          required: false,
          visible: true,
          kind: "multi",
        },
        {
          id: ids.taskId,
          title: "Dach geprüft",
          done: true,
          required: false,
          visible: true,
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

describe("F7-02F Mehrfachauswahl (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7-02F Multi");
  });

  it("F702F-DB-01: Multi-Art persistiert; Pflicht-Multi blockiert den Abschluss bis zur Auswahl", async () => {
    const ids = treeIds();
    const created = await saveBlocks(fixture, multiBlocks(ids, false, false));
    expect(created.version).toBe(1);
    const items = created.blocks[0]!.segments[0]!.items;
    expect(items.find((item) => item.id === ids.multiAId)?.kind).toBe("multi");
    expect(items.find((item) => item.id === ids.multiBId)?.kind).toBe("multi");

    await activateInstallation(fixture);
    const completeCommand = (
      checklistId: string,
      version: number,
    ): MutateChecklistSegmentCommand => ({
      schemaVersion: CHECKLIST_SCHEMA_VERSION,
      checklistId,
      projectId: fixture.projectId,
      segmentId: ids.segmentId,
      baseVersion: version,
    });
    // Pflicht-Multi unerledigt -> Abschluss verweigert (Gate-Neutralitaet).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, completeCommand(created.checklistId!, created.version)),
    )).rejects.toThrow();
    // Auswahl treffen -> Abschluss gelingt.
    const chosen = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: created.checklistId!,
        projectId: fixture.projectId,
        phase: "site_documentation",
        title: "Baustellendokumentation",
        baseVersion: created.version,
        blocks: multiBlocks(ids, true, false),
      }),
    );
    const completed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, completeCommand(chosen.checklistId!, chosen.version)),
    );
    expect(completed.version).toBe(chosen.version + 1);
  });

  it("F702F-DB-02: zwei erledigte Multis im Segment akzeptiert der Save-Guard (Gegenprobe Radio)", async () => {
    const ids = treeIds();
    const created = await saveBlocks(fixture, multiBlocks(ids, true, true));
    expect(created.version).toBe(1);
    // Direkt-Validator (SQL 0143) bestaetigt denselben Bestand.
    const direct = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      select public._f704_valid_checklist_blocks(${JSON.stringify(multiBlocks(ids, true, true))}::jsonb) as valid
    `));
    expect((direct.rows[0] as { valid: boolean }).valid).toBe(true);
    // Gegenprobe: zwei erledigte Radios bleiben verboten.
    const radioBlocks = multiBlocks(ids, true, true);
    for (const item of radioBlocks[0]!.segments[0]!.items) {
      if (item.kind === "multi") (item as { kind: string }).kind = "radio";
    }
    const radioDirect = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      select public._f704_valid_checklist_blocks(${JSON.stringify(radioBlocks)}::jsonb) as valid
    `));
    expect((radioDirect.rows[0] as { valid: boolean }).valid).toBe(false);
  });

  it("F702F-DB-03: Fremdtenant scheitert am fremden Projekt", async () => {
    const ids = treeIds();
    const foreign = await seedWorkspace("F7-02F Fremd");
    await expect(withAuthorizedTenantOn(
      testPool, foreign.editorId, foreign.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: null,
        projectId: fixture.projectId,
        phase: "site_documentation",
        title: "Baustellendokumentation",
        baseVersion: 0,
        blocks: multiBlocks(ids, true, false),
      }),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
  });
});
