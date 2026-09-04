import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  calendarItemV1Schema,
  projectAppointmentCommandV1Schema,
  projectAppointmentItemV1Schema,
  projectAppointmentRangeV1Schema,
  type CalendarItemV1,
  type ProjectAppointmentCommandV1,
  type ProjectAppointmentCommandResult,
  type ProjectAppointmentRangeV1,
} from "@/lib/integrations/calendar/contract";
import {
  AppointmentConflictError,
  AppointmentNotFoundError,
  AppointmentValidationError,
} from "./errors";

const BERLIN_TIMESTAMP = 'YYYY-MM-DD"T"HH24:MI:SS.MS';

// M1-15b §7 Sichtbarkeit (Kimi-P3-1: ein Fragment statt drei Kopien):
// tenancy für alle internen Rollen, user für Owner (Membership des Actors)
// + Admin, client nie. Aktive-Kalender-Filter bleibt Aufrufersache.
function calendarVisibleFragment(ctx: ServiceCtx) {
  return sql`
    calendar_record.calendar_type <> 'client'
    and (
      calendar_record.calendar_type = 'tenancy'
      or (
        calendar_record.calendar_type = 'user'
        and calendar_record.membership_id = (
          select membership_record.id
            from membership membership_record
           where membership_record.workspace_id = ${ctx.workspaceId}::uuid
             and membership_record.user_id = ${ctx.actor}::uuid
           limit 1
        )
      )
      or ${ctx.role === "admin"}
    )
  `;
}

type AppointmentRow = {
  id: string;
  revision: number;
  title: string;
  description: string | null;
  location: string | null;
  start_iso: string;
  end_iso: string;
  all_day: boolean;
  appointment_type: string;
  calendar_id: string;
  calendar_name: string | null;
  calendar_color: string | null;
  attendees: unknown;
  [key: string]: unknown;
};

type CalendarRow = {
  id: string;
  name: string;
  color: string | null;
  calendar_type: string;
  category_id: string | null;
  category_name: string | null;
  [key: string]: unknown;
};

function requireAppointmentRead(ctx: ServiceCtx): void {
  if (!can(ctx, "appointment.read")) {
    throw new PermissionDeniedError("appointment.read", "project_appointment", undefined, ctx.actor);
  }
}

function requireAppointmentWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "appointment.write")) {
    throw new PermissionDeniedError("appointment.write", "project_appointment", undefined, ctx.actor);
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
       and public._m115_actor_can_read_appointments(project_record.workspace_id)
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
  if (!result.rows[0]) throw new AppointmentNotFoundError();

  // Zweites READ-COMMITTED-Statement: gewinnt die Erasure zuerst, wartet der
  // Project-Lock oben auf ihren Commit; erst der frische Snapshot entscheidet.
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
  if (!activeSubject.rows[0]) throw new AppointmentNotFoundError();
}

async function lockAppointment(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  appointmentId: string,
): Promise<{ id: string; revision: number }> {
  const result = await tx.execute<{ id: string; revision: number; [key: string]: unknown }>(sql`
    select id, revision
      from project_appointment
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
       and id = ${appointmentId}::uuid
     for update
  `);
  const row = result.rows[0];
  if (!row) throw new AppointmentNotFoundError();
  return row;
}

async function validateAttendeeMemberships(
  tx: TenantTx,
  workspaceId: string,
  membershipIds: readonly string[],
): Promise<void> {
  const expected = [...new Set(membershipIds)];
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
  `);
  if (result.rows.length !== expected.length) throw new AppointmentNotFoundError();
}


// PostgreSQL-CHECK- (23514) und FK- (23503) Fehler werden explizit auf
// `invalid`/`not_found` gemappt, statt als unbekannter Fehler durchzuschlagen.
// Die Drizzle-Wrapperfehler tragen die echte Postgres-Meldung in `.cause`.
function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

// M1-15b §6: calendar_id muss für den Actor SICHTBAR und active=true sein,
// sonst `invalid` (keine Existenz-/Scope-Leaks).
async function validateCalendar(
  tx: TenantTx,
  ctx: ServiceCtx,
  calendarId: string,
): Promise<void> {
  const result = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select calendar_record.id
      from calendar calendar_record
     where calendar_record.workspace_id = ${ctx.workspaceId}::uuid
       and calendar_record.id = ${calendarId}::uuid
       and calendar_record.active = true
       and ${calendarVisibleFragment(ctx)}
      for share
  `);
  if (result.rows.length !== 1) throw new AppointmentValidationError();
}

async function mapAppointmentMutationError(error: unknown): Promise<never> {
  const code = postgresErrorCode(error);
  if (code === "23514") throw new AppointmentValidationError();
  if (code === "23503") throw new AppointmentNotFoundError();
  throw error;
}

function requireRevision(currentRevision: number, expectedRevision: number): void {
  if (currentRevision !== expectedRevision) {
    throw new AppointmentConflictError(currentRevision);
  }
}

type AppointmentEventType =
  | "project.appointment_created"
  | "project.appointment_updated"
  | "project.appointment_deleted";

async function emitAppointmentEvidence(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    projectId: string;
    appointmentId: string;
    revision: number;
    eventType: AppointmentEventType;
  },
): Promise<void> {
  const evidence = {
    projectId: input.projectId,
    appointmentId: input.appointmentId,
    revision: input.revision,
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
    action: "appointment.write",
    resource: "project_appointment",
    allowed: true,
    details: evidence,
  });
}

async function syncAttendees(
  tx: TenantTx,
  ctx: ServiceCtx,
  appointmentId: string,
  membershipIds: readonly string[],
): Promise<void> {
  await tx.execute(sql`
    delete from project_appointment_attendee
     where workspace_id = ${ctx.workspaceId}::uuid
       and appointment_id = ${appointmentId}::uuid
  `);
  if (membershipIds.length === 0) return;
  const values = membershipIds.map((membershipId) => ({
    id: randomUUID(),
    workspaceId: ctx.workspaceId,
    appointmentId,
    membershipId,
  }));
  for (const value of values) {
    await tx.execute(sql`
      insert into project_appointment_attendee (
        id, workspace_id, appointment_id, membership_id
      ) values (
        ${value.id}::uuid, ${value.workspaceId}::uuid,
        ${value.appointmentId}::uuid, ${value.membershipId}::uuid
      )
    `);
  }
}

async function createAppointment(
  tx: TenantTx,
  ctx: ServiceCtx,
  command: Extract<ProjectAppointmentCommandV1, { kind: "create_appointment" }>,
): Promise<ProjectAppointmentCommandResult> {
  await lockProject(tx, ctx.workspaceId, command.projectId);
  await validateAttendeeMemberships(tx, ctx.workspaceId, command.attendeeMembershipIds);
  await validateCalendar(tx, ctx, command.calendarId);
  const appointmentId = randomUUID();
  try {
    await tx.execute(sql`
      insert into project_appointment (
        id, workspace_id, project_id, title, description, location,
        start_at, end_at, all_day, appointment_type, calendar_id,
        revision, created_by
      ) values (
        ${appointmentId}::uuid, ${ctx.workspaceId}::uuid, ${command.projectId}::uuid,
        ${command.title},
        ${command.description},
        ${command.location},
        ${command.start}::timestamp at time zone 'Europe/Berlin',
        ${command.end}::timestamp at time zone 'Europe/Berlin',
        ${command.allDay}, ${command.type},
        ${command.calendarId},
        1, ${ctx.actor}::uuid
      )
    `);
  } catch (error) {
    await mapAppointmentMutationError(error);
  }
  await syncAttendees(tx, ctx, appointmentId, command.attendeeMembershipIds);
  await emitAppointmentEvidence(tx, ctx, {
    projectId: command.projectId,
    appointmentId,
    revision: 1,
    eventType: "project.appointment_created",
  });
  return { projectId: command.projectId, appointmentId, revision: 1, changed: true };
}

async function updateAppointment(
  tx: TenantTx,
  ctx: ServiceCtx,
  command: Extract<ProjectAppointmentCommandV1, { kind: "update_appointment" }>,
): Promise<ProjectAppointmentCommandResult> {
  await lockProject(tx, ctx.workspaceId, command.projectId);
  const appointment = await lockAppointment(
    tx, ctx, command.projectId, command.appointmentId,
  );
  requireRevision(appointment.revision, command.expectedRevision);
  await validateAttendeeMemberships(tx, ctx.workspaceId, command.attendeeMembershipIds);
  await validateCalendar(tx, ctx, command.calendarId);

  let revision: number | undefined;
  try {
    const updated = await tx.execute<{ revision: number; [key: string]: unknown }>(sql`
      update project_appointment
         set title = ${command.title},
             description = ${command.description},
             location = ${command.location},
             start_at = ${command.start}::timestamp at time zone 'Europe/Berlin',
             end_at = ${command.end}::timestamp at time zone 'Europe/Berlin',
             all_day = ${command.allDay},
             appointment_type = ${command.type},
             calendar_id = ${command.calendarId},
             revision = revision + 1,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and project_id = ${command.projectId}::uuid
         and id = ${command.appointmentId}::uuid
         and revision = ${command.expectedRevision}
       returning revision
    `);
    revision = updated.rows[0]?.revision;
  } catch (error) {
    await mapAppointmentMutationError(error);
  }
  if (!revision) throw new AppointmentConflictError();
  await syncAttendees(tx, ctx, command.appointmentId, command.attendeeMembershipIds);
  await emitAppointmentEvidence(tx, ctx, {
    projectId: command.projectId,
    appointmentId: command.appointmentId,
    revision,
    eventType: "project.appointment_updated",
  });
  return {
    projectId: command.projectId,
    appointmentId: command.appointmentId,
    revision,
    changed: true,
  };
}

async function deleteAppointment(
  tx: TenantTx,
  ctx: ServiceCtx,
  command: Extract<ProjectAppointmentCommandV1, { kind: "delete_appointment" }>,
): Promise<ProjectAppointmentCommandResult> {
  await lockProject(tx, ctx.workspaceId, command.projectId);
  const appointment = await lockAppointment(
    tx, ctx, command.projectId, command.appointmentId,
  );
  requireRevision(appointment.revision, command.expectedRevision);

  const deleted = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    delete from project_appointment
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
       and id = ${command.appointmentId}::uuid
       and revision = ${command.expectedRevision}
     returning id
  `);
  if (!deleted.rows[0]) throw new AppointmentConflictError();
  await emitAppointmentEvidence(tx, ctx, {
    projectId: command.projectId,
    appointmentId: command.appointmentId,
    revision: command.expectedRevision,
    eventType: "project.appointment_deleted",
  });
  return {
    projectId: command.projectId,
    appointmentId: command.appointmentId,
    revision: command.expectedRevision,
    changed: true,
  };
}

export async function executeProjectAppointmentCommand(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ProjectAppointmentCommandV1,
): Promise<ProjectAppointmentCommandResult> {
  requireAppointmentWrite(ctx);
  const parsed = projectAppointmentCommandV1Schema.safeParse(input);
  if (!parsed.success) throw new AppointmentValidationError();
  const command = parsed.data;
  if (command.kind === "create_appointment") return createAppointment(tx, ctx, command);
  if (command.kind === "update_appointment") return updateAppointment(tx, ctx, command);
  return deleteAppointment(tx, ctx, command);
}

export async function listProjectAppointments(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  options: {
    rangeStart: string;
    rangeEnd: string;
    view: "month" | "week" | "list";
  },
): Promise<ProjectAppointmentRangeV1 | null> {
  requireAppointmentRead(ctx);
  if (!await lockReadableProject(tx, ctx.workspaceId, projectId)) return null;

  const appointments = await tx.execute<AppointmentRow>(sql`
    select appointment_record.id,
           appointment_record.revision,
           appointment_record.title,
           appointment_record.description,
           appointment_record.location,
           to_char(
             appointment_record.start_at at time zone 'Europe/Berlin',
             ${BERLIN_TIMESTAMP}
           ) as start_iso,
           to_char(
             appointment_record.end_at at time zone 'Europe/Berlin',
             ${BERLIN_TIMESTAMP}
           ) as end_iso,
           appointment_record.all_day,
           appointment_record.appointment_type,
           appointment_record.calendar_id,
           calendar_record.name as calendar_name,
           calendar_record.color as calendar_color,
           coalesce((
             select jsonb_agg(
               jsonb_build_object(
                 'membershipId', attendee.membership_id,
                 'label', identity_record.email
               ) order by lower(identity_record.email), attendee.membership_id
             )
               from project_appointment_attendee attendee
               join membership membership_record
                 on membership_record.workspace_id = attendee.workspace_id
                and membership_record.id = attendee.membership_id
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
              where attendee.workspace_id = ${ctx.workspaceId}::uuid
                and attendee.appointment_id = appointment_record.id
           ), '[]'::jsonb) as attendees
      from project_appointment appointment_record
      left join calendar calendar_record
        on calendar_record.workspace_id = appointment_record.workspace_id
       and calendar_record.id = appointment_record.calendar_id
       and ${calendarVisibleFragment(ctx)}
     where appointment_record.workspace_id = ${ctx.workspaceId}::uuid
       and appointment_record.project_id = ${projectId}::uuid
       and appointment_record.start_at < (${options.rangeEnd}::timestamp at time zone 'Europe/Berlin')
       and appointment_record.end_at > (${options.rangeStart}::timestamp at time zone 'Europe/Berlin')
     order by appointment_record.start_at asc,
              appointment_record.end_at asc,
              appointment_record.id asc
  `);

  const calendars = await tx.execute<CalendarRow>(sql`
    select calendar_record.id,
           calendar_record.name,
           calendar_record.color,
           calendar_record.calendar_type,
           calendar_record.category_id,
           category_record.name as category_name
      from calendar calendar_record
      left join calendar_category category_record
        on category_record.workspace_id = calendar_record.workspace_id
       and category_record.id = calendar_record.category_id
     where calendar_record.workspace_id = ${ctx.workspaceId}::uuid
       and calendar_record.active = true
       and ${calendarVisibleFragment(ctx)}
     order by calendar_record.calendar_type asc,
              calendar_record.name asc,
              calendar_record.id asc
  `);

  const members = await tx.execute<{ membershipId: string; label: string; [key: string]: unknown }>(sql`
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
         or membership_record.capabilities->'external_only' is not distinct from 'false'::jsonb
       )
     order by lower(identity_record.email), membership_record.id
     limit 200
  `);

  return projectAppointmentRangeV1Schema.parse({
    schemaVersion: "project-appointment-range.v1",
    projectId,
    permissions: { canWrite: can(ctx, "appointment.write") },
    rangeStart: options.rangeStart,
    rangeEnd: options.rangeEnd,
    view: options.view,
    items: appointments.rows.map((row) => projectAppointmentItemV1Schema.parse({
      id: row.id,
      revision: row.revision,
      title: row.title,
      description: row.description,
      location: row.location,
      start: row.start_iso,
      end: row.end_iso,
      allDay: row.all_day,
      type: row.appointment_type,
      calendarId: row.calendar_id,
      calendarName: row.calendar_name,
      calendarColor: row.calendar_color,
      attendees: row.attendees,
    })),
    calendars: calendars.rows.map((row) => ({
      id: row.id,
      name: row.name,
      color: row.color,
      type: row.calendar_type,
      categoryId: row.category_id,
      categoryName: row.category_name,
    })),
    members: members.rows.map((row) => ({
      membershipId: row.membershipId,
      label: row.label,
    })),
  });
}

// ═══════════════════════════════════════════════════════════════════════
// M1-15b: Kalender-Verwaltung (Spec §6/§7)
// ═══════════════════════════════════════════════════════════════════════

export const CALENDAR_SCOPE_TYPES = ["team", "tenancy", "user", "client"] as const;

function requireCalendarRead(ctx: ServiceCtx): void {
  if (!can(ctx, "calendar.read")) {
    throw new PermissionDeniedError("calendar.read", "calendar", undefined, ctx.actor);
  }
}

function requireCalendarWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "calendar.write")) {
    throw new PermissionDeniedError("calendar.write", "calendar", undefined, ctx.actor);
  }
}

// Sichtbarkeit (Spec §7, DECIDED WMEE): tenancy für alle internen Rollen,
// user für Owner + Admin, team strukturell (später), client nie.
export async function listVisibleCalendars(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<CalendarItemV1[]> {
  requireCalendarRead(ctx);
  const result = await tx.execute<CalendarRow>(sql`
    select calendar_record.id,
           calendar_record.name,
           calendar_record.color,
           calendar_record.calendar_type,
           calendar_record.category_id,
           category_record.name as category_name
      from calendar calendar_record
      left join calendar_category category_record
        on category_record.workspace_id = calendar_record.workspace_id
       and category_record.id = calendar_record.category_id
     where calendar_record.workspace_id = ${ctx.workspaceId}::uuid
       and calendar_record.active = true
       and ${calendarVisibleFragment(ctx)}
     order by calendar_record.calendar_type asc,
              calendar_record.name asc,
              calendar_record.id asc
  `);
  return result.rows.map((row) => calendarItemV1Schema.parse({
    id: row.id,
    name: row.name,
    color: row.color,
    type: row.calendar_type,
    categoryId: row.category_id,
    categoryName: row.category_name,
  }));
}

// Lazy Auto-Provisionierung des persönlichen Kalenders je Membership
// (Spec §6, DEC-M115B-17: Name „Persönlich — <E-Mail>", da user_identity
// keine Anzeigenamen führt).
export async function ensurePersonalCalendar(
  tx: TenantTx,
  ctx: ServiceCtx,
  membershipId: string,
): Promise<string> {
  const existing = await tx.execute<{ id: string }>(sql`
    select id from calendar
     where workspace_id = ${ctx.workspaceId}::uuid
       and membership_id = ${membershipId}::uuid
       and calendar_type = 'user'
     limit 1
  `);
  if (existing.rows[0]) return existing.rows[0].id;

  const member = await tx.execute<{ email: string }>(sql`
    select identity_record.email
      from membership membership_record
      join user_identity identity_record
        on identity_record.id = membership_record.user_id
     where membership_record.workspace_id = ${ctx.workspaceId}::uuid
       and membership_record.id = ${membershipId}::uuid
     limit 1
  `);
  if (!member.rows[0]) throw new AppointmentNotFoundError();

  const calendarId = randomUUID();
  // Kimi-P2-2/P2-3: Race-sicher — parallele Erst-Provisionierungen kollidieren
  // am partial-unique (membership) oder am Namens-Unique; dann re-selectieren
  // wir strikt über die MEMBERSHIP (nie über den Namen).
  try {
    await tx.execute(sql`
      insert into calendar (
        id, workspace_id, name, calendar_type, membership_id, created_by
      ) values (
        ${calendarId}::uuid, ${ctx.workspaceId}::uuid,
        ${`Persönlich — ${member.rows[0].email}`}, 'user',
        ${membershipId}::uuid, ${ctx.actor}::uuid
      )
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code !== "23505") throw error;
    const winner = await tx.execute<{ id: string }>(sql`
      select id from calendar
       where workspace_id = ${ctx.workspaceId}::uuid
         and membership_id = ${membershipId}::uuid
         and calendar_type = 'user'
       limit 1
    `);
    if (winner.rows[0]) return winner.rows[0].id;
    throw error;
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "calendar",
    aggregateId: calendarId,
    eventType: "calendar.created",
    actor: ctx.actor,
    payload: { calendarType: "user", membershipId },
  });
  return calendarId;
}

export async function createTenancyCalendar(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { name: string; color?: string | null },
): Promise<CalendarItemV1> {
  requireCalendarWrite(ctx);
  const name = input.name.normalize("NFKC").trim();
  if (name.length < 1 || name.length > 200) throw new AppointmentValidationError();
  if (input.color !== undefined && input.color !== null
      && !/^#[0-9a-fA-F]{6}$/u.test(input.color)) {
    throw new AppointmentValidationError();
  }
  const calendarId = randomUUID();
  await tx.execute(sql`
    insert into calendar (
      id, workspace_id, name, color, calendar_type, created_by
    ) values (
      ${calendarId}::uuid, ${ctx.workspaceId}::uuid,
      ${name}, ${input.color ?? null}, 'tenancy', ${ctx.actor}::uuid
    )
  `);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "calendar",
    aggregateId: calendarId,
    eventType: "calendar.created",
    actor: ctx.actor,
    payload: { calendarType: "tenancy" },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "calendar.write",
    resource: "calendar",
    allowed: true,
    details: { calendarId, name },
  });
  return calendarItemV1Schema.parse({
    id: calendarId, name, color: input.color ?? null, type: "tenancy",
    categoryId: null, categoryName: null,
  });
}

export async function archiveCalendar(
  tx: TenantTx,
  ctx: ServiceCtx,
  calendarId: string,
): Promise<void> {
  requireCalendarWrite(ctx);
  // Kimi-P1-2: persönliche Kalender sind membership-verwaltet und NICHT
  // archivierbar (sonst dead-end: partial-unique verhindert Re-Provision,
  // validateCalendar blockiert jede Terminanlage des Owners).
  const target = await tx.execute<{ calendar_type: string }>(sql`
    select calendar_type from calendar
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${calendarId}::uuid
     limit 1
  `);
  if (!target.rows[0]) throw new AppointmentNotFoundError();
  if (target.rows[0].calendar_type === "user") throw new AppointmentValidationError();
  const updated = await tx.execute(sql`
    update calendar
       set active = false,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${calendarId}::uuid
       and active = true
       and calendar_type in ('tenancy', 'team')
     returning id
  `);
  if (!updated.rows[0]) throw new AppointmentNotFoundError();
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "calendar.write",
    resource: "calendar",
    allowed: true,
    details: { calendarId, archived: true },
  });
}
