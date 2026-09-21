import {
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { workspace } from "./core";
import { projectNote } from "./project-note";
import { team } from "./team";

// F1-26 Team-Mentions (`@team:slug`): eigene Tabelle + dynamische Auflösung
// (kein Fan-Out, kein Cap-Bomb; Muster F1-20/F7-11: team-FK RESTRICT,
// note-FK CASCADE).
export const projectNoteTeamMention = pgTable(
  "project_note_team_mention",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    noteId: uuid("note_id").notNull(),
    teamId: uuid("team_id").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_note_team_mention_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_note_team_mention_ws_note_team_uq").on(
      t.workspaceId,
      t.noteId,
      t.teamId,
    ),
    index("project_note_team_mention_ws_team_note_idx").on(
      t.workspaceId,
      t.teamId,
      t.noteId,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_note_team_mention_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.noteId],
      foreignColumns: [projectNote.workspaceId, projectNote.id],
      name: "project_note_team_mention_note_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
      name: "project_note_team_mention_team_fk",
    }).onDelete("restrict"),
  ],
);
