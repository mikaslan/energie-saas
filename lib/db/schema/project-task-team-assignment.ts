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
import { projectTask } from "./project-task";
import { team } from "./team";

export const projectTaskTeamAssignment = pgTable(
  "project_task_team_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    taskId: uuid("task_id").notNull(),
    teamId: uuid("team_id").notNull(),
    assignedBy: uuid("assigned_by").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_task_team_assignment_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_task_team_assignment_ws_task_team_uq").on(
      t.workspaceId,
      t.taskId,
      t.teamId,
    ),
    index("project_task_team_assignment_ws_team_task_idx").on(
      t.workspaceId,
      t.teamId,
      t.taskId,
    ),
    check(
      "project_task_team_assignment_time_ck",
      sql`pg_catalog.isfinite(${t.assignedAt})`,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_task_team_assignment_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [projectTask.workspaceId, projectTask.id],
      name: "project_task_team_assignment_task_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
      name: "project_task_team_assignment_team_fk",
    }).onDelete("restrict"),
  ],
);
