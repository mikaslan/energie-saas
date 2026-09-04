import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import { TIME_TRACKING_SCHEMA_VERSION } from "@/lib/integrations/time-tracking/contract";
import {
  archiveTimeEntry,
  createTimeEntry,
  getTimeUtilization,
  listTimeEntries,
  startTimeEntry,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  secondId: string;
  viewerId: string;
  externalId: string;
  projectId: string;
};

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const secondId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f904d.test`}),
             (${secondId}::uuid, ${`second-${secondId}@f904d.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f904d.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f904d.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${secondId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid,
              'editor', '{"external_only":true}'::jsonb)
    `);
  });
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9.4d Kontakt', 'F9', 'Fixture',
        ${`${contactId}@f904d.test`}, ${`${contactId}@f904d.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9.4d Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id, 'F9.4d Projekt', 'fixture'
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
  return { workspaceId, editorId, secondId, viewerId, externalId, projectId };
}

async function createEntry(
  fixture: Fixture,
  actorId: string,
  startHour: number,
  minutes: number,
  comment: string,
): Promise<string> {
  const pad = (n: number) => String(n).padStart(2, "0");
  return withAuthorizedTenantOn(
    testPool, actorId, fixture.workspaceId,
    (tx, ctx) => createTimeEntry(tx, ctx, {
      schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
      projectId: fixture.projectId,
      fields: {
        typeId: null,
        startAt: `2026-09-04T${pad(startHour)}:00:00.000Z`,
        endAt: `2026-09-04T${pad(startHour + 2)}:00:00.000Z`,
        workingTimeMinutes: minutes,
        breakDurationMinutes: 0,
        comment,
      },
    }).then((created) => created.id),
  );
}

describe("F9.4 Slice D Team-Auslastung (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedWorkspace("F9.4d Team");
    await createEntry(fixture, fixture.editorId, 8, 90, "Montage");
    await createEntry(fixture, fixture.secondId, 14, 30, "Nacharbeit");
  });

  it("F904D-DB-01: Summen je Mitglied, absteigend sortiert, Summe = Listensumme", async () => {
    const utilization = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getTimeUtilization(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(utilization.rows).toHaveLength(2);
    expect(utilization.rows[0]!.userId).toBe(fixture.editorId);
    expect(utilization.rows[0]!.totalWorkingMinutes).toBe(90);
    expect(utilization.rows[0]!.entryCount).toBe(1);
    expect(utilization.rows[0]!.running).toBe(false);
    expect(utilization.rows[0]!.label).toContain("f904d.test");
    expect(utilization.rows[1]!.userId).toBe(fixture.secondId);
    expect(utilization.rows[1]!.totalWorkingMinutes).toBe(30);

    // WYSIWYG-Pin: Dashboard-Summe = Listensumme bei gleichem Filter.
    const list = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    const dashboardTotal = utilization.rows.reduce((sum, row) => sum + row.totalWorkingMinutes, 0);
    expect(dashboardTotal).toBe(list.totalWorkingMinutes);
    expect(dashboardTotal).toBe(120);
  });

  it("F904D-DB-02: laufender Eintrag zählt nicht, markiert aber; Archiv fliegt raus; Filter treu", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId: fixture.projectId,
        typeId: null,
        comment: "Laufend",
      }),
    );
    const withRunning = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getTimeUtilization(tx, ctx, { projectId: fixture.projectId }),
    );
    const editorRow = withRunning.rows.find((row) => row.userId === fixture.editorId)!;
    expect(editorRow.totalWorkingMinutes).toBe(90);
    expect(editorRow.entryCount).toBe(2);
    expect(editorRow.running).toBe(true);

    const archivedId = await createEntry(fixture, fixture.secondId, 10, 60, "WirdArchiviert");
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveTimeEntry(tx, ctx, archivedId),
    );
    const afterArchive = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getTimeUtilization(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(afterArchive.rows.find((row) => row.userId === fixture.secondId)!.totalWorkingMinutes)
      .toBe(30);

    const filtered = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getTimeUtilization(tx, ctx, { projectId: fixture.projectId, userIds: [fixture.secondId] }),
    );
    expect(filtered.rows).toHaveLength(1);
    expect(filtered.rows[0]!.userId).toBe(fixture.secondId);
  });

  it("F904D-DB-03: Viewer lesen ok, Externer denied", async () => {
    const viewer = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => getTimeUtilization(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(viewer.rows).toHaveLength(2);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => getTimeUtilization(tx, ctx, { projectId: fixture.projectId }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
