import "server-only";

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  EMPTY_TASK_RICH_TEXT_V1,
  PROJECT_TASK_MAX_ASSIGNEES,
  PROJECT_TASK_MAX_CHECKLIST_ITEMS,
  PROJECT_TASK_MAX_LABELS,
  PROJECT_TASK_MAX_REVISION,
  PROJECT_TASK_MEMBER_SEARCH_LIMIT,
  PROJECT_TASK_PAGE_LIMIT,
  projectTaskCommandV1Schema,
  projectTaskCursorTokenSchema,
  projectTaskMemberSearchV1Schema,
  taskLabelColors,
  taskRichTextV1Schema,
  type ProjectTaskCommandV1,
  type ProjectActivityCursor,
  type ProjectActivityKind,
  type ProjectActivityPageV1,
  type ProjectTaskCommandResult,
  type ProjectTaskItemV1,
  type ProjectTaskMemberSearchV1,
  type ProjectTaskMemberSearchPageV1,
  type ProjectTaskPageV1,
  type ProjectTaskWorkspaceV1,
  type TaskLabelColor,
} from "@/lib/integrations/tasks/contract";
import {
  ProjectTaskArchivedError,
  ProjectTaskConflictError,
  ProjectTaskNotFoundError,
  ProjectTaskValidationError,
} from "./errors";

type TaskRow = {
  id: string;
  revision: number;
  title: string;
  body_version: string;
  body: unknown;
  due_at: Date | string | null;
  due_date: string | null;
  status: "open" | "done";
  completed_at: Date | string | null;
  archived_at: Date | string | null;
  [key: string]: unknown;
};
type ChecklistRow = {
  task_id: string;
  id: string;
  position: number;
  text: string;
  is_done: boolean;
  [key: string]: unknown;
};
type LabelRow = {
  task_id: string;
  id: string;
  position: number;
  name: string;
  color: TaskLabelColor;
  [key: string]: unknown;
};
type ActivityRow = {
  id: string;
  event_type: string;
  occurred_at: string;
  actor_label: string;
  task_id: unknown;
  task_title: unknown;
  [key: string]: unknown;
};
type WorkspaceProjectionRow = {
  project_id: unknown;
  archived_count: unknown;
  tasks: unknown;
  next_task_cursor: unknown;
  activity_rows: unknown;
  activity_has_more: unknown;
  [key: string]: unknown;
};

type TaskCursorPayload = {
  v: 1;
  projectId: string;
  archived: boolean;
  status: "open" | "done";
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  id: string;
};

const activityKinds: Readonly<Record<string, ProjectActivityKind>> = {
  "project.task_created": "task_created",
  "project.task_updated": "task_updated",
  "project.task_checklist_changed": "task_checklist_changed",
  "project.task_completed": "task_completed",
  "project.task_reopened": "task_reopened",
  "project.task_archived": "task_archived",
};
const activityCursorSchema = z.strictObject({
  occurredAt: z.iso.datetime({ offset: true }),
  id: z.uuid().transform((value) => value.toLowerCase()),
});
const taskCursorPayloadSchema: z.ZodType<TaskCursorPayload> = z.strictObject({
  v: z.literal(1),
  projectId: z.uuid().transform((value) => value.toLowerCase()),
  archived: z.boolean(),
  status: z.enum(["open", "done"]),
  dueAt: z.iso.datetime({ offset: true }).nullable(),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid().transform((value) => value.toLowerCase()),
}).superRefine((value, ctx) => {
  if ((value.status === "open") !== (value.completedAt === null)) {
    ctx.addIssue({ code: "custom", message: "task cursor state is inconsistent" });
  }
});
const projectedUuidSchema = z.uuid().transform((value) => value.toLowerCase());
const projectedTimestampSchema = z.iso.datetime({ offset: true }).nullable();
const projectedMemberSchema = z.strictObject({
  membershipId: projectedUuidSchema,
  label: z.string().min(1),
});
const projectedChecklistSchema = z.strictObject({
  id: projectedUuidSchema,
  position: z.number().int().min(0).max(PROJECT_TASK_MAX_CHECKLIST_ITEMS - 1),
  text: z.string().min(1).max(500),
  done: z.boolean(),
});
const projectedLabelSchema = z.strictObject({
  id: projectedUuidSchema,
  position: z.number().int().min(0).max(PROJECT_TASK_MAX_LABELS - 1),
  name: z.string().min(1).max(40),
  color: z.enum(taskLabelColors),
});
const projectedTaskSchema: z.ZodType<ProjectTaskItemV1> = z.strictObject({
  id: projectedUuidSchema,
  revision: z.number().int().min(1).max(PROJECT_TASK_MAX_REVISION),
  title: z.string().min(1).max(200),
  body: taskRichTextV1Schema,
  dueAt: projectedTimestampSchema,
  status: z.enum(["open", "done"]),
  completedAt: projectedTimestampSchema,
  archivedAt: projectedTimestampSchema,
  assignees: z.array(projectedMemberSchema).max(PROJECT_TASK_MAX_ASSIGNEES),
  checklist: z.array(projectedChecklistSchema).max(PROJECT_TASK_MAX_CHECKLIST_ITEMS),
  labels: z.array(projectedLabelSchema).max(PROJECT_TASK_MAX_LABELS),
}).superRefine((value, ctx) => {
  if ((value.status === "open") !== (value.completedAt === null)) {
    ctx.addIssue({ code: "custom", message: "task completion state is inconsistent" });
  }
});
const projectedActivityRowSchema = z.strictObject({
  id: projectedUuidSchema,
  event_type: z.string().min(1),
  occurred_at: z.iso.datetime({ offset: true }),
  actor_label: z.string().min(1),
  task_id: projectedUuidSchema,
  task_title: z.string().min(1).max(200).nullable(),
});
const workspaceProjectionSchema = z.strictObject({
  project_id: projectedUuidSchema,
  archived_count: z.number().int().nonnegative(),
  tasks: z.array(projectedTaskSchema).max(PROJECT_TASK_PAGE_LIMIT),
  next_task_cursor: taskCursorPayloadSchema.nullable(),
  activity_rows: z.array(projectedActivityRowSchema).max(100),
  activity_has_more: z.boolean(),
});

function decodeTaskCursor(
  token: string | null | undefined,
  projectId: string,
  archived: boolean,
): TaskCursorPayload | null {
  if (token == null) return null;
  const tokenResult = projectTaskCursorTokenSchema.safeParse(token);
  if (!tokenResult.success) throw new ProjectTaskValidationError();
  try {
    const bytes = Buffer.from(tokenResult.data, "base64url");
    if (bytes.toString("base64url") !== tokenResult.data) {
      throw new ProjectTaskValidationError();
    }
    const parsed = taskCursorPayloadSchema.safeParse(
      JSON.parse(bytes.toString("utf8")) as unknown,
    );
    if (
      !parsed.success
      || parsed.data.projectId !== projectId.toLowerCase()
      || parsed.data.archived !== archived
    ) throw new ProjectTaskValidationError();
    return parsed.data;
  } catch (error) {
    if (error instanceof ProjectTaskValidationError) throw error;
    throw new ProjectTaskValidationError();
  }
}

function encodeTaskCursor(payload: TaskCursorPayload | null): string | null {
  if (payload === null) return null;
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function requireTaskRead(ctx: ServiceCtx): void {
  if (!can(ctx, "task.read")) {
    throw new PermissionDeniedError("task.read", "project_task", undefined, ctx.actor);
  }
}

function requireTaskWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "task.write")) {
    throw new PermissionDeniedError("task.write", "project_task", undefined, ctx.actor);
  }
}

function requireActivityRead(ctx: ServiceCtx): void {
  if (!can(ctx, "project.activity.read")) {
    throw new PermissionDeniedError(
      "project.activity.read",
      "project_activity",
      undefined,
      ctx.actor,
    );
  }
}

function uuidList(values: readonly string[]) {
  return sql.join(values.map((value) => sql`${value}::uuid`), sql`, `);
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
       and public._m110_actor_can_read_tasks(project_record.workspace_id)
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
  if (!result.rows[0]) throw new ProjectTaskNotFoundError();

  // Absichtlich ein zweites READ-COMMITTED-Statement: gewinnt die Erasure
  // zuerst, wartet der Project-Lock oben auf ihren Commit. Erst der frische
  // Snapshot hier darf danach entscheiden, ob noch Taskdaten entstehen.
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
  if (!activeSubject.rows[0]) throw new ProjectTaskNotFoundError();
}

async function lockWorkspace(tx: TenantTx, workspaceId: string): Promise<void> {
  const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id from workspace where id = ${workspaceId}::uuid for share
  `);
  if (!result.rows[0]) throw new ProjectTaskNotFoundError();
}

// `lockWorkspace(... FOR SHARE)` muss vor diesem Validator gehalten werden.
// Membership-DML nimmt im Statement-Guard denselben Workspace `FOR UPDATE`;
// dadurch bleibt die geprüfte interne Rolle bis zum Transaktionsende stabil.
async function validateInternalMembershipsUnderWorkspaceLock(
  tx: TenantTx,
  workspaceId: string,
  membershipIds: readonly string[],
): Promise<void> {
  const expected = [...new Set(membershipIds)].sort();
  if (expected.length === 0) return;
  const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from membership
     where workspace_id = ${workspaceId}::uuid
       and id in (${uuidList(expected)})
       and role in ('viewer', 'editor', 'admin')
       and jsonb_typeof(capabilities) = 'object'
       and not exists (
         select 1
           from jsonb_each(capabilities) as capability(key, value)
          where jsonb_typeof(capability.value) <> 'boolean'
       )
       and (
         not (capabilities ? 'external_only')
         or capabilities->'external_only' = 'false'::jsonb
     )
     order by id
  `);
  if (result.rows.length !== expected.length) throw new ProjectTaskNotFoundError();
}

async function actorMembershipId(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<string> {
  const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from membership
     where workspace_id = ${ctx.workspaceId}::uuid
       and user_id = ${ctx.actor}::uuid
       and role in ('editor', 'admin')
       and jsonb_typeof(capabilities) = 'object'
       and not exists (
         select 1
           from jsonb_each(capabilities) as capability(key, value)
          where jsonb_typeof(capability.value) <> 'boolean'
       )
       and (
         not (capabilities ? 'external_only')
         or capabilities->'external_only' = 'false'::jsonb
     )
     limit 1
  `);
  const id = result.rows[0]?.id;
  if (!id) throw new ProjectTaskNotFoundError();
  return id;
}

function dueAtExpression(dueDate: string | null) {
  return dueDate === null
    ? sql`null::timestamptz`
    : sql`(((${dueDate}::date + 1)::timestamp at time zone 'Europe/Berlin') - interval '1 millisecond')`;
}

function activityPageFromRows(
  rows: z.infer<typeof projectedActivityRowSchema>[],
  hasMore: boolean,
): ProjectActivityPageV1 {
  const items = rows.map((row) => {
    const kind = activityKinds[row.event_type];
    if (!kind) throw new ProjectTaskValidationError();
    return {
      id: row.id,
      kind,
      occurredAt: row.occurred_at,
      actorLabel: row.actor_label,
      taskId: row.task_id,
      taskTitle: row.task_title,
    };
  });
  const last = items.at(-1);
  return {
    schemaVersion: "project-activity-page.v1",
    items,
    nextCursor: hasMore && last
      ? { occurredAt: last.occurredAt, id: last.id }
      : null,
  };
}

async function queryProjectTaskPageProjection(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  input: {
    archived: boolean;
    taskCursor: TaskCursorPayload | null;
    includeActivity: boolean;
    activityCursor: ProjectActivityCursor | null;
    activityLimit: number;
  },
): Promise<ProjectTaskPageV1 | null> {
  const { archived, taskCursor, includeActivity, activityCursor, activityLimit } = input;
  const canWrite = can(ctx, "task.write");
  const taskArchiveFilter = archived
    ? sql`task.archived_at is not null`
    : sql`task.archived_at is null`;
  const taskCursorFilter = taskCursor === null
    ? sql``
    : sql`and (
        task.status < ${taskCursor.status}
        or (
          task.status = ${taskCursor.status}
          and (
            (
              ${taskCursor.dueAt}::timestamptz is not null
              and (task.due_at is null or task.due_at > ${taskCursor.dueAt}::timestamptz)
            )
            or (
              task.due_at is not distinct from ${taskCursor.dueAt}::timestamptz
              and (
                (
                  ${taskCursor.completedAt}::timestamptz is not null
                  and (
                    task.completed_at is null
                    or task.completed_at < ${taskCursor.completedAt}::timestamptz
                  )
                )
                or (
                  task.completed_at is not distinct from
                    ${taskCursor.completedAt}::timestamptz
                  and (
                    task.created_at < ${taskCursor.createdAt}::timestamptz
                    or (
                      task.created_at = ${taskCursor.createdAt}::timestamptz
                      and task.id > ${taskCursor.id}::uuid
                    )
                  )
                )
              )
            )
          )
        )
      )`;
  const activityCursorFilter = activityCursor === null
    ? sql``
    : sql`and (event.occurred_at, event.id) < (
        ${activityCursor.occurredAt}::timestamptz,
        ${activityCursor.id}::uuid
      )`;
  const result = await tx.execute<WorkspaceProjectionRow>(sql`
    with task_window as materialized (
      select task.id, task.revision, task.title, task.body_version, task.body,
             task.due_at, task.status, task.completed_at, task.archived_at,
             task.created_at
        from project_task task
       where task.workspace_id = ${ctx.workspaceId}::uuid
         and task.project_id = ${projectId}::uuid
         and ${taskArchiveFilter}
         ${taskCursorFilter}
       order by
         task.status desc,
         task.due_at asc nulls last,
         task.completed_at desc nulls last,
         task.created_at desc,
         task.id
       limit ${PROJECT_TASK_PAGE_LIMIT + 1}
    ), selected_task as materialized (
      select *
        from task_window task
       order by
         task.status desc,
         task.due_at asc nulls last,
         task.completed_at desc nulls last,
         task.created_at desc,
         task.id
       limit ${PROJECT_TASK_PAGE_LIMIT}
    ), projected_task as (
      select task.*,
             coalesce((
               select jsonb_agg(
                 jsonb_build_object(
                   'membershipId', assignment.membership_id,
                   'label', identity_record.email
                 ) order by lower(identity_record.email), assignment.membership_id
               )
                 from project_task_assignee assignment
                 join membership membership_record
                   on membership_record.workspace_id = assignment.workspace_id
                  and membership_record.id = assignment.membership_id
                  and membership_record.role in ('viewer', 'editor', 'admin')
                  and jsonb_typeof(membership_record.capabilities) = 'object'
                  and not exists (
                    select 1
                      from jsonb_each(membership_record.capabilities)
                           as capability(key, value)
                     where jsonb_typeof(capability.value) <> 'boolean'
                  )
                  and (
                    not (membership_record.capabilities ? 'external_only')
                    or membership_record.capabilities->'external_only'
                         is not distinct from 'false'::jsonb
                  )
                 join user_identity identity_record
                   on identity_record.id = membership_record.user_id
                where assignment.workspace_id = ${ctx.workspaceId}::uuid
                  and assignment.task_id = task.id
             ), '[]'::jsonb) as assignees,
             coalesce((
               select jsonb_agg(
                 jsonb_build_object(
                   'id', item.id,
                   'position', item.position,
                   'text', item.text,
                   'done', item.is_done
                 ) order by item.position, item.id
               )
                 from project_task_checklist_item item
                where item.workspace_id = ${ctx.workspaceId}::uuid
                  and item.task_id = task.id
             ), '[]'::jsonb) as checklist,
             coalesce((
               select jsonb_agg(
                 jsonb_build_object(
                   'id', label.id,
                   'position', label.position,
                   'name', label.name,
                   'color', label.color
                 ) order by label.position, label.id
               )
                 from project_task_label label
                where label.workspace_id = ${ctx.workspaceId}::uuid
                  and label.task_id = task.id
             ), '[]'::jsonb) as labels
        from selected_task task
    ), activity_event_window as materialized (
      select event.id, event.event_type, event.occurred_at,
             event.actor, event.payload, event.workspace_id, event.aggregate_id
        from domain_events event
       where ${includeActivity}::boolean
         and event.workspace_id = ${ctx.workspaceId}::uuid
         and event.aggregate_type = 'project'
         and event.aggregate_id = ${projectId}::uuid
         and event.event_type in (
           'project.task_created', 'project.task_updated',
           'project.task_checklist_changed', 'project.task_completed',
           'project.task_reopened', 'project.task_archived'
         )
         and pg_catalog.pg_input_is_valid(event.payload->>'taskId', 'uuid')
         ${activityCursorFilter}
       order by event.occurred_at desc, event.id desc
       limit ${activityLimit + 1}
    ), activity_window as materialized (
      select event.id, event.event_type, event.occurred_at as occurred_sort,
             to_char(
               event.occurred_at at time zone 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
             ) as occurred_at,
             coalesce(identity_record.email, 'System') as actor_label,
             event.payload->'taskId' as task_id,
             activity_task.title as task_title
        from activity_event_window event
        left join user_identity identity_record
          on identity_record.id = case
               when pg_catalog.pg_input_is_valid(event.actor, 'uuid')
               then event.actor::uuid
               else null::uuid
             end
        left join project_task activity_task
          on activity_task.workspace_id = event.workspace_id
         and activity_task.project_id = event.aggregate_id
         and activity_task.id = (event.payload->>'taskId')::uuid
    )
    select project_record.id as project_id,
           coalesce((
             select count(*)::int
               from project_task archived_task
              where archived_task.workspace_id = ${ctx.workspaceId}::uuid
                and archived_task.project_id = ${projectId}::uuid
                and archived_task.archived_at is not null
           ), 0)::int as archived_count,
           coalesce((
             select jsonb_agg(
               jsonb_build_object(
                 'id', task.id,
                 'revision', task.revision,
                 'title', task.title,
                 'body', jsonb_build_object(
                   'schemaVersion', task.body_version,
                   'doc', task.body
                 ),
                 'dueAt', case when task.due_at is null then null else
                   to_char(task.due_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
                 'status', task.status,
                 'completedAt', case when task.completed_at is null then null else
                   to_char(task.completed_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
                 'archivedAt', case when task.archived_at is null then null else
                   to_char(task.archived_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
                 'assignees', task.assignees,
                 'checklist', task.checklist,
                 'labels', task.labels
               ) order by
                 task.status desc,
                 task.due_at asc nulls last,
                 task.completed_at desc nulls last,
                 task.created_at desc,
                 task.id
             ) from projected_task task
           ), '[]'::jsonb) as tasks,
           case when (select count(*) from task_window) > ${PROJECT_TASK_PAGE_LIMIT}
             then (
               select jsonb_build_object(
                 'v', 1,
                 'projectId', ${projectId}::uuid,
                 'archived', ${archived}::boolean,
                 'status', cursor_task.status,
                 'dueAt', case when cursor_task.due_at is null then null else
                   to_char(cursor_task.due_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
                 'completedAt', case when cursor_task.completed_at is null then null else
                   to_char(cursor_task.completed_at at time zone 'UTC',
                           'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end,
                 'createdAt', to_char(cursor_task.created_at at time zone 'UTC',
                                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                 'id', cursor_task.id
               )
                from selected_task cursor_task
                order by
                  cursor_task.status desc,
                  cursor_task.due_at asc nulls last,
                  cursor_task.completed_at desc nulls last,
                  cursor_task.created_at desc,
                  cursor_task.id
                offset ${PROJECT_TASK_PAGE_LIMIT - 1}
                limit 1
             )
             else null
           end as next_task_cursor,
           coalesce((
             select jsonb_agg(
               jsonb_build_object(
                 'id', activity.id,
                 'event_type', activity.event_type,
                 'occurred_at', activity.occurred_at,
                 'actor_label', activity.actor_label,
                 'task_id', activity.task_id,
                 'task_title', activity.task_title
               ) order by activity.occurred_sort desc, activity.id desc
             )
               from (
                 select * from activity_window
                  order by occurred_sort desc, id desc
                  limit ${activityLimit}
               ) activity
           ), '[]'::jsonb) as activity_rows,
           (select count(*) > ${activityLimit} from activity_window)
             as activity_has_more
      from project project_record
     where project_record.workspace_id = ${ctx.workspaceId}::uuid
       and project_record.id = ${projectId}::uuid
       and public._m110_actor_can_read_tasks(project_record.workspace_id)
  `);
  const parsed = workspaceProjectionSchema.safeParse(result.rows[0]);
  if (!parsed.success) {
    if (!result.rows[0]) return null;
    throw new ProjectTaskValidationError();
  }
  const items = parsed.data.tasks;
  return {
    schemaVersion: "project-task-page.v1",
    workspace: {
      schemaVersion: "project-task-workspace.v1",
      projectId: parsed.data.project_id,
      permissions: { canWrite },
      taskPageLimit: PROJECT_TASK_PAGE_LIMIT,
      nextTaskCursor: encodeTaskCursor(parsed.data.next_task_cursor),
      open: archived ? [] : items.filter(({ status }) => status === "open"),
      done: archived ? [] : items.filter(({ status }) => status === "done"),
      archived: archived ? items : [],
      archivedCount: parsed.data.archived_count,
    },
    activity: activityPageFromRows(
      parsed.data.activity_rows,
      parsed.data.activity_has_more,
    ),
  };
}

export async function getProjectTaskWorkspace(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  options: { archived?: boolean; taskCursor?: string | null } = {},
): Promise<ProjectTaskWorkspaceV1 | null> {
  requireTaskRead(ctx);
  const archived = options.archived === true;
  const taskCursor = decodeTaskCursor(options.taskCursor, projectId, archived);
  if (!await lockReadableProject(tx, ctx.workspaceId, projectId)) return null;
  const page = await queryProjectTaskPageProjection(tx, ctx, projectId, {
    archived,
    taskCursor,
    includeActivity: false,
    activityCursor: null,
    activityLimit: 25,
  });
  return page?.workspace ?? null;
}

export async function getProjectTaskPage(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  options: {
    archived?: boolean;
    taskCursor?: string | null;
    activityCursor?: ProjectActivityCursor | null;
    activityLimit?: number;
  } = {},
): Promise<ProjectTaskPageV1 | null> {
  requireTaskRead(ctx);
  requireActivityRead(ctx);
  const archived = options.archived === true;
  const taskCursor = decodeTaskCursor(options.taskCursor, projectId, archived);
  const activityCursorResult = options.activityCursor == null
    ? null
    : activityCursorSchema.safeParse(options.activityCursor);
  if (activityCursorResult !== null && !activityCursorResult.success) {
    throw new ProjectTaskValidationError();
  }
  const activityLimit = options.activityLimit ?? 25;
  if (!Number.isInteger(activityLimit) || activityLimit < 1 || activityLimit > 100) {
    throw new ProjectTaskValidationError();
  }
  if (!await lockReadableProject(tx, ctx.workspaceId, projectId)) return null;
  return queryProjectTaskPageProjection(tx, ctx, projectId, {
    archived,
    taskCursor,
    includeActivity: true,
    activityCursor: activityCursorResult?.data ?? null,
    activityLimit,
  });
}

export async function getProjectActivityPage(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  input: { cursor?: ProjectActivityCursor | null; limit?: number } = {},
): Promise<ProjectActivityPageV1 | null> {
  requireActivityRead(ctx);
  if (!await lockReadableProject(tx, ctx.workspaceId, projectId)) return null;
  const cursorResult = input.cursor == null
    ? null
    : activityCursorSchema.safeParse(input.cursor);
  if (cursorResult !== null && !cursorResult.success) throw new ProjectTaskValidationError();
  const limit = input.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ProjectTaskValidationError();
  }
  const cursor = cursorResult?.data ?? null;
  const cursorFilter = cursor === null
    ? sql``
    : sql`and (event.occurred_at, event.id) < (${cursor.occurredAt}::timestamptz, ${cursor.id}::uuid)`;
  const result = await tx.execute<ActivityRow>(sql`
    with activity_event_window as materialized (
      select event.id, event.event_type, event.occurred_at,
             event.actor, event.payload, event.workspace_id, event.aggregate_id
        from domain_events event
       where event.workspace_id = ${ctx.workspaceId}::uuid
         and event.aggregate_type = 'project'
         and event.aggregate_id = ${projectId}::uuid
         and event.event_type in (
           'project.task_created', 'project.task_updated',
           'project.task_checklist_changed', 'project.task_completed',
           'project.task_reopened', 'project.task_archived'
         )
         and pg_catalog.pg_input_is_valid(event.payload->>'taskId', 'uuid')
         ${cursorFilter}
       order by event.occurred_at desc, event.id desc
       limit ${limit + 1}
    )
    select event.id, event.event_type,
           to_char(
             event.occurred_at at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
           ) as occurred_at,
           coalesce(identity_record.email, 'System') as actor_label,
           event.payload->'taskId' as task_id,
           activity_task.title as task_title
      from activity_event_window event
      left join user_identity identity_record
        on identity_record.id = case
             when pg_catalog.pg_input_is_valid(event.actor, 'uuid')
             then event.actor::uuid
             else null::uuid
           end
      left join project_task activity_task
        on activity_task.workspace_id = event.workspace_id
       and activity_task.project_id = event.aggregate_id
       and activity_task.id = (event.payload->>'taskId')::uuid
     order by event.occurred_at desc, event.id desc
  `);
  const pageRows = result.rows.slice(0, limit);
  const parsedRows = pageRows.map((row) => {
    const parsed = projectedActivityRowSchema.safeParse(row);
    if (!parsed.success) throw new ProjectTaskValidationError();
    return parsed.data;
  });
  return activityPageFromRows(parsedRows, result.rows.length > limit);
}

export async function searchProjectTaskMembers(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  input: ProjectTaskMemberSearchV1,
): Promise<ProjectTaskMemberSearchPageV1 | null> {
  requireTaskWrite(ctx);
  const parsed = projectTaskMemberSearchV1Schema.safeParse(input);
  if (!parsed.success) throw new ProjectTaskValidationError();
  if (!await lockReadableProject(tx, ctx.workspaceId, projectId)) return null;
  const result = await tx.execute<{
    membershipId: unknown;
    label: unknown;
    [key: string]: unknown;
  }>(sql`
    select membership_record.id as "membershipId",
           identity_record.email as label
      from membership membership_record
      join user_identity identity_record
        on identity_record.id = membership_record.user_id
     where membership_record.workspace_id = ${ctx.workspaceId}::uuid
       and membership_record.role in ('viewer', 'editor', 'admin')
       and jsonb_typeof(membership_record.capabilities) = 'object'
       and not exists (
         select 1
           from jsonb_each(membership_record.capabilities) as capability(key, value)
          where jsonb_typeof(capability.value) <> 'boolean'
       )
       and (
         not (membership_record.capabilities ? 'external_only')
         or membership_record.capabilities->'external_only'
              is not distinct from 'false'::jsonb
       )
       and position(lower(${parsed.data.query}) in lower(identity_record.email)) > 0
     order by
       case when position(lower(${parsed.data.query}) in lower(identity_record.email)) = 1
            then 0 else 1 end,
       lower(identity_record.email), membership_record.id
     limit ${PROJECT_TASK_MEMBER_SEARCH_LIMIT + 1}
  `);
  const members = result.rows.slice(0, PROJECT_TASK_MEMBER_SEARCH_LIMIT).map((row) => {
    const member = projectedMemberSchema.safeParse(row);
    if (!member.success) throw new ProjectTaskValidationError();
    return member.data;
  });
  return {
    schemaVersion: "project-task-member-search-page.v1",
    query: parsed.data.query,
    members,
    hasMore: result.rows.length > PROJECT_TASK_MEMBER_SEARCH_LIMIT,
  };
}

async function insertAssignees(
  tx: TenantTx,
  workspaceId: string,
  taskId: string,
  membershipIds: readonly string[],
): Promise<void> {
  if (membershipIds.length === 0) return;
  const rows = membershipIds.map((membershipId) => sql`(
    ${randomUUID()}::uuid, ${workspaceId}::uuid, ${taskId}::uuid,
    ${membershipId}::uuid
  )`);
  await tx.execute(sql`
    insert into project_task_assignee (id, workspace_id, task_id, membership_id)
    values ${sql.join(rows, sql`, `)}
  `);
}

async function insertChecklist(
  tx: TenantTx,
  workspaceId: string,
  taskId: string,
  items: ReadonlyArray<{ id?: string | null; text: string; done: boolean }>,
): Promise<void> {
  if (items.length === 0) return;
  const rows = items.map((item, position) => sql`(
    ${item.id ?? randomUUID()}::uuid, ${workspaceId}::uuid, ${taskId}::uuid,
    ${position}, ${item.text}, ${item.done}
  )`);
  await tx.execute(sql`
    insert into project_task_checklist_item (
      id, workspace_id, task_id, position, text, is_done
    ) values ${sql.join(rows, sql`, `)}
  `);
}

async function insertLabels(
  tx: TenantTx,
  workspaceId: string,
  taskId: string,
  labels: ReadonlyArray<{ id?: string | null; name: string; color: TaskLabelColor }>,
): Promise<void> {
  if (labels.length === 0) return;
  const rows = labels.map((label, position) => sql`(
    ${label.id ?? randomUUID()}::uuid, ${workspaceId}::uuid, ${taskId}::uuid,
    ${position}, ${label.name}, ${label.color}
  )`);
  await tx.execute(sql`
    insert into project_task_label (
      id, workspace_id, task_id, position, name, color
    ) values ${sql.join(rows, sql`, `)}
  `);
}

async function emitTaskEvidence(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    projectId: string;
    taskId: string;
    revision: number;
    kind: ProjectTaskCommandV1["kind"];
    eventType: keyof typeof activityKinds;
    changedKeys?: readonly string[];
    counts?: { assignees: number; checklist: number; labels: number };
  },
): Promise<void> {
  const evidence = {
    projectId: input.projectId,
    taskId: input.taskId,
    revision: input.revision,
    kind: input.kind,
    ...(input.changedKeys ? { changedKeys: [...input.changedKeys].sort() } : {}),
    ...(input.counts ? { counts: input.counts } : {}),
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
    action: "task.write",
    resource: "project_task",
    allowed: true,
    details: evidence,
  });
}

async function createTask(
  tx: TenantTx,
  ctx: ServiceCtx,
  command: Extract<ProjectTaskCommandV1, { kind: "quick_create" | "create" }>,
): Promise<ProjectTaskCommandResult> {
  await lockProject(tx, ctx.workspaceId, command.projectId);
  await lockWorkspace(tx, ctx.workspaceId);
  const taskId = randomUUID();
  const quick = command.kind === "quick_create";
  const membershipIds = quick
    ? [await actorMembershipId(tx, ctx)]
    : [...command.assigneeMembershipIds].sort();
  if (!quick) {
    await validateInternalMembershipsUnderWorkspaceLock(
      tx,
      ctx.workspaceId,
      membershipIds,
    );
  }
  const body = quick ? EMPTY_TASK_RICH_TEXT_V1 : command.body;
  const dueDate = quick ? null : command.dueDate;
  await tx.execute(sql`
    insert into project_task (
      id, workspace_id, project_id, title, body_version, body, due_at,
      status, revision, created_by, updated_by
    ) values (
      ${taskId}::uuid, ${ctx.workspaceId}::uuid, ${command.projectId}::uuid,
      ${command.title}, 'task-rich-text.v1', ${JSON.stringify(body.doc)}::jsonb,
      ${dueAtExpression(dueDate)}, 'open', 1, ${ctx.actor}::uuid, ${ctx.actor}::uuid
    )
  `);
  await insertAssignees(tx, ctx.workspaceId, taskId, membershipIds);
  const checklist = quick ? [] : command.checklist;
  const labels = quick ? [] : command.labels;
  await insertChecklist(tx, ctx.workspaceId, taskId, checklist);
  await insertLabels(tx, ctx.workspaceId, taskId, labels);
  await emitTaskEvidence(tx, ctx, {
    projectId: command.projectId,
    taskId,
    revision: 1,
    kind: command.kind,
    eventType: "project.task_created",
    counts: {
      assignees: membershipIds.length,
      checklist: checklist.length,
      labels: labels.length,
    },
  });
  return { projectId: command.projectId, taskId, revision: 1, changed: true };
}

async function lockTask(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  taskId: string,
): Promise<TaskRow> {
  const result = await tx.execute<TaskRow>(sql`
    select id, revision, title, body_version, body, due_at,
           case when due_at is null then null
                else to_char(due_at at time zone 'Europe/Berlin', 'YYYY-MM-DD')
            end as due_date,
           status, completed_at, archived_at
      from project_task
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
       and id = ${taskId}::uuid
     for update
  `);
  const row = result.rows[0];
  if (!row) throw new ProjectTaskNotFoundError();
  return row;
}

function requireRevision(task: TaskRow, expectedRevision: number): void {
  if (task.revision !== expectedRevision) {
    throw new ProjectTaskConflictError(task.revision);
  }
  if (task.revision >= PROJECT_TASK_MAX_REVISION) {
    throw new ProjectTaskConflictError(task.revision);
  }
}

function requireActive(task: TaskRow): void {
  if (task.archived_at !== null) throw new ProjectTaskArchivedError();
}

async function currentAssigneeIds(
  tx: TenantTx,
  ctx: ServiceCtx,
  taskId: string,
  lock = false,
): Promise<string[]> {
  const suffix = lock ? sql`for update` : sql``;
  const result = await tx.execute<{ membership_id: string; [key: string]: unknown }>(sql`
    select membership_id
      from project_task_assignee
     where workspace_id = ${ctx.workspaceId}::uuid
       and task_id = ${taskId}::uuid
     order by membership_id
     ${suffix}
  `);
  return result.rows.map(({ membership_id: id }) => id);
}

async function currentChecklist(
  tx: TenantTx,
  ctx: ServiceCtx,
  taskId: string,
): Promise<ChecklistRow[]> {
  const result = await tx.execute<ChecklistRow>(sql`
    select task_id, id, position, text, is_done
      from project_task_checklist_item
     where workspace_id = ${ctx.workspaceId}::uuid
       and task_id = ${taskId}::uuid
     order by position, id
     for update
  `);
  return result.rows;
}

async function currentLabels(
  tx: TenantTx,
  ctx: ServiceCtx,
  taskId: string,
): Promise<LabelRow[]> {
  const result = await tx.execute<LabelRow>(sql`
    select task_id, id, position, name, color
      from project_task_label
     where workspace_id = ${ctx.workspaceId}::uuid
       and task_id = ${taskId}::uuid
     order by position, id
     for update
  `);
  return result.rows;
}

async function reviseTask(
  tx: TenantTx,
  ctx: ServiceCtx,
  command: Extract<ProjectTaskCommandV1, { kind: "update" }>,
): Promise<ProjectTaskCommandResult> {
  await lockProject(tx, ctx.workspaceId, command.projectId);
  await lockWorkspace(tx, ctx.workspaceId);
  const task = await lockTask(tx, ctx, command.projectId, command.taskId);
  requireRevision(task, command.expectedRevision);
  requireActive(task);
  const existingAssigneeIds = await currentAssigneeIds(tx, ctx, task.id, true);
  await validateInternalMembershipsUnderWorkspaceLock(
    tx,
    ctx.workspaceId,
    command.assigneeMembershipIds,
  );
  const checklist = await currentChecklist(tx, ctx, task.id);
  const labels = await currentLabels(tx, ctx, task.id);
  const existingChecklistIds = new Set(checklist.map(({ id }) => id));
  const existingLabelIds = new Set(labels.map(({ id }) => id));
  if (command.checklist.some(({ id }) => id !== null && !existingChecklistIds.has(id))) {
    throw new ProjectTaskNotFoundError();
  }
  if (command.labels.some(({ id }) => id !== null && !existingLabelIds.has(id))) {
    throw new ProjectTaskNotFoundError();
  }

  const changeKeys: string[] = [];
  if (task.title !== command.title) changeKeys.push("title");
  if (!isDeepStrictEqual(task.body, command.body.doc)) changeKeys.push("body");
  if (task.due_date !== command.dueDate) changeKeys.push("dueDate");
  const targetAssignees = [...command.assigneeMembershipIds].sort();
  if (!isDeepStrictEqual(existingAssigneeIds, targetAssignees)) changeKeys.push("assignees");
  const targetChecklist = command.checklist.map((item, position) => ({
    id: item.id,
    position,
    text: item.text,
    done: item.done,
  }));
  const existingChecklist = checklist.map((item) => ({
    id: item.id,
    position: item.position,
    text: item.text,
    done: item.is_done,
  }));
  if (!isDeepStrictEqual(existingChecklist, targetChecklist)) changeKeys.push("checklist");
  const targetLabels = command.labels.map((item, position) => ({
    id: item.id,
    position,
    name: item.name,
    color: item.color,
  }));
  const existingLabels = labels.map((item) => ({
    id: item.id,
    position: item.position,
    name: item.name,
    color: item.color,
  }));
  if (!isDeepStrictEqual(existingLabels, targetLabels)) changeKeys.push("labels");
  if (changeKeys.length === 0) {
    return {
      projectId: command.projectId,
      taskId: task.id,
      revision: task.revision,
      changed: false,
    };
  }

  const updated = await tx.execute<{ revision: number; [key: string]: unknown }>(sql`
    update project_task
       set title = ${command.title},
           body_version = 'task-rich-text.v1',
           body = ${JSON.stringify(command.body.doc)}::jsonb,
           due_at = ${dueAtExpression(command.dueDate)},
           revision = revision + 1,
           updated_by = ${ctx.actor}::uuid,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
       and id = ${task.id}::uuid
       and revision = ${command.expectedRevision}
       and archived_at is null
     returning revision
  `);
  const revision = updated.rows[0]?.revision;
  if (!revision) throw new ProjectTaskConflictError();
  await tx.execute(sql`
    delete from project_task_assignee
     where workspace_id = ${ctx.workspaceId}::uuid and task_id = ${task.id}::uuid
  `);
  await tx.execute(sql`
    delete from project_task_checklist_item
     where workspace_id = ${ctx.workspaceId}::uuid and task_id = ${task.id}::uuid
  `);
  await tx.execute(sql`
    delete from project_task_label
     where workspace_id = ${ctx.workspaceId}::uuid and task_id = ${task.id}::uuid
  `);
  await insertAssignees(tx, ctx.workspaceId, task.id, targetAssignees);
  await insertChecklist(tx, ctx.workspaceId, task.id, command.checklist);
  await insertLabels(tx, ctx.workspaceId, task.id, command.labels);
  await emitTaskEvidence(tx, ctx, {
    projectId: command.projectId,
    taskId: task.id,
    revision,
    kind: command.kind,
    eventType: "project.task_updated",
    changedKeys: changeKeys,
    counts: {
      assignees: targetAssignees.length,
      checklist: command.checklist.length,
      labels: command.labels.length,
    },
  });
  return { projectId: command.projectId, taskId: task.id, revision, changed: true };
}

async function mutateTaskState(
  tx: TenantTx,
  ctx: ServiceCtx,
  command: Exclude<ProjectTaskCommandV1, { kind: "quick_create" | "create" | "update" }>,
): Promise<ProjectTaskCommandResult> {
  await lockProject(tx, ctx.workspaceId, command.projectId);
  await lockWorkspace(tx, ctx.workspaceId);
  const task = await lockTask(tx, ctx, command.projectId, command.taskId);
  requireRevision(task, command.expectedRevision);
  requireActive(task);

  let eventType: keyof typeof activityKinds;
  if (command.kind === "toggle_checklist_item") {
    const item = await tx.execute<{
      id: string;
      is_done: boolean;
      [key: string]: unknown;
    }>(sql`
      select id, is_done
        from project_task_checklist_item
       where workspace_id = ${ctx.workspaceId}::uuid
         and task_id = ${task.id}::uuid
         and id = ${command.checklistItemId}::uuid
       for update
    `);
    const current = item.rows[0];
    if (!current) throw new ProjectTaskNotFoundError();
    if (current.is_done === command.done) {
      return {
        projectId: command.projectId,
        taskId: task.id,
        revision: task.revision,
        changed: false,
      };
    }
    const updated = await tx.execute<{ revision: number; [key: string]: unknown }>(sql`
      update project_task
         set revision = revision + 1, updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and project_id = ${command.projectId}::uuid
         and id = ${task.id}::uuid
         and revision = ${command.expectedRevision}
         and archived_at is null
       returning revision
    `);
    const revision = updated.rows[0]?.revision;
    if (!revision) throw new ProjectTaskConflictError();
    await tx.execute(sql`
      update project_task_checklist_item
         set is_done = ${command.done}, updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and task_id = ${task.id}::uuid
         and id = ${current.id}::uuid
    `);
    eventType = "project.task_checklist_changed";
    await emitTaskEvidence(tx, ctx, {
      projectId: command.projectId,
      taskId: task.id,
      revision,
      kind: command.kind,
      eventType,
      changedKeys: ["checklist"],
    });
    return { projectId: command.projectId, taskId: task.id, revision, changed: true };
  }

  if (command.kind === "archive") {
    const updated = await tx.execute<{ revision: number; [key: string]: unknown }>(sql`
      update project_task
         set archived_at = statement_timestamp(), revision = revision + 1,
             updated_by = ${ctx.actor}::uuid, updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and project_id = ${command.projectId}::uuid
         and id = ${task.id}::uuid
         and revision = ${command.expectedRevision}
         and archived_at is null
       returning revision
    `);
    const revision = updated.rows[0]?.revision;
    if (!revision) throw new ProjectTaskConflictError();
    eventType = "project.task_archived";
    await emitTaskEvidence(tx, ctx, {
      projectId: command.projectId,
      taskId: task.id,
      revision,
      kind: command.kind,
      eventType,
      changedKeys: ["archived"],
    });
    return { projectId: command.projectId, taskId: task.id, revision, changed: true };
  }

  const targetStatus = command.kind === "complete" ? "done" : "open";
  if (task.status === targetStatus) {
    return {
      projectId: command.projectId,
      taskId: task.id,
      revision: task.revision,
      changed: false,
    };
  }
  const updated = await tx.execute<{ revision: number; [key: string]: unknown }>(sql`
    update project_task
       set status = ${targetStatus},
           completed_at = case when ${targetStatus} = 'done'
                               then statement_timestamp() else null end,
           revision = revision + 1,
           updated_by = ${ctx.actor}::uuid,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
       and id = ${task.id}::uuid
       and revision = ${command.expectedRevision}
       and archived_at is null
     returning revision
  `);
  const revision = updated.rows[0]?.revision;
  if (!revision) throw new ProjectTaskConflictError();
  eventType = command.kind === "complete"
    ? "project.task_completed"
    : "project.task_reopened";
  await emitTaskEvidence(tx, ctx, {
    projectId: command.projectId,
    taskId: task.id,
    revision,
    kind: command.kind,
    eventType,
    changedKeys: ["status"],
  });
  return { projectId: command.projectId, taskId: task.id, revision, changed: true };
}

export async function executeProjectTaskCommand(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ProjectTaskCommandV1,
): Promise<ProjectTaskCommandResult> {
  requireTaskWrite(ctx);
  const parsed = projectTaskCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new ProjectTaskValidationError();
  const command = parsed.data;
  if (command.kind === "quick_create" || command.kind === "create") {
    return createTask(tx, ctx, command);
  }
  if (command.kind === "update") return reviseTask(tx, ctx, command);
  return mutateTaskState(tx, ctx, command);
}
