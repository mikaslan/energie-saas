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
import { PermissionDeniedError } from "@/lib/permissions";
import { testPool } from "../setup/test-db";

/**
 * F7-02H Block-Fälligkeitsdatum (Katalog F7.2) — optionales dueDate je
 * Block (Kalendertag, STRUKTUR wie der Block-Name, kein Gate).
 * Validator 0174 + Zod: Format + Echtheit, Struktur-Charakter.
 */

type Fixture = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  projectId: string;
};

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f702h.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f702h.test`})
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
        ${`${contactId}@f702h.test`}, ${`${contactId}@f702h.test`})
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

function datedBlocks(dueDate: string | null | undefined): EditableChecklistBlocksV2 {
  return [{
    id: randomUUID(),
    name: "PV",
    position: 0,
    visible: true,
    ...(dueDate === undefined ? {} : { dueDate }),
    segments: [{
      id: randomUUID(),
      name: "Protokoll",
      position: 0,
      visible: true,
      items: [{
        id: randomUUID(),
        title: "Dach geprüft",
        done: false,
        required: false,
        visible: true,
      }],
    }],
  }];
}

function saveAs(
  fixture: Fixture,
  userId: string,
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
    testPool, userId, fixture.workspaceId,
    (tx, ctx) => saveProjectChecklist(tx, ctx, command),
  );
}

describe("F7-02H Block-Fälligkeitsdatum (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7-02H Datum");
  });

  it("F702H-DB-01: Datum persistiert, auf null rücksetzbar, fehlend bleibt gültig", async () => {
    const created = await saveAs(fixture, fixture.adminId, datedBlocks("2026-10-01"));
    expect(created.version).toBe(1);
    expect(created.blocks[0]!.dueDate).toBe("2026-10-01");
    const cleared = await saveAs(
      fixture, fixture.adminId, datedBlocks(null), created.checklistId!, created.version,
    );
    expect(cleared.version).toBe(2);
    expect(cleared.blocks[0]!.dueDate ?? null).toBeNull();
    const legacy = await saveAs(fixture, fixture.adminId, datedBlocks(undefined));
    expect(legacy.blocks[0]!.dueDate ?? null).toBeNull();
  });

  it("F702H-DB-02: Formatbruch und Schalttag-Falle scheitern (Guard + Validator)", async () => {
    for (const bad of ["01.10.2026", "2026-13-01", "2026-02-31", "2026-1-1", "heute"]) {
      await expect(saveAs(fixture, fixture.adminId, datedBlocks(bad)))
        .rejects.toBeInstanceOf(ChecklistValidationError);
      const direct = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
        select public._f704_valid_checklist_blocks(${JSON.stringify(datedBlocks(bad))}::jsonb) as valid
      `));
      expect((direct.rows[0] as { valid: boolean }).valid).toBe(false);
    }
    const valid = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      select public._f704_valid_checklist_blocks(${JSON.stringify(datedBlocks("2026-02-28"))}::jsonb) as valid
    `));
    expect((valid.rows[0] as { valid: boolean }).valid).toBe(true);
  });

  it("F702H-DB-03: Datum ist Struktur — Editor-Antwort mit Datumswechsel scheitert", async () => {
    const created = await saveAs(fixture, fixture.adminId, datedBlocks(null));
    // Struktur-Vergleich direkt: Datumswechsel ändert die Struktur.
    const structureOf = async (dueDate: string | null): Promise<string> => {
      const result = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
        select public._f704_checklist_structure(${JSON.stringify(datedBlocks(dueDate))}::jsonb) as structure
      `));
      return JSON.stringify((result.rows[0] as { structure: unknown }).structure);
    };
    expect(await structureOf("2026-10-01")).not.toBe(await structureOf(null));
    // Editor darf antworten (done), aber kein Datum setzen (gleiche IDs).
    const ids = {
      block: created.blocks[0]!.id,
      segment: created.blocks[0]!.segments[0]!.id,
      item: created.blocks[0]!.segments[0]!.items[0]!.id,
    };
    const withIds = (dueDate: string | null, done: boolean): EditableChecklistBlocksV2 => [{
      id: ids.block,
      name: "PV",
      position: 0,
      visible: true,
      dueDate,
      segments: [{
        id: ids.segment,
        name: "Protokoll",
        position: 0,
        visible: true,
        items: [{ id: ids.item, title: "Dach geprüft", done, required: false, visible: true }],
      }],
    }];
    const answered = await saveAs(
      fixture, fixture.editorId, withIds(null, true), created.checklistId!, created.version,
    );
    expect(answered.version).toBe(2);
    await expect(saveAs(
      fixture, fixture.editorId, withIds("2026-10-01", true), answered.checklistId!, answered.version,
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
