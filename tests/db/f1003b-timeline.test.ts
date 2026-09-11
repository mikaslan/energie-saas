import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  PORTAL_INVITE_CREATE_VERSION,
} from "@/lib/integrations/portal/portal-contract";
import {
  createPortalInvite,
  resolvePortalByToken,
} from "@/modules/portal";
import {
  completeInstallation,
  createInstallation,
  recordHandover,
  setLeadInstaller,
} from "@/modules/installations";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  editorMembershipId: string;
  projectId: string;
};

async function seedFixture(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const editorMembershipId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f1003b.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F10', 'Fixture',
        ${`${contactId}@f1003b.test`}, ${`${contactId}@f1003b.test`})
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
  return { workspaceId, editorId, editorMembershipId, projectId };
}

describe("F10-03b Status-Timeline (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture(`F10-03b ${randomUUID()}`);
  });

  it("F1003B-DB-01: created/completed/handover in Reihenfolge, ohne Lead/Payloads", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setLeadInstaller(tx, ctx, {
        projectId: fixture.projectId,
        membershipId: fixture.editorMembershipId,
      }),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => completeInstallation(tx, ctx, { projectId: fixture.projectId }),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => recordHandover(tx, ctx, {
        projectId: fixture.projectId,
        byName: "Interne Abnehmerin",
        note: null,
      }),
    );
    const invite = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        ttlDays: 14,
      }),
    );
    const view = await resolvePortalByToken(testPool, { token: invite.token });

    expect(view.installation?.status).toBe("completed");
    const timeline = view.installation?.timeline ?? [];
    expect(timeline.map((entry) => entry.type)).toEqual([
      "created",
      "completed",
      "handover_recorded",
    ]);
    // Nur Typ + Zeit + Berlin-Tag — keine Payloads, Akteure, Namen.
    for (const entry of timeline) {
      expect(Object.keys(entry).sort()).toEqual(["at", "day", "type"]);
      expect(entry.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    const days = timeline.map((entry) => entry.day);
    expect([...days].sort()).toEqual(days);
  });

  it("F1003B-DB-02: ohne Events ehrlich leer, ohne Installation null", async () => {
    const invite = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createPortalInvite(tx, ctx, {
        schemaVersion: PORTAL_INVITE_CREATE_VERSION,
        workspaceId: fixture.workspaceId,
        projectId: fixture.projectId,
        ttlDays: 14,
      }),
    );
    const empty = await resolvePortalByToken(testPool, { token: invite.token });
    expect(empty.installation).toBeNull();

    // Roh-Seed ohne Events (F1004-Muster) → leere Timeline, kein Crash.
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into installation (workspace_id, project_id, source, status)
        values (${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid, 'direct', 'active')
      `);
    });
    const bare = await resolvePortalByToken(testPool, { token: invite.token });
    expect(bare.installation?.status).toBe("active");
    expect(bare.installation?.timeline).toEqual([]);
  });
});
