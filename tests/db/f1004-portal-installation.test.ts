import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  PORTAL_INVITE_CREATE_VERSION,
  PORTAL_INVITE_WITHDRAW_VERSION,
} from "@/lib/integrations/portal/portal-contract";
import {
  createPortalInvite,
  PortalNotFoundError,
  resolvePortalByToken,
  withdrawPortalInvite,
} from "@/modules/portal";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  projectId: string;
};

async function seedFixture(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1004.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F10', 'Fixture',
        ${`${contactId}@f1004.test`}, ${`${contactId}@f1004.test`})
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
  return { workspaceId, editorId, projectId };
}

async function createInvite(fixture: Fixture) {
  return withAuthorizedTenantOn(
    testPool, fixture.editorId, fixture.workspaceId,
    (tx, ctx) => createPortalInvite(tx, ctx, {
      schemaVersion: PORTAL_INVITE_CREATE_VERSION,
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      ttlDays: 14,
    }),
  );
}

async function seedInstallation(
  fixture: Fixture,
  status: "active" | "completed",
  withHandover: boolean,
): Promise<void> {
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into installation (
        workspace_id, project_id, source, status,
        completed_at, handover_at, handover_by_name
      ) values (
        ${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid, 'direct', ${status},
        case when ${status} = 'completed'
          then '2026-09-08T10:00:00.000Z'::timestamptz end,
        case when ${withHandover}
          then '2026-09-09T10:00:00.000Z'::timestamptz end,
        case when ${withHandover} then 'Interne Abnehmerin' end
      )
    `);
  });
}

describe("F10-03 Installation-Tab (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture(`F10-03 ${randomUUID()}`);
  });

  it("F1004-DB-01: ohne Installation null, mit Stand ohne Namen/Notizen", async () => {
    const invite = await createInvite(fixture);
    const empty = await resolvePortalByToken(testPool, { token: invite.token });
    expect(empty.installation).toBeNull();

    await seedInstallation(fixture, "active", false);
    const active = await resolvePortalByToken(testPool, { token: invite.token });
    expect(active.installation).toMatchObject({ status: "active" });
    expect(active.installation?.completedAt).toBeNull();
    expect(active.installation?.handoverAt).toBeNull();
    expect(active.installation).not.toHaveProperty("handoverByName");
    expect(active.installation).not.toHaveProperty("handoverNote");
    expect(active.installation).not.toHaveProperty("source");
  });

  it("F1004-DB-02: completed + Abnahme projiziert Daten, Withdraw bleibt not_found", async () => {
    const invite = await createInvite(fixture);
    await seedInstallation(fixture, "completed", true);
    const view = await resolvePortalByToken(testPool, { token: invite.token });
    expect(view.installation?.status).toBe("completed");
    expect(view.installation?.completedAt).toBe("2026-09-08T10:00:00.000Z");
    expect(view.installation?.handoverAt).toBe("2026-09-09T10:00:00.000Z");

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => withdrawPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_WITHDRAW_VERSION,
        workspaceId: fixture.workspaceId,
        inviteId: invite.inviteId,
        reason: "user_request",
      }),
    );
    await expect(resolvePortalByToken(testPool, { token: invite.token }))
      .rejects.toBeInstanceOf(PortalNotFoundError);
  });
});
