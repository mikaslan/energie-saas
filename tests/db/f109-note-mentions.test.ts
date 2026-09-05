// F1-09 @-Mentions (PostgreSQL): Auflösung, Diff, RLS, Limit.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  executeProjectNoteCommand,
  listProjectNotes,
  PROJECT_NOTE_COMMAND_VERSION,
  NoteConflictError,
  NoteValidationError,
  type ProjectNoteCommandV1,
} from "@/modules/notes";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  editorId: string;
  editorEmail: string;
  viewerId: string;
  viewerEmail: string;
};

async function seedFixture(suffix: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const editorEmail = `editor-${editorId}@${suffix}`;
  const viewerEmail = `viewer-${viewerId}@${suffix}`;

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F109 Mentions')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${editorEmail}), (${viewerId}::uuid, ${viewerEmail})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F109-CUSTOMER', 'Fixture', 'Contact', 'c@f109.test', 'c@f109.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F109 Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F109 Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return { workspaceId, projectId, editorId, editorEmail, viewerId, viewerEmail };
}

function createCommand(fixture: Fixture, textMarkdown: string): ProjectNoteCommandV1 {
  return {
    schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
    kind: "create_note",
    projectId: fixture.projectId,
    textMarkdown,
    pinned: false,
  };
}

async function createNote(fixture: Fixture, textMarkdown: string) {
  return withAuthorizedTenantOn(
    testPool,
    fixture.editorId,
    fixture.workspaceId,
    (tx, ctx) => executeProjectNoteCommand(tx, ctx, createCommand(fixture, textMarkdown)),
  );
}

async function listNotes(fixture: Fixture) {
  const page = await withAuthorizedTenantOn(
    testPool,
    fixture.editorId,
    fixture.workspaceId,
    (tx, ctx) => listProjectNotes(tx, ctx, fixture.projectId),
  );
  return page?.notes ?? [];
}

describe("F1-09 Projektnotiz-Mentions (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture("f109.test");
  });

  it("DB-01: speichert nur auflösbare Refs, Rohtext bleibt", async () => {
    const created = await createNote(
      fixture,
      `Hallo @${fixture.viewerEmail} und @phantom@f109.test!`,
    );
    const notes = await listNotes(fixture);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe(created.noteId);
    expect(notes[0]!.textMarkdown).toContain("@phantom@f109.test");
    expect(notes[0]!.mentions).toEqual([
      { userIdentityId: fixture.viewerId.toLowerCase(), emailLower: fixture.viewerEmail.toLowerCase() },
    ]);
  });

  it("DB-02: Update ersetzt die Mention-Menge, CAS-Konflikt ohne Halbschreib", async () => {
    const created = await createNote(fixture, `Hallo @${fixture.viewerEmail}`);
    await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      (tx, ctx) => executeProjectNoteCommand(tx, ctx, {
        schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
        kind: "update_note_text",
        projectId: fixture.projectId,
        noteId: created.noteId,
        expectedRevision: created.revision,
        textMarkdown: `Hallo @${fixture.editorEmail}`,
      }),
    );
    await expect(
      withAuthorizedTenantOn(
        testPool,
        fixture.editorId,
        fixture.workspaceId,
        (tx, ctx) => executeProjectNoteCommand(tx, ctx, {
          schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
          kind: "update_note_text",
          projectId: fixture.projectId,
          noteId: created.noteId,
          expectedRevision: created.revision,
          textMarkdown: "Veraltet",
        }),
      ),
    ).rejects.toBeInstanceOf(NoteConflictError);
    const notes = await listNotes(fixture);
    expect(notes[0]!.mentions).toEqual([
      { userIdentityId: fixture.editorId.toLowerCase(), emailLower: fixture.editorEmail.toLowerCase() },
    ]);
  });

  it("DB-03: Cross-Workspace-Ref wird nicht aufgelöst", async () => {
    const other = await seedFixture("f109-foreign.test");
    await createNote(fixture, `Fremd ist @${other.viewerEmail} hier Phantom`);
    const notes = await listNotes(fixture);
    expect(notes[0]!.mentions).toEqual([]);
  });

  it("DB-04: Cross-Workspace-Insert scheitert an with check", async () => {
    const created = await createNote(fixture, "Hallo Welt");
    const wsB = randomUUID();
    let caught: unknown;
    try {
      await withTenantOn(testPool, wsB, (tx) =>
        tx.execute(sql`
          insert into project_note_mention (
            workspace_id, project_id, note_id, mentioned_identity_id,
            email_lower, revision
          ) values (
            ${fixture.workspaceId}::uuid, ${fixture.projectId}::uuid,
            ${created.noteId}::uuid, ${fixture.viewerId}::uuid,
            ${fixture.viewerEmail.toLowerCase()}, 1
          )
        `),
      );
    } catch (error) {
      caught = error;
    }
    // Echte Notiz (FK passiert), falscher Workspace (WITH CHECK scheitert).
    // Drizzle wrapt den PG-Fehler: Meldung steht in .cause (rls.test.ts-Muster).
    expect(caught).toBeInstanceOf(Error);
    expect(String((caught as { cause?: unknown }).cause)).toMatch(/row-level security/i);
  });

  it("DB-05: über dem Limit → Validierungsfehler, keine Zeile", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `@u${i}@f109.test`).join(" ");
    await expect(createNote(fixture, many)).rejects.toBeInstanceOf(NoteValidationError);
    expect(await listNotes(fixture)).toEqual([]);
  });
});
