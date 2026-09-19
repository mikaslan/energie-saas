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
  approveTimeEntry,
  archiveTimeEntry,
  createTimeEntry,
  listProjectlessTimeEntries,
  listTimeEntryRevisions,
  unapproveTimeEntry,
  updateTimeEntry,
  TimeTrackingConflictError,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  projectId: string;
};

// F914-Stil: frischer Workspace je Test, eigenes Projekt, kein W3-Recycling.
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
      values (${editorId}::uuid, ${`editor-${editorId}@f915a.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f915a.test`})
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
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9-15a Projekt', 'F9', 'Fuenfzehn',
        ${`${contactId}@f915a.test`}, ${`${contactId}@f915a.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9-15a Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id,
             'F9-15a Projekt', 'fixture'
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

function entryCommand(projectId: string | null, comment = "Projektlose Arbeit"): CreateTimeEntryCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId: projectId as string,
    fields: {
      typeId: null,
      startAt: "2026-09-05T08:00:00.000Z",
      endAt: "2026-09-05T10:00:00.000Z",
      workingTimeMinutes: 120,
      breakDurationMinutes: 0,
      comment,
    },
  };
}

function updatedFields(comment: string) {
  return {
    typeId: null,
    startAt: "2026-09-05T08:00:00.000Z",
    endAt: "2026-09-05T11:00:00.000Z",
    workingTimeMinutes: 180,
    breakDurationMinutes: 15,
    comment,
  };
}

describe("F9-15a Projektlose Folge: Edit/Archiv/Freigabe (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace("F9-15a Projektlos verwalten");
  });

  it("F915A-DB-01: update an projektloser Zeile → Felder geändert, Projekt NULL, Revisions-Copy NULL", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(null)),
    );
    expect(created.projectId).toBeNull();

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id: created.id,
        fields: updatedFields("Projektlos geändert"),
      }),
    );
    expect(updated.projectId).toBeNull();
    expect(updated.comment).toBe("Projektlos geändert");
    expect(updated.workingTimeMinutes).toBe(180);
    expect(updated.breakDurationMinutes).toBe(15);

    const revisions = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntryRevisions(tx, ctx, { entryId: created.id }),
    );
    expect(revisions.revisions.length).toBeGreaterThan(0);
    for (const revision of revisions.revisions) {
      expect(revision.projectId).toBeNull();
    }
    expect(revisions.revisions[0]!.comment).toBe("Projektlose Arbeit");
  });

  it("F915A-DB-02: archive an projektloser Zeile → Default-Read leer, includeArchived lesbar", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(null)),
    );

    const archived = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveTimeEntry(tx, ctx, created.id),
    );
    expect(archived.projectId).toBeNull();
    expect(archived.archivedAt).not.toBeNull();

    const visible = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listProjectlessTimeEntries(tx, ctx, {}),
    );
    expect(visible.entries.map((e) => e.id)).not.toContain(created.id);

    const withArchived = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listProjectlessTimeEntries(tx, ctx, { includeArchived: true }),
    );
    expect(withArchived.entries.map((e) => e.id)).toContain(created.id);
  });

  it("F915A-DB-03: approve/unapprove an projektloser Zeile → Freigabe-Sichtbarkeit lesend", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(null)),
    );

    const approved = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => approveTimeEntry(tx, ctx, created.id),
    );
    expect(approved.projectId).toBeNull();
    expect(approved.approvedAt).not.toBeNull();

    const approvedRead = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listProjectlessTimeEntries(tx, ctx, { approval: "approved" }),
    );
    expect(approvedRead.entries.map((e) => e.id)).toContain(created.id);
    const openRead = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listProjectlessTimeEntries(tx, ctx, { approval: "open" }),
    );
    expect(openRead.entries.map((e) => e.id)).not.toContain(created.id);

    const unapproved = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unapproveTimeEntry(tx, ctx, created.id),
    );
    expect(unapproved.projectId).toBeNull();
    expect(unapproved.approvedAt).toBeNull();

    const reopened = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listProjectlessTimeEntries(tx, ctx, { approval: "open" }),
    );
    expect(reopened.entries.map((e) => e.id)).toContain(created.id);
  });

  it("F915A-DB-04: Freigabe-Guards gelten projektlos wie am Projekt (Conflict, kein Silent-Write)", async () => {
    const created = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => createTimeEntry(tx, ctx, entryCommand(null)),
    );
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => approveTimeEntry(tx, ctx, created.id),
    );

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id: created.id,
        fields: updatedFields("Darf nicht speichern"),
      }),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveTimeEntry(tx, ctx, created.id),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => approveTimeEntry(tx, ctx, created.id),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);

    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unapproveTimeEntry(tx, ctx, created.id),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unapproveTimeEntry(tx, ctx, created.id),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);
  });
});
