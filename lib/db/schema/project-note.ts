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
import { workspace } from "./core";
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
