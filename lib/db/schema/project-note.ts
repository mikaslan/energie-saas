import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { userIdentity, workspace } from "./core";
import { project } from "./project";

export const PROJECT_NOTE_TEXT_VERSION = "note-text.v1" as const;

// M1-13 Projektnotizen (F1.9, parentType = 'project'). Kanonische Textform ist
// ausschließlich text_markdown; text_plain wird bei Read abgeleitet (P2-4).
export const projectNote = pgTable(
  "project_note",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    parentType: text("parent_type").notNull().default("project"),
    textVersion: text("text_version").notNull().default(PROJECT_NOTE_TEXT_VERSION),
    textMarkdown: text("text_markdown").notNull(),
    pinnedAt: timestamp("pinned_at", { withTimezone: true }),
    pinnedBy: uuid("pinned_by"),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    editedBy: uuid("edited_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    unique("project_note_ws_id_uq").on(t.workspaceId, t.id),
    index("project_note_ws_project_active_idx")
      .on(
        t.workspaceId,
        t.projectId,
        t.pinnedAt.desc().nullsLast(),
        t.createdAt.desc().nullsLast(),
        t.id.asc().nullsLast(),
      )
      .where(sql`${t.deletedAt} is null`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_note_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "project_note_project_fk",
    }).onDelete("cascade"),
    check("project_note_parent_type_ck", sql`${t.parentType} = 'project'`),
    check("project_note_text_version_ck", sql`${t.textVersion} = 'note-text.v1'`),
    check(
      "project_note_text_markdown_ck",
      sql`length(${t.textMarkdown}) between 1 and 10000`,
    ),
    check(
      "project_note_pin_pair_ck",
      sql`(${t.pinnedAt} is null) = (${t.pinnedBy} is null)`,
    ),
    check(
      "project_note_edit_pair_ck",
      sql`(${t.editedAt} is null) = (${t.editedBy} is null)`,
    ),
    check(
      "project_note_deleted_at_ck",
      sql`${t.deletedAt} is null or ${t.deletedAt} >= ${t.createdAt}`,
    ),
    check("project_note_revision_ck", sql`${t.revision} between 1 and 2147483647`),
    check(
      "project_note_timestamps_ck",
      sql`isfinite(${t.createdAt})
          and (${t.pinnedAt} is null or isfinite(${t.pinnedAt}))
          and (${t.editedAt} is null or isfinite(${t.editedAt}))
          and (${t.deletedAt} is null or isfinite(${t.deletedAt}))`,
    ),
  ],
);

// F1-09 @-Mentions: Seitentabelle zu project_note. Roh-Refs bleiben im
// Markdown; hier liegen nur aufgelöste Identitäten (Diff pro Revision).
export const projectNoteMention = pgTable(
  "project_note_mention",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    noteId: uuid("note_id").notNull(),
    mentionedIdentityId: uuid("mentioned_identity_id").notNull(),
    emailLower: text("email_lower").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_note_mention_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_note_mention_ws_note_identity_uq").on(
      t.workspaceId,
      t.noteId,
      t.mentionedIdentityId,
    ),
    index("project_note_mention_ws_note_idx").on(t.workspaceId, t.noteId),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_note_mention_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.noteId],
      foreignColumns: [projectNote.workspaceId, projectNote.id],
      name: "project_note_mention_note_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.mentionedIdentityId],
      foreignColumns: [userIdentity.id],
      name: "project_note_mention_identity_fk",
    }),
    check(
      "project_note_mention_email_ck",
      sql`length(${t.emailLower}) between 3 and 254`,
    ),
    check("project_note_mention_revision_ck", sql`${t.revision} between 1 and 2147483647`),
  ],
);
