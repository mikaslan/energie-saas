import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  clearRoutingRule,
  LeadSourceNotFoundError,
  LeadSourceValidationError,
  listRoutableMembers,
  listRoutingRules,
  setRoutingRule,
  suggestAssigneeForProject,
} from "@/modules/lead-sources";
import { changeProjectAssignment } from "@/modules/projects/assignment-service";
import { PROJECT_ASSIGNMENT_COMMAND_VERSION } from "@/modules/projects/assignment-contract";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  sourceId: string;
  editorId: string;
  editorMembershipId: string;
  viewerId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const sourceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const editorMembershipId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1-10 Routing')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f110.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f110.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{"assign_projects": true}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into lead_source (id, workspace_id, name, name_normalized)
      values (${sourceId}::uuid, ${workspaceId}::uuid, 'F110 Quelle', 'f110 quelle')
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F110-CUSTOMER', 'Fixture', 'Contact', 'c@f110.test', 'c@f110.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F110 Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key, lead_source_id)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F110 Project', 'manual', ${sourceId}::uuid
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return { workspaceId, projectId, sourceId, editorId, editorMembershipId, viewerId };
}

describe("F1-10 Lead-Routing (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("F110-DB-01: Set → Liste → Upsert ersetzt → Clear löscht (idempotent)", async () => {
    const run = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
      withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;

    const created = await run((tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: fixture.editorMembershipId,
    }));
    expect(created.sourceName).toBe("F110 Quelle");
    expect(created.assigneeLabel).toContain("@f110.test");
    expect(created.permissions.canWrite).toBe(true);

    const listed = await run((tx, ctx) => listRoutingRules(tx, ctx));
    expect(listed).toHaveLength(1);
    expect(listed[0]?.leadSourceId).toBe(fixture.sourceId.toLowerCase());

    // Upsert: zweites Mitglied ersetzt die Regel (weiterhin genau eine).
    const otherUserId = randomUUID();
    const otherMembershipId = randomUUID();
    await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${otherUserId}::uuid, ${`other-${otherUserId}@f110.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${otherMembershipId}::uuid, ${fixture.workspaceId}::uuid, ${otherUserId}::uuid, 'editor', '{}'::jsonb)
      `);
    });
    await run((tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: otherMembershipId,
    }));
    const relisted = await run((tx, ctx) => listRoutingRules(tx, ctx));
    expect(relisted).toHaveLength(1);
    expect(relisted[0]?.assigneeMembershipId).toBe(otherMembershipId.toLowerCase());

    const cleared = await run((tx, ctx) => clearRoutingRule(tx, ctx, { leadSourceId: fixture.sourceId }));
    expect(cleared.deleted).toBe(true);
    const clearedAgain = await run((tx, ctx) => clearRoutingRule(tx, ctx, { leadSourceId: fixture.sourceId }));
    expect(clearedAgain.deleted).toBe(false);
    expect(await run((tx, ctx) => listRoutingRules(tx, ctx))).toHaveLength(0);
  });

  it("F110-DB-02: unbekannte Quelle/Mitgliedschaft fail-closed; Viewer darf nicht schreiben", async () => {
    const asEditor = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
      withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;
    const asViewer = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
      withAuthorizedTenantOn(testPool, fixture.viewerId, fixture.workspaceId, fn as never) as Promise<T>;

    await expect(asEditor((tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: randomUUID(),
      assigneeMembershipId: fixture.editorMembershipId,
    }))).rejects.toBeInstanceOf(LeadSourceNotFoundError);

    await expect(asEditor((tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: randomUUID(),
    }))).rejects.toBeInstanceOf(LeadSourceValidationError);

    await expect(asViewer((tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: fixture.editorMembershipId,
    }))).rejects.toBeInstanceOf(PermissionDeniedError);

    // Viewer liest: leere Liste + Mitglieder sichtbar (lead_source.read).
    expect(await asViewer((tx, ctx) => listRoutingRules(tx, ctx))).toHaveLength(0);
    const members = await asViewer((tx, ctx) => listRoutableMembers(tx, ctx));
    expect(members.length).toBeGreaterThanOrEqual(2);
  });

  it("F110-DB-03: Vorschlag nur mit Regel — nach Key-Account schwindet er", async () => {
    const run = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
      withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;

    expect(await run((tx, ctx) => suggestAssigneeForProject(tx, ctx, { projectId: fixture.projectId }))).toBeNull();

    await run((tx, ctx) => setRoutingRule(tx, ctx, {
      leadSourceId: fixture.sourceId,
      assigneeMembershipId: fixture.editorMembershipId,
    }));
    const suggestion = await run((tx, ctx) => suggestAssigneeForProject(tx, ctx, { projectId: fixture.projectId }));
    expect(suggestion?.sourceName).toBe("F110 Quelle");
    expect(suggestion?.membershipId).toBe(fixture.editorMembershipId.toLowerCase());
    expect(suggestion?.label).toContain("@f110.test");

    // Vorschlag per bestehendem Pfad übernehmen → danach kein Vorschlag mehr.
    await run((tx, ctx) => changeProjectAssignment(tx, ctx, {
      schemaVersion: PROJECT_ASSIGNMENT_COMMAND_VERSION,
      kind: "set_key_account",
      projectId: fixture.projectId,
      expectedAssignmentRevision: 0,
      membershipId: fixture.editorMembershipId,
    }));
    expect(await run((tx, ctx) => suggestAssigneeForProject(tx, ctx, { projectId: fixture.projectId }))).toBeNull();
  });

  it("F110-DB-04: Tenant-Isolation — Regeln aus Workspace A sind in B unsichtbar", async () => {
    const other = await seedFixture();
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => setRoutingRule(tx, ctx, {
        leadSourceId: fixture.sourceId,
        assigneeMembershipId: fixture.editorMembershipId,
      }),
    );
    const inB = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => listRoutingRules(tx, ctx),
    );
    expect(inB).toHaveLength(0);
    const suggestB = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => suggestAssigneeForProject(tx, ctx, { projectId: other.projectId }),
    );
    expect(suggestB).toBeNull();
  });
});
