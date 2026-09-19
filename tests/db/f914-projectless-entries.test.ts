import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  type CreateTimeEntryCommand,
  type StartTimeEntryCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  createTimeEntry,
  getMyRunningTimeEntry,
  listProjectlessTimeEntries,
  listTimeEntries,
  listTimeEntryRevisions,
  startTimeEntry,
  stopTimeEntry,
  updateTimeEntry,
  TimeTrackingConflictError,
  TimeTrackingNotFoundError,
  TimeTrackingValidationError,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
};

// F902/F913-Stil: frischer Workspace je Test, eigenes Projekt, kein W3-Recycling.
async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f914.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f914.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
              'editor', '{}'::jsonb),
             (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid,
              'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9-14 Projekt', 'F9', 'Vierzehn',
        ${`${contactId}@f914.test`}, ${`${contactId}@f914.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9-14 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F9-14 Projekt', 'fixture'
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

function entryCommand(projectId: string | null): CreateTimeEntryCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId: projectId as string,
    fields: {
      typeId: null,
      startAt: "2026-09-05T08:00:00.000Z",
      endAt: "2026-09-05T10:00:00.000Z",
      workingTimeMinutes: 120,
      breakDurationMinutes: 0,
      comment: "Projektlose Arbeit",
    },
  };
}

function startCommand(projectId: string | null): StartTimeEntryCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId: projectId as string,
    typeId: null,
    comment: "Projektloser Timer",
  };
}

describe("F9-14 Projekt-optionale Zeiteinträge (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F9-14 Projekt-optional");
  });

  it("F914-DB-01: projektlos anlegen → nur im projektlosen Read, strikte Trennung", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(null)),
    );
    expect(created.projectId).toBeNull();

    const projectless = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listProjectlessTimeEntries(tx, ctx, {}),
    );
    expect(projectless.entries.map((e) => e.id)).toContain(created.id);

    const projectBound = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(projectBound.entries.map((e) => e.id)).not.toContain(created.id);
  });

  it("F914-DB-02: Timer ohne Projekt starten/stoppen; Running-Unique greift projektübergreifend", async () => {
    const running = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(null)),
    );
    expect(running.running).toBe(true);
    expect(running.projectId).toBeNull();

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(fixture.projectId)),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);

    const stopped = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => stopTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id: running.id,
        workingTimeMinutes: 30,
        breakDurationMinutes: 0,
        comment: "Projektloser Timer",
      }),
    );
    expect(stopped.endAt).not.toBeNull();
    expect(stopped.projectId).toBeNull();
  });

  it("F914-DB-03: Revision kopiert project_id NULL, Verlauf lesbar", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(null)),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id: created.id,
        fields: {
          typeId: null,
          startAt: "2026-09-05T08:00:00.000Z",
          endAt: "2026-09-05T10:00:00.000Z",
          workingTimeMinutes: 120,
          breakDurationMinutes: 0,
          comment: "Projektlos geändert",
        },
      }),
    );
    const revisions = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntryRevisions(tx, ctx, { entryId: created.id }),
    );
    expect(revisions.revisions.length).toBeGreaterThan(0);
    for (const revision of revisions.revisions) {
      expect(revision.projectId).toBeNull();
    }
  });

  it("F914-DB-04: Widget-Read liefert projektlosen Timer mit NULL-Projekt", async () => {
    const running = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(null)),
    );
    const mine = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => getMyRunningTimeEntry(tx, ctx),
    );
    expect(mine).not.toBeNull();
    expect(mine!.id).toBe(running.id);
    expect(mine!.projectId).toBeNull();
    expect(mine!.projectName).toBeNull();
  });

  // Guard-Erhalt (kein Feature-Test): Diese Schranken gelten heute schon und
  // müssen nach der Nullable-Öffnung exakt so weiter gelten — gruen bei RED
  // wie bei GREEN (Absicht, kein Zufall). Belegter Bestand: Create mappt
  // FK-23503 auf Validation (service.ts upsert-catch), nur Start prüft
  // explizit auf NotFound (service.ts:1037).
  it("F914-DB-05: ungültiges projectId bleibt ValidationError, Start mit fremdem UUID bleibt NotFound", async () => {
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand("keine-uuid")),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(randomUUID())),
    )).rejects.toBeInstanceOf(TimeTrackingValidationError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => startTimeEntry(tx, ctx, startCommand(randomUUID())),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);
  });
});
