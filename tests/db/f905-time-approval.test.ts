import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  TIME_TRACKING_SCHEMA_VERSION,
} from "@/lib/integrations/time-tracking/contract";
import {
  approveTimeEntry,
  archiveTimeEntry,
  createTimeEntry,
  createTimeEventType,
  listTimeEntries,
  unapproveTimeEntry,
  updateTimeEntry,
  TimeTrackingConflictError,
  TimeTrackingNotFoundError,
} from "@/modules/time-tracking";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
  projectId: string;
  typeId: string;
  entryId: string;
};

async function seedWorkspace(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F9-05 Freigabe')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f905.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f905.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f905.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid,
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
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9-05 Kontakt', 'F9', 'Fixture',
        ${`${contactId}@f905.test`}, ${`${contactId}@f905.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9-05 Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id, 'F9-05 Projekt', 'fixture'
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
  const typeId = await withAuthorizedTenantOn(
    testPool, editorId, workspaceId,
    (tx, ctx) => createTimeEventType(tx, ctx, {
      schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
      name: "Montage",
    }).then((created) => created.id),
  );
  const entryId = await withAuthorizedTenantOn(
    testPool, editorId, workspaceId,
    (tx, ctx) => createTimeEntry(tx, ctx, {
      schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
      projectId,
      fields: {
        typeId,
        startAt: "2026-09-04T08:00:00.000Z",
        endAt: "2026-09-04T10:00:00.000Z",
        workingTimeMinutes: 120,
        breakDurationMinutes: 0,
        comment: "Freigabe-Kandidat",
      },
    }).then((created) => created.id),
  );
  return { workspaceId, editorId, viewerId, externalId, projectId, typeId, entryId };
}

function updateFields(fixture: Fixture, comment: string) {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    id: fixture.entryId,
    fields: {
      typeId: fixture.typeId,
      startAt: "2026-09-04T08:00:00.000Z",
      endAt: "2026-09-04T10:00:00.000Z",
      workingTimeMinutes: 120,
      breakDurationMinutes: 0,
      comment,
    },
  } as Parameters<typeof updateTimeEntry>[2];
}

describe("F9-05 Zeitfreigabe (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedWorkspace();
  });

  it("F905-DB-01: Approve sperrt Update/Archiv; Unapprove entsperrt", async () => {
    const approved = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => approveTimeEntry(tx, ctx, fixture.entryId),
    );
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.approvedBy).toBe(fixture.editorId);

    // Update fail-closed.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(tx, ctx, updateFields(fixture, "Nach Freigabe")),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);

    // Archiv fail-closed.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => archiveTimeEntry(tx, ctx, fixture.entryId),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);

    // Doppel-Approve fail-closed.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => approveTimeEntry(tx, ctx, fixture.entryId),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);

    // Filter: approved findet ihn, open nicht.
    const onlyApproved = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId, approval: "approved" }),
    );
    expect(onlyApproved.entries.map((entry) => entry.id)).toContain(fixture.entryId);
    const onlyOpen = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId, approval: "open" }),
    );
    expect(onlyOpen.entries.map((entry) => entry.id)).not.toContain(fixture.entryId);

    // Unapprove entsperrt: Update geht wieder, Filter dreht sich.
    const unapproved = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unapproveTimeEntry(tx, ctx, fixture.entryId),
    );
    expect(unapproved.approvedAt).toBeNull();
    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(tx, ctx, updateFields(fixture, "Nach Entsperrung")),
    );
    expect(updated.comment).toBe("Nach Entsperrung");

    // Unapprove ohne Freigabe fail-closed; fehlender Eintrag NotFound.
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => unapproveTimeEntry(tx, ctx, fixture.entryId),
    )).rejects.toBeInstanceOf(TimeTrackingConflictError);
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => approveTimeEntry(tx, ctx, "00000000-0000-4000-8000-000000000000"),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);
  });

  it("F905-RBAC-01: Viewer liest Status read-only; External fail-closed", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => approveTimeEntry(tx, ctx, fixture.entryId),
    );
    const viewerList = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    const seen = viewerList.entries.find((entry) => entry.id === fixture.entryId);
    expect(seen?.approvedAt).not.toBeNull();
    expect(seen?.permissions.canWrite).toBe(false);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => approveTimeEntry(tx, ctx, fixture.entryId),
    )).rejects.toBeInstanceOf(Error);
  });
});
