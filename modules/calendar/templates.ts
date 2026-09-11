// F16-05 Termin-Vorlagen — Template-CRUD + Anwenden je Projekt.
// Kein "server-only" (konsistent mit Tasks-/Time-Modulen).
// Keine neuen Permissions: appointment.read/appointment.write.
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  PROJECT_APPOINTMENT_COMMAND_VERSION,
  addBerlinWallClockMinutes,
} from "@/lib/integrations/calendar/contract";
import {
  APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
  applyAppointmentTemplateCommandSchema,
  archiveAppointmentTemplateCommandSchema,
  createAppointmentTemplateCommandSchema,
  appointmentTemplateDtoSchema,
  updateAppointmentTemplateCommandSchema,
  type ApplyAppointmentTemplateCommand,
  type AppointmentTemplateDto,
  type ArchiveAppointmentTemplateCommand,
  type CreateAppointmentTemplateCommand,
  type UpdateAppointmentTemplateCommand,
} from "@/lib/integrations/calendar/template-contract";
import {
  AppointmentNotFoundError,
  AppointmentTemplateConflictError,
  AppointmentTemplateNotFoundError,
  AppointmentTemplateValidationError,
  AppointmentValidationError,
} from "./errors";
import { executeProjectAppointmentCommand } from "./service";

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "appointment.read")) {
    throw new PermissionDeniedError("appointment.read", "appointment_template", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "appointment.write")) {
    throw new PermissionDeniedError("appointment.write", "appointment_template", undefined, ctx.actor);
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

export function normalizeAppointmentTemplateName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

type TemplateRow = {
  id: string;
  name: string;
  title: string;
  duration_minutes: number;
  position: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const TEMPLATE_SELECT = sql`
  select id, name, title, duration_minutes,
         position, active, created_at, updated_at
    from appointment_template
`;

function toDto(row: TemplateRow, canWrite: boolean): AppointmentTemplateDto {
  return appointmentTemplateDtoSchema.parse({
    schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    title: row.title,
    durationMinutes: row.duration_minutes,
    position: row.position,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

export async function listAppointmentTemplates(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { includeArchived?: boolean } = {},
): Promise<AppointmentTemplateDto[]> {
  requireRead(ctx);
  const includeArchived = query.includeArchived === true;
  const result = await tx.execute<TemplateRow>(sql`
    ${TEMPLATE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     ${includeArchived ? sql`` : sql`and active = true`}
   order by position asc, name asc, id asc
  `);
  const write = can(ctx, "appointment.write");
  return result.rows.map((row) => toDto(row, write));
}

export async function createAppointmentTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateAppointmentTemplateCommand,
): Promise<AppointmentTemplateDto> {
  requireWrite(ctx);
  const parsed = createAppointmentTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new AppointmentTemplateValidationError();
  const command = parsed.data;

  let row: TemplateRow;
  try {
    const inserted = await tx.execute<TemplateRow>(sql`
      insert into appointment_template (
        workspace_id, name, name_normalized, title, duration_minutes,
        position, created_by
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.name},
        ${normalizeAppointmentTemplateName(command.name)},
        ${command.title},
        ${command.durationMinutes},
        ${command.position ?? 0},
        ${ctx.actor}::uuid
      )
      returning id, name, title, duration_minutes,
                position, active, created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new AppointmentTemplateConflictError();
    if (code === "23514") throw new AppointmentTemplateValidationError();
    throw error;
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "appointment_template",
    aggregateId: row.id,
    eventType: "appointment_template.created",
    actor: ctx.actor,
    payload: { name: command.name },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "appointment_template.write",
    resource: "appointment_template",
    allowed: true,
    details: { name: command.name },
  });
  return toDto(row, true);
}

export async function updateAppointmentTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdateAppointmentTemplateCommand,
): Promise<AppointmentTemplateDto> {
  requireWrite(ctx);
  const parsed = updateAppointmentTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new AppointmentTemplateValidationError();
  const command = parsed.data;

  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update appointment_template
         set name = ${command.name},
             name_normalized = ${normalizeAppointmentTemplateName(command.name)},
             title = ${command.title},
             duration_minutes = ${command.durationMinutes},
             position = ${command.position},
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
      returning id, name, title, duration_minutes,
                position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new AppointmentTemplateConflictError();
    if (code === "23514") throw new AppointmentTemplateValidationError();
    throw error;
  }
  if (!rows[0]) throw new AppointmentTemplateNotFoundError();
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "appointment_template",
    aggregateId: command.id,
    eventType: "appointment_template.updated",
    actor: ctx.actor,
    payload: { name: command.name },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "appointment_template.write",
    resource: "appointment_template",
    allowed: true,
    details: { id: command.id },
  });
  return toDto(rows[0], true);
}

async function setTemplateActive(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveAppointmentTemplateCommand,
): Promise<AppointmentTemplateDto> {
  requireWrite(ctx);
  const parsed = archiveAppointmentTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new AppointmentTemplateValidationError();
  const command = parsed.data;
  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update appointment_template
         set active = ${command.active},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
         and active is distinct from ${command.active}
      returning id, name, title, duration_minutes,
                position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new AppointmentTemplateConflictError();
    if (code === "23514") throw new AppointmentTemplateValidationError();
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
    if (!current.rows[0]) throw new AppointmentTemplateNotFoundError();
    return toDto(current.rows[0], true);
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "appointment_template",
    aggregateId: command.id,
    eventType: command.active ? "appointment_template.restored" : "appointment_template.archived",
    actor: ctx.actor,
    payload: {},
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "appointment_template.write",
    resource: "appointment_template",
    allowed: true,
    details: { id: command.id, active: command.active },
  });
  return toDto(row, true);
}

export function archiveAppointmentTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveAppointmentTemplateCommand,
): Promise<AppointmentTemplateDto> {
  return setTemplateActive(tx, ctx, { ...input, active: false });
}

export function restoreAppointmentTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveAppointmentTemplateCommand,
): Promise<AppointmentTemplateDto> {
  return setTemplateActive(tx, ctx, { ...input, active: true });
}

// Vorlage im Projekt anwenden: Termin mit Titel-Preset, Ende = Start +
// Dauer (Berliner Wanduhr, DST-Lücke fail-closed). Nur aktive Vorlagen;
// Kalender-/Projektsperren meldet der Appointment-Pfad selbst.
export async function applyAppointmentTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ApplyAppointmentTemplateCommand,
): Promise<{ projectId: string; appointmentId: string; revision: number; templateId: string }> {
  requireWrite(ctx);
  const parsed = applyAppointmentTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new AppointmentTemplateValidationError();
  const command = parsed.data;
  const found = await tx.execute<TemplateRow>(sql`
    ${TEMPLATE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     and id = ${command.templateId}::uuid
     and active = true
   limit 1
  `);
  const template = found.rows[0];
  if (!template) throw new AppointmentTemplateNotFoundError();
  const end = addBerlinWallClockMinutes(command.start, template.duration_minutes);
  if (end === null) throw new AppointmentTemplateValidationError();
  try {
    const created = await executeProjectAppointmentCommand(tx, ctx, {
      schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
      kind: "create_appointment",
      projectId: command.projectId,
      title: template.title,
      start: command.start,
      end,
      allDay: false,
      type: "other",
      location: null,
      description: null,
      attendeeMembershipIds: [],
      calendarId: command.calendarId,
      // F1-12: Vorlagen-Termine ohne Team (explizit, strictObject).
      teamId: null,
    });
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "appointment_template",
      aggregateId: template.id,
      eventType: "appointment_template.applied",
      actor: ctx.actor,
      payload: { projectId: created.projectId, appointmentId: created.appointmentId },
    });
    return { ...created, templateId: template.id };
  } catch (error) {
    if (error instanceof AppointmentValidationError) throw new AppointmentTemplateValidationError();
    if (error instanceof AppointmentNotFoundError) throw new AppointmentTemplateNotFoundError();
    throw error;
  }
}
