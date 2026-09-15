// F16-04 Aufgaben-Vorlagen — Template-CRUD + Anwenden je Projekt.
// Kein "server-only" (konsistent mit Checklisten-/Time-Modulen).
// Keine neuen Permissions: task.read/task.write.
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  EMPTY_TASK_RICH_TEXT_V1,
  PROJECT_TASK_MEMBER_SEARCH_LIMIT,
  projectTaskMemberSearchV1Schema,
  type ProjectTaskMemberOptionV1,
  type ProjectTaskMemberSearchPageV1,
  type ProjectTaskMemberSearchV1,
} from "@/lib/integrations/tasks/contract";
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
  type TaskTemplateLabelItem,
  type UpdateTaskTemplateCommand,
} from "@/lib/integrations/tasks/template-contract";
import { taskLabelColors } from "@/lib/integrations/tasks/contract";
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
  assignee_membership_ids: string[] | null;
  checklist_items: unknown;
  label_items: unknown;
  position: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const TEMPLATE_SELECT = sql`
  select id, name, title, due_offset_days,
         assignee_membership_ids, checklist_items, label_items,
         position, active, created_at, updated_at
    from task_template
`;

// F16-04d: gespeicherte Checklisten-Texte lesen (DB-Check sichert Array;
// fremde Formen entfallen defensiv — Schreiben validiert strikt).
function storedChecklistItems(value: unknown): { text: string }[] {
  if (!Array.isArray(value)) return [];
  const items: { text: string }[] = [];
  for (const entry of value) {
    if (
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
      && typeof (entry as { text?: unknown }).text === "string"
    ) {
      const text = ((entry as { text: string }).text as string).trim();
      if (text.length >= 1 && text.length <= 500) items.push({ text });
    }
  }
  return items;
}

function checklistJsonLiteral(items: readonly { text: string }[]) {
  return sql`${JSON.stringify(items.map((item) => ({ text: item.text })))}::jsonb`;
}

// F16-04e: gespeicherte Label-Inhalte lesen (DB-Check sichert Array;
// fremde Formen entfallen defensiv — Schreiben validiert strikt).
// Farbe fällt bei unbekanntem Wert auf "slate" (Legacy-Toleranz,
// Schreiben kennt nur die sechs Farben).
const LABEL_COLORS = new Set<string>(taskLabelColors);
function storedLabelItems(value: unknown): TaskTemplateLabelItem[] {
  if (!Array.isArray(value)) return [];
  const items: TaskTemplateLabelItem[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const record = entry as { name?: unknown; color?: unknown };
    if (typeof record.name !== "string") continue;
    const name = record.name.normalize("NFKC").trim();
    if (name.length < 1 || name.length > 40) continue;
    if (/[\u0000-\u001f\u007f-\u009f]/u.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const color = typeof record.color === "string" && LABEL_COLORS.has(record.color)
      ? (record.color as TaskTemplateLabelItem["color"])
      : "slate";
    items.push({ name, color });
  }
  return items;
}

function labelJsonLiteral(items: readonly TaskTemplateLabelItem[]) {
  return sql`${JSON.stringify(items.map((item) => ({ name: item.name, color: item.color })))}::jsonb`;
}

async function resolveAssigneeOptions(
  tx: TenantTx,
  workspaceId: string,
  membershipIds: readonly string[],
): Promise<{ live: { membershipId: string; label: string }[]; departedIds: string[] }> {
  const ids = [...new Set(membershipIds)];
  if (ids.length === 0) return { live: [], departedIds: [] };
  const result = await tx.execute<{ membershipId: string; label: string }>(sql`
    select membership_record.id as "membershipId",
           identity_record.email as label
      from membership membership_record
      join user_identity identity_record
        on identity_record.id = membership_record.user_id
     where membership_record.workspace_id = ${workspaceId}::uuid
       and membership_record.id in (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
  `);
  const byId = new Map(result.rows.map((row) => [row.membershipId, row.label]));
  // Vorlagen-Reihenfolge bleibt; Ausgeschiedene stehen separat (F16-04c,
  // sichtbar ohne Label — kein PII-Lookup an Nicht-Mitglieder).
  const live: { membershipId: string; label: string }[] = [];
  const departedIds: string[] = [];
  for (const id of ids) {
    const label = byId.get(id);
    if (label === undefined) departedIds.push(id);
    else live.push({ membershipId: id, label });
  }
  return { live, departedIds };
}

async function toDto(
  tx: TenantTx,
  workspaceId: string,
  row: TemplateRow,
  canWrite: boolean,
): Promise<TaskTemplateDto> {
  const assigneeMembershipIds = [...new Set(row.assignee_membership_ids ?? [])];
  const resolved = await resolveAssigneeOptions(tx, workspaceId, assigneeMembershipIds);
  return taskTemplateDtoSchema.parse({
    schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    title: row.title,
    dueOffsetDays: row.due_offset_days,
    assigneeMembershipIds,
    assignees: resolved.live,
    departedAssigneeMembershipIds: resolved.departedIds,
    checklistItems: storedChecklistItems(row.checklist_items),
    labelItems: storedLabelItems(row.label_items),
    position: row.position,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

// F16-04b: JS-Arrays rendert drizzle als Record — explizites
// UUID-Array-Literal (leere Liste als '{}' mit Cast).
function uuidArrayLiteral(values: readonly string[]) {
  if (values.length === 0) return sql`'{}'::uuid[]`;
  return sql`ARRAY[${sql.join(values.map((id) => sql`${id}::uuid`), sql`, `)}]`;
}

// F16-04b: Bearbeiter-IDs müssen interne Workspace-Memberships sein
// (gleiche Prädikate wie der Task-Validator; fail-closed ohne Orakel).
// Ohne Workspace-Lock wie der F7.3-Komponenten-Check — ausgeschiedene
// IDs filtert das Anwenden tolerant heraus (s. applyTaskTemplate).
async function selectLiveAssigneeIds(
  tx: TenantTx,
  workspaceId: string,
  membershipIds: readonly string[],
): Promise<string[]> {
  const expected = [...new Set(membershipIds)];
  if (expected.length === 0) return [];
  const result = await tx.execute<{ id: string }>(sql`
    select id
      from membership
     where workspace_id = ${workspaceId}::uuid
       and id in (${sql.join(expected.map((id) => sql`${id}::uuid`), sql`, `)})
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
  `);
  return result.rows.map((row) => row.id);
}

async function validateTemplateAssignees(
  tx: TenantTx,
  workspaceId: string,
  membershipIds: readonly string[],
): Promise<void> {
  const expected = [...new Set(membershipIds)];
  const live = await selectLiveAssigneeIds(tx, workspaceId, expected);
  if (live.length !== expected.length) throw new TaskTemplateValidationError();
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
  return Promise.all(result.rows.map((row) => toDto(tx, ctx.workspaceId, row, write)));
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
  const assignees = [...new Set(command.assigneeMembershipIds ?? [])];
  await validateTemplateAssignees(tx, ctx.workspaceId, assignees);
  const checklist = command.checklistItems ?? [];
  const labels = command.labelItems ?? [];

  let row: TemplateRow;
  try {
    const inserted = await tx.execute<TemplateRow>(sql`
      insert into task_template (
        workspace_id, name, name_normalized, title, due_offset_days,
        assignee_membership_ids, checklist_items, label_items, position, created_by
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.name},
        ${normalizeTaskTemplateName(command.name)},
        ${command.title},
        ${command.dueOffsetDays ?? null},
        ${uuidArrayLiteral(assignees)},
        ${checklistJsonLiteral(checklist)},
        ${labelJsonLiteral(labels)},
        ${command.position ?? 0},
        ${ctx.actor}::uuid
      )
      returning id, name, title, due_offset_days, assignee_membership_ids,
                checklist_items, label_items, position, active, created_at, updated_at
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
  return toDto(tx, ctx.workspaceId, row, true);
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
  const assignees = [...new Set(command.assigneeMembershipIds ?? [])];
  // F16-04c: Ausgeschiedene bleiben gespeichert (Werterhalt statt stillem
  // Purgen). Lebende strikt validieren; der Rest muss bereits gespeicherte
  // Ausgeschiedene sein — Neuzugang fremder IDs bleibt Validation (kein
  // Einschleusen über den Update-Pfad).
  const current = await tx.execute<{ assignee_membership_ids: string[] | null }>(sql`
    select assignee_membership_ids
      from task_template
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.id}::uuid
  `);
  const currentRow = current.rows[0];
  if (!currentRow) throw new TaskTemplateNotFoundError();
  const stored = new Set(currentRow.assignee_membership_ids ?? []);
  const live = await selectLiveAssigneeIds(tx, ctx.workspaceId, assignees);
  await validateTemplateAssignees(tx, ctx.workspaceId, live);
  const liveSet = new Set(live);
  for (const id of assignees) {
    if (!liveSet.has(id) && !stored.has(id)) throw new TaskTemplateValidationError();
  }

  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update task_template
         set name = ${command.name},
             name_normalized = ${normalizeTaskTemplateName(command.name)},
             title = ${command.title},
             due_offset_days = ${command.dueOffsetDays ?? null},
             assignee_membership_ids = ${uuidArrayLiteral(assignees)},
             checklist_items = ${checklistJsonLiteral(command.checklistItems ?? [])},
             label_items = ${labelJsonLiteral(command.labelItems ?? [])},
             position = ${command.position},
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
      returning id, name, title, due_offset_days, assignee_membership_ids,
                checklist_items, label_items, position, active, created_at, updated_at
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
  return toDto(tx, ctx.workspaceId, rows[0], true);
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
    return toDto(tx, ctx.workspaceId, current.rows[0], true);
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
  return toDto(tx, ctx.workspaceId, row, true);
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
  // F16-04b: gespeicherte Bearbeiter gegen aktuelle Memberships auflösen;
  // Ausgeschiedene entfallen still, leer = Anwender-Fallback wie bisher.
  const storedAssignees = [...new Set(template.assignee_membership_ids ?? [])];
  const resolved = storedAssignees.length === 0
    ? []
    : (await tx.execute<{ id: string }>(sql`
      select id
        from membership
       where workspace_id = ${ctx.workspaceId}::uuid
         and id in (${sql.join(storedAssignees.map((id) => sql`${id}::uuid`), sql`, `)})
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
    `)).rows.map((row) => row.id);
  const validAssignees = storedAssignees.filter((id) => resolved.includes(id));
  const assigneeMembershipIds = validAssignees.length === 0
    ? [await actorMembershipId(tx, ctx)]
    : validAssignees;
  // F16-04d: Vorlagen-Checkliste wird unerledigt übernommen (Reihenfolge
  // stabil; Texte sind schreibseitig validiert — Anwenden scheitert nie
  // an der eigenen Vorlage).
  const checklist = storedChecklistItems(template.checklist_items)
    .map((item) => ({ text: item.text, done: false }));
  // F16-04e: Vorlagen-Labels werden als Task-Labels übernommen (Name +
  // Farbe 1:1, IDs/Positionen vergibt die Task-Anlage; Texte sind
  // schreibseitig validiert — Anwenden scheitert nie an der Vorlage).
  const labels = storedLabelItems(template.label_items)
    .map((item) => ({ name: item.name, color: item.color }));
  const created = await executeProjectTaskCommand(tx, ctx, {
    schemaVersion: PROJECT_TASK_COMMAND_VERSION,
    kind: "create",
    projectId: command.projectId,
    title: template.title,
    body: EMPTY_TASK_RICH_TEXT_V1,
    dueDate,
    assigneeMembershipIds,
    checklist,
    labels,
  });
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "task_template",
    aggregateId: template.id,
    eventType: "task_template.applied",
    actor: ctx.actor,
    payload: { projectId: created.projectId, taskId: created.taskId, assigneeCount: assigneeMembershipIds.length, checklistCount: checklist.length, labelCount: labels.length },
  });
  return { ...created, templateId: template.id };
}

// F16-04b: workspace-weite Mitgliedersuche für die Vorlagen-Verwaltung
// (task.write-Gate wie die Projektsuche; Query ≥ 2 Zeichen und gleiches
// Limit — keine Voll-Enumeration, kein PII-Mehr gegenüber der
// Projektsuche; listTeamMemberOptions bleibt settings.manage).
export async function searchTaskTemplateMembers(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ProjectTaskMemberSearchV1,
): Promise<ProjectTaskMemberSearchPageV1> {
  requireWrite(ctx);
  const parsed = projectTaskMemberSearchV1Schema.safeParse(input);
  if (!parsed.success) throw new TaskTemplateValidationError();
  const result = await tx.execute<{ membershipId: string; label: string }>(sql`
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
  const members: ProjectTaskMemberOptionV1[] = result.rows
    .slice(0, PROJECT_TASK_MEMBER_SEARCH_LIMIT)
    .map((row) => ({ membershipId: row.membershipId, label: row.label }));
  return {
    schemaVersion: "project-task-member-search-page.v1",
    query: parsed.data.query,
    members,
    hasMore: result.rows.length > PROJECT_TASK_MEMBER_SEARCH_LIMIT,
  };
}
