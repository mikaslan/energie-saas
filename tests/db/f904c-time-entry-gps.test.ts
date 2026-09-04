import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { TIME_TRACKING_SCHEMA_VERSION } from "@/lib/integrations/time-tracking/contract";
import {
  listTimeEntryRevisions,
  startTimeEntry,
  stopTimeEntry,
  TimeTrackingValidationError,
  updateTimeEntry,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
};

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f904c.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f904c.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
  });
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9.4c Kontakt', 'F9', 'Fixture',
        ${`${contactId}@f904c.test`}, ${`${contactId}@f904c.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9.4c Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id, 'F9.4c Projekt', 'fixture'
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
  return { workspaceId, editorId, viewerId, projectId };
}

describe("F9.4 Slice C GPS am Start-Event (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedWorkspace("F9.4c GPS");
  });

  it("F904C-DB-01: Start mit Koordinaten speichert sie, Start ohne bleibt NULL", async () => {
    const withGps = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId: fixture.projectId,
        typeId: null,
        comment: null,
        startLat: 52.52,
        startLng: 13.405,
      }),
    );
    expect(withGps.startLat).toBeCloseTo(52.52, 10);
    expect(withGps.startLng).toBeCloseTo(13.405, 10);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => stopTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id: withGps.id,
        workingTimeMinutes: 30,
        breakDurationMinutes: 0,
        comment: null,
      }),
    );

    const withoutGps = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId: fixture.projectId,
        typeId: null,
        comment: null,
      }),
    );
    expect(withoutGps.startLat).toBeNull();
    expect(withoutGps.startLng).toBeNull();
  });

  it("F904C-DB-02: Out-of-Range und halbe Paare sind ValidationError", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId: fixture.projectId,
        typeId: null,
        comment: null,
        startLat: 91,
        startLng: 13.405,
      }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId: fixture.projectId,
        typeId: null,
        comment: null,
        startLat: 52.52,
      }),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
  });

  it("F904C-DB-03: Update behält Koordinaten, Revision kopiert sie (Vollbild)", async () => {
    const started = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId: fixture.projectId,
        typeId: null,
        comment: null,
        startLat: 52.52,
        startLng: 13.405,
      }),
    );
    const stopped = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => stopTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id: started.id,
        workingTimeMinutes: 30,
        breakDurationMinutes: 0,
        comment: null,
      }),
    );
    expect(stopped.startLat).toBeCloseTo(52.52, 10);

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id: started.id,
        fields: {
          typeId: null,
          startAt: "2026-09-04T08:00:00.000Z",
          endAt: "2026-09-04T10:00:00.000Z",
          workingTimeMinutes: 90,
          breakDurationMinutes: 0,
          comment: "Nachgetragen",
        },
      }),
    );
    expect(updated.startLat).toBeCloseTo(52.52, 10);
    expect(updated.startLng).toBeCloseTo(13.405, 10);

    const history = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntryRevisions(tx, ctx, { entryId: started.id }),
    );
    expect(history.revisions).toHaveLength(1);
    expect(history.revisions[0]!.startLat).toBeCloseTo(52.52, 10);
    expect(history.revisions[0]!.startLng).toBeCloseTo(13.405, 10);
  });
});
