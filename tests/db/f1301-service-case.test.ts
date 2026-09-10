import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  createServiceCase,
  listServiceCases,
  ServiceCaseNotFoundError,
  ServiceCaseValidationError,
  setServiceCaseStatus,
} from "@/modules/service-cases";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; projectId: string; editorId: string; viewerId: string };

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F13-01 Service')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1301.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f1301.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1301-CUSTOMER', 'Fixture', 'Contact', 'c@f1301.test', 'c@f1301.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1301 Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F1301 Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return { workspaceId, projectId, editorId, viewerId };
}

describe("F13-01 Serviceauftrag (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F1301-DB-01: Anlage → Kanten open/in_progress/done; illegale Kanten fail-closed", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createServiceCase(tx, ctx, {
        projectId: fixture.projectId,
        title: "Wechselrichter prüfen",
        description: "Fehlercode 302.",
        dueDate: "2026-10-15",
      }),
    );
    expect(created.status).toBe("open");
    expect(created.dueDate).toBe("2026-10-15");
    expect(created.completedAt).toBeNull();

    // open → done direkt ist illegal (nur via in_progress).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setServiceCaseStatus(tx, ctx, { id: created.id, status: "done" }),
    )).rejects.toBeInstanceOf(ServiceCaseValidationError);

    const started = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setServiceCaseStatus(tx, ctx, { id: created.id, status: "in_progress" }),
    );
    expect(started.status).toBe("in_progress");
    const done = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setServiceCaseStatus(tx, ctx, { id: created.id, status: "done" }),
    );
    expect(done.status).toBe("done");
    expect(done.completedAt).not.toBeNull();

    // Terminal: done → cancelled illegal.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setServiceCaseStatus(tx, ctx, { id: created.id, status: "cancelled" }),
    )).rejects.toBeInstanceOf(ServiceCaseValidationError);

    // Liste belegt Vorgang.
    const listed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listServiceCases(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(listed.map((serviceCase) => serviceCase.id)).toContain(created.id);

    // Leerer Titel, Fremdprojekt, fehlender Vorgang fail-closed.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createServiceCase(tx, ctx, { projectId: fixture.projectId, title: "   " }),
    )).rejects.toBeInstanceOf(ServiceCaseValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createServiceCase(tx, ctx, {
        projectId: "00000000-0000-4000-8000-000000000000",
        title: "Fremdprojekt",
      }),
    )).rejects.toBeInstanceOf(ServiceCaseNotFoundError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setServiceCaseStatus(tx, ctx, {
        id: "00000000-0000-4000-8000-000000000000",
        status: "cancelled",
      }),
    )).rejects.toBeInstanceOf(ServiceCaseNotFoundError);
  });

  it("F1301-RBAC-01: Viewer liest read-only; Schreiben fail-closed", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createServiceCase(tx, ctx, { projectId: fixture.projectId, title: "Wartung" }),
    );
    const viewerList = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listServiceCases(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(viewerList.map((serviceCase) => serviceCase.id)).toContain(created.id);
    expect(viewerList[0]?.permissions.canWrite).toBe(false);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => createServiceCase(tx, ctx, { projectId: fixture.projectId, title: "Viewer" }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => setServiceCaseStatus(tx, ctx, { id: created.id, status: "cancelled" }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
