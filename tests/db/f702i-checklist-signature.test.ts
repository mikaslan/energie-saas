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
 * F7-02I Unterschrift-Punkt (Katalog F7.2) — kind=signature mit
 * signerRole (kunde/techniker/dritter, STRUKTUR) und Signatur-PNG im
 * wiederverwendeten `photo`-Key (NUTZLAST wie 02g). Validator 0175.
 */

type Fixture = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  projectId: string;
};

function signatureKey(projectId: string, itemId: string, sha8 = "b2c3d4e5"): string {
  return `immutable/${projectId}/checklist-photos/${itemId}_${sha8}.png`;
}

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f702i.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f702i.test`})
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
        ${`${contactId}@f702i.test`}, ${`${contactId}@f702i.test`})
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

function signatureBlocks(itemId: string): EditableChecklistBlocksV2 {
  return [{
    id: randomUUID(),
    name: "PV",
    position: 0,
    visible: true,
    segments: [{
      id: randomUUID(),
      name: "Protokoll",
      position: 0,
      visible: true,
      items: [{
        id: itemId,
        title: "Abnahme",
        done: false,
        required: true,
        visible: true,
      }],
    }],
  }];
}

// Absichtlich ungetypt: Negativfaelle tragen ungueltige Werte.
function patchedBlocks(
  itemId: string,
  patch: Record<string, unknown>,
): EditableChecklistBlocksV2 {
  const blocks = signatureBlocks(itemId);
  Object.assign(blocks[0]!.segments[0]!.items[0]!, patch);
  return blocks;
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

describe("F7-02I Unterschrift-Punkt (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7-02I Signatur");
  });

  it("F702I-DB-01: Signaturpunkt mit Rolle und Key persistiert (Arbeitspunkt)", async () => {
    const itemId = randomUUID();
    const key = signatureKey(fixture.projectId, itemId);
    const created = await saveAs(fixture, fixture.adminId, patchedBlocks(itemId, {
      kind: "signature",
      photo: key,
      signerRole: "kunde",
    }));
    expect(created.version).toBe(1);
    const item = created.blocks[0]!.segments[0]!.items[0]!;
    expect(item.kind).toBe("signature");
    expect(item.photo).toBe(key);
    expect(item.signerRole).toBe("kunde");
    expect(item.required).toBe(true);
  });

  it("F702I-DB-02: Mischbestaende scheitern (Guard + Direkt-Validator)", async () => {
    const itemId = randomUUID();
    const key = signatureKey(fixture.projectId, itemId);
    const bad: Array<Record<string, unknown>> = [
      { photo: key },
      { signerRole: "kunde" },
      { kind: "signature", signerRole: "notar" },
      { kind: "task", photo: key, signerRole: "kunde" },
      { kind: "image", signerRole: "kunde" },
    ];
    for (const patch of bad) {
      await expect(saveAs(fixture, fixture.adminId, patchedBlocks(itemId, patch)))
        .rejects.toBeInstanceOf(ChecklistValidationError);
      const direct = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
        select public._f704_valid_checklist_blocks(${JSON.stringify(patchedBlocks(itemId, patch))}::jsonb) as valid
      `));
      expect((direct.rows[0] as { valid: boolean }).valid).toBe(false);
    }
    const valid = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
      select public._f704_valid_checklist_blocks(${JSON.stringify(patchedBlocks(itemId, {
        kind: "signature",
        photo: key,
        signerRole: "techniker",
      }))}::jsonb) as valid
    `));
    expect((valid.rows[0] as { valid: boolean }).valid).toBe(true);
  });

  it("F702I-DB-03: Rolle ist Struktur, Signatur-Bytes sind Nutzlast", async () => {
    const itemId = randomUUID();
    const created = await saveAs(fixture, fixture.adminId, patchedBlocks(itemId, {
      kind: "signature",
      photo: null,
      signerRole: "kunde",
    }));
    const ids = {
      block: created.blocks[0]!.id,
      segment: created.blocks[0]!.segments[0]!.id,
    };
    const withIds = (patch: Record<string, unknown>): EditableChecklistBlocksV2 => {
      const blocks: EditableChecklistBlocksV2 = [{
        id: ids.block,
        name: "PV",
        position: 0,
        visible: true,
        segments: [{
          id: ids.segment,
          name: "Protokoll",
          position: 0,
          visible: true,
          items: [{
            id: itemId,
            title: "Abnahme",
            done: false,
            required: true,
            visible: true,
          }],
        }],
      }];
      Object.assign(blocks[0]!.segments[0]!.items[0]!, patch);
      return blocks;
    };
    // Rollenwechsel aendert die Struktur (Editor-42501).
    const structureOf = async (patch: Record<string, unknown>): Promise<string> => {
      const result = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
        select public._f704_checklist_structure(${JSON.stringify(withIds(patch))}::jsonb) as structure
      `));
      return JSON.stringify((result.rows[0] as { structure: unknown }).structure);
    };
    const roleBase = { kind: "signature", photo: null, signerRole: "kunde" };
    expect(await structureOf({ ...roleBase, signerRole: "techniker" }))
      .not.toBe(await structureOf(roleBase));
    await expect(saveAs(
      fixture, fixture.editorId,
      withIds({ kind: "signature", photo: null, signerRole: "techniker" }),
      created.checklistId!, created.version,
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    // Signieren (Bytes setzen) ist Editor-Antwort und gelingt.
    const key = signatureKey(fixture.projectId, itemId);
    const signed = await saveAs(
      fixture, fixture.editorId,
      withIds({ kind: "signature", photo: key, signerRole: "kunde" }),
      created.checklistId!, created.version,
    );
    expect(signed.version).toBe(2);
    expect(signed.blocks[0]!.segments[0]!.items[0]!.photo).toBe(key);
  });
});
