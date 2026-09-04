import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { applyChecklistTemplate, createChecklistTemplate } from "@/modules/checklists";
import { CHECKLIST_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/checklists/template-contract";
import { testPool } from "../setup/test-db";

describe("repro2", () => {
  it("apply + viewer select", async () => {
    const ws = randomUUID();
    const editor = randomUUID();
    const viewer = randomUUID();
    const comp = randomUUID();
    const projectId = randomUUID();
    const contactId = randomUUID();
    const siteId = randomUUID();
    await withTenantOn(testPool, ws, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${ws}::uuid, 'r')`);
      await tx.execute(sql`insert into user_identity (id, email) values (${editor}::uuid, ${`${editor}@r.test`}), (${viewer}::uuid, ${`${viewer}@r.test`})`);
      await tx.execute(sql`insert into membership (id, workspace_id, user_id, role, capabilities) values (${randomUUID()}::uuid, ${ws}::uuid, ${editor}::uuid, 'editor', '{}'::jsonb), (${randomUUID()}::uuid, ${ws}::uuid, ${viewer}::uuid, 'viewer', '{}'::jsonb)`);
      await tx.execute(sql`insert into catalog_component (id, workspace_id, internal_sku, component_type, created_by) values (${comp}::uuid, ${ws}::uuid, 'X', 'inverter', ${editor}::uuid)`);
      await tx.execute(sql`insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized) values (${contactId}::uuid, ${ws}::uuid, 'P', 'A', 'B', ${`${contactId}@r.test`}, ${`${contactId}@r.test`})`);
      await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${ws}::uuid, ${contactId}::uuid, 'S')`);
      await tx.execute(sql`
        insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
        select ${projectId}::uuid, ${ws}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'P', 'fixture'
          from kanban_board board join kanban_column intake
            on intake.workspace_id = board.workspace_id and intake.board_id = board.id
           and intake.is_intake = true and intake.archived_at is null
         where board.workspace_id = ${ws}::uuid and board.scope = 'residential'
           and board.is_default = true and board.archived_at is null`);
    });
    const template = await withAuthorizedTenantOn(testPool, editor, ws, (tx, ctx) =>
      createChecklistTemplate(tx, ctx, {
        schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
        name: "T", description: null, position: 0, targets: [],
        items: [{ componentId: comp, quantity: 2, position: 0, visibleToCustomer: true, priceOverridesComponent: false }],
      }));
    const applied = await withAuthorizedTenantOn(testPool, editor, ws, (tx, ctx) =>
      applyChecklistTemplate(tx, ctx, { templateId: template.id, projectId }));
    console.log("applied:", applied);
    const viaSuper = await withTenantOn(testPool, ws, (tx) => tx.execute(sql`select count(*)::text as n from project_checklist`));
    console.log("super count:", viaSuper.rows[0]);
    const viaViewer = await withAuthorizedTenantOn(testPool, viewer, ws, (tx, ctx) =>
      tx.execute(sql`select count(*)::text as n from project_checklist where workspace_id = ${ctx.workspaceId}::uuid`));
    console.log("viewer count:", viaViewer.rows[0]);
    expect(applied.version).toBe(1);
  });
});
