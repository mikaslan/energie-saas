import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { workspace } from "./core";
import { project } from "./project";
import { team } from "./team";

export const projectTeamAssignment = pgTable(
  "project_team_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    teamId: uuid("team_id").notNull(),
    assignedBy: uuid("assigned_by").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_team_assignment_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_team_assignment_ws_project_team_uq").on(
      t.workspaceId,
      t.projectId,
      t.teamId,
    ),
    index("project_team_assignment_ws_team_project_idx").on(
      t.workspaceId,
      t.teamId,
      t.projectId,
    ),
    check(
      "project_team_assignment_time_ck",
      sql`pg_catalog.isfinite(${t.assignedAt})`,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_team_assignment_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "project_team_assignment_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
      name: "project_team_assignment_team_fk",
    }).onDelete("restrict"),
  ],
);
