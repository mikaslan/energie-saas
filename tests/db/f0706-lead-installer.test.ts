import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  createInstallation,
  getInstallation,
  InstallationNotFoundError,
  InstallationValidationError,
  listInstallerOptions,
  setLeadInstaller,
} from "@/modules/installations";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  editorMembershipId: string;
  viewerId: string;
  externalId: string;
  projectId: string;
  foreignMembershipId: string;
};

async function seedProject(
  workspaceId: string,
  label: string,
): Promise<{ projectId: string }> {
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F7', 'Fixture',
        ${`${contactId}@f706.test`}, ${`${contactId}@f706.test`})
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
             ${siteId}::uuid, board.id, intake_column.id, ${label}, 'fixture'
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
  return { projectId };
}

async function seedWorkspace(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  const editorMembershipId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7.06 Lead')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f706.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f706.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f706.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
              'editor', '{"external_only":true}'::jsonb)
    `);
  });
  const { projectId } = await seedProject(workspaceId, "F7.06 Projekt");

  // Fremdmandant für die Tenant-Schranke.
  const foreignWorkspaceId = randomUUID();
  const foreignUserId = randomUUID();
  const foreignMembershipId = randomUUID();
  await withTenantOn(testPool, foreignWorkspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${foreignWorkspaceId}::uuid, 'F7.06 Fremd')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${foreignUserId}::uuid, ${`fremd-${foreignUserId}@f706.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${foreignMembershipId}::uuid, ${foreignWorkspaceId}::uuid, ${foreignUserId}::uuid,
              'editor', '{}'::jsonb)
    `);
  });

  await withAuthorizedTenantOn(
    testPool, editorId, workspaceId,
    (tx, ctx) => createInstallation(tx, ctx, { projectId }),
  );
  return {
    workspaceId, editorId, editorMembershipId, viewerId, externalId,
    projectId, foreignMembershipId,
  };
}

describe("F7.05 Slice 3 Lead Installer (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedWorkspace();
  });

  function readOf(userId: string) {
    return withAuthorizedTenantOn(
      testPool, userId, fixture.workspaceId,
      (tx, ctx) => getInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
  }

  it("F706-DB-01: setzen/lesen/leeren-Roundtrip mit Label", async () => {
    const assigned = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setLeadInstaller(tx, ctx, {
        projectId: fixture.projectId,
        membershipId: fixture.editorMembershipId,
      }),
    );
    expect(assigned.leadInstallerMembershipId).toBe(fixture.editorMembershipId);
    expect(assigned.leadInstallerLabel).toContain("@f706.test");

    const reread = await readOf(fixture.viewerId);
    expect(reread?.leadInstallerMembershipId).toBe(fixture.editorMembershipId);
    expect(reread?.leadInstallerLabel).toBe(assigned.leadInstallerLabel);

    const cleared = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setLeadInstaller(tx, ctx, {
        projectId: fixture.projectId,
        membershipId: null,
      }),
    );
    expect(cleared.leadInstallerMembershipId).toBeNull();
    expect(cleared.leadInstallerLabel).toBeNull();
  });

  it("F706-DB-02: Optionen listen Mitglieder, Schreiben bleibt Editor-intern", async () => {
    const options = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listInstallerOptions(tx, ctx),
    );
    expect(options.some((option) => option.membershipId === fixture.editorMembershipId)).toBe(true);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => setLeadInstaller(tx, ctx, {
        projectId: fixture.projectId,
        membershipId: fixture.editorMembershipId,
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => setLeadInstaller(tx, ctx, {
        projectId: fixture.projectId,
        membershipId: fixture.editorMembershipId,
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("F706-DB-03: fremde/unbekannte Membership und fehlende Installation fail-closed", async () => {
    const assign = (membershipId: string | null, projectId: string) => withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setLeadInstaller(tx, ctx, { projectId, membershipId }),
    );
    await expect(assign(fixture.foreignMembershipId, fixture.projectId)).rejects
      .toBeInstanceOf(InstallationValidationError);
    await expect(assign(randomUUID(), fixture.projectId)).rejects
      .toBeInstanceOf(InstallationValidationError);
    await expect(assign(fixture.editorMembershipId, randomUUID())).rejects
      .toBeInstanceOf(InstallationNotFoundError);
    // Fehlschlag hinterlässt keine Zuweisung.
    expect((await readOf(fixture.editorId))?.leadInstallerMembershipId).toBeNull();
  });
});
