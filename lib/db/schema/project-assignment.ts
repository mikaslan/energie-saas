import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { membership, workspace } from "./core";
import { project } from "./project";

export const projectAssignmentRoles = ["key_account", "user"] as const;

export const projectAssignment = pgTable(
  "project_assignment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    assignmentRole: text("assignment_role")
      .$type<(typeof projectAssignmentRoles)[number]>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_assignment_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_assignment_ws_project_membership_uq").on(
      t.workspaceId,
      t.projectId,
      t.membershipId,
    ),
    uniqueIndex("project_assignment_one_key_account_uidx")
      .on(t.workspaceId, t.projectId)
      .where(sql`${t.assignmentRole} = 'key_account'`),
    index("project_assignment_ws_membership_project_idx").on(
      t.workspaceId,
      t.membershipId,
      t.projectId,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_assignment_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "project_assignment_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.membershipId],
      foreignColumns: [membership.workspaceId, membership.id],
      name: "project_assignment_membership_fk",
    }).onDelete("restrict"),
    check(
      "project_assignment_role_ck",
      sql`${t.assignmentRole} in ('key_account', 'user')`,
    ),
  ],
);
