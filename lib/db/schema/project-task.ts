import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { membership, workspace } from "./core";
import { project } from "./project";

export const PROJECT_TASK_BODY_VERSION = "task-rich-text.v1" as const;
export const projectTaskStatuses = ["open", "done"] as const;
export const projectTaskLabelColors = [
  "slate",
  "blue",
  "emerald",
  "amber",
  "rose",
  "violet",
] as const;

export type ProjectTaskRichTextDoc = {
  type: "doc";
  content: unknown[];
};

export const projectTask = pgTable(
  "project_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    title: text("title").notNull(),
    bodyVersion: text("body_version").notNull().default(PROJECT_TASK_BODY_VERSION),
    body: jsonb("body")
      .$type<ProjectTaskRichTextDoc>()
      .notNull()
      .default({ type: "doc", content: [] }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    status: text("status")
      .$type<(typeof projectTaskStatuses)[number]>()
      .notNull()
      .default("open"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_task_ws_id_uq").on(t.workspaceId, t.id),
    index("project_task_ws_project_active_idx")
      .on(
        t.workspaceId,
        t.projectId,
        t.status.desc().nullsFirst(),
        t.dueAt.asc().nullsLast(),
        t.completedAt.desc().nullsLast(),
        t.createdAt.desc().nullsFirst(),
        t.id.asc().nullsLast(),
      )
      .where(sql`${t.archivedAt} is null`),
    index("project_task_ws_due_active_idx")
      .on(t.workspaceId, t.dueAt, t.id)
      .where(sql`${t.archivedAt} is null and ${t.dueAt} is not null`),
    index("project_task_ws_project_archived_idx")
      .on(
        t.workspaceId,
        t.projectId,
        t.status.desc().nullsFirst(),
        t.dueAt.asc().nullsLast(),
        t.completedAt.desc().nullsLast(),
        t.createdAt.desc().nullsFirst(),
        t.id.asc().nullsLast(),
      )
      .where(sql`${t.archivedAt} is not null`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_task_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "project_task_project_fk",
    }).onDelete("cascade"),
    check("project_task_title_ck", sql`length(btrim(${t.title})) between 1 and 200`),
    check(
      "project_task_body_version_ck",
      sql`${t.bodyVersion} = 'task-rich-text.v1'`,
    ),
    check(
      "project_task_body_ck",
      sql`public._m110_valid_task_rich_text_v1(${t.body})`,
    ),
    check("project_task_due_at_ck", sql`${t.dueAt} is null or isfinite(${t.dueAt})`),
    check("project_task_status_ck", sql`${t.status} in ('open', 'done')`),
    check(
      "project_task_completion_ck",
      sql`(${t.status} = 'open' and ${t.completedAt} is null)
          or (${t.status} = 'done' and ${t.completedAt} is not null)`,
    ),
    check(
      "project_task_revision_ck",
      sql`${t.revision} between 1 and 2147483647`,
    ),
    check(
      "project_task_timestamps_ck",
      sql`${t.updatedAt} >= ${t.createdAt}
          and (${t.completedAt} is null or ${t.completedAt} >= ${t.createdAt})
          and (${t.archivedAt} is null or ${t.archivedAt} >= ${t.createdAt})`,
    ),
  ],
);

export const projectTaskAssignee = pgTable(
  "project_task_assignee",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    taskId: uuid("task_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_task_assignee_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_task_assignee_ws_task_membership_uq").on(
      t.workspaceId,
      t.taskId,
      t.membershipId,
    ),
    index("project_task_assignee_ws_membership_task_idx").on(
      t.workspaceId,
      t.membershipId,
      t.taskId,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_task_assignee_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [projectTask.workspaceId, projectTask.id],
      name: "project_task_assignee_task_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.membershipId],
      foreignColumns: [membership.workspaceId, membership.id],
      name: "project_task_assignee_membership_fk",
    }).onDelete("restrict"),
  ],
);

export const projectTaskChecklistItem = pgTable(
  "project_task_checklist_item",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    taskId: uuid("task_id").notNull(),
    position: integer("position").notNull(),
    text: text("text").notNull(),
    isDone: boolean("is_done").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_task_checklist_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_task_checklist_ws_task_position_uq").on(
      t.workspaceId,
      t.taskId,
      t.position,
    ),
    index("project_task_checklist_ws_task_idx").on(t.workspaceId, t.taskId, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_task_checklist_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [projectTask.workspaceId, projectTask.id],
      name: "project_task_checklist_task_fk",
    }).onDelete("cascade"),
    check("project_task_checklist_position_ck", sql`${t.position} between 0 and 99`),
    check(
      "project_task_checklist_text_ck",
      sql`length(btrim(${t.text})) between 1 and 500`,
    ),
    check("project_task_checklist_time_ck", sql`${t.updatedAt} >= ${t.createdAt}`),
  ],
);

export const projectTaskLabel = pgTable(
  "project_task_label",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    taskId: uuid("task_id").notNull(),
    position: integer("position").notNull(),
    name: text("name").notNull(),
    color: text("color")
      .$type<(typeof projectTaskLabelColors)[number]>()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_task_label_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_task_label_ws_task_position_uq").on(
      t.workspaceId,
      t.taskId,
      t.position,
    ),
    uniqueIndex("project_task_label_ws_task_name_ci_uq").on(
      t.workspaceId,
      t.taskId,
      sql`lower(btrim(${t.name}))`,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_task_label_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.taskId],
      foreignColumns: [projectTask.workspaceId, projectTask.id],
      name: "project_task_label_task_fk",
    }).onDelete("cascade"),
    check("project_task_label_position_ck", sql`${t.position} between 0 and 14`),
    check(
      "project_task_label_name_ck",
      sql`length(btrim(${t.name})) between 1 and 40
          and ${t.name} = normalize(${t.name}, NFKC)
          and ${t.name} !~ '[[:cntrl:]]'
          and ${t.name} !~ '(^[[:space:]])|([[:space:]]$)'`,
    ),
    check(
      "project_task_label_color_ck",
      sql`${t.color} in ('slate', 'blue', 'emerald', 'amber', 'rose', 'violet')`,
    ),
  ],
);
