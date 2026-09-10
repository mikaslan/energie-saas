import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PROJECT_OUTCOME_COMMAND_VERSION,
  changeProjectOutcome,
  getClosureTrendStats,
} from "@/modules/projects";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  projectId: string;
};

async function seedFixture(): Promise<Fixture> {
  const fixture: Fixture = {
    workspaceId: randomUUID(),
    editorId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
    projectId: randomUUID(),
  };
  const contactId = randomUUID();
  const siteId = randomUUID();

  await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${fixture.workspaceId}::uuid, 'DASH-07 Trend')
    `);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${fixture.editorId}::uuid, ${`${fixture.editorId}@dash07.test`}),
        (${fixture.viewerId}::uuid, ${`${fixture.viewerId}@dash07.test`}),
        (${fixture.externalId}::uuid, ${`${fixture.externalId}@dash07.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${fixture.workspaceId}::uuid,
          ${fixture.externalId}::uuid, 'editor', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values (
        ${contactId}::uuid, ${fixture.workspaceId}::uuid,
        'DASH-07 Kundin', 'Fixture', 'Contact', 'kundin@dash07.test',
        'kundin@dash07.test'
      )
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label, formatted_address)
      values (
        ${siteId}::uuid, ${fixture.workspaceId}::uuid,
        ${contactId}::uuid, 'DASH-07 Standort', 'Prüfweg 7, 10115 Berlin'
      )
    `);
    const projects = await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, phase, outcome, source_key
      )
      select ${fixture.projectId}::uuid, ${fixture.workspaceId}::uuid,
             ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id,
             'Trendprojekt', 'request', 'open', 'dash07-main'
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
    if (projects.rowCount !== 1) throw new Error("DASH-07 project was not seeded");
  });
  return fixture;
}

describe("DASH-07 Abschlusstrend (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("DASH07-DB-01: gewonnener Abschluss landet im laufenden Berliner Monat", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => changeProjectOutcome(tx, ctx, {
        schemaVersion: PROJECT_OUTCOME_COMMAND_VERSION,
        kind: "mark_won",
        projectId: fixture.projectId,
        expectedOutcomeRevision: 0,
        confirmation: "mark_won",
      }),
    );

    const stats = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getClosureTrendStats(tx, ctx),
    );
    expect(stats.months).toHaveLength(12);
    expect(stats.wonTotal).toBe(1);
    expect(stats.lostTotal).toBe(0);
    expect(stats.endMonth).toMatch(/^\d{4}-\d{2}$/u);
    const current = stats.months.find((item) => item.month === stats.endMonth);
    expect(current).toMatchObject({ won: 1, lost: 0, total: 1 });
    // Lueckenlose Monate, aeltester zuerst.
    const keys = stats.months.map((item) => item.month);
    expect([...new Set(keys)]).toHaveLength(12);
    expect(keys[11]).toBe(stats.endMonth);
  });

  it("DASH07-DB-02: Viewer liest, External fail-closed", async () => {
    const stats = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getClosureTrendStats(tx, ctx),
    );
    expect(stats.months).toHaveLength(12);
    expect(stats.wonTotal).toBe(0);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => getClosureTrendStats(tx, ctx),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
