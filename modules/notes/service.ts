import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  projectNoteCommandV1Schema,
  projectNoteItemV1Schema,
  projectNoteMentionV1Schema,
  projectNotePageV1Schema,
  type ProjectNoteCommandV1,
  type ProjectNoteCommandResult,
  type ProjectNoteItemV1,
  type ProjectNoteMentionV1,
  type ProjectNotePageV1,
} from "@/lib/integrations/notes/note-contract";
import { markdownToPlainText } from "@/lib/integrations/notes/note-markdown";
import {
  extractNoteMentionRefs,
  NoteMentionLimitError,
} from "@/lib/integrations/notes/note-mentions";
import { NoteConflictError, NoteNotFoundError, NoteValidationError } from "./errors";

type NoteRow = {
  id: string;
  revision: number;
  text_markdown: string;
  pinned_at_iso: string | null;
  created_at_iso: string;
  edited_at_iso: string | null;
  created_by_label: string;
  edited_by_label: string | null;
  pinned_by_label: string | null;
  [key: string]: unknown;
};

const TIMESTAMP_ISO = 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"';

function requireNoteRead(ctx: ServiceCtx): void {
  if (!can(ctx, "note.read")) {
    throw new PermissionDeniedError("note.read", "project_note", undefined, ctx.actor);
  }
}

function requireNoteWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "note.write")) {
    throw new PermissionDeniedError("note.write", "project_note", undefined, ctx.actor);
  }
}

function derivePlain(textMarkdown: string): string {
  try {
    return markdownToPlainText(textMarkdown);
  } catch {
    return textMarkdown;
  }
}

async function lockReadableProject(
  tx: TenantTx,
  workspaceId: string,
  projectId: string,
): Promise<boolean> {
  const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select project_record.id
      from project project_record
     where project_record.workspace_id = ${workspaceId}::uuid
       and project_record.id = ${projectId}::uuid
       and public._m113_actor_can_read_notes(project_record.workspace_id)
     for share
  `);
  return result.rows.length === 1;
}

async function lockProject(
  tx: TenantTx,
  workspaceId: string,
  projectId: string,
): Promise<void> {
  const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from project
     where workspace_id = ${workspaceId}::uuid
       and id = ${projectId}::uuid
     for key share
  `);
  if (!result.rows[0]) throw new NoteNotFoundError();

  // Zweites READ-COMMITTED-Statement: gewinnt die Erasure zuerst, wartet der
  // Project-Lock oben auf ihren Commit; erst der frische Snapshot entscheidet.
  const activeSubject = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select project_record.id
      from project project_record
      join contact contact_record
        on contact_record.workspace_id = project_record.workspace_id
       and contact_record.id = project_record.contact_id
     where project_record.workspace_id = ${workspaceId}::uuid
       and project_record.id = ${projectId}::uuid
       and contact_record.deleted_at is null
  `);
  if (!activeSubject.rows[0]) throw new NoteNotFoundError();
}

async function lockNote(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  noteId: string,
): Promise<{ id: string; revision: number }> {
  const result = await tx.execute<{ id: string; revision: number; [key: string]: unknown }>(sql`
    select id, revision
      from project_note
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
       and id = ${noteId}::uuid
       and deleted_at is null
     for update
  `);
  const row = result.rows[0];
  if (!row) throw new NoteNotFoundError();
  return row;
}

function requireRevision(currentRevision: number, expectedRevision: number): void {
  if (currentRevision !== expectedRevision) {
    throw new NoteConflictError(currentRevision);
  }
}

type NoteEventType =
  | "project.note_created"
  | "project.note_updated"
  | "project.note_deleted"
  | "project.note_pinned"
  | "project.note_unpinned"
  | "project.note_mentioned";

type MentionRow = {
  note_id: string;
  user_identity_id: string;
  email_lower: string;
  [key: string]: unknown;
};

// F1-09: ersetzt die Mention-Menge einer Notiz atomar im Schreib-Tx.
// Phantom-Refs (keine Membership) bleiben Rohtext und speichern nichts.
async function replaceNoteMentions(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  noteId: string,
  revision: number,
  textMarkdown: string,
): Promise<ProjectNoteMentionV1[]> {
  let refs;
  try {
    refs = extractNoteMentionRefs(textMarkdown);
  } catch (error) {
    if (error instanceof NoteMentionLimitError) throw new NoteValidationError();
    throw error;
  }
  const resolved =
    refs.length === 0
      ? []
      : (
          await tx.execute<{ identity_id: string; email_lower: string }>(sql`
            select identity_record.id as identity_id,
                   lower(identity_record.email) as email_lower
              from membership membership_record
              join user_identity identity_record
                on identity_record.id = membership_record.user_id
             where membership_record.workspace_id = ${ctx.workspaceId}::uuid
               and lower(identity_record.email) = any(${refs.map((ref) => ref.emailLower)})
          `)
        ).rows;
  const byEmail = new Map(resolved.map((row) => [row.email_lower, row.identity_id]));
  await tx.execute(sql`
    delete from project_note_mention
     where workspace_id = ${ctx.workspaceId}::uuid
       and note_id = ${noteId}::uuid
  `);
  const mentions: ProjectNoteMentionV1[] = [];
  for (const ref of refs) {
    const identityId = byEmail.get(ref.emailLower);
    if (!identityId) continue;
    await tx.execute(sql`
      insert into project_note_mention (
        workspace_id, project_id, note_id, mentioned_identity_id,
        email_lower, revision
      ) values (
        ${ctx.workspaceId}::uuid, ${projectId}::uuid, ${noteId}::uuid,
        ${identityId}::uuid, ${ref.emailLower}, ${revision}
      )
    `);
    mentions.push(
      projectNoteMentionV1Schema.parse({
        userIdentityId: identityId,
        emailLower: ref.emailLower,
      }),
    );
  }
  if (mentions.length > 0) {
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "project",
      aggregateId: projectId,
      eventType: "project.note_mentioned",
      actor: ctx.actor,
      payload: {
        projectId,
        noteId,
        revision,
        mentionedIdentityIds: mentions.map((mention) => mention.userIdentityId),
      },
    });
  }
  return mentions;
}

async function emitNoteEvidence(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    projectId: string;
    noteId: string;
    revision: number;
    kind: ProjectNoteCommandV1["kind"];
    eventType: NoteEventType;
  },
): Promise<void> {
  const evidence = {
    projectId: input.projectId,
    noteId: input.noteId,
    revision: input.revision,
    kind: input.kind,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: input.projectId,
    eventType: input.eventType,
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "note.write",
    resource: "project_note",
    allowed: true,
    details: evidence,
  });
}

async function createNote(
  tx: TenantTx,
  ctx: ServiceCtx,
  command: Extract<ProjectNoteCommandV1, { kind: "create_note" }>,
): Promise<ProjectNoteCommandResult> {
  await lockProject(tx, ctx.workspaceId, command.projectId);
  const noteId = randomUUID();
  await tx.execute(sql`
    insert into project_note (
      id, workspace_id, project_id, parent_type, text_version, text_markdown,
      pinned_at, pinned_by, revision, created_by
    ) values (
      ${noteId}::uuid, ${ctx.workspaceId}::uuid, ${command.projectId}::uuid,
      'project', 'note-text.v1', ${command.textMarkdown},
      case when ${command.pinned} then statement_timestamp() else null end,
      case when ${command.pinned} then ${ctx.actor}::uuid else null end,
      1, ${ctx.actor}::uuid
    )
  `);
  await emitNoteEvidence(tx, ctx, {
    projectId: command.projectId,
    noteId,
    revision: 1,
    kind: command.kind,
    eventType: "project.note_created",
  });
  await replaceNoteMentions(tx, ctx, command.projectId, noteId, 1, command.textMarkdown);
  return { projectId: command.projectId, noteId, revision: 1, changed: true };
}

async function mutateNote(
  tx: TenantTx,
  ctx: ServiceCtx,
  command: Exclude<ProjectNoteCommandV1, { kind: "create_note" }>,
): Promise<ProjectNoteCommandResult> {
  await lockProject(tx, ctx.workspaceId, command.projectId);
  const note = await lockNote(tx, ctx, command.projectId, command.noteId);
  requireRevision(note.revision, command.expectedRevision);

  let eventType: NoteEventType;
  if (command.kind === "update_note_text") {
    const updated = await tx.execute<{ revision: number; [key: string]: unknown }>(sql`
      update project_note
         set text_markdown = ${command.textMarkdown},
             edited_at = statement_timestamp(),
             edited_by = ${ctx.actor}::uuid,
             revision = revision + 1
       where workspace_id = ${ctx.workspaceId}::uuid
         and project_id = ${command.projectId}::uuid
         and id = ${command.noteId}::uuid
         and revision = ${command.expectedRevision}
         and deleted_at is null
       returning revision
    `);
    const revision = updated.rows[0]?.revision;
    if (!revision) throw new NoteConflictError();
    eventType = "project.note_updated";
    await emitNoteEvidence(tx, ctx, {
      projectId: command.projectId,
      noteId: command.noteId,
      revision,
      kind: command.kind,
      eventType,
    });
    await replaceNoteMentions(
      tx, ctx, command.projectId, command.noteId, revision, command.textMarkdown,
    );
    return { projectId: command.projectId, noteId: command.noteId, revision, changed: true };
  }

  if (command.kind === "set_note_pinned") {
    const updated = await tx.execute<{ revision: number; [key: string]: unknown }>(sql`
      update project_note
         set pinned_at = case when ${command.pinned} then statement_timestamp() else null end,
             pinned_by = case when ${command.pinned} then ${ctx.actor}::uuid else null end,
             revision = revision + 1
       where workspace_id = ${ctx.workspaceId}::uuid
         and project_id = ${command.projectId}::uuid
         and id = ${command.noteId}::uuid
         and revision = ${command.expectedRevision}
         and deleted_at is null
       returning revision
    `);
    const revision = updated.rows[0]?.revision;
    if (!revision) throw new NoteConflictError();
    eventType = command.pinned ? "project.note_pinned" : "project.note_unpinned";
    await emitNoteEvidence(tx, ctx, {
      projectId: command.projectId,
      noteId: command.noteId,
      revision,
      kind: command.kind,
      eventType,
    });
    return { projectId: command.projectId, noteId: command.noteId, revision, changed: true };
  }

  const updated = await tx.execute<{ revision: number; [key: string]: unknown }>(sql`
    update project_note
       set deleted_at = statement_timestamp(),
           revision = revision + 1
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
       and id = ${command.noteId}::uuid
       and revision = ${command.expectedRevision}
       and deleted_at is null
     returning revision
  `);
  const revision = updated.rows[0]?.revision;
  if (!revision) throw new NoteConflictError();
  eventType = "project.note_deleted";
  await emitNoteEvidence(tx, ctx, {
    projectId: command.projectId,
    noteId: command.noteId,
    revision,
    kind: command.kind,
    eventType,
  });
  return { projectId: command.projectId, noteId: command.noteId, revision, changed: true };
}

export async function executeProjectNoteCommand(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ProjectNoteCommandV1,
): Promise<ProjectNoteCommandResult> {
  requireNoteWrite(ctx);
  const parsed = projectNoteCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new NoteValidationError();
  const command = parsed.data;
  if (command.kind === "create_note") return createNote(tx, ctx, command);
  return mutateNote(tx, ctx, command);
}

export async function listProjectNotes(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectNotePageV1 | null> {
  requireNoteRead(ctx);
  if (!await lockReadableProject(tx, ctx.workspaceId, projectId)) return null;

  const result = await tx.execute<NoteRow>(sql`
    select note_record.id,
           note_record.revision,
           note_record.text_markdown,
           to_char(
             note_record.pinned_at at time zone 'UTC', ${TIMESTAMP_ISO}
           ) as pinned_at_iso,
           to_char(
             note_record.created_at at time zone 'UTC', ${TIMESTAMP_ISO}
           ) as created_at_iso,
           to_char(
             note_record.edited_at at time zone 'UTC', ${TIMESTAMP_ISO}
           ) as edited_at_iso,
           coalesce(creator.email, 'System') as created_by_label,
           editor.email as edited_by_label,
           pinner.email as pinned_by_label
      from project_note note_record
      left join user_identity creator on creator.id = note_record.created_by
      left join user_identity editor on editor.id = note_record.edited_by
      left join user_identity pinner on pinner.id = note_record.pinned_by
     where note_record.workspace_id = ${ctx.workspaceId}::uuid
       and note_record.project_id = ${projectId}::uuid
       and note_record.deleted_at is null
     order by note_record.pinned_at desc nulls last,
              note_record.created_at desc,
              note_record.id asc
  `);

  const noteIds = result.rows.map((row) => row.id);
  const mentionRows =
    noteIds.length === 0
      ? []
      : (
          await tx.execute<MentionRow>(sql`
            select note_id,
                   mentioned_identity_id as user_identity_id,
                   email_lower
              from project_note_mention
             where workspace_id = ${ctx.workspaceId}::uuid
               and note_id = any(${noteIds})
             order by email_lower asc
          `)
        ).rows;
  const mentionsByNote = new Map<string, ProjectNoteMentionV1[]>();
  for (const row of mentionRows) {
    const parsed = projectNoteMentionV1Schema.parse({
      userIdentityId: row.user_identity_id,
      emailLower: row.email_lower,
    });
    const list = mentionsByNote.get(row.note_id) ?? [];
    list.push(parsed);
    mentionsByNote.set(row.note_id, list);
  }

  const items: ProjectNoteItemV1[] = result.rows.map((row) => ({
    id: row.id,
    revision: row.revision,
    textMarkdown: row.text_markdown,
    textPlain: derivePlain(row.text_markdown),
    pinned: row.pinned_at_iso !== null,
    createdAt: row.created_at_iso,
    createdByLabel: row.created_by_label,
    editedAt: row.edited_at_iso,
    editedByLabel: row.edited_by_label,
    pinnedAt: row.pinned_at_iso,
    pinnedByLabel: row.pinned_by_label,
    mentions: mentionsByNote.get(row.id) ?? [],
  }));

  return projectNotePageV1Schema.parse({
    schemaVersion: "project-note-page.v1",
    projectId,
    permissions: { canWrite: can(ctx, "note.write") },
    notes: items.map((item) => projectNoteItemV1Schema.parse(item)),
  });
}
