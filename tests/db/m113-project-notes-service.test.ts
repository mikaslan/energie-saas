import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  executeProjectNoteCommand,
  listProjectNotes,
  PROJECT_NOTE_COMMAND_VERSION,
  NoteConflictError,
  NoteNotFoundError,
  NoteValidationError,
  type ProjectNoteCommandV1,
} from "@/modules/notes";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  contactId: string;
  editorId: string;
  viewerId: string;
  externalId: string;
};

async function seedFixture(): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'M1-13 Notes')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values
        (${editorId}::uuid, ${`editor-${editorId}@m113.test`}),
        (${viewerId}::uuid, ${`viewer-${viewerId}@m113.test`}),
        (${externalId}::uuid, ${`external-${externalId}@m113.test`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid, 'admin', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'M113-CUSTOMER', 'Fixture', 'Contact', 'c@m113.test', 'c@m113.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'M113 Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'M113 Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return { workspaceId, projectId, contactId, editorId, viewerId, externalId };
}

function createCommand(fixture: Fixture, textMarkdown = "Erste Notiz", pinned = false): ProjectNoteCommandV1 {
  return {
    schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
    kind: "create_note",
    projectId: fixture.projectId,
    textMarkdown,
    pinned,
  };
}

async function createNote(fixture: Fixture, textMarkdown = "Erste Notiz", pinned = false) {
  return withAuthorizedTenantOn(
    testPool,
    fixture.editorId,
    fixture.workspaceId,
    (tx, ctx) => executeProjectNoteCommand(tx, ctx, createCommand(fixture, textMarkdown, pinned)),
  );
}

async function listNotes(fixture: Fixture, actorId: string) {
  return withAuthorizedTenantOn(
    testPool,
    actorId,
    fixture.workspaceId,
    (tx, ctx) => listProjectNotes(tx, ctx, fixture.projectId),
  );
}

describe("M1-13 Projektnotizen-Service (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture();
  });

  it("legt Notizen an, leitet plain ab und sortiert gepinnte zuerst", async () => {
    await createNote(fixture, "**Ältere** Notiz", false);
    await createNote(fixture, "Gepinnte Notiz", true);
    const page = await listNotes(fixture, fixture.editorId);
    expect(page?.notes.map((n) => n.textMarkdown)).toEqual(["Gepinnte Notiz", "**Ältere** Notiz"]);
    expect(page?.notes[0]?.pinned).toBe(true);
    expect(page?.notes[0]?.textPlain).toBe("Gepinnte Notiz");
    expect(page?.notes[1]?.textPlain).toBe("Ältere Notiz");
    expect(page?.permissions.canWrite).toBe(true);
  });

  it("editiert, pinnt und löscht mit Revision + CAS", async () => {
    const created = await createNote(fixture, "Original", false);
    const page = await listNotes(fixture, fixture.editorId);
    const note = page!.notes[0]!;

    const updated = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => executeProjectNoteCommand(tx, ctx, {
        schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
        kind: "update_note_text",
        projectId: fixture.projectId,
        noteId: note.id,
        expectedRevision: 1,
        textMarkdown: "Bearbeitet",
      }),
    );
    expect(updated.revision).toBe(2);
    const afterEdit = await listNotes(fixture, fixture.editorId);
    expect(afterEdit!.notes[0]!.revision).toBe(2);
    expect(afterEdit!.notes[0]!.editedAt).not.toBeNull();
    expect(afterEdit!.notes[0]!.editedByLabel).toBe(`editor-${fixture.editorId}@m113.test`);

    const pinned = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => executeProjectNoteCommand(tx, ctx, {
        schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
        kind: "set_note_pinned",
        projectId: fixture.projectId,
        noteId: note.id,
        expectedRevision: 2,
        pinned: true,
      }),
    );
    expect(pinned.revision).toBe(3);
    const afterPin = await listNotes(fixture, fixture.editorId);
    expect(afterPin!.notes[0]!.pinned).toBe(true);
    expect(afterPin!.notes[0]!.pinnedByLabel).toBe(`editor-${fixture.editorId}@m113.test`);

    const deleted = await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => executeProjectNoteCommand(tx, ctx, {
        schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
        kind: "delete_note",
        projectId: fixture.projectId,
        noteId: note.id,
        expectedRevision: 3,
      }),
    );
    expect(deleted.revision).toBe(4);
    const afterDelete = await listNotes(fixture, fixture.editorId);
    expect(afterDelete!.notes).toEqual([]);
    expect(created.noteId).toBe(note.id);
  });

  it("meldet Revisionskonflikte für alle drei Mutationen (P1-2)", async () => {
    const created = await createNote(fixture, "Original", false);
    const stale = 99;
    for (const command of [
      { kind: "update_note_text" as const, textMarkdown: "X" },
      { kind: "set_note_pinned" as const, pinned: true },
      { kind: "delete_note" as const },
    ]) {
      await expect(withAuthorizedTenantOn(
        testPool, fixture.editorId, fixture.workspaceId,
        (tx, ctx) => executeProjectNoteCommand(tx, ctx, {
          schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
          projectId: fixture.projectId,
          noteId: created.noteId,
          expectedRevision: stale,
          ...command,
        }),
      )).rejects.toBeInstanceOf(NoteConflictError);
    }
  });

  it("behandelt gelöschte Notizen als not_found, nicht als conflict (P1-3)", async () => {
    const created = await createNote(fixture, "Weg", false);
    await withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => executeProjectNoteCommand(tx, ctx, {
        schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
        kind: "delete_note",
        projectId: fixture.projectId,
        noteId: created.noteId,
        expectedRevision: 1,
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, fixture.editorId, fixture.workspaceId,
      (tx, ctx) => executeProjectNoteCommand(tx, ctx, {
        schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
        kind: "set_note_pinned",
        projectId: fixture.projectId,
        noteId: created.noteId,
        expectedRevision: 1,
        pinned: true,
      }),
    )).rejects.toBeInstanceOf(NoteNotFoundError);
  });

  it("lehnt javascript:-Links serverseitig ab (P1-1)", async () => {
    await expect(createNote(fixture, "[x](javascript:alert(1))")).rejects.toBeInstanceOf(NoteValidationError);
  });

  it("Viewer liest, External wird abgewiesen (RLS + Service)", async () => {
    await createNote(fixture, "Notiz", false);
    const viewerPage = await listNotes(fixture, fixture.viewerId);
    expect(viewerPage?.notes).toHaveLength(1);
    expect(viewerPage?.permissions.canWrite).toBe(false);

    await expect(withAuthorizedTenantOn(
      testPool, fixture.viewerId, fixture.workspaceId,
      (tx, ctx) => executeProjectNoteCommand(tx, ctx, createCommand(fixture)),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    await expect(listNotes(fixture, fixture.externalId)).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("Cross-Tenant-Lesen ist fail-closed", async () => {
    await createNote(fixture, "Notiz", false);
    const other = await seedFixture();
    const otherPage = await listNotes(other, other.editorId);
    expect(otherPage?.notes).toEqual([]);
    // Direktes Lesen des fremden Projekts liefert null (nicht found, kein Leak).
    const foreign = await withAuthorizedTenantOn(
      testPool, other.editorId, other.workspaceId,
      (tx, ctx) => listProjectNotes(tx, ctx, fixture.projectId),
    );
    expect(foreign).toBeNull();
  });

  it("schreibt Event und Audit in derselben Transaktion (1-Tx-Beweis)", async () => {
    await createNote(fixture, "Notiz", false);
    const counts = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      const events = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from domain_events
         where workspace_id = ${fixture.workspaceId}::uuid
           and event_type = 'project.note_created'
      `);
      const audits = await tx.execute<{ count: number }>(sql`
        select count(*)::int as count from audit_log
         where workspace_id = ${fixture.workspaceId}::uuid
           and action = 'note.write' and resource = 'project_note'
      `);
      return { events: events.rows[0]!.count, audits: audits.rows[0]!.count };
    });
    expect(counts.events).toBe(1);
    expect(counts.audits).toBe(1);
  });
});
