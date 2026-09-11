import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  type CreateTimeEntryCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  createTimeEntry,
  listTimeEntries,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  residentialProjectId: string;
  commercialProjectId: string;
};

async function seedProject(
  workspaceId: string,
  scope: "residential" | "commercial",
  label: string,
): Promise<string> {
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, ${label}, 'F9', 'Fixture',
        ${`${contactId}@f902b.test`}, ${`${contactId}@f902b.test`})
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
         and board.scope = ${scope}
         and board.is_default = true
         and board.archived_at is null
    `);
  });
  return projectId;
}

function entryCommand(projectId: string, comment: string): CreateTimeEntryCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId,
    fields: {
      typeId: null,
      startAt: "2026-09-04T08:00:00.000Z",
      endAt: "2026-09-04T09:00:00.000Z",
      workingTimeMinutes: 60,
      breakDurationMinutes: 0,
      comment,
    },
  };
}

describe("F9-02b Auto-Tag Residential/Commercial (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    const workspaceId = randomUUID();
    const editorId = randomUUID();
    const viewerId = randomUUID();
    await withTenantOn(testPool, workspaceId, async (tx) => {
      await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F9.02b Auto-Tag')`);
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${editorId}::uuid, ${`editor-${editorId}@f902b.test`}),
               (${viewerId}::uuid, ${`viewer-${viewerId}@f902b.test`})
      `);
      await tx.execute(sql`
        insert into membership (id, workspace_id, user_id, role, capabilities)
        values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
                'editor', '{}'::jsonb),
               (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
                'viewer', '{}'::jsonb)
      `);
    });
    const residentialProjectId = await seedProject(workspaceId, "residential", "F9.02b Wohnbau");
    const commercialProjectId = await seedProject(workspaceId, "commercial", "F9.02b Gewerbe");
    fixture = { workspaceId, editorId, viewerId, residentialProjectId, commercialProjectId };
    await withAuthorizedTenantOn(
      testPool, editorId, workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(residentialProjectId, "Eintrag Wohnbau")),
    );
    await withAuthorizedTenantOn(
      testPool, editorId, workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(commercialProjectId, "Eintrag Gewerbe")),
    );
  });

  it("F902B-DB-01: Tag folgt dem Board-Scope des Projekts", async () => {
    const residential = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.residentialProjectId }),
    );
    expect(residential.entries.map((entry) => entry.scopeTag)).toEqual(["residential"]);

    const commercial = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.commercialProjectId }),
    );
    expect(commercial.entries.map((entry) => entry.scopeTag)).toEqual(["commercial"]);
  });
});
