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
  ChecklistValidationError,
  completeChecklistSegment,
  saveProjectChecklist,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

/**
 * F7-02D Radio-Einfachauswahl (Katalog F7.2, Slice B).
 * kind=radio abhakbar wie Aufgabe, hoechstens ein erledigter Radio-Punkt
 * je Segment (Validator 0141 + Zod), Pflicht-/Gate-Neutralitaet, Tenant-Schranke.
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
    secondSegmentId: randomUUID(),
    radioAId: randomUUID(),
    radioBId: randomUUID(),
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
      values (${editorId}::uuid, ${`editor-${editorId}@f702d.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f702d.test`})
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
        ${`${contactId}@f702d.test`}, ${`${contactId}@f702d.test`})
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

function radioBlocks(
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
          id: ids.radioAId,
          title: "Variante A",
          done: doneA,
          required: true,
          visible: true,
          kind: "radio",
        },
        {
          id: ids.radioBId,
          title: "Variante B",
          done: doneB,
          required: false,
          visible: true,
          kind: "radio",
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

describe("F7-02D Radio-Einfachauswahl (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7-02D Radio");
  });

  it("F702D-DB-01: Radio-Art persistiert; Pflicht-Radio blockiert den Abschluss bis zur Auswahl", async () => {
    const ids = treeIds();
    const created = await saveBlocks(fixture, radioBlocks(ids, false, false));
    expect(created.version).toBe(1);
    const items = created.blocks[0]!.segments[0]!.items;
    expect(items.find((item) => item.id === ids.radioAId)?.kind).toBe("radio");
    expect(items.find((item) => item.id === ids.radioBId)?.kind).toBe("radio");

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
    // Pflicht-Radio unerledigt -> Abschluss verweigert (Gate-Neutralitaet).
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
        blocks: radioBlocks(ids, true, false),
      }),
    );
    const completed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, completeCommand(chosen.checklistId!, chosen.version)),
    );
    expect(completed.version).toBe(chosen.version + 1);
  });

  it("F702D-DB-02: zwei erledigte Radios im Segment verweigert der Save-Guard", async () => {
    const ids = treeIds();
    await expect(saveBlocks(fixture, radioBlocks(ids, true, true)))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    // Direkt-Validator (SQL 0141) weist denselben Bestand ab.
    const direct = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      select public._f704_valid_checklist_blocks(${JSON.stringify(radioBlocks(ids, true, true))}::jsonb) as valid
    `));
    expect((direct.rows[0] as { valid: boolean }).valid).toBe(false);
    const single = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      select public._f704_valid_checklist_blocks(${JSON.stringify(radioBlocks(ids, true, false))}::jsonb) as valid
    `));
    expect((single.rows[0] as { valid: boolean }).valid).toBe(true);
  });

  it("F702D-DB-03: je ein erledigter Radio in zwei Segmenten ist gueltig; Fremdtenant scheitert", async () => {
    const ids = treeIds();
    const first = radioBlocks(ids, true, false);
    const secondSegment = {
      id: ids.secondSegmentId,
      name: "Zusatz",
      position: 1,
      visible: true,
      items: [{
        id: randomUUID(),
        title: "Variante C",
        done: true,
        required: false,
        visible: true,
        kind: "radio" as const,
      }],
    };
    const created = await saveBlocks(fixture, [{
      ...first[0]!,
      segments: [...first[0]!.segments, secondSegment],
    }]);
    expect(created.version).toBe(1);

    const foreign = await seedWorkspace("F7-02D Fremd");
    await expect(withAuthorizedTenantOn(
      testPool, foreign.editorId, foreign.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: null,
        projectId: fixture.projectId,
        phase: "site_documentation",
        title: "Baustellendokumentation",
        baseVersion: 0,
        blocks: radioBlocks(treeIds(), true, false),
      }),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
  });
});
