// Hinweis: KEIN "server-only"-Import — konsistent mit modules/lead-sources:
// der Projekt-Seitengraph wird von Build-/Route-Importtests geladen.
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  TIME_TRACKING_SCHEMA_VERSION,
  createTimeEntryCommandSchema,
  createTimeEventTypeCommandSchema,
  stopTimeEntryCommandSchema,
  timeEntryDtoSchema,
  timeEntryExportResultSchema,
  timeEntryListDtoSchema,
  timeEntryListQuerySchema,
  startTimeEntryCommandWithGpsSchema,
  timeEntryRevisionDtoSchema,
  timeEntryRevisionListDtoSchema,
  timeEntryRevisionListQuerySchema,
  timeMemberOptionSchema,
  timeUtilizationDtoSchema,
  timeEventTypeDtoSchema,
  updateTimeEntryCommandSchema,
  updateTimeEventTypeCommandSchema,
  type CreateTimeEntryCommand,
  type CreateTimeEventTypeCommand,
  type StartTimeEntryCommand,
  type StopTimeEntryCommand,
  type TimeEntryDto,
  type TimeEntryExportResult,
  type TimeEntryListDto,
  type TimeEntryRevisionDto,
  type TimeEntryRevisionListDto,
  type TimeMemberOption,
  type TimeUtilizationDto,
  type TimeEventTypeDto,
  type UpdateTimeEntryCommand,
  type UpdateTimeEventTypeCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  TimeTrackingConflictError,
  TimeTrackingNotFoundError,
  TimeTrackingValidationError,
} from "./errors";

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "time.read")) {
    throw new PermissionDeniedError("time.read", "time_tracking", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "time.write")) {
    throw new PermissionDeniedError("time.write", "time_tracking", undefined, ctx.actor);
  }
}

export function normalizeTimeName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

async function writeAuditFor(
  tx: TenantTx,
  ctx: ServiceCtx,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action,
    resource: "time_tracking",
    allowed: true,
    details,
  });
}

// ═════════════════════════════ Event-Typen ═════════════════════════════

type EventTypeRow = {
  id: string;
  name: string;
  position: number;
  text_color: string | null;
  background_color: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

function toEventTypeDto(row: EventTypeRow, canWrite: boolean): TimeEventTypeDto {
  return timeEventTypeDtoSchema.parse({
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    position: row.position,
    textColor: row.text_color,
    backgroundColor: row.background_color,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

const EVENT_TYPE_SELECT = sql`
  select id, name, position, text_color, background_color, archived_at,
         created_at, updated_at
    from time_event_type
`;

export async function listTimeEventTypes(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { includeArchived?: boolean } = {},
): Promise<TimeEventTypeDto[]> {
  requireRead(ctx);
  const includeArchived = query.includeArchived === true;
  const result = await tx.execute<EventTypeRow>(sql`
    ${EVENT_TYPE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     ${includeArchived ? sql`` : sql`and archived_at is null`}
   order by position asc, name asc, id asc
  `);
  const canWrite = can(ctx, "time.write");
  return result.rows.map((row) => toEventTypeDto(row, canWrite));
}

export async function createTimeEventType(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateTimeEventTypeCommand,
): Promise<TimeEventTypeDto> {
  requireWrite(ctx);
  const parsed = createTimeEventTypeCommandSchema.safeParse(input);
  if (!parsed.success) throw new TimeTrackingValidationError();
  const command = parsed.data;
  const normalized = normalizeTimeName(command.name);

  let row: EventTypeRow;
  try {
    const inserted = await tx.execute<EventTypeRow>(sql`
      insert into time_event_type (
        workspace_id, name, name_normalized, position, text_color, background_color
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.name},
        ${normalized},
        ${command.position ?? 0},
        ${command.textColor ?? null},
        ${command.backgroundColor ?? null}
      )
      returning id, name, position, text_color, background_color, archived_at,
                created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new TimeTrackingConflictError(command.name);
    if (code === "23514") throw new TimeTrackingValidationError();
    throw error;
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "time_event_type",
    aggregateId: row.id,
    eventType: "time_event_type.created",
    actor: ctx.actor,
    payload: { name: command.name },
  });
  await writeAuditFor(tx, ctx, "time.event_type.create", { name: command.name });

  return toEventTypeDto(row, true);
}

export async function updateTimeEventType(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdateTimeEventTypeCommand,
): Promise<TimeEventTypeDto> {
  requireWrite(ctx);
  const parsed = updateTimeEventTypeCommandSchema.safeParse(input);
  if (!parsed.success) throw new TimeTrackingValidationError();
  const command = parsed.data;
  const normalized = normalizeTimeName(command.name);

  let rows: EventTypeRow[];
  try {
    const updated = await tx.execute<EventTypeRow>(sql`
      update time_event_type
         set name = ${command.name},
             name_normalized = ${normalized},
             position = ${command.position},
             text_color = ${command.textColor ?? null},
             background_color = ${command.backgroundColor ?? null},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
       returning id, name, position, text_color, background_color, archived_at,
                 created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new TimeTrackingConflictError(command.name);
    if (code === "23514") throw new TimeTrackingValidationError();
    throw error;
  }
  if (!rows[0]) throw new TimeTrackingNotFoundError("time_event_type", command.id);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "time_event_type",
    aggregateId: command.id,
    eventType: "time_event_type.updated",
    actor: ctx.actor,
    payload: { name: command.name },
  });
  await writeAuditFor(tx, ctx, "time.event_type.update", { id: command.id });

  return toEventTypeDto(rows[0], true);
}

async function setEventTypeArchived(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
  archived: boolean,
  action: "archive" | "restore",
): Promise<TimeEventTypeDto> {
  requireWrite(ctx);
  let rows: EventTypeRow[];
  try {
    const updated = await tx.execute<EventTypeRow>(sql`
      update time_event_type
         set archived_at = ${archived ? sql`statement_timestamp()` : sql`null`},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${id}::uuid
         and (${archived ? sql`archived_at is null` : sql`archived_at is not null`})
       returning id, name, position, text_color, background_color, archived_at,
                 created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new TimeTrackingConflictError(id);
    if (code === "23514") throw new TimeTrackingValidationError();
    throw error;
  }
  const row = rows[0];
  if (!row) {
    const current = await tx.execute<EventTypeRow>(sql`
      ${EVENT_TYPE_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id}::uuid
     limit 1
    `);
    if (!current.rows[0]) throw new TimeTrackingNotFoundError("time_event_type", id);
    return toEventTypeDto(current.rows[0], true);
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "time_event_type",
    aggregateId: id,
    eventType: archived ? "time_event_type.archived" : "time_event_type.restored",
    actor: ctx.actor,
    payload: {},
  });
  await writeAuditFor(tx, ctx, `time.event_type.${action}`, { id });

  return toEventTypeDto(row, true);
}

export function archiveTimeEventType(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<TimeEventTypeDto> {
  return setEventTypeArchived(tx, ctx, id, true, "archive");
}

export function restoreTimeEventType(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<TimeEventTypeDto> {
  return setEventTypeArchived(tx, ctx, id, false, "restore");
}

// ═════════════════════════════ Zeiteinträge ═════════════════════════════

type TimeEntryRow = {
  id: string;
  user_id: string;
  project_id: string;
  type_id: string | null;
  start_at: string;
  end_at: string | null;
  start_lat: number | null;
  start_lng: number | null;
  working_time_minutes: number | null;
  break_duration_minutes: number;
  comment: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

function toTimeEntryDto(row: TimeEntryRow, canWrite: boolean): TimeEntryDto {
  return timeEntryDtoSchema.parse({
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    id: row.id,
    userId: row.user_id,
    projectId: row.project_id,
    typeId: row.type_id,
    startAt: row.start_at,
    endAt: row.end_at,
    startLat: row.start_lat,
    startLng: row.start_lng,
    workingTimeMinutes: row.working_time_minutes,
    running: row.end_at === null && row.archived_at === null,
    breakDurationMinutes: row.break_duration_minutes,
    comment: row.comment,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

const ENTRY_SELECT = sql`
  select id, user_id, project_id, type_id, start_at, end_at,
         start_lat, start_lng,
         working_time_minutes, break_duration_minutes, comment, archived_at,
         created_at, updated_at
    from time_entry
`;

export async function listTimeMemberOptions(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<TimeMemberOption[]> {
  requireRead(ctx);
  const result = await tx.execute<{ user_id: string; label: string }>(sql`
    select membership_record.user_id, identity_record.email as label
      from membership membership_record
      join user_identity identity_record
        on identity_record.id = membership_record.user_id
     where membership_record.workspace_id = ${ctx.workspaceId}::uuid
     order by lower(identity_record.email), membership_record.user_id
     limit 200
  `);
  return timeMemberOptionSchema
    .array()
    .parse(result.rows.map((row) => ({ userId: row.user_id, label: row.label })));
}

export async function listTimeEntries(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string; includeArchived?: boolean; userIds?: string[] | null },
): Promise<TimeEntryListDto> {
  requireRead(ctx);
  const parsed = timeEntryListQuerySchema.safeParse(query);
  if (!parsed.success) throw new TimeTrackingValidationError();
  const includeArchived = parsed.data.includeArchived === true;
  const userIds = parsed.data.userIds ?? [];
  // F9.3-Fix: JS-Arrays werden hier NICHT als Postgres-Array serialisiert
  // (malformed array literal) — explizit als IN-Liste bauen (Muster
  // validateAttendeeMemberships).
  const userFilter = userIds.length === 0
    ? sql``
    : sql`and user_id in (${sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
  const result = await tx.execute<TimeEntryRow & { total: string }>(sql`
    select id, user_id, project_id, type_id, start_at, end_at,
           start_lat, start_lng,
           working_time_minutes, break_duration_minutes, comment, archived_at,
           created_at, updated_at,
           -- "total" = SUMME der Arbeitsminuten gestoppter Einträge
           -- (nicht Zeilenzahl; laufende Einträge zählen bewusst nicht;
           --  F9.3: Summe folgt dem userIds-Filter).
           (select coalesce(sum(working_time_minutes), 0)::text
              from time_entry total_entries
             where total_entries.workspace_id = ${ctx.workspaceId}::uuid
               and total_entries.project_id = ${parsed.data.projectId}::uuid
               and total_entries.archived_at is null
               and total_entries.end_at is not null
               ${userFilter}) as total
      from time_entry
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${parsed.data.projectId}::uuid
       ${includeArchived ? sql`` : sql`and archived_at is null`}
       ${userFilter}
     order by (end_at is null) desc, start_at desc, id asc
  `);
  const canWrite = can(ctx, "time.write");
  const entries = result.rows.map((row) => toTimeEntryDto(row, canWrite));
  const total = result.rows[0] ? Number(result.rows[0].total) : 0;
  return timeEntryListDtoSchema.parse({
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    entries,
    totalWorkingMinutes: total,
  });
}

async function upsertTimeEntry(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateTimeEntryCommand | UpdateTimeEntryCommand,
  mode: "create" | "update",
): Promise<TimeEntryDto> {
  requireWrite(ctx);
  const parsed = (mode === "create" ? createTimeEntryCommandSchema : updateTimeEntryCommandSchema)
    .safeParse(input);
  if (!parsed.success) throw new TimeTrackingValidationError();
  const command = parsed.data;
  const fields = command.fields;

  let rows: TimeEntryRow[];
  try {
    if (mode === "create") {
      const create = command as CreateTimeEntryCommand;
      const inserted = await tx.execute<TimeEntryRow>(sql`
        insert into time_entry (
          workspace_id, user_id, project_id, type_id, start_at, end_at,
          working_time_minutes, break_duration_minutes, comment, created_by
        ) values (
          ${ctx.workspaceId}::uuid,
          ${ctx.actor}::uuid,
          ${create.projectId}::uuid,
          ${fields.typeId ?? null}::uuid,
          ${new Date(fields.startAt).toISOString()}::timestamptz,
          ${new Date(fields.endAt).toISOString()}::timestamptz,
          ${fields.workingTimeMinutes},
          ${fields.breakDurationMinutes},
          ${fields.comment},
          ${ctx.actor}::uuid
        )
        returning id, user_id, project_id, type_id, start_at, end_at,
                  start_lat, start_lng,
                  working_time_minutes, break_duration_minutes, comment,
                  archived_at, created_at, updated_at
      `);
      rows = inserted.rows;
    } else {
      const update = command as UpdateTimeEntryCommand;
      // F9.4 Slice B: VOR dem UPDATE das Vorher-Bild als immutable Revision
      // sichern (gleiche Transaktion, gleicher Statement-Snapshot: old_entry
      // sieht garantiert den Stand vor dem Update). Kein Diff-Vergleich —
      // jeder Speichervorgang schreibt genau eine Revision (SPEC §2).
      // Trifft das UPDATE keine Zeile, sichert der JOIN bewusst nichts.
      const updated = await tx.execute<TimeEntryRow>(sql`
        with old_entry as (
          select id, user_id, project_id, type_id, start_at, end_at,
                 start_lat, start_lng,
                 working_time_minutes, break_duration_minutes, comment
            from time_entry
           where workspace_id = ${ctx.workspaceId}::uuid
             and id = ${update.id}::uuid
        ),
        updated as (
          update time_entry
             set type_id = ${fields.typeId ?? null}::uuid,
                 start_at = ${new Date(fields.startAt).toISOString()}::timestamptz,
                 end_at = ${new Date(fields.endAt).toISOString()}::timestamptz,
                 working_time_minutes = ${fields.workingTimeMinutes},
                 break_duration_minutes = ${fields.breakDurationMinutes},
                 comment = ${fields.comment},
                 updated_by = ${ctx.actor}::uuid,
                 updated_at = statement_timestamp()
           where workspace_id = ${ctx.workspaceId}::uuid
             and id = ${update.id}::uuid
          returning id, user_id, project_id, type_id, start_at, end_at,
                    start_lat, start_lng,
                    working_time_minutes, break_duration_minutes, comment,
                    archived_at, created_at, updated_at
        ),
        inserted_revision as (
          insert into time_entry_revision (
            workspace_id, entry_id, user_id, project_id, type_id, start_at,
            end_at, start_lat, start_lng,
            working_time_minutes, break_duration_minutes, comment,
            revised_by, revised_at
          )
          select ${ctx.workspaceId}::uuid, old_entry.id, old_entry.user_id,
                 old_entry.project_id, old_entry.type_id, old_entry.start_at,
                 old_entry.end_at, old_entry.start_lat, old_entry.start_lng,
                 old_entry.working_time_minutes,
                 old_entry.break_duration_minutes, old_entry.comment,
                 ${ctx.actor}::uuid, statement_timestamp()
            from old_entry
            join updated on updated.id = old_entry.id
        )
        select id, user_id, project_id, type_id, start_at, end_at,
               start_lat, start_lng,
               working_time_minutes, break_duration_minutes, comment,
               archived_at, created_at, updated_at
          from updated
      `);
      rows = updated.rows;
    }
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23503" || code === "23514") throw new TimeTrackingValidationError();
    throw error;
  }
  const row = rows[0];
  if (!row) {
    throw new TimeTrackingNotFoundError(
      "time_entry",
      mode === "create" ? (command as CreateTimeEntryCommand).projectId : (command as UpdateTimeEntryCommand).id,
    );
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "time_entry",
    aggregateId: row.id,
    eventType: mode === "create" ? "time_entry.created" : "time_entry.updated",
    actor: ctx.actor,
    payload: { projectId: row.project_id, workingTimeMinutes: row.working_time_minutes },
  });
  await writeAuditFor(tx, ctx, `time.entry.${mode}`, {
    id: row.id,
    projectId: row.project_id,
    workingTimeMinutes: row.working_time_minutes,
  });

  return toTimeEntryDto(row, true);
}

export function createTimeEntry(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateTimeEntryCommand,
): Promise<TimeEntryDto> {
  return upsertTimeEntry(tx, ctx, input, "create");
}

export function updateTimeEntry(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdateTimeEntryCommand,
): Promise<TimeEntryDto> {
  return upsertTimeEntry(tx, ctx, input, "update");
}

// ═══════════════════════════════════════════════════════════════════════
// F9.4 Slice B Versionshistorie: immutable Vorher-Bilder je Eintrag
// ═══════════════════════════════════════════════════════════════════════

type TimeEntryRevisionRow = {
  id: string;
  entry_id: string;
  user_id: string;
  project_id: string;
  type_id: string | null;
  start_at: string;
  end_at: string | null;
  start_lat: number | null;
  start_lng: number | null;
  working_time_minutes: number | null;
  break_duration_minutes: number;
  comment: string | null;
  revised_by: string;
  revised_at: string;
  created_at: string;
};

function toTimeEntryRevisionDto(row: TimeEntryRevisionRow): TimeEntryRevisionDto {
  return timeEntryRevisionDtoSchema.parse({
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    id: row.id,
    entryId: row.entry_id,
    userId: row.user_id,
    projectId: row.project_id,
    typeId: row.type_id,
    startAt: row.start_at,
    endAt: row.end_at,
    startLat: row.start_lat,
    startLng: row.start_lng,
    workingTimeMinutes: row.working_time_minutes,
    breakDurationMinutes: row.break_duration_minutes,
    comment: row.comment,
    revisedBy: row.revised_by,
    revisedAt: row.revised_at,
    createdAt: row.created_at,
  });
}

export async function listTimeEntryRevisions(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { entryId: string },
): Promise<TimeEntryRevisionListDto> {
  requireRead(ctx);
  const parsed = timeEntryRevisionListQuerySchema.safeParse(query);
  if (!parsed.success) throw new TimeTrackingValidationError();
  // Gleiche Schranke wie Eintraege: fremder Eintrag => not_found
  // (kein leeres Ergebnis, keine Existenz-Orakel).
  const entry = await tx.execute<{ id: string }>(sql`
    select id from time_entry
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.entryId}::uuid
     limit 1
  `);
  if (!entry.rows[0]) throw new TimeTrackingNotFoundError("time_entry", parsed.data.entryId);
  const result = await tx.execute<TimeEntryRevisionRow>(sql`
    select id, entry_id, user_id, project_id, type_id, start_at, end_at,
           start_lat, start_lng,
           working_time_minutes, break_duration_minutes, comment,
           revised_by, revised_at, created_at
      from time_entry_revision
     where workspace_id = ${ctx.workspaceId}::uuid
       and entry_id = ${parsed.data.entryId}::uuid
     order by revised_at desc, id asc
  `);
  return timeEntryRevisionListDtoSchema.parse({
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    entryId: parsed.data.entryId,
    revisions: result.rows.map(toTimeEntryRevisionDto),
  });
}

export async function archiveTimeEntry(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<TimeEntryDto> {
  requireWrite(ctx);
  const updated = await tx.execute<TimeEntryRow>(sql`
    update time_entry
       set archived_at = statement_timestamp(),
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id}::uuid
       and archived_at is null
       and end_at is not null
     returning id, user_id, project_id, type_id, start_at, end_at,
               start_lat, start_lng,
               working_time_minutes, break_duration_minutes, comment,
               archived_at, created_at, updated_at
  `);
  const row = updated.rows[0];
  if (!row) {
    const current = await tx.execute<TimeEntryRow>(sql`
      ${ENTRY_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id}::uuid
     limit 1
    `);
    if (!current.rows[0]) throw new TimeTrackingNotFoundError("time_entry", id);
    // Kimi-P1-1: laufende Einträge sind NICHT archivierbar — sonst belegt
    // der versteckte Eintrag weiterhin den partiellen Unique (Deadlock).
    if (current.rows[0].end_at === null) throw new TimeTrackingNotFoundError("time_entry", id);
    return toTimeEntryDto(current.rows[0], true);
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "time_entry",
    aggregateId: id,
    eventType: "time_entry.archived",
    actor: ctx.actor,
    payload: {},
  });
  await writeAuditFor(tx, ctx, "time.entry.archive", { id });

  return toTimeEntryDto(row, true);
}

// ═══════════════════════════════════════════════════════════════════════
// F9.2 Stoppuhr: laufender Eintrag je Nutzer (Spec §2)
// ═══════════════════════════════════════════════════════════════════════

export async function startTimeEntry(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: StartTimeEntryCommand,
): Promise<TimeEntryDto> {
  requireWrite(ctx);
  // F9.4 Slice C: GPS-Refine (beide-oder-keiner) gilt nur hier am Start.
  const parsed = startTimeEntryCommandWithGpsSchema.safeParse(input);
  if (!parsed.success) throw new TimeTrackingValidationError();
  const command = parsed.data;

  const projectExists = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
     limit 1
  `);
  if (!projectExists.rows[0]) throw new TimeTrackingNotFoundError("project", command.projectId);

  let row: TimeEntryRow;
  try {
    const inserted = await tx.execute<TimeEntryRow>(sql`
      insert into time_entry (
        workspace_id, user_id, project_id, type_id, start_at, comment,
        start_lat, start_lng, created_by
      ) values (
        ${ctx.workspaceId}::uuid,
        ${ctx.actor}::uuid,
        ${command.projectId}::uuid,
        ${command.typeId ?? null}::uuid,
        statement_timestamp(),
        ${command.comment},
        ${command.startLat ?? null},
        ${command.startLng ?? null},
        ${ctx.actor}::uuid
      )
      returning id, user_id, project_id, type_id, start_at, end_at,
                start_lat, start_lng,
                working_time_minutes, break_duration_minutes, comment,
                archived_at, created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    // 23505 = partieller Unique (bereits laufender Eintrag des Actors).
    if (code === "23505") throw new TimeTrackingConflictError("running entry exists");
    if (code === "23503" || code === "23514") throw new TimeTrackingValidationError();
    throw error;
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "time_entry",
    aggregateId: row.id,
    eventType: "time_entry.started",
    actor: ctx.actor,
    payload: { projectId: command.projectId },
  });
  await writeAuditFor(tx, ctx, "time.entry.start", { id: row.id, projectId: command.projectId });

  return toTimeEntryDto(row, true);
}

export async function stopTimeEntry(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: StopTimeEntryCommand,
): Promise<TimeEntryDto> {
  requireWrite(ctx);
  const parsed = stopTimeEntryCommandSchema.safeParse(input);
  if (!parsed.success) throw new TimeTrackingValidationError();
  const command = parsed.data;

  const updated = await tx.execute<TimeEntryRow>(sql`
    update time_entry
       set end_at = statement_timestamp(),
           working_time_minutes = ${command.workingTimeMinutes},
           break_duration_minutes = ${command.breakDurationMinutes},
           comment = coalesce(${command.comment}, comment),
           updated_by = ${ctx.actor}::uuid,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.id}::uuid
       and user_id = ${ctx.actor}::uuid
       and end_at is null
     returning id, user_id, project_id, type_id, start_at, end_at,
               start_lat, start_lng,
               working_time_minutes, break_duration_minutes, comment,
               archived_at, created_at, updated_at
  `);
  const row = updated.rows[0];
  if (!row) throw new TimeTrackingNotFoundError("time_entry", command.id);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "time_entry",
    aggregateId: command.id,
    eventType: "time_entry.stopped",
    actor: ctx.actor,
    payload: { workingTimeMinutes: command.workingTimeMinutes },
  });
  await writeAuditFor(tx, ctx, "time.entry.stop", {
    id: command.id,
    workingTimeMinutes: command.workingTimeMinutes,
  });

  return toTimeEntryDto(row, true);
}

// Laufenden Eintrag verwerfen (Hard-Delete — DSGVO-konform, da noch keine
// Inhalts-/Zeitdaten erfasst wurden; nur der eigene Eintrag).
export async function discardTimeEntry(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<void> {
  requireWrite(ctx);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) {
    throw new TimeTrackingValidationError();
  }
  const deleted = await tx.execute(sql`
    delete from time_entry
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id}::uuid
       and user_id = ${ctx.actor}::uuid
       and end_at is null
     returning id
  `);
  if (!deleted.rows[0]) throw new TimeTrackingNotFoundError("time_entry", id);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "time_entry",
    aggregateId: id,
    eventType: "time_entry.discarded",
    actor: ctx.actor,
    payload: {},
  });
  await writeAuditFor(tx, ctx, "time.entry.discard", { id });
}

// F9.4 Slice D Team-Auslastung: Aggregation je Mitglied, gleiche
// Filter-Semantik wie listTimeEntries (WYSIWYG), reiner Lese-Pfad
// (requireRead), keine Migration. Summen ignorieren laufende Einträge
// (working_time_minutes IS NULL faellt aus sum()), markieren sie aber.
export async function getTimeUtilization(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string; includeArchived?: boolean; userIds?: string[] | null },
): Promise<TimeUtilizationDto> {
  requireRead(ctx);
  const parsed = timeEntryListQuerySchema.safeParse(query);
  if (!parsed.success) throw new TimeTrackingValidationError();
  const includeArchived = parsed.data.includeArchived === true;
  const userIds = parsed.data.userIds ?? [];
  const userFilter = userIds.length === 0
    ? sql``
    : sql`and e.user_id in (${sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
  const members = await listTimeMemberOptions(tx, ctx);
  const labelByUserId = new Map(members.map((member) => [member.userId, member.label]));
  const result = await tx.execute<{
    user_id: string;
    entry_count: number;
    total_minutes: number;
    running: boolean;
  }>(sql`
    select e.user_id,
           count(*)::int as entry_count,
           coalesce(sum(e.working_time_minutes), 0)::int as total_minutes,
           bool_or(e.end_at is null) as running
      from time_entry e
     where e.workspace_id = ${ctx.workspaceId}::uuid
       and e.project_id = ${parsed.data.projectId}::uuid
       ${includeArchived ? sql`` : sql`and e.archived_at is null`}
       ${userFilter}
     group by e.user_id
     order by coalesce(sum(e.working_time_minutes), 0) desc, e.user_id asc
  `);
  return timeUtilizationDtoSchema.parse({
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    rows: result.rows.map((row) => ({
      schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
      userId: row.user_id,
      label: labelByUserId.get(row.user_id) ?? "Unbekannt",
      entryCount: row.entry_count,
      totalWorkingMinutes: row.total_minutes,
      running: row.running,
    })),
  });
}

// F9.4 Slice A CSV-Export: gleiche Filter-Semantik wie listTimeEntries
// (WYSIWYG), reiner Lese-Pfad (requireRead), keine Migration.
const EXPORT_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const EXPORT_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function exportCell(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

type TimeExportRow = {
  start_at: string | Date;
  end_at: string | Date | null;
  working_time_minutes: number | null;
  break_duration_minutes: number | null;
  type_name: string | null;
  comment: string | null;
  user_id: string;
};

export async function exportTimeEntries(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string; includeArchived?: boolean; userIds?: string[] | null },
): Promise<TimeEntryExportResult> {
  requireRead(ctx);
  const parsed = timeEntryListQuerySchema.safeParse(query);
  if (!parsed.success) throw new TimeTrackingValidationError();
  const includeArchived = parsed.data.includeArchived === true;
  const userIds = parsed.data.userIds ?? [];
  // F9.3-Fix gilt auch hier: IN-Liste statt Array-Literal (Muster oben).
  const userFilter = userIds.length === 0
    ? sql``
    : sql`and e.user_id in (${sql.join(userIds.map((id) => sql`${id}::uuid`), sql`, `)})`;
  const result = await tx.execute<TimeExportRow>(sql`
    select e.start_at, e.end_at, e.working_time_minutes, e.break_duration_minutes,
           t.name as type_name, e.comment, e.user_id
      from time_entry e
      left join time_event_type t
        on t.workspace_id = e.workspace_id
       and t.id = e.type_id
     where e.workspace_id = ${ctx.workspaceId}::uuid
       and e.project_id = ${parsed.data.projectId}::uuid
       ${includeArchived ? sql`` : sql`and e.archived_at is null`}
       ${userFilter}
     order by (e.end_at is null) desc, e.start_at desc, e.id asc
  `);
  const lines = [
    "datum;beginn;ende;minuten;pause_minuten;ereignistyp;kommentar;nutzer_id",
  ];
  for (const row of result.rows) {
    const start = new Date(row.start_at);
    const end = row.end_at === null ? null : new Date(row.end_at);
    lines.push([
      EXPORT_DATE_FORMAT.format(start),
      EXPORT_TIME_FORMAT.format(start),
      end === null ? "" : EXPORT_TIME_FORMAT.format(end),
      row.working_time_minutes === null ? "" : String(row.working_time_minutes),
      row.break_duration_minutes === null ? "" : String(row.break_duration_minutes),
      row.type_name ?? "",
      row.comment ?? "",
      row.user_id,
    ].map(exportCell).join(";"));
  }
  const stamp = EXPORT_DATE_FORMAT.format(new Date()).replaceAll("-", "");
  return timeEntryExportResultSchema.parse({
    content: `\uFEFF${lines.join("\r\n")}\r\n`,
    contentType: "text/csv; charset=utf-8",
    fileName: `zeiterfassung-${parsed.data.projectId.slice(0, 8)}-${stamp}.csv`,
  });
}
