import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  createTeam,
  listTeamMemberships,
  setTeamActive,
  setTeamMembers,
} from "@/modules/teams";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  adminId: string;
  editorId: string;
  editorMembershipId: string;
  viewerId: string;
};

async function seedFixture(emailDomain: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const adminId = randomUUID();
  const editorId = randomUUID();
  const editorMembershipId = randomUUID();
  const viewerId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F7.07 Gruppierung')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${adminId}::uuid, ${`admin-${adminId}@${emailDomain}`}),
             (${editorId}::uuid, ${`editor-${editorId}@${emailDomain}`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@${emailDomain}`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${adminId}::uuid, 'admin', '{}'::jsonb),
             (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });

  return { workspaceId, adminId, editorId, editorMembershipId, viewerId };
}

describe("F7-07 Team-Gruppierung (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("f0707.test");
  });

  const asAdmin = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.adminId, fixture.workspaceId, fn as never) as Promise<T>;

  const asEditor = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.editorId, fixture.workspaceId, fn as never) as Promise<T>;

  const asViewer = <T>(fn: (tx: never, ctx: never) => Promise<T>): Promise<T> =>
    withAuthorizedTenantOn(testPool, fixture.viewerId, fixture.workspaceId, fn as never) as Promise<T>;

  it("F0707-DB-01: nur aktive Teams, deterministisch, ohne PII", async () => {
    const alpha = await asAdmin((tx, ctx) => createTeam(tx, ctx, { name: "Alpha-Team" }));
    const beta = await asAdmin((tx, ctx) => createTeam(tx, ctx, { name: "Beta-Team" }));
    await asAdmin((tx, ctx) => setTeamMembers(tx, ctx, {
      id: beta.id, membershipIds: [fixture.editorMembershipId],
    }));
    await asAdmin((tx, ctx) => setTeamMembers(tx, ctx, {
      id: alpha.id, membershipIds: [fixture.editorMembershipId],
    }));
    await asAdmin((tx, ctx) => setTeamActive(tx, ctx, {
      // setTeamMembers fasst die Team-Revision nicht an → weiter 1.
      id: beta.id, active: false, expectedRevision: 1,
    }));

    const rows = await asEditor((tx, ctx) => listTeamMemberships(tx, ctx));
    // Nur Alpha (aktiv); Beta ist archiviert. Schlüssel exakt, keine E-Mails.
    expect(rows).toEqual([{
      teamId: alpha.id,
      teamName: "Alpha-Team",
      membershipId: fixture.editorMembershipId,
    }]);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["membershipId", "teamId", "teamName"]);
    }
  });

  it("F0707-DB-02: Mandantentrennung; Viewer liest mit (calendar.read)", async () => {
    const alpha = await asAdmin((tx, ctx) => createTeam(tx, ctx, { name: "Alpha-Team" }));
    await asAdmin((tx, ctx) => setTeamMembers(tx, ctx, {
      id: alpha.id, membershipIds: [fixture.editorMembershipId],
    }));

    // Fremder Workspace sieht nichts (RLS + Workspace-Filter).
    const other = await seedFixture("f0707-fremd.test");
    const foreign = await withAuthorizedTenantOn(
      testPool, other.adminId, other.workspaceId,
      (tx, ctx) => listTeamMemberships(tx, ctx),
    );
    expect(foreign).toEqual([]);

    // Viewer hat calendar.read (minRole viewer) und sieht dieselbe Liste.
    const asViewerRows = await asViewer((tx, ctx) => listTeamMemberships(tx, ctx));
    expect(asViewerRows).toEqual([{
      teamId: alpha.id,
      teamName: "Alpha-Team",
      membershipId: fixture.editorMembershipId,
    }]);
  });
});
