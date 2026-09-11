// F11-03a Notiz-Outbox-Replay (PostgreSQL): clientKey-Idempotenz.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
import {
  executeProjectNoteCommand,
  listProjectNotes,
  PROJECT_NOTE_COMMAND_VERSION,
  type ProjectNoteCommandV1,
} from "@/modules/notes";
import { testPool } from "../setup/test-db";

type Fixture = {
  workspaceId: string;
  projectId: string;
  editorId: string;
};

async function seedFixture(suffix: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F1103a Outbox')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${`editor-${editorId}@${suffix}`})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values (${randomUUID()}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F1103a-CUSTOMER', 'Fixture', 'Contact', 'c@f1103a.test', 'c@f1103a.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F1103a Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, 'F1103a Project', 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
  });

  return { workspaceId, projectId, editorId };
}

describe("F11-03a Notiz-Replay (PostgreSQL)", () => {
  let fixture: Fixture;

  beforeEach(async () => {
    fixture = await seedFixture("f1103a.test");
  });

  const run = (
    fx: Fixture,
    command: ProjectNoteCommandV1,
  ): Promise<{ projectId: string; noteId: string; revision: number; changed: boolean }> =>
    withAuthorizedTenantOn(testPool, fx.editorId, fx.workspaceId, ((tx: never, ctx: never) =>
      executeProjectNoteCommand(tx, ctx, command)) as never) as Promise<{
      projectId: string; noteId: string; revision: number; changed: boolean;
    }>;

  const createdEventCount = async (fx: Fixture): Promise<number> => {
    const found = await withTenantOn(testPool, fx.workspaceId, async (tx) => {
      const rows = await tx.execute<{ n: string }>(sql`
        select count(*)::text as n from domain_events
         where workspace_id = ${fx.workspaceId}::uuid
           and event_type = 'project.note_created'
      `);
      return rows.rows[0]?.n ?? "0";
    });
    return Number(found);
  };

  it("F1103a-DB-01: gleicher clientKey → eine Notiz, ein Event, changed=false", async () => {
    const clientKey = randomUUID();
    type CreateNote = Extract<ProjectNoteCommandV1, { kind: "create_note" }>;
    const command = (): CreateNote => ({
      schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
      kind: "create_note",
      projectId: fixture.projectId,
      textMarkdown: "Offline-Entwurf mit Schlüssel",
      pinned: false,
      clientKey,
    });

    const first = await run(fixture, command());
    expect(first.changed).toBe(true);
    const replay = await run(fixture, command());
    expect(replay.noteId).toBe(first.noteId);
    expect(replay.changed).toBe(false);
    const replayAgain = await run(fixture, command());
    expect(replayAgain.noteId).toBe(first.noteId);

    const page = await withAuthorizedTenantOn(
      testPool,
      fixture.editorId,
      fixture.workspaceId,
      ((tx: never, ctx: never) => listProjectNotes(tx, ctx, fixture.projectId)) as never,
    ) as { notes: { id: string }[] };
    expect(page.notes.filter((note) => note.id === first.noteId)).toHaveLength(1);
    expect(page.notes).toHaveLength(1);
    expect(await createdEventCount(fixture)).toBe(1);
  });

  it("F1103a-DB-02: klassischer Pfad ohne Schlüssel dupliziert wie bisher; Schlüssel sind mandantengebunden", async () => {
    const classic = (): ProjectNoteCommandV1 => ({
      schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
      kind: "create_note",
      projectId: fixture.projectId,
      textMarkdown: "Klassischer Entwurf",
      pinned: false,
    });
    const first = await run(fixture, classic());
    const second = await run(fixture, classic());
    expect(second.noteId).not.toBe(first.noteId);

    const foreign = await seedFixture("f1103a-foreign.test");
    const sharedKey = randomUUID();
    const keyed = (projectId: string): ProjectNoteCommandV1 => ({
      schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
      kind: "create_note",
      projectId,
      textMarkdown: "Mandanten-Entwurf",
      pinned: false,
      clientKey: sharedKey,
    });
    const home = await run(fixture, keyed(fixture.projectId));
    const away = await run(foreign, keyed(foreign.projectId));
    expect(away.noteId).not.toBe(home.noteId);
  });
});
