import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
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
    phase: text("phase").notNull().default("site_documentation"),
    title: text("title").notNull().default("Baustellendokumentation"),
    version: integer("version").notNull().default(1),
    blocks: jsonb("blocks").notNull(),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_checklist_ws_id_uq").on(t.workspaceId, t.id),
    index("project_checklist_ws_project_phase_idx").on(t.workspaceId, t.projectId, t.phase),
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
      "project_checklist_phase_ck",
      sql`${t.phase} in ('qualification', 'consultation', 'site_documentation')`,
    ),
    check(
      "project_checklist_title_ck",
      sql`public._f704_valid_clean_text(${t.title}, 200)`,
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

export const projectChecklistSegmentCompletion = pgTable(
  "project_checklist_segment_completion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    checklistId: uuid("checklist_id").notNull(),
    segmentId: uuid("segment_id").notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }).notNull().defaultNow(),
    completedBy: uuid("completed_by").notNull(),
  },
  (t) => [
    unique("project_checklist_segment_completion_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_checklist_segment_completion_segment_uq").on(
      t.workspaceId,
      t.checklistId,
      t.segmentId,
    ),
    index("project_checklist_segment_completion_checklist_idx").on(
      t.workspaceId,
      t.checklistId,
      t.completedAt,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_checklist_segment_completion_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.checklistId],
      foreignColumns: [projectChecklist.workspaceId, projectChecklist.id],
      name: "project_checklist_segment_completion_checklist_fk",
    }).onDelete("cascade"),
    check(
      "project_checklist_segment_completion_time_ck",
      sql`pg_catalog.isfinite(${t.completedAt})`,
    ),
  ],
);
