import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { CHECKLIST_SCHEMA_VERSION } from "@/lib/integrations/checklists/contract";
import { CHECKLIST_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/checklists/template-contract";
import {
  applyChecklistTemplate,
  ChecklistValidationError,
  createChecklistTemplate,
  getProjectChecklist,
  reapplyChecklistTemplate,
  saveProjectChecklist,
} from "@/modules/checklists";
import { testPool } from "../setup/test-db";

/**
 * F7-03D Template-Regeln: Anwenden/Reapply mappen visibleIfComponentId auf
 * die erzeugte Punkt-ID (visibleIf); Save-Guard weist baumelnde Regeln ab.
 */

type Fixture = {
  workspaceId: string;
  editorId: string;
  adminId: string;
  projectId: string;
  componentA: string;
  componentB: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const adminId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const componentA = randomUUID();
  const componentB = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7-03D Regeln')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f703d.test`}),
             (${adminId}::uuid, ${`admin-${adminId}@f703d.test`})
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
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F703D', 'F7', 'Fixture',
        ${`${contactId}@f703d.test`}, ${`${contactId}@f703d.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F703D Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F703D Project', 'fixture'
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
      values (${componentA}::uuid, ${workspaceId}::uuid, 'WR-10K',
              'inverter', ${editorId}::uuid),
             (${componentB}::uuid, ${workspaceId}::uuid, 'MOD-450',
              'module', ${editorId}::uuid)
    `);
  });
  return { workspaceId, editorId, adminId, projectId, componentA, componentB };
}

function templateItems(fixture: Fixture, rule: string | null) {
  return [
    {
      componentId: fixture.componentA,
      quantity: 1,
      position: 0,
      visibleToCustomer: false,
      priceOverridesComponent: false,
      kind: null,
      visibleIfComponentId: null,
    },
    {
      componentId: fixture.componentB,
      quantity: 2,
      position: 1,
      visibleToCustomer: false,
      priceOverridesComponent: false,
      kind: null,
      visibleIfComponentId: rule,
    },
  ];
}

async function createTemplate(fixture: Fixture, rule: string | null, name: string) {
  return withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createChecklistTemplate(tx, ctx, {
      schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
      name,
      description: null,
      targets: ["residential"],
      items: templateItems(fixture, rule),
    }),
  );
}

async function stripToItemA(
  fixture: Fixture,
  before: Awaited<ReturnType<typeof getProjectChecklist>>,
  componentId: string,
) {
  const block = before.blocks[0]!;
  const segment = block.segments[0]!;
  const itemA = segment.items.find((entry) => entry.componentId === fixture.componentA)!;
  await withAuthorizedTenantOn(
    testPool, fixture.adminId, fixture.workspaceId,
    (tx, ctx) => saveProjectChecklist(tx, ctx, {
      schemaVersion: CHECKLIST_SCHEMA_VERSION,
      checklistId: before.checklistId,
      projectId: fixture.projectId,
      phase: "site_documentation",
      title: before.title,
      baseVersion: before.version,
      blocks: [{
        id: block.id,
        name: block.name,
        position: block.position,
        visible: true,
        segments: [{
          id: segment.id,
          name: segment.name,
          position: segment.position,
          visible: true,
          items: [{
            id: itemA.id,
            title: itemA.title,
            done: false,
            required: false,
            visible: true,
            componentId,
          }],
        }],
      }],
    }),
  );
}

describe("F7-03D Template-Regeln (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F703D-DB-01: Anwenden mappt Regel auf Punkt-ID (visibleIf gesetzt)", async () => {
    const template = await createTemplate(fixture, fixture.componentA, "Regel-Standard");
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
    const items = checklist.blocks[0]!.segments[0]!.items;
    expect(items).toHaveLength(2);
    const byComponent = new Map(items.map((entry) => [entry.componentId, entry]));
    const a = byComponent.get(fixture.componentA)!;
    const b = byComponent.get(fixture.componentB)!;
    expect(a.visibleIf ?? null).toBeNull();
    expect(b.visibleIf).toEqual({ itemId: a.id, equals: true });
  });

  it("F703D-DB-02: Baumelnde Regel scheitert beim Speichern", async () => {
    await expect(createTemplate(fixture, randomUUID(), "Regel-Baumelnd"))
      .rejects.toBeInstanceOf(ChecklistValidationError);
  });

  it("F703D-DB-03: Reapply-Merge ergaenzt Regel-Position mit Mapping", async () => {
    const template = await createTemplate(fixture, fixture.componentA, "Regel-Merge");
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
      }),
    );
    // Position B per Struktur-Save entfernen (Admin), dann mergen.
    const before = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    const block = before.blocks[0]!;
    const segment = block.segments[0]!;
    const itemA = segment.items.find((entry) => entry.componentId === fixture.componentA)!;
    await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: before.checklistId,
        projectId: fixture.projectId,
        phase: "site_documentation",
        title: before.title,
        baseVersion: before.version,
        blocks: [{
          id: block.id,
          name: block.name,
          position: block.position,
          visible: true,
          segments: [{
            id: segment.id,
            name: segment.name,
            position: segment.position,
            visible: true,
            items: [{
              id: itemA.id,
              title: itemA.title,
              done: false,
              required: false,
              visible: true,
              componentId: itemA.componentId,
            }],
          }],
        }],
      }),
    );
    const merged = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
        mode: "merge",
      }),
    );
    expect(merged.added).toBe(1);
    const checklist = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    const items = checklist.blocks[0]!.segments[0]!.items;
    const byComponent = new Map(items.map((entry) => [entry.componentId, entry]));
    expect(byComponent.get(fixture.componentB)!.visibleIf).toEqual({
      itemId: byComponent.get(fixture.componentA)!.id,
      equals: true,
    });
  });

  it("F703D-DB-04: Merge mit Duplikat-Komponenten mappt jede Regel auf den eigenen Punkt", async () => {
    const template = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createChecklistTemplate(tx, ctx, {
        schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
        name: "Regel-Duplikat",
        description: null,
        targets: ["residential"],
        items: [
          {
            componentId: fixture.componentA, quantity: 1, position: 0,
            visibleToCustomer: false, priceOverridesComponent: false,
            kind: null, visibleIfComponentId: null,
          },
          {
            componentId: fixture.componentB, quantity: 1, position: 1,
            visibleToCustomer: false, priceOverridesComponent: false,
            kind: null, visibleIfComponentId: fixture.componentA,
          },
          {
            componentId: fixture.componentB, quantity: 2, position: 2,
            visibleToCustomer: false, priceOverridesComponent: false,
            kind: null, visibleIfComponentId: fixture.componentA,
          },
        ],
      }),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
      }),
    );
    const before = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    await stripToItemA(fixture, before, fixture.componentA);
    const merged = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
        mode: "merge",
      }),
    );
    expect(merged.added).toBe(2);
    const checklist = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    const items = checklist.blocks[0]!.segments[0]!.items;
    const itemA = items.find((entry) => entry.componentId === fixture.componentA)!;
    const dupes = items.filter((entry) => entry.componentId === fixture.componentB);
    expect(dupes).toHaveLength(2);
    for (const dupe of dupes) {
      expect(dupe.visibleIf).toEqual({ itemId: itemA.id, equals: true });
    }
  });

  it("F703D-DB-05: Merge loest Regelziel per Titel-Fallback (Legacy-Komponente)", async () => {
    const template = await createTemplate(fixture, fixture.componentA, "Regel-Titel-Fallback");
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => applyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
      }),
    );
    const before = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    // Regelziel behaelt den Titel, traegt aber eine Legacy-Komponente:
    // der Merge darf nicht aborten (Werterhalt wie ohne F7-03D).
    await stripToItemA(fixture, before, randomUUID());
    const merged = await withAuthorizedTenantOn(
      testPool, fixture.adminId, fixture.workspaceId,
      (tx, ctx) => reapplyChecklistTemplate(tx, ctx, {
        templateId: template.id,
        projectId: fixture.projectId,
        mode: "merge",
      }),
    );
    expect(merged.added).toBe(1);
    const checklist = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getProjectChecklist(tx, ctx, fixture.projectId),
    );
    const items = checklist.blocks[0]!.segments[0]!.items;
    expect(items).toHaveLength(2);
    const itemA = items.find((entry) => entry.componentId !== fixture.componentB)!;
    expect(items.find((entry) => entry.componentId === fixture.componentB)!.visibleIf)
      .toEqual({ itemId: itemA.id, equals: true });
  });
});
