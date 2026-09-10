// F16-04 Aufgaben-Vorlagen — Template-CRUD + Anwenden je Projekt.
// Kein "server-only" (konsistent mit Checklisten-/Time-Modulen).
// Keine neuen Permissions: task.read/task.write.
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { EMPTY_TASK_RICH_TEXT_V1 } from "@/lib/integrations/tasks/contract";
import {
  TASK_TEMPLATE_SCHEMA_VERSION,
  applyTaskTemplateCommandSchema,
  archiveTaskTemplateCommandSchema,
  createTaskTemplateCommandSchema,
  taskTemplateDtoSchema,
  updateTaskTemplateCommandSchema,
  type ApplyTaskTemplateCommand,
  type ArchiveTaskTemplateCommand,
  type CreateTaskTemplateCommand,
  type TaskTemplateDto,
  type UpdateTaskTemplateCommand,
} from "@/lib/integrations/tasks/template-contract";
import {
  TaskTemplateConflictError,
  TaskTemplateNotFoundError,
  TaskTemplateValidationError,
} from "./errors";
import { actorMembershipId, executeProjectTaskCommand } from "./service";
import { PROJECT_TASK_COMMAND_VERSION } from "@/lib/integrations/tasks/contract";

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "task.read")) {
    throw new PermissionDeniedError("task.read", "task_template", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "task.write")) {
    throw new PermissionDeniedError("task.write", "task_template", undefined, ctx.actor);
  }
}

function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

export function normalizeTaskTemplateName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

// Fälligkeit ab heute (Europe/Berlin) plus Offset als Kalendertag.
export function berlinDatePlusDays(offsetDays: number, now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = parts.split("-").map(Number);
  const shifted = new Date(Date.UTC(year!, month! - 1, day!) + offsetDays * 86_400_000);
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

type TemplateRow = {
  id: string;
  name: string;
  title: string;
  due_offset_days: number | null;
  position: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const TEMPLATE_SELECT = sql`
  select id, name, title, due_offset_days,
         position, active, created_at, updated_at
    from task_template
`;

function toDto(row: TemplateRow, canWrite: boolean): TaskTemplateDto {
  return taskTemplateDtoSchema.parse({
    schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    title: row.title,
    dueOffsetDays: row.due_offset_days,
    position: row.position,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

export async function listTaskTemplates(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { includeArchived?: boolean } = {},
): Promise<TaskTemplateDto[]> {
  requireRead(ctx);
  const includeArchived = query.includeArchived === true;
  const result = await tx.execute<TemplateRow>(sql`
    ${TEMPLATE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     ${includeArchived ? sql`` : sql`and active = true`}
   order by position asc, name asc, id asc
  `);
  const write = can(ctx, "task.write");
  return result.rows.map((row) => toDto(row, write));
}

export async function createTaskTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateTaskTemplateCommand,
): Promise<TaskTemplateDto> {
  requireWrite(ctx);
  const parsed = createTaskTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new TaskTemplateValidationError();
  const command = parsed.data;

  let row: TemplateRow;
  try {
    const inserted = await tx.execute<TemplateRow>(sql`
      insert into task_template (
        workspace_id, name, name_normalized, title, due_offset_days,
        position, created_by
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.name},
        ${normalizeTaskTemplateName(command.name)},
        ${command.title},
        ${command.dueOffsetDays ?? null},
        ${command.position ?? 0},
        ${ctx.actor}::uuid
      )
      returning id, name, title, due_offset_days,
                position, active, created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new TaskTemplateConflictError();
    if (code === "23514") throw new TaskTemplateValidationError();
    throw error;
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "task_template",
    aggregateId: row.id,
    eventType: "task_template.created",
    actor: ctx.actor,
    payload: { name: command.name },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "task_template.write",
    resource: "task_template",
    allowed: true,
    details: { name: command.name },
  });
  return toDto(row, true);
}

export async function updateTaskTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdateTaskTemplateCommand,
): Promise<TaskTemplateDto> {
  requireWrite(ctx);
  const parsed = updateTaskTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new TaskTemplateValidationError();
  const command = parsed.data;

  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update task_template
         set name = ${command.name},
             name_normalized = ${normalizeTaskTemplateName(command.name)},
             title = ${command.title},
             due_offset_days = ${command.dueOffsetDays ?? null},
             position = ${command.position},
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
      returning id, name, title, due_offset_days,
                position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new TaskTemplateConflictError();
    if (code === "23514") throw new TaskTemplateValidationError();
    throw error;
  }
  if (!rows[0]) throw new TaskTemplateNotFoundError();
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "task_template",
    aggregateId: command.id,
    eventType: "task_template.updated",
    actor: ctx.actor,
    payload: { name: command.name },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "task_template.write",
    resource: "task_template",
    allowed: true,
    details: { id: command.id },
  });
  return toDto(rows[0], true);
}

async function setTemplateActive(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveTaskTemplateCommand,
): Promise<TaskTemplateDto> {
  requireWrite(ctx);
  const parsed = archiveTaskTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new TaskTemplateValidationError();
  const command = parsed.data;
  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update task_template
         set active = ${command.active},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
         and active is distinct from ${command.active}
      returning id, name, title, due_offset_days,
                position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new TaskTemplateConflictError();
    if (code === "23514") throw new TaskTemplateValidationError();
    throw error;
  }
  const row = rows[0];
  if (!row) {
    const current = await tx.execute<TemplateRow>(sql`
      ${TEMPLATE_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.id}::uuid
     limit 1
    `);
    if (!current.rows[0]) throw new TaskTemplateNotFoundError();
    return toDto(current.rows[0], true);
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "task_template",
    aggregateId: command.id,
    eventType: command.active ? "task_template.restored" : "task_template.archived",
    actor: ctx.actor,
    payload: {},
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "task_template.write",
    resource: "task_template",
    allowed: true,
    details: { id: command.id, active: command.active },
  });
  return toDto(row, true);
}

export function archiveTaskTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveTaskTemplateCommand,
): Promise<TaskTemplateDto> {
  return setTemplateActive(tx, ctx, { ...input, active: false });
}

export function restoreTaskTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveTaskTemplateCommand,
): Promise<TaskTemplateDto> {
  return setTemplateActive(tx, ctx, { ...input, active: true });
}

// Vorlage im Projekt anwenden: Aufgabe mit Titel-Preset, Fälligkeit
// heute + Offset (oder leer), Bearbeiter = Anwendender. Nur aktive
// Vorlagen; Projekt sperrt executeProjectTaskCommand selbst.
export async function applyTaskTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ApplyTaskTemplateCommand,
): Promise<{ projectId: string; taskId: string; revision: number; templateId: string }> {
  requireWrite(ctx);
  const parsed = applyTaskTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new TaskTemplateValidationError();
  const command = parsed.data;
  const found = await tx.execute<TemplateRow>(sql`
    ${TEMPLATE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     and id = ${command.templateId}::uuid
     and active = true
   limit 1
  `);
  const template = found.rows[0];
  if (!template) throw new TaskTemplateNotFoundError();
  const dueDate = template.due_offset_days === null
    ? null
    : berlinDatePlusDays(template.due_offset_days);
  const created = await executeProjectTaskCommand(tx, ctx, {
    schemaVersion: PROJECT_TASK_COMMAND_VERSION,
    kind: "create",
    projectId: command.projectId,
    title: template.title,
    body: EMPTY_TASK_RICH_TEXT_V1,
    dueDate,
    assigneeMembershipIds: [await actorMembershipId(tx, ctx)],
    checklist: [],
    labels: [],
  });
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "task_template",
    aggregateId: template.id,
    eventType: "task_template.applied",
    actor: ctx.actor,
    payload: { projectId: created.projectId, taskId: created.taskId },
  });
  return { ...created, templateId: template.id };
}
