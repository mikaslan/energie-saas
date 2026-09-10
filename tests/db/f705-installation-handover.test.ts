import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  completeInstallation,
  createInstallation,
  getInstallation,
  InstallationNotFoundError,
  InstallationValidationError,
  recordHandover,
} from "@/modules/installations";
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
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7-05 Abnahme')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f705.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f705.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F705-CUSTOMER', 'Fixture', 'Contact', 'c@f705.test', 'c@f705.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F705 Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F705 Project', 'manual'
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

async function seedCompleted(fixture: Fixture): Promise<void> {
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }),
  );
  await withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => completeInstallation(tx, ctx, { projectId: fixture.projectId }),
  );
}

describe("F7-05 Abnahme (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F705-DB-01: Abnahme belegt Wer/Wann/Notiz; Korrektur überschreibt", async () => {
    await seedCompleted(fixture);

    const handover = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordHandover(tx, ctx, {
        projectId: fixture.projectId,
        byName: "Familie Berger",
        note: "Zähler läuft, App erklärt.",
      }),
    );
    expect(handover.handoverAt).not.toBeNull();
    expect(handover.handoverByName).toBe("Familie Berger");
    expect(handover.handoverNote).toBe("Zähler läuft, App erklärt.");

    // Korrektur via erneuter Abnahme (neuer Zeitstempel, auditiert).
    const corrected = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordHandover(tx, ctx, {
        projectId: fixture.projectId,
        byName: "Familie Berger",
        note: null,
      }),
    );
    expect(corrected.handoverNote).toBeNull();
    expect(corrected.handoverByName).toBe("Familie Berger");

    // Leerer Name und überlange Notiz fail-closed.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordHandover(tx, ctx, { projectId: fixture.projectId, byName: "   " }),
    )).rejects.toBeInstanceOf(InstallationValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordHandover(tx, ctx, {
        projectId: fixture.projectId,
        byName: "Familie Berger",
        note: "x".repeat(501),
      }),
    )).rejects.toBeInstanceOf(InstallationValidationError);

    // Fehlendes Projekt → NotFound ohne Orakel.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordHandover(tx, ctx, {
        projectId: "00000000-0000-4000-8000-000000000000",
        byName: "Niemand",
      }),
    )).rejects.toBeInstanceOf(InstallationNotFoundError);
  });

  it("F705-DB-02: aktive Installation nie abnehmbar", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordHandover(tx, ctx, { projectId: fixture.projectId, byName: "Zu früh" }),
    )).rejects.toBeInstanceOf(InstallationValidationError);
  });

  it("F705-RBAC-01: Viewer liest Abnahme read-only", async () => {
    await seedCompleted(fixture);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordHandover(tx, ctx, { projectId: fixture.projectId, byName: "Familie Berger" }),
    );
    const read = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(read?.handoverByName).toBe("Familie Berger");
    expect(read?.permissions.canWrite).toBe(false);

    // Viewer ohne Schreibrecht fail-closed (Berechtigung, nicht Validierung).
    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => recordHandover(tx, ctx, { projectId: fixture.projectId, byName: "Viewer" }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
