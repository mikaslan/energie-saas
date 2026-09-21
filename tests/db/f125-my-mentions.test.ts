// F1-25 „Meine Erwähnungen" (PostgreSQL): RED — `listMentionedNotes`
// existiert noch nicht (Import schlägt fehl, bis GREEN liefert).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  executeProjectNoteCommand,
  listMentionedNotes,
  NoteValidationError,
  PROJECT_NOTE_COMMAND_VERSION,
} from "@/modules/notes";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  projectName: string;
  projectId2: string;
  projectName2: string;
  editorId: string;
  editorEmail: string;
  viewerId: string;
  viewerEmail: string;
  externalId: string;
  externalEmail: string;
};

async function seedFixture(suffix: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const projectId2 = randomUUID();
  const projectName = `F125 Project A ${workspaceId.slice(0, 8)}`;
  const projectName2 = `F125 Project B ${workspaceId.slice(0, 8)}`;
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const externalId = randomUUID();
  const editorEmail = `editor-${editorId}@${suffix}`;
  const viewerEmail = `viewer-${viewerId}@${suffix}`;
  const externalEmail = `external-${externalId}@${suffix}`;

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F125 Mentions')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${editorEmail}), (${viewerId}::uuid, ${viewerEmail}), (${externalId}::uuid, ${externalEmail})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${randomUUID()}::uuid, ${workspaceId}::uuid, ${externalId}::uuid, 'editor', '{"external_only":true}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F125-CUSTOMER', 'Fixture', 'Contact', 'c@f125.test', 'c@f125.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F125 Site')`);
    for (const [id, name] of [[projectId, projectName], [projectId2, projectName2]] as const) {
      await tx.execute(sql`
        insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
        select ${id}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, ${name}, 'manual'
          from kanban_board board
          join kanban_column intake
            on intake.workspace_id = board.workspace_id and intake.board_id = board.id
           and intake.is_intake = true and intake.archived_at is null
         where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
           and board.is_default = true and board.archived_at is null
      `);
    }
  });

  return {
    workspaceId, projectId, projectName, projectId2, projectName2,
    editorId, editorEmail, viewerId, viewerEmail, externalId, externalEmail,
  };
}

async function createNote(fixture: Fixture, actorId: string, projectId: string, textMarkdown: string) {
  return withAuthorizedTenantOn(
    testPool,
    actorId,
    fixture.workspaceId,
    (tx, ctx) => executeProjectNoteCommand(tx, ctx, {
      schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
      kind: "create_note",
      projectId,
      textMarkdown,
      pinned: false,
    }),
  );
}

async function listMentions(fixture: Fixture, actorId: string, query?: { limit?: number }) {
  return withAuthorizedTenantOn(
    testPool,
    actorId,
    fixture.workspaceId,
    (tx, ctx) => query === undefined
      ? listMentionedNotes(tx, ctx)
      : listMentionedNotes(tx, ctx, query),
  );
}

describe("F1-25 Meine Erwähnungen (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture("f125.test");
  });

  it("F125-DB-01: eigene Mention gefunden — workspace-weit, neueste zuerst, Zeilenform", async () => {
    const stampA = `f125-a-${Date.now()}`;
    const stampB = `f125-b-${Date.now()}`;
    const first = await createNote(fixture, fixture.editorId, fixture.projectId, `Älter ${stampA} an @${fixture.viewerEmail}`);
    const second = await createNote(fixture, fixture.editorId, fixture.projectId2, `Neuer ${stampB} an @${fixture.viewerEmail}`);

    const result = await listMentions(fixture, fixture.viewerId);

    expect(Object.keys(result).sort()).toEqual(["notes"]);
    expect(result.notes).toHaveLength(2);
    // Neueste zuerst.
    expect(result.notes[0]!.noteId).toBe(second.noteId);
    expect(result.notes[1]!.noteId).toBe(first.noteId);
    // Zeilenform exakt: Projekt (id+Name), Notiz (id, Excerpt, created_at).
    expect(Object.keys(result.notes[0]!).sort()).toEqual(
      ["createdAtIso", "excerpt", "noteId", "projectId", "projectName"],
    );
    expect(result.notes[0]).toMatchObject({
      projectId: fixture.projectId2,
      projectName: fixture.projectName2,
      noteId: second.noteId,
    });
    expect(result.notes[0]!.excerpt).toContain(stampB);
    expect(result.notes[0]!.excerpt.length).toBeLessThanOrEqual(120);
    expect(Number.isNaN(Date.parse(result.notes[0]!.createdAtIso))).toBe(false);
    expect(result.notes[1]).toMatchObject({
      projectId: fixture.projectId,
      projectName: fixture.projectName,
      noteId: first.noteId,
    });
  });

  it("F125-DB-02: Excerpt ist auf 120 Zeichen gedeckelt", async () => {
    const marker = `f125-cap-${Date.now()}`;
    await createNote(
      fixture,
      fixture.editorId,
      fixture.projectId,
      `${marker} an @${fixture.viewerEmail} ${"x".repeat(300)}`,
    );

    const result = await listMentions(fixture, fixture.viewerId);

    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.excerpt.length).toBeLessThanOrEqual(120);
    expect(result.notes[0]!.excerpt.length).toBeGreaterThan(0);
    expect(result.notes[0]!.excerpt).toContain(marker);
  });

  it("F125-DB-03: fremde Mention ist nicht dabei", async () => {
    const stampViewer = `f125-v-${Date.now()}`;
    const stampEditor = `f125-e-${Date.now()}`;
    const forViewer = await createNote(fixture, fixture.editorId, fixture.projectId, `An Viewer ${stampViewer} @${fixture.viewerEmail}`);
    const forEditor = await createNote(fixture, fixture.editorId, fixture.projectId, `An Editor ${stampEditor} @${fixture.editorEmail}`);

    const viewerResult = await listMentions(fixture, fixture.viewerId);
    expect(viewerResult.notes.map((row) => row.noteId)).toEqual([forViewer.noteId]);

    const editorResult = await listMentions(fixture, fixture.editorId);
    expect(editorResult.notes.map((row) => row.noteId)).toEqual([forEditor.noteId]);
  });

  it("F125-DB-04: Mention ohne note.read entfällt lautlos (kein Throw, kein Leak)", async () => {
    await createNote(
      fixture,
      fixture.editorId,
      fixture.projectId,
      `Vertraulich f125-noread an @${fixture.externalEmail}`,
    );

    // External hat kein note.read (internalOnly) — trotzdem kein
    // PermissionDeniedError wie bei listProjectNotes, sondern ehrlich leer.
    const result = await listMentions(fixture, fixture.externalId);

    expect(result.notes).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("F125 Project");
    expect(JSON.stringify(result)).not.toContain("f125-noread");
  });

  it("F125-DB-05: Tenant-Trennung — fremder Workspace unsichtbar", async () => {
    const other = await seedFixture("f125-foreign.test");
    const own = await createNote(fixture, fixture.editorId, fixture.projectId, `Eigen f125-own an @${fixture.viewerEmail}`);
    const foreign = await createNote(other, other.editorId, other.projectId, `Fremd f125-foreign an @${other.viewerEmail}`);

    const ownResult = await listMentions(fixture, fixture.viewerId);
    expect(ownResult.notes.map((row) => row.noteId)).toEqual([own.noteId]);

    const foreignResult = await listMentions(other, other.viewerId);
    expect(foreignResult.notes.map((row) => row.noteId)).toEqual([foreign.noteId]);
    expect(JSON.stringify(foreignResult)).not.toContain(fixture.projectName);
  });

  it("F125-DB-06: Limit-Default 5, explizites Limit, Cap 20 (F1-06b-Muster)", async () => {
    const created: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const note = await createNote(
        fixture,
        fixture.editorId,
        i % 2 === 0 ? fixture.projectId : fixture.projectId2,
        `Bulk ${i} f125-bulk an @${fixture.viewerEmail}`,
      );
      created.push(note.noteId);
    }

    const defaultResult = await listMentions(fixture, fixture.viewerId);
    expect(defaultResult.notes).toHaveLength(5);
    // Neueste zuerst: createdAtIso ist absteigend sortiert.
    const defaultIso = defaultResult.notes.map((row) => row.createdAtIso);
    expect([...defaultIso].sort().reverse()).toEqual(defaultIso);
    expect(defaultResult.notes.map((row) => row.noteId)).toContain(created[20]);

    const two = await listMentions(fixture, fixture.viewerId, { limit: 2 });
    expect(two.notes).toHaveLength(2);

    const capped = await listMentions(fixture, fixture.viewerId, { limit: 20 });
    expect(capped.notes).toHaveLength(20);
  });

  it("F125-DB-07: ungültiges Limit wird abgewiesen", async () => {
    await createNote(fixture, fixture.editorId, fixture.projectId, `Hallo f125-limits an @${fixture.viewerEmail}`);
    await expect(listMentions(fixture, fixture.viewerId, { limit: 0 })).rejects.toBeInstanceOf(NoteValidationError);
    await expect(listMentions(fixture, fixture.viewerId, { limit: 21 })).rejects.toBeInstanceOf(NoteValidationError);
  });

  it("F125-DB-08: External ehrlich leer (eigene + fremde Mentions, exakte Form)", async () => {
    await createNote(fixture, fixture.editorId, fixture.projectId, `An External f125-ext an @${fixture.externalEmail}`);
    await createNote(fixture, fixture.editorId, fixture.projectId2, `An Viewer f125-ext2 an @${fixture.viewerEmail}`);

    const result = await listMentions(fixture, fixture.externalId);

    expect(result).toEqual({ notes: [] });
  });
});
