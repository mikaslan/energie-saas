// F1-26 Team-Mentions `@team:slug` (PostgreSQL): RED — Tabelle
// `project_note_team_mention` (Migration 0321) + `@team:`-Pattern in
// `note-mentions.ts` + erweiterter `listMentionedNotes`-Pfad fehlen noch
// (GREEN liefert). Fixture-Muster: f109 (Notizen), f125 (Meine
// Erwähnungen), f1020 (Teams + RESTRICT-Code-Auslese).
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

// Fester Slug je Workspace (name_normalized): Zwei Fixtures teilen den
// Slug über Tenant-Grenzen hinweg (DB-10), innerhalb eines Workspace ist
// er eindeutig.
const TEAM_SLUG = "f126-montage";
const ARCHIVED_TEAM_SLUG = "f126-altbau";

type Fixture = {
  workspaceId: string;
  projectId: string;
  projectName: string;
  editorId: string;
  viewerId: string;
  viewerEmail: string;
  outsiderId: string;
  viewerMembershipId: string;
  teamId: string;
  archivedTeamId: string;
};

async function seedFixture(suffix: string): Promise<Fixture> {
  const workspaceId = randomUUID();
  const projectId = randomUUID();
  const projectName = `F126 Project ${workspaceId.slice(0, 8)}`;
  const contactId = randomUUID();
  const siteId = randomUUID();
  const editorId = randomUUID();
  const viewerId = randomUUID();
  const outsiderId = randomUUID();
  const editorEmail = `editor-${editorId}@${suffix}`;
  const viewerEmail = `viewer-${viewerId}@${suffix}`;
  const outsiderEmail = `outsider-${outsiderId}@${suffix}`;
  const editorMembershipId = randomUUID();
  const viewerMembershipId = randomUUID();
  const outsiderMembershipId = randomUUID();
  const teamId = randomUUID();
  const archivedTeamId = randomUUID();

  await withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${workspaceId}::uuid, 'F126 Team-Mentions')`);
    await tx.execute(sql`
      insert into user_identity (id, email)
      values (${editorId}::uuid, ${editorEmail}), (${viewerId}::uuid, ${viewerEmail}), (${outsiderId}::uuid, ${outsiderEmail})
    `);
    await tx.execute(sql`
      insert into membership (id, workspace_id, user_id, role, capabilities)
      values
        (${editorMembershipId}::uuid, ${workspaceId}::uuid, ${editorId}::uuid, 'editor', '{}'::jsonb),
        (${viewerMembershipId}::uuid, ${workspaceId}::uuid, ${viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${outsiderMembershipId}::uuid, ${workspaceId}::uuid, ${outsiderId}::uuid, 'viewer', '{}'::jsonb)
    `);
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${workspaceId}::uuid, 'F126-CUSTOMER', 'Fixture', 'Contact', 'c@f126.test', 'c@f126.test')
    `);
    await tx.execute(sql`insert into site (id, workspace_id, contact_id, label) values (${siteId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, 'F126 Site')`);
    await tx.execute(sql`
      insert into project (id, workspace_id, contact_id, site_id, kanban_board_id, kanban_column_id, name, source_key)
      select ${projectId}::uuid, ${workspaceId}::uuid, ${contactId}::uuid, ${siteId}::uuid, board.id, intake.id, ${projectName}, 'manual'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id and intake.board_id = board.id
         and intake.is_intake = true and intake.archived_at is null
       where board.workspace_id = ${workspaceId}::uuid and board.scope = 'residential'
         and board.is_default = true and board.archived_at is null
    `);
    // Slug-fähige Namen (name_normalized == Slug, keine Leerzeichen).
    await tx.execute(sql`
      insert into team (id, workspace_id, name, name_normalized, active, revision, created_by)
      values
        (${teamId}::uuid, ${workspaceId}::uuid, ${TEAM_SLUG}, ${TEAM_SLUG}, true, 1, ${editorId}::uuid),
        (${archivedTeamId}::uuid, ${workspaceId}::uuid, ${ARCHIVED_TEAM_SLUG}, ${ARCHIVED_TEAM_SLUG}, false, 2, ${editorId}::uuid)
    `);
    await tx.execute(sql`
      insert into team_member (workspace_id, team_id, membership_id)
      values
        (${workspaceId}::uuid, ${teamId}::uuid, ${viewerMembershipId}::uuid),
        (${workspaceId}::uuid, ${archivedTeamId}::uuid, ${viewerMembershipId}::uuid)
    `);
  });

  return {
    workspaceId, projectId, projectName, editorId,
    viewerId, viewerEmail, outsiderId, viewerMembershipId,
    teamId, archivedTeamId,
  };
}

async function createTeamRow(
  workspaceId: string,
  createdBy: string,
  teamId: string,
  slug: string,
  active: boolean,
): Promise<void> {
  await withTenantOn(testPool, workspaceId, (tx) =>
    tx.execute(sql`
      insert into team (id, workspace_id, name, name_normalized, active, revision, created_by)
      values (${teamId}::uuid, ${workspaceId}::uuid, ${slug}, ${slug}, ${active}, 1, ${createdBy}::uuid)
    `),
  );
}

async function createNote(fixture: Fixture, actorId: string, textMarkdown: string) {
  return withAuthorizedTenantOn(
    testPool,
    actorId,
    fixture.workspaceId,
    (tx, ctx) => executeProjectNoteCommand(tx, ctx, {
      schemaVersion: PROJECT_NOTE_COMMAND_VERSION,
      kind: "create_note",
      projectId: fixture.projectId,
      textMarkdown,
      pinned: false,
    }),
  );
}

async function listMentions(fixture: Fixture, actorId: string) {
  return withAuthorizedTenantOn(
    testPool,
    actorId,
    fixture.workspaceId,
    (tx, ctx) => listMentionedNotes(tx, ctx),
  );
}

// Direkter Tabellenzugriff (Spec fixiert Namen + Spalten): rot, solange
// Migration 0321 fehlt (relation does not exist).
async function teamMentionTeamIds(fixture: Fixture, noteId: string): Promise<string[]> {
  return withTenantOn(testPool, fixture.workspaceId, async (tx) => {
    const result = await tx.execute<{ team_id: string }>(sql`
      select team_id
        from project_note_team_mention
       where workspace_id = ${fixture.workspaceId}::uuid
         and note_id = ${noteId}::uuid
       order by team_id
    `);
    return result.rows.map((row) => row.team_id.toLowerCase());
  });
}

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof current !== "object" || current === null) return undefined;
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === "string") return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

describe("F1-26 Team-Mentions @team:slug (PostgreSQL)", () => {
  let fixture: Fixture;
  beforeEach(async () => {
    fixture = await seedFixture("f126.test");
  });

  it("F126-DB-01: @team:slug speichert eine Team-Mention-Zeile", async () => {
    const stamp = `f126-save-${Date.now()}`;
    const created = await createNote(
      fixture,
      fixture.editorId,
      `${stamp} bitte prüfen @team:${TEAM_SLUG}`,
    );

    expect(await teamMentionTeamIds(fixture, created.noteId)).toEqual([
      fixture.teamId.toLowerCase(),
    ]);
  });

  it("F126-DB-02: archiviertes Team wird ignoriert (kein Throw, keine Zeile, unsichtbar)", async () => {
    const created = await createNote(
      fixture,
      fixture.editorId,
      `Altbau f126-archived an @team:${ARCHIVED_TEAM_SLUG}`,
    );

    expect(await teamMentionTeamIds(fixture, created.noteId)).toEqual([]);
    // Viewer ist Mitglied des archivierten Teams — sieht die Notiz trotzdem nicht.
    expect((await listMentions(fixture, fixture.viewerId)).notes).toEqual([]);
  });

  it("F126-DB-03: fremdes Team (nur im anderen Workspace aktiv) wird ignoriert", async () => {
    const other = await seedFixture("f126-foreign.test");
    await createTeamRow(other.workspaceId, other.editorId, randomUUID(), "f126-fremdteam", true);

    const created = await createNote(
      fixture,
      fixture.editorId,
      `Fremd f126-foreign an @team:f126-fremdteam`,
    );

    expect(await teamMentionTeamIds(fixture, created.noteId)).toEqual([]);
    expect((await listMentions(fixture, fixture.viewerId)).notes).toEqual([]);
  });

  it("F126-DB-04: unbekannter Slug wird ignoriert (kein Throw, keine Zeile)", async () => {
    const created = await createNote(
      fixture,
      fixture.editorId,
      `Phantom f126-unknown an @team:f126-phantom`,
    );

    expect(await teamMentionTeamIds(fixture, created.noteId)).toEqual([]);
  });

  it("F126-DB-05: Mitglied sieht Team-Notiz in listMentionedNotes (F1-25-Zeilenform), Nicht-Mitglied nicht", async () => {
    const stamp = `f126-see-${Date.now()}`;
    const created = await createNote(
      fixture,
      fixture.editorId,
      `${stamp} an @team:${TEAM_SLUG}`,
    );

    const result = await listMentions(fixture, fixture.viewerId);
    expect(result.notes).toHaveLength(1);
    expect(Object.keys(result.notes[0]!).sort()).toEqual(
      ["createdAtIso", "excerpt", "noteId", "projectId", "projectName"],
    );
    expect(result.notes[0]).toMatchObject({
      projectId: fixture.projectId,
      projectName: fixture.projectName,
      noteId: created.noteId,
    });
    expect(result.notes[0]!.excerpt).toContain(stamp);

    expect((await listMentions(fixture, fixture.outsiderId)).notes).toEqual([]);
  });

  it("F126-DB-06: entferntes Mitglied sieht die Team-Notiz nicht mehr", async () => {
    const created = await createNote(
      fixture,
      fixture.editorId,
      `Austritt f126-removed an @team:${TEAM_SLUG}`,
    );
    expect((await listMentions(fixture, fixture.viewerId)).notes.map((row) => row.noteId))
      .toEqual([created.noteId]);

    await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute(sql`
        delete from team_member
         where workspace_id = ${fixture.workspaceId}::uuid
           and team_id = ${fixture.teamId}::uuid
           and membership_id = ${fixture.viewerMembershipId}::uuid
      `),
    );

    expect((await listMentions(fixture, fixture.viewerId)).notes).toEqual([]);
  });

  it("F126-DB-07: nach Team-Archivierung sieht das Mitglied die Notiz nicht mehr", async () => {
    const created = await createNote(
      fixture,
      fixture.editorId,
      `Archiv f126-deactivated an @team:${TEAM_SLUG}`,
    );
    expect((await listMentions(fixture, fixture.viewerId)).notes.map((row) => row.noteId))
      .toEqual([created.noteId]);

    await withTenantOn(testPool, fixture.workspaceId, (tx) =>
      tx.execute(sql`
        update team set active = false
         where workspace_id = ${fixture.workspaceId}::uuid
           and id = ${fixture.teamId}::uuid
      `),
    );

    expect((await listMentions(fixture, fixture.viewerId)).notes).toEqual([]);
  });

  it("F126-DB-08: Dedupe direkt+Team — eine Notiz erscheint genau einmal", async () => {
    const stamp = `f126-dedupe-${Date.now()}`;
    const created = await createNote(
      fixture,
      fixture.editorId,
      `${stamp} an @${fixture.viewerEmail} und @team:${TEAM_SLUG}`,
    );

    // Beide Pfade haben geschrieben (Team-Zeile als Gate).
    expect(await teamMentionTeamIds(fixture, created.noteId)).toEqual([
      fixture.teamId.toLowerCase(),
    ]);
    const result = await listMentions(fixture, fixture.viewerId);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]!.noteId).toBe(created.noteId);
  });

  it("F126-DB-09: Team-Refs zählen gegen den 20er-Cap (rein + gemischt)", async () => {
    const many = Array.from({ length: 21 }, (_, i) => `@team:f126-cap-${i}`).join(" ");
    await expect(createNote(fixture, fixture.editorId, many))
      .rejects.toBeInstanceOf(NoteValidationError);

    const mixed = `${Array.from({ length: 19 }, (_, i) => `@u${i}@f126.test`).join(" ")} @team:f126-cap-a @team:f126-cap-b`;
    await expect(createNote(fixture, fixture.editorId, mixed))
      .rejects.toBeInstanceOf(NoteValidationError);

    // Grenze: genau 20 Team-Refs sind ok (unbekannte Slugs, keine Zeilen).
    const twenty = Array.from({ length: 20 }, (_, i) => `@team:f126-ok-${i}`).join(" ");
    const created = await createNote(fixture, fixture.editorId, twenty);
    expect(await teamMentionTeamIds(fixture, created.noteId)).toEqual([]);
  });

  it("F126-DB-10: Tenant-Trennung — gleicher Slug, fremde Team-Notiz unsichtbar", async () => {
    const other = await seedFixture("f126-foreign.test");
    const foreign = await createNote(
      other,
      other.editorId,
      `Fremd f126-tenant an @team:${TEAM_SLUG}`,
    );

    // Gleicher Slug in beiden Workspaces (Voraussetzung des Tests).
    expect(TEAM_SLUG).toBe("f126-montage");
    // B-Mitglied sieht die eigene Team-Notiz (Gate: erweiterter Pfad).
    expect((await listMentions(other, other.viewerId)).notes.map((row) => row.noteId))
      .toEqual([foreign.noteId]);
    // A-Mitglied (eigenes Team, gleicher Slug) sieht die B-Notiz nicht.
    expect((await listMentions(fixture, fixture.viewerId)).notes).toEqual([]);
  });

  it("F126-DB-11: team-FK RESTRICT — DELETE am erwähnten Team scheitert mit 23001", async () => {
    // Team OHNE sonstige Bindung (keine Mitglieder!): Die
    // Legacy-SET-NULL-Wechselwirkung würde sonst 23514 vor 23001 werfen.
    const lonelyTeamId = randomUUID();
    await createTeamRow(fixture.workspaceId, fixture.editorId, lonelyTeamId, "f126-einsam", true);
    await createNote(fixture, fixture.editorId, `Einsam f126-restrict an @team:f126-einsam`);

    const code = await withTenantOn(testPool, fixture.workspaceId, async (tx) => {
      try {
        await tx.execute(sql`
          delete from team
           where workspace_id = ${fixture.workspaceId}::uuid
             and id = ${lonelyTeamId}::uuid
        `);
        return null;
      } catch (error) {
        return postgresCode(error) ?? "unknown";
      }
    });
    expect(code).toBe("23001");
  });
});
