import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  CHECKLIST_SCHEMA_VERSION,
  type EditableChecklistBlocksV2,
  type ProjectChecklistDto,
  type SaveProjectChecklistCommand,
} from "@/lib/integrations/checklists/contract";
import {
  ChecklistValidationError,
  saveProjectChecklist,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

/**
 * F7-02G Bild-Punkt (Katalog F7.2) — kind=image mit Foto-Key `photo`.
 * Validator 0173 + Zod: image ist Arbeitspunkt (required/done erlaubt),
 * `photo` nur dort (Spiegel zu value), gueltiger Key, Struktur-Neutralitaet.
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
    imageId: randomUUID(),
    taskId: randomUUID(),
  };
}

function photoKey(projectId: string, itemId: string, sha8 = "a1b2c3d4"): string {
  return `immutable/${projectId}/checklist-photos/${itemId}_${sha8}.jpg`;
}

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f702g.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f702g.test`})
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
        ${`${contactId}@f702g.test`}, ${`${contactId}@f702g.test`})
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

function imageBlocks(
  ids: ReturnType<typeof treeIds>,
  photo: string | null,
  imageDone: boolean,
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
          id: ids.imageId,
          title: "Zaehlerfoto",
          done: imageDone,
          required: true,
          visible: true,
          kind: "image",
          photo,
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

describe("F7-02G Bild-Punkt (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7-02G Bild");
  });

  it("F702G-DB-01: Bildpunkt mit Foto-Key persistiert; Pflicht-Bild zaehlt wie Aufgabe", async () => {
    const ids = treeIds();
    const key = photoKey(fixture.projectId, ids.imageId);
    const created = await saveBlocks(fixture, imageBlocks(ids, key, false));
    expect(created.version).toBe(1);
    const items = created.blocks[0]!.segments[0]!.items;
    expect(items.find((item) => item.id === ids.imageId)?.photo).toBe(key);
    // Erledigtes Bild mit Foto: done:true persistiert am Bildpunkt.
    const done = await saveBlocks(
      fixture, imageBlocks(ids, key, true), created.checklistId!, created.version,
    );
    expect(done.version).toBe(2);
    const doneItems = done.blocks[0]!.segments[0]!.items;
    const imageItem = doneItems.find((item) => item.id === ids.imageId);
    expect(imageItem?.done).toBe(true);
    expect(imageItem?.photo).toBe(key);
  });

  it("F702G-DB-02: Foto an Aufgabe, Fremd-Key und ungueltiger Key scheitern", async () => {
    const ids = treeIds();
    const key = photoKey(fixture.projectId, ids.imageId);
    const base = imageBlocks(ids, null, false);
    const mutate = (index: number, patch: Record<string, unknown>): EditableChecklistBlocksV2 => {
      const copy = JSON.parse(JSON.stringify(base)) as EditableChecklistBlocksV2;
      Object.assign(copy[0]!.segments[0]!.items[index]!, patch);
      return copy;
    };
    // Foto an Aufgabe (kind fehlt = task).
    await expect(saveBlocks(fixture, mutate(1, { photo: key })))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    // Unzulaessiger Key (kein Checklist-Foto-Pfad).
    await expect(saveBlocks(fixture, mutate(0, { photo: "immutable/x/y.png" })))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    // Direkt-Validator (SQL 0173) weist denselben Fremdbestand ab.
    const direct = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      select public._f704_valid_checklist_blocks(${JSON.stringify(mutate(1, { photo: key }))}::jsonb) as valid
    `));
    expect((direct.rows[0] as { valid: boolean }).valid).toBe(false);
    const valid = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      select public._f704_valid_checklist_blocks(${JSON.stringify(imageBlocks(ids, key, false))}::jsonb) as valid
    `));
    expect((valid.rows[0] as { valid: boolean }).valid).toBe(true);
  });

  it("F702G-DB-03: Foto-Wechsel ist keine Struktur (Editor-Antwort auf Vorlage)", async () => {
    const ids = treeIds();
    const keyA = photoKey(fixture.projectId, ids.imageId, "a1b2c3d4");
    const keyB = photoKey(fixture.projectId, ids.imageId, "e5f60718");
    const structureOf = async (photo: string | null): Promise<string> => {
      const result = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
        select public._f704_checklist_structure(${JSON.stringify(imageBlocks(ids, photo, false))}::jsonb) as structure
      `));
      return JSON.stringify((result.rows[0] as { structure: unknown }).structure);
    };
    expect(await structureOf(keyA)).toBe(await structureOf(keyB));
    expect(await structureOf(keyA)).toBe(await structureOf(null));
  });
});
