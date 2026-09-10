import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  LEAD_SOURCE_SCHEMA_VERSION,
} from "@/lib/integrations/lead-sources/contract";
import {
  createLeadSource,
  getLeadSourcePipelineStats,
} from "@/modules/lead-sources";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  contactId: string;
  siteId: string;
};

async function seedFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    workspaceId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
    contactId: randomUUID(),
    siteId: randomUUID(),
  };
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name) values (${fixture.workspaceId}::uuid, 'DASH-08 Quellen')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${fixture.editorId}::uuid, ${`${fixture.editorId}@dash08.test`}),
        (${fixture.viewerId}::uuid, ${`${fixture.viewerId}@dash08.test`}),
        (${fixture.externalId}::uuid, ${`${fixture.externalId}@dash08.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${fixture.editorId}::uuid,
          'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${fixture.viewerId}::uuid,
          'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid, ${fixture.externalId}::uuid,
          'editor', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values (
        ${fixture.contactId}::uuid, ${fixture.workspaceId}::uuid,
        'DASH-08 Kundin', 'Fixture', 'Contact', 'kundin@dash08.test', 'kundin@dash08.test'
      )
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label, formatted_address)
      values (
        ${fixture.siteId}::uuid, ${fixture.workspaceId}::uuid,
        ${fixture.contactId}::uuid, 'DASH-08 Standort', 'Prüfweg 8, 10115 Berlin'
      )
    `);
  });
  return fixture;
}

async function seedProject(
  fixture: Fixture,
  name: string,
  leadSourceId: string | null,
): Promise<string> {
  const projectId = randomUUID();
  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const inserted = await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, phase, outcome, source_key, lead_source_id
      )
      select ${projectId}::uuid, ${fixture.workspaceId}::uuid,
             ${fixture.contactId}::uuid, ${fixture.siteId}::uuid, board.id, intake.id,
             ${name}, 'request', 'open', ${`dash08-${name}`},
             ${leadSourceId}::uuid
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id
         and intake.board_id = board.id
         and intake.is_intake = true
         and intake.archived_at is null
       where board.workspace_id = ${fixture.workspaceId}::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
      returning id
    `);
    if (inserted.rowCount !== 1) throw new Error("DASH-08 project was not seeded");
  });
  return projectId;
}

describe("DASH-08 Pipeline nach Quelle (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("DASH08-DB-01: gruppiert Board-Menge je Quelle inkl. Ohne-Quelle", async () => {
    const portal = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createLeadSource(tx, ctx, {
        schemaVersion: LEAD_SOURCE_SCHEMA_VERSION,
        name: "Portal",
        projectDomain: "residential",
        color: "#3B82F6",
      }),
    );
    const ids = [
      await seedProject(fixture, "P1", portal.id),
      await seedProject(fixture, "P2", portal.id),
      await seedProject(fixture, "P3", null),
    ];

    const slices = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getLeadSourcePipelineStats(tx, ctx, ids),
    );
    expect(slices).toHaveLength(2);
    expect(slices[0]).toMatchObject({ sourceName: "Portal", unassigned: false, count: 2 });
    expect(slices[1]).toMatchObject({ sourceName: "Ohne Quelle", unassigned: true, count: 1 });

    // Leere Pipeline-Menge: aktive Quelle erscheint ehrlich mit 0.
    const empty = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getLeadSourcePipelineStats(tx, ctx, []),
    );
    expect(empty).toEqual([
      { sourceName: "Portal", unassigned: false, count: 0 },
    ]);

    // Ungueltige ID fail-closed.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getLeadSourcePipelineStats(tx, ctx, ["keine-uuid"]),
    )).rejects.toBeInstanceOf(Error);
  });

  it("DASH08-DB-02: Viewer liest, External fail-closed", async () => {
    const slices = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getLeadSourcePipelineStats(tx, ctx, [randomUUID()]),
    );
    expect(slices).toEqual([]);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => getLeadSourcePipelineStats(tx, ctx, [randomUUID()]),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
