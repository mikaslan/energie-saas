import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";
import { project } from "./project";

export const projectChecklist = pgTable(
  "project_checklist",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    version: integer("version").notNull().default(1),
    blocks: jsonb("blocks").notNull(),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_checklist_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_checklist_ws_project_uq").on(t.workspaceId, t.projectId),
    index("project_checklist_ws_project_idx").on(t.workspaceId, t.projectId),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_checklist_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "project_checklist_project_fk",
    }),
    check(
      "project_checklist_blocks_ck",
      sql`pg_catalog.jsonb_typeof(${t.blocks}) = 'array'`,
    ),
    check(
      "project_checklist_version_ck",
      sql`${t.version} between 1 and 2147483647`,
    ),
    check(
      "project_checklist_timestamps_ck",
      sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`,
    ),
  ],
);
