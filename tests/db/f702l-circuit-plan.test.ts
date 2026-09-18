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
import { CHECKLIST_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/checklists/template-contract";
import {
  applyChecklistTemplate,
  ChecklistValidationError,
  createChecklistTemplate,
  getProjectChecklist,
  saveProjectChecklist,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

/**
 * F7-02L Schaltplan-Punkt (Katalog F7.2) — kind=circuit-plan als Anzeige-Art
 * (weder Pflicht noch abhakbar, keine Nutzlast). Validator 0185.
 * Fixture-Muster nach F7-02K (Projekt + Katalog-Komponente fuer DB-04).
 */

type Fixture = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  projectId: string;
  componentA: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const componentA = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7-02L Schaltplan')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f702l.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f702l.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid,
              'admin', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F702L', 'F7', 'Fixture',
        ${`${contactId}@f702l.test`}, ${`${contactId}@f702l.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F702L Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F702L Project', 'fixture'
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
    await tx.execute(sql`
      insert into catalog_component (
        id, workspace_id, internal_sku, component_type, created_by
      )
      values (${componentA}::uuid, ${workspaceId}::uuid, 'MOD-450',
              'module', ${editorId}::uuid)
    `);
  });
  return { workspaceId, editorId, adminId, projectId, componentA };
}

function circuitPlanBlocks(itemId: string): EditableChecklistBlocksV2 {
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
        title: "Schaltplan",
        done: false,
        required: false,
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
  const blocks = circuitPlanBlocks(itemId);
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

async function directValid(
  fixture: Fixture,
  blocks: EditableChecklistBlocksV2,
): Promise<boolean> {
  const result = await withTenantOn(testPool, fixture.workspaceId, (tx) => tx.execute(sql`
    select public._f704_valid_checklist_blocks(${JSON.stringify(blocks)}::jsonb) as valid
  `));
  return (result.rows[0] as { valid: boolean }).valid;
}

describe("F7-02L Schaltplan-Punkt (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F702L-DB-01: circuit-plan persistiert (Save + Re-Read)", async () => {
    const itemId = randomUUID();
    const created = await saveAs(fixture, fixture.adminId, patchedBlocks(itemId, {
      kind: "circuit-plan",
    }));
    expect(created.version).toBe(1);
    expect(created.blocks[0]!.segments[0]!.items[0]!.kind).toBe("circuit-plan");
    const reread = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    const rereadItem = reread.blocks[0]!.segments[0]!.items[0]!;
    expect(rereadItem.kind).toBe("circuit-plan");
    expect(rereadItem.done).toBe(false);
    expect(rereadItem.required).toBe(false);
    expect(await directValid(fixture, patchedBlocks(itemId, { kind: "circuit-plan" })))
      .toBe(true);
  });

  it("F702L-DB-02: required/done am kind werden verworfen", async () => {
    const itemId = randomUUID();
    for (const patch of [
      { kind: "circuit-plan", required: true },
      { kind: "circuit-plan", done: true },
    ]) {
      await expect(saveAs(fixture, fixture.adminId, patchedBlocks(itemId, patch)))
        .rejects.toBeInstanceOf(ChecklistValidationError);
      expect(await directValid(fixture, patchedBlocks(itemId, patch))).toBe(false);
    }
  });

  it("F702L-DB-03: fremder kind bleibt verworfen (IN-Regression)", async () => {
    const itemId = randomUUID();
    const patch = { kind: "video" };
    await expect(saveAs(fixture, fixture.adminId, patchedBlocks(itemId, patch)))
      .rejects.toBeInstanceOf(ChecklistValidationError);
    expect(await directValid(fixture, patchedBlocks(itemId, patch))).toBe(false);
  });

  it("F702L-DB-04: Template-Anwendung erzeugt kind-Punkt mit done/required false", async () => {
    const template = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, {
        schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
        name: "Schaltplan-Vorlage",
        description: null,
        targets: ["residential"],
        items: [{
          componentId: fixture.componentA,
          quantity: 1,
          position: 0,
          visibleToCustomer: false,
          priceOverridesComponent: false,
          kind: "circuit-plan",
          visibleIfComponentId: null,
        }],
      }),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
      }),
    );
    const checklist = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    const applied = checklist.blocks[0]!.segments[0]!.items[0]!;
    expect(applied.kind).toBe("circuit-plan");
    expect(applied.done).toBe(false);
    expect(applied.required).toBe(false);
  });
});
