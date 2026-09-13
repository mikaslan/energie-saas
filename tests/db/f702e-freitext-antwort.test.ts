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
 * F7-02E Freitext-Antwort (Katalog F7.2, Slice B ohne Diktat).
 * kind=text abhakbar wie Aufgabe, optionaler Antworttext nur dort
 * (Validator 0142 + Zod), Pflicht-/Gate-Neutralitaet, Tenant-Schranke.
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
    textId: randomUUID(),
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
      values (${editorId}::uuid, ${`editor-${editorId}@f702e.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f702e.test`})
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
        ${`${contactId}@f702e.test`}, ${`${contactId}@f702e.test`})
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

function textBlocks(
  ids: ReturnType<typeof treeIds>,
  textDone: boolean,
  textValue: string | null,
): EditableChecklistBlocksV2 {
  return [{
    id: ids.blockId,
    name: "PV",
    position: 0,
    visible: true,
    segments: [{
      id: ids.segmentId,
      name: "Protokoll",
      position: 0,
      visible: true,
      items: [
        {
          id: ids.textId,
          title: "Zählerstand",
          done: textDone,
          required: true,
          visible: true,
          kind: "text",
          value: textValue,
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
  checklistId: string | null = null,
  baseVersion = 0,
): Promise<ProjectChecklistDto> {
  const command: SaveProjectChecklistCommand = {
    schemaVersion: CHECKLIST_SCHEMA_VERSION,
    checklistId,
    projectId: fixture.projectId,
    phase: "site_documentation",
    title: "Baustellendokumentation",
    baseVersion,
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

describe("F7-02E Freitext-Antwort (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7-02E Text");
  });

  it("F702E-DB-01: Antworttext persistiert; Pflicht-Text blockiert den Abschluss bis erledigt", async () => {
    const ids = treeIds();
    const created = await saveBlocks(fixture, textBlocks(ids, false, "42.195 kWh"));
    expect(created.version).toBe(1);
    const items = created.blocks[0]!.segments[0]!.items;
    expect(items.find((item) => item.id === ids.textId)?.value).toBe("42.195 kWh");

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
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, completeCommand(created.checklistId!, created.version)),
    )).rejects.toThrow();
    const chosen = await saveBlocks(
      fixture, textBlocks(ids, true, "42.195 kWh"), created.checklistId!, created.version,
    );
    const completed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeChecklistSegment(tx, ctx, completeCommand(chosen.checklistId!, chosen.version)),
    );
    expect(completed.version).toBe(chosen.version + 1);
  });

  it("F702E-DB-02: Antworttext an Aufgabe und Überlänge verweigert der Save-Guard", async () => {
    const ids = treeIds();
    const base = textBlocks(ids, false, null);
    const mutate = (patch: Record<string, unknown>): EditableChecklistBlocksV2 => {
      const copy = JSON.parse(JSON.stringify(base)) as EditableChecklistBlocksV2;
      Object.assign(copy[0]!.segments[0]!.items[1]!, patch);
      return copy;
    };
    // Wert an Aufgabe (kind fehlt = task) und Überlänge am Textpunkt.
    await expect(saveBlocks(fixture, mutate({ value: "Fremdtext" })))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(saveBlocks(
      fixture,
      (() => {
        const copy = JSON.parse(JSON.stringify(base)) as EditableChecklistBlocksV2;
        Object.assign(copy[0]!.segments[0]!.items[0]!, {
          kind: "text",
          value: `x${"y".repeat(2000)}`,
        });
        return copy;
      })(),
    )).rejects.toBeInstanceOf(ChecklistValidationError);
    // Direkt-Validator (SQL 0142) weist denselben Fremdtext ab.
    const direct = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      select public._f704_valid_checklist_blocks(${JSON.stringify(mutate({ value: "Fremdtext" }))}::jsonb) as valid
    `));
    expect((direct.rows[0] as { valid: boolean }).valid).toBe(false);
    const valid = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      select public._f704_valid_checklist_blocks(${JSON.stringify(textBlocks(ids, false, "ok"))}::jsonb) as valid
    `));
    expect((valid.rows[0] as { valid: boolean }).valid).toBe(true);
  });

  it("F702E-DB-03: Fremdtenant scheitert an der Kapsel-Schranke", async () => {
    const ids = treeIds();
    const foreign = await seedWorkspace("F7-02E Fremd");
    await expect(withAuthorizedTenantOn(
      testPool, foreign.editorId, foreign.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: null,
        projectId: fixture.projectId,
        phase: "site_documentation",
        title: "Baustellendokumentation",
        baseVersion: 0,
        blocks: textBlocks(ids, false, "42.195 kWh"),
      }),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
  });
});
