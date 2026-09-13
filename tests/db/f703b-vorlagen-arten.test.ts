import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  CHECKLIST_SCHEMA_VERSION,
  type EditableChecklistBlocksV2,
  type SaveProjectChecklistCommand,
} from "@/lib/integrations/checklists/contract";
import {
  CHECKLIST_TEMPLATE_SCHEMA_VERSION,
  type ChecklistTemplateItemV1,
  type CreateChecklistTemplateCommand,
} from "@/lib/integrations/checklists/template-contract";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  applyChecklistTemplate,
  ChecklistValidationError,
  createChecklistTemplate,
  reapplyChecklistTemplate,
  saveProjectChecklist,
  updateChecklistTemplate,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

/**
 * F7-03B Punkt-Arten in Vorlagen (Katalog F7.3).
 * Template-Positionen tragen optional kind (nullish = Legacy = Aufgabe);
 * Apply/Merge-Nachschub/Reset uebernehmen die Art 1:1 auf den
 * Projekt-Punkt (ohne Inhalt/Antwort). Merge ueberschreibt vorhandene
 * Arten nie (Werterhalt).
 */

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  adminId: string;
  componentIds: string[];
  projectId: string;
};

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  const componentIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f703b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f703b.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f703b.test`})
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
    const skus = ["WR-A", "WR-B", "WR-C", "WR-D", "WR-E"];
    for (const [index, componentId] of componentIds.entries()) {
      await tx.execute(sql`
        insert into catalog_component (
          id, workspace_id, internal_sku, component_type, created_by
        ) values (
          ${componentId}::uuid, ${workspaceId}::uuid, ${skus[index]!},
          'inverter', ${editorId}::uuid
        )
      `);
    }
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F7.3b Projekt', 'F7', 'DreiB',
        ${`${contactId}@f703b.test`}, ${`${contactId}@f703b.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F7.3b Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F7.3b Projekt', 'fixture'
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
  return { workspaceId, editorId, viewerId, adminId, componentIds, projectId };
}

function item(overrides: Partial<ChecklistTemplateItemV1> = {}): ChecklistTemplateItemV1 {
  return {
    componentId: randomUUID(),
    quantity: 1,
    position: 0,
    visibleToCustomer: true,
    priceOverridesComponent: false,
    ...overrides,
  };
}

function templateCommand(
  fixture: Fixture,
  overrides: Partial<CreateChecklistTemplateCommand> = {},
): CreateChecklistTemplateCommand {
  return {
    schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
    name: "Arten-Vorlage",
    description: "Punkt-Arten",
    position: 0,
    targets: ["residential"],
    items: [item({ componentId: fixture.componentIds[0]! })],
    ...overrides,
  };
}

type ProjectItem = { title: string; kind: string | null; componentId: string | null };

async function appliedItems(fixture: Fixture): Promise<ProjectItem[]> {
  const checklist = await withAuthorizedTenantOn(
    testPool, fixture.viewerId, fixture.workspaceId,
    (tx, ctx) => tx.execute(sql`select blocks from project_checklist
      where workspace_id = ${ctx.workspaceId}::uuid
        and project_id = ${fixture.projectId}::uuid limit 1`),
  );
  const blocks = checklist.rows[0]!.blocks as Array<{
    segments: Array<{ items: ProjectItem[] }>;
  }>;
  return blocks[0]!.segments[0]!.items;
}

describe("F7-03B Punkt-Arten in Vorlagen (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F7-03B Arten");
  });

  it("F703B-DB-01: Arten je Position landen per Apply 1:1 auf dem Projekt-Punkt; ungueltige Art fail-closed", async () => {
    const kinds = ["radio", "text", "multi", "title", "description"] as const;
    const template = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture, {
        items: kinds.map((kind, index) => item({
          componentId: fixture.componentIds[index]!,
          position: index,
          kind,
        })),
      })),
    );
    const applied = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
      }),
    );
    expect(applied.version).toBe(1);
    const items = await appliedItems(fixture);
    expect(items.map((entry) => entry.kind)).toEqual([...kinds]);

    // Ungueltige Art scheitert schon bei der Anlage (strictObject + Enum).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture, {
        name: "Ungueltig",
        items: [item({
          componentId: fixture.componentIds[0]!,
          kind: "video" as unknown as "task",
        })],
      })),
    )).rejects.toBeInstanceOf(ChecklistValidationError);
  });

  it("F703B-DB-02: Legacy-Vorlage ohne kind wendet unveraendert als Aufgabe an", async () => {
    const legacyItems = [{
      componentId: fixture.componentIds[0]!,
      quantity: 2,
      position: 0,
      visibleToCustomer: true,
      priceOverridesComponent: false,
    }];
    const template = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture, {
        name: "Legacy",
        items: legacyItems as unknown as ChecklistTemplateItemV1[],
      })),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
      }),
    );
    const items = await appliedItems(fixture);
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBeNull();
    expect(items[0]!.title).toBe("WR-A × 2");
  });

  it("F703B-DB-04: Antwortwert ist Nutzlast — Editor-Save mit Antworttext gelingt, Art-Wechsel bleibt Admin-sache", async () => {
    // Manuelle Checkliste mit Textpunkt (Vorlagen-unabhaengig: der Befund
    // aus F7-03B-E2E-01 traf jeden Editor-Save mit Antworttext).
    const blockId = randomUUID();
    const segmentId = randomUUID();
    const textId = randomUUID();
    const textBlocks = (value: string | null): EditableChecklistBlocksV2 => [{
      id: blockId,
      name: "PV",
      position: 0,
      visible: true,
      segments: [{
        id: segmentId,
        name: "Antworten",
        position: 0,
        visible: true,
        items: [{
          id: textId,
          title: "Dachhaken",
          done: false,
          required: false,
          visible: true,
          kind: "text",
          value,
        }],
      }],
    }];
    const saveAs = (actorId: string, checklistId: string | null, baseVersion: number, blocks: EditableChecklistBlocksV2) => {
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
        testPool, actorId, fixture.workspaceId,
        (tx, ctx) => saveProjectChecklist(tx, ctx, command),
      );
    };
    const created = await saveAs(fixture.editorId, null, 0, textBlocks(null));
    expect(created.version).toBe(1);
    // Editor beantwortet den Textpunkt — kein Strukturwechsel (0144).
    const answered = await saveAs(fixture.editorId, created.checklistId!, created.version, textBlocks("gesetzt"));
    expect(answered.version).toBe(2);
    expect(answered.blocks[0]!.segments[0]!.items[0]).toMatchObject({ kind: "text", value: "gesetzt" });
    // Art-Wechsel bleibt Struktur: Editor scheitert, Admin gelingt.
    // (value faellt ehrlich mit — Mischbestand text-fremder Werte lehnt
    // schon der Zod-Guard als Validation ab, nicht erst die Kapsel.)
    const rekinded = textBlocks(null);
    rekinded[0]!.segments[0]!.items[0]!.kind = "multi";
    await expect(saveAs(fixture.editorId, answered.checklistId!, answered.version, rekinded))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    const adminSaved = await saveAs(fixture.adminId, answered.checklistId!, answered.version, rekinded);
    expect(adminSaved.blocks[0]!.segments[0]!.items[0]).toMatchObject({ kind: "multi", value: null });
  });

  it("F703B-DB-03: Merge ergaenzt fehlende Position MIT Art, vorhandene Art bleibt; Reset rendert Art frisch", async () => {
    const template = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, templateCommand(fixture, {
        name: "Wachsend",
        items: [item({ componentId: fixture.componentIds[0]!, kind: "task" })],
      })),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
      }),
    );
    // Vorlage waechst: vorhandene Position wechselt die Art (task -> multi),
    // neue Position mit Art radio kommt dazu.
    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateChecklistTemplate(tx, ctx, {
        schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
        id: template.id,
        name: "Wachsend",
        description: "Punkt-Arten",
        position: 0,
        targets: ["residential"],
        items: [
          item({ componentId: fixture.componentIds[0]!, kind: "multi" }),
          item({ componentId: fixture.componentIds[1]!, position: 1, kind: "radio" }),
        ],
      }),
    );
    expect(updated.items.map((entry) => entry.kind)).toEqual(["multi", "radio"]);

    const merged = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
        projectId: fixture.projectId,
        templateId: template.id,
        mode: "merge",
      }),
    );
    expect(merged.added).toBe(1);
    const afterMerge = await appliedItems(fixture);
    expect(afterMerge).toHaveLength(2);
    // Werterhalt: vorhandener Punkt behaelt task (kein Art-Overwrite);
    // Nachschub traegt radio.
    const byComponent = new Map(afterMerge.map((entry) => [entry.componentId, entry.kind]));
    expect(byComponent.get(fixture.componentIds[0]!)).toBe("task");
    expect(byComponent.get(fixture.componentIds[1]!)).toBe("radio");

    await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
        projectId: fixture.projectId,
        templateId: template.id,
        mode: "reset",
      }),
    );
    const afterReset = await appliedItems(fixture);
    const resetByComponent = new Map(afterReset.map((entry) => [entry.componentId, entry.kind]));
    expect(resetByComponent.get(fixture.componentIds[0]!)).toBe("multi");
    expect(resetByComponent.get(fixture.componentIds[1]!)).toBe("radio");
  });
});
