import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  type UpdateTimeEntryCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  createTimeEntry,
  createTimeEventType,
  listTimeEntries,
  listTimeEntryRevisions,
  TimeTrackingNotFoundError,
  updateTimeEntry,
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

async function seedWorkspace(label: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, ${label})`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@f904b.test`}),
             (${viewerId}::uuid, ${`viewer-${viewerId}@f904b.test`}),
             (${externalId}::uuid, ${`external-${externalId}@f904b.test`})
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
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F9.4b Kontakt', 'F9', 'Fixture',
        ${`${contactId}@f904b.test`}, ${`${contactId}@f904b.test`})
    `);
    await tx.execute(sql`
      insert into site (id, workspace_id, contact_id, label)
      values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F9.4b Site')
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid,
             ${siteId}::uuid, board.id, intake_column.id, 'F9.4b Projekt', 'fixture'
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
      name: "Anfahrt",
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
        workingTimeMinutes: 90,
        breakDurationMinutes: 0,
        comment: "Erstfassung",
      },
    }).then((created) => created.id),
  );
  return { workspaceId, editorId, viewerId, externalId, projectId, typeId, entryId };
}

function updateCommand(entryId: string, typeId: string | null, comment: string): UpdateTimeEntryCommand {
  return {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    id: entryId,
    fields: {
      typeId,
      startAt: "2026-09-04T08:00:00.000Z",
      endAt: "2026-09-04T10:00:00.000Z",
      workingTimeMinutes: 90,
      breakDurationMinutes: 0,
      comment,
    },
  };
}

describe("F9.4 Slice B Versionshistorie (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedWorkspace("F9.4b Export");
  });

  it("F904B-DB-01: Update schreibt Revision mit vollständigem Vorher-Bild", async () => {
    const before = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntryRevisions(tx, ctx, { entryId: fixture.entryId }),
    );
    expect(before.entryId).toBe(fixture.entryId);
    expect(before.revisions).toHaveLength(0);

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(tx, ctx, updateCommand(fixture.entryId, fixture.typeId, "Zweitfassung")),
    );
    expect(updated.comment).toBe("Zweitfassung");

    const history = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntryRevisions(tx, ctx, { entryId: fixture.entryId }),
    );
    expect(history.revisions).toHaveLength(1);
    const revision = history.revisions[0]!;
    expect(revision.entryId).toBe(fixture.entryId);
    expect(revision.userId).toBe(fixture.editorId);
    expect(revision.projectId).toBe(fixture.projectId);
    expect(revision.typeId).toBe(fixture.typeId);
    expect(revision.startAt).toBe("2026-09-04T08:00:00.000Z");
    expect(revision.endAt).toBe("2026-09-04T10:00:00.000Z");
    expect(revision.workingTimeMinutes).toBe(90);
    expect(revision.breakDurationMinutes).toBe(0);
    expect(revision.comment).toBe("Erstfassung");
    expect(revision.revisedBy).toBe(fixture.editorId);
    expect(revision.revisedAt).not.toBe("");
    expect(revision.createdAt).not.toBe("");
  });

  it("F904B-DB-02: Update ohne Feldänderung schreibt trotzdem; zweiter Edit stapelt absteigend", async () => {
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(tx, ctx, updateCommand(fixture.entryId, fixture.typeId, "Zweitfassung")),
    );
    // Identische Felder erneut speichern: trotzdem genau eine Revision.
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(tx, ctx, updateCommand(fixture.entryId, fixture.typeId, "Zweitfassung")),
    );
    const history = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTimeEntryRevisions(tx, ctx, { entryId: fixture.entryId }),
    );
    expect(history.revisions).toHaveLength(2);
    // Neueste zuerst: Noop-Edit sicherte "Zweitfassung", erster Edit "Erstfassung".
    expect(history.revisions.map((revision) => revision.comment)).toEqual([
      "Zweitfassung",
      "Erstfassung",
    ]);
    expect(history.revisions[0]!.typeId).toBe(fixture.typeId);
    expect(history.revisions[1]!.typeId).toBe(fixture.typeId);

    const entries = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTimeEntries(tx, ctx, { projectId: fixture.projectId }),
    );
    expect(entries.entries).toHaveLength(1);
    expect(entries.entries[0]!.comment).toBe("Zweitfassung");
  });

  it("F904B-DB-03: Fremdeintrag not_found, Viewer lesen ok, Externer denied", async () => {
    const foreign = await seedWorkspace("F9.4b Fremd");

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => listTimeEntryRevisions(tx, ctx, { entryId: foreign.entryId }),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => updateTimeEntry(
        tx, ctx, updateCommand(foreign.entryId, foreign.typeId, "Angriff"),
      ),
    )).rejects.toBeInstanceOf(TimeTrackingNotFoundError);

    const viewerHistory = await withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => listTimeEntryRevisions(tx, ctx, { entryId: fixture.entryId }),
    );
    expect(viewerHistory.revisions).toHaveLength(0);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.externalId, fixture.workspaceId,
      (tx, ctx) => listTimeEntryRevisions(tx, ctx, { entryId: fixture.entryId }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
