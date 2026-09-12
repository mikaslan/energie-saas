import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CHECKLIST_SCHEMA_VERSION,
  toEditableChecklistBlocks,
} from "@/lib/integrations/checklists/contract";
import {
  CHECKLIST_TEMPLATE_SCHEMA_VERSION,
  type ChecklistTemplateItemV1,
  type CreateChecklistTemplateCommand,
} from "@/lib/integrations/checklists/template-contract";
import {
  applyChecklistTemplate,
  ChecklistNotFoundError,
  ChecklistValidationError,
  createChecklistTemplate,
  getProjectChecklist,
  reapplyChecklistTemplate,
  saveProjectChecklist,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  adminId: string;
  componentA: string;
  componentB: string;
  projectId: string;
};

async function seedWorkspace(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const adminId = randomUUID();
  const componentA = randomUUID();
  const componentB = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7-13 Reapply')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f713.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f713.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f713.test`})
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
    await tx.execute(sql`
      insert into catalog_component (id, workspace_id, internal_sku, component_type, created_by)
      values (${componentA}::uuid, ${workspaceId}::uuid, 'WR-10K', 'inverter', ${editorId}::uuid),
             (${componentB}::uuid, ${workspaceId}::uuid, 'MOD-450', 'module', ${editorId}::uuid)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F713 Projekt', 'F7', 'Dreizehn',
        ${`${contactId}@f713.test`}, ${`${contactId}@f713.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F713 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F713 Projekt', 'fixture'
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
  return { workspaceId, editorId, viewerId, adminId, componentA, componentB, projectId };
}

function templateCommand(
  name: string,
  componentId: string,
): CreateChecklistTemplateCommand {
  const item: ChecklistTemplateItemV1 = {
    componentId,
    quantity: 2,
    position: 0,
    visibleToCustomer: true,
    priceOverridesComponent: false,
  };
  return {
    schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
    name,
    description: "F713",
    position: 0,
    targets: ["residential"],
    items: [item],
  };
}

describe("F7-13 Template Re-Apply (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace();
  });

  const asEditor = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, fn as never) as Promise<T>;
  const asViewer = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.viewerId, fx.workspaceId, fn as never) as Promise<T>;
  const asAdmin = <T>(fx: Fixture, fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fx.adminId, fx.workspaceId, fn as never) as Promise<T>;

  async function markFirstItemDone(fx: Fixture): Promise<void> {
    const detail = await asEditor(fx, (tx, ctx) => getProjectChecklist(tx, ctx, fx.projectId));
    const blocks = toEditableChecklistBlocks(detail.blocks);
    blocks[0]!.segments[0]!.items[0]!.done = true;
    await asEditor(fx, (tx, ctx) => saveProjectChecklist(tx, ctx, {
      schemaVersion: CHECKLIST_SCHEMA_VERSION,
      checklistId: detail.checklistId,
      projectId: fx.projectId,
      phase: "site_documentation",
      title: detail.title,
      baseVersion: detail.version,
      blocks,
    }));
  }

  async function itemTitles(fx: Fixture): Promise<Array<{ title: string; done: boolean }>> {
    const detail = await asEditor(fx, (tx, ctx) => getProjectChecklist(tx, ctx, fx.projectId));
    return detail.blocks.flatMap((block) => block.segments.flatMap((segment) =>
      segment.items.map((item) => ({ title: item.title, done: item.done })),
    ));
  }

  it("F713-DB-01: Merge erhält done, ergänzt Fehlendes, ist idempotent", async () => {
    const templateA = await asEditor(fixture, (tx, ctx) => createChecklistTemplate(tx, ctx,
      templateCommand("Vorlage A", fixture.componentA)));
    const templateB = await asEditor(fixture, (tx, ctx) => createChecklistTemplate(tx, ctx,
      templateCommand("Vorlage B", fixture.componentB)));

    await asEditor(fixture, (tx, ctx) => applyChecklistTemplate(tx, ctx, {
      templateId: templateA.id, projectId: fixture.projectId,
    }));
    await markFirstItemDone(fixture);

    // Merge ergänzt Knoten = Strukturänderung: Editor wird abgewiesen
    // (Kapsel- + canEditStructure-Regel des Produkts).
    await expect(asEditor(fixture, (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
      projectId: fixture.projectId, templateId: templateA.id, mode: "merge",
    }))).rejects.toBeInstanceOf(PermissionDeniedError);

    // Gleiches Template: nichts zu ergänzen, Haken bleibt.
    const noop = await asAdmin(fixture, (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
      projectId: fixture.projectId, templateId: templateA.id, mode: "merge",
    }));
    expect(noop.added).toBe(0);
    expect(await itemTitles(fixture)).toEqual([
      { title: "WR-10K × 2", done: true },
    ]);

    // Fremdes Template: Block wird angehängt, Haken bleibt.
    const merged = await asAdmin(fixture, (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
      projectId: fixture.projectId, templateId: templateB.id, mode: "merge",
    }));
    expect(merged.added).toBe(1);
    expect(await itemTitles(fixture)).toEqual([
      { title: "WR-10K × 2", done: true },
      { title: "MOD-450 × 2", done: false },
    ]);
  });

  it("F713-DB-02: Reset (Admin) ersetzt Werte; Editor wird abgewiesen", async () => {
    const templateA = await asEditor(fixture, (tx, ctx) => createChecklistTemplate(tx, ctx,
      templateCommand("Vorlage A", fixture.componentA)));
    await asEditor(fixture, (tx, ctx) => applyChecklistTemplate(tx, ctx, {
      templateId: templateA.id, projectId: fixture.projectId,
    }));
    await markFirstItemDone(fixture);

    await expect(asEditor(fixture, (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
      projectId: fixture.projectId, templateId: templateA.id, mode: "reset",
    }))).rejects.toBeInstanceOf(PermissionDeniedError);

    const reset = await asAdmin(fixture, (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
      projectId: fixture.projectId, templateId: templateA.id, mode: "reset",
    }));
    expect(reset.added).toBe(0);
    expect(await itemTitles(fixture)).toEqual([
      { title: "WR-10K × 2", done: false },
    ]);
  });

  it("F713-DB-03: NotFound, Validation, Viewer-Deny, Fremdtenant-Leere", async () => {
    const templateA = await asEditor(fixture, (tx, ctx) => createChecklistTemplate(tx, ctx,
      templateCommand("Vorlage A", fixture.componentA)));

    // Kein Bestand: kein Re-Apply (keine Auto-Anlage).
    await expect(asAdmin(fixture, (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
      projectId: fixture.projectId, templateId: templateA.id, mode: "merge",
    }))).rejects.toBeInstanceOf(ChecklistNotFoundError);

    await asEditor(fixture, (tx, ctx) => applyChecklistTemplate(tx, ctx, {
      templateId: templateA.id, projectId: fixture.projectId,
    }));

    // Unbekannte Vorlage, ungültiger Modus (als Admin: Gate passiert,
    // Pfad-Validierung geprüft), Viewer-Merge.
    await expect(asAdmin(fixture, (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
      projectId: fixture.projectId, templateId: randomUUID(), mode: "merge",
    }))).rejects.toBeInstanceOf(ChecklistNotFoundError);
    await expect(asAdmin(fixture, (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
      projectId: fixture.projectId, templateId: templateA.id, mode: "bogus" as "merge",
    }))).rejects.toBeInstanceOf(ChecklistValidationError);
    await expect(asViewer(fixture, (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
      projectId: fixture.projectId, templateId: templateA.id, mode: "merge",
    }))).rejects.toBeInstanceOf(PermissionDeniedError);

    // Fremdtenant sieht nichts: Admin mit dortiger Mitgliedschaft passiert
    // das Gate, findet aber keine fremde Checkliste (Mandantenisolation).
    const foreignWorkspaceId = randomUUID();
    await withTenantOn(testPool, foreignWorkspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${foreignWorkspaceId}::uuid, 'F7-13 Fremd')`);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${randomUUID()}::uuid, ${foreignWorkspaceId}::uuid, ${fixture.adminId}::uuid, 'admin', '{}'::jsonb)
      `);
    });
    await expect(withAuthorizedTenantOn(
      testPool, fixture.adminId, foreignWorkspaceId,
      (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
        projectId: fixture.projectId, templateId: templateA.id, mode: "merge",
      }),
    )).rejects.toBeInstanceOf(ChecklistNotFoundError);
  });
});
