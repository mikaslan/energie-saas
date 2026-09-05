import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { OfferNotFoundError } from "@/modules/offers";
import {
  completeInstallation,
  createInstallation,
  getInstallation,
  InstallationConflictError,
  InstallationNotFoundError,
  InstallationValidationError,
} from "@/modules/installations";
import { testPool } from "../setup/test-db";

type Fixture = { workspaceId: string; projectId: string; editorId: string; viewerId: string };

async function seedFixture(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f701.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f701.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F701-CUSTOMER', 'Fixture', 'Contact', 'c@f701.test', 'c@f701.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F701 Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F701 Project', 'manual'
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

async function projectPhase(fixture: Fixture): Promise<string | null> {
  return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const result = await tx.execute<{ phase: string }>(sql`
      select phase from project
       where workspace_id = ${fixture.workspaceId}::uuid and id = ${fixture.projectId}::uuid
    `);
    return result.rows[0]?.phase ?? null;
  });
}

describe("F7.1 Installation Kern (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture("F7.1 Installation");
  });

  it("F701-DB-01: Direktanlage + Phasenwechsel + Basic-Read", async () => {
    expect(await projectPhase(fixture)).toBe("request");

    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(created.source).toBe("direct");
    expect(created.status).toBe("active");
    expect(created.offerId).toBeNull();
    expect(created.variantId).toBeNull();
    expect(created.completedAt).toBeNull();
    expect(created.permissions.canWrite).toBe(true);

    // Phasenwechsel (Spalte bleibt — kein Installation-Spalten-Typ).
    expect(await projectPhase(fixture)).toBe("installation");

    const read = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(read?.id).toBe(created.id);
    expect(read?.permissions.canWrite).toBe(false);
  });

  it("F701-DB-02: Doppelanlage → Conflict; Offer-Scope-Miss → NotFound", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }),
    )).rejects.toBeInstanceOf(InstallationConflictError);

    const other = await seedFixture("F7.1 Nachbar");
    await expect(withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => createInstallation(tx, ctx, {
        projectId: other.projectId,
        offerId: randomUUID(),
      }),
    )).rejects.toBeInstanceOf(OfferNotFoundError);

    await expect(withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => createInstallation(tx, ctx, {
        projectId: other.projectId,
        variantId: randomUUID(),
      }),
    )).rejects.toBeInstanceOf(InstallationValidationError);
  });

  it("F701-DB-03: Abschluss happy path + doppelter Abschluss → Validation", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    const completed = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).not.toBeNull();

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeInstallation(tx, ctx, { projectId: fixture.projectId }),
    )).rejects.toBeInstanceOf(InstallationValidationError);

    const other = await seedFixture("F7.1 Leer");
    await expect(withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => completeInstallation(tx, ctx, { projectId: other.projectId }),
    )).rejects.toBeInstanceOf(InstallationNotFoundError);
  });

  it("F701-DB-04: Cross-Workspace-Isolation + Viewer-Schreibsperre", async () => {
    const other = await seedFixture("F7.1 Fremd");
    const foreign = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => getInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(foreign).toBeNull();

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => completeInstallation(tx, ctx, { projectId: fixture.projectId }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
