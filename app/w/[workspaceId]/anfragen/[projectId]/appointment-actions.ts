"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  APPOINTMENT_DESCRIPTION_MAX_LENGTH,
  APPOINTMENT_LOCATION_MAX_LENGTH,
  APPOINTMENT_TITLE_MAX_LENGTH,
  APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
  PROJECT_APPOINTMENT_COMMAND_VERSION,
  PROJECT_APPOINTMENT_MAX_ATTENDEES,
  PROJECT_APPOINTMENT_MAX_REVISION,
  projectAppointmentCommandV1Schema,
  AppointmentConflictError,
  AppointmentNotFoundError,
  applyAppointmentTemplate,
  AppointmentTemplateConflictError,
  AppointmentTemplateNotFoundError,
  AppointmentTemplateValidationError,
  AppointmentValidationError,
  executeProjectAppointmentCommand,
  type ProjectAppointmentCommandV1,
} from "@/modules/calendar";

const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;

export type ProjectAppointmentActionState =
  | { status: "idle" }
  | {
      status: "success";
      operation: ProjectAppointmentCommandV1["kind"];
      appointmentId: string;
      revision: number;
      changed: boolean;
    }
  | { status: "invalid" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

const CREATE_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "projectId",
  "title",
  "start",
  "end",
  "allDay",
  "type",
  "location",
  "description",
  "calendarId",
  "attendees",
  "teamId",
]);
const UPDATE_FIELDS = new Set([...CREATE_FIELDS, "appointmentId", "expectedRevision"]);
const DELETE_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "projectId",
  "appointmentId",
  "expectedRevision",
]);

function exactStringEntries(
  formData: FormData,
  allowedFields: ReadonlySet<string>,
): Record<string, string> | null {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
    if (!allowedFields.has(name)) return null;
    values.set(name, value);
  }
  const domainEntries = [...values].filter(([name]) => !name.startsWith("$ACTION"));
  if (
    domainEntries.length !== allowedFields.size
    || ![...allowedFields].every((name) => values.has(name))
  ) return null;
  return Object.fromEntries(domainEntries);
}

function parseRevision(value: string | undefined): number | null {
  if (!value || !POSITIVE_INTEGER_PATTERN.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision <= PROJECT_APPOINTMENT_MAX_REVISION
    ? revision
    : null;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseOptionalText(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  return value;
}

// F1-12: optionaler Team-Bezug ("" = ohne Team; unförmig = invalid,
// Fremd/Archiv scheitert im Service-Guard ohne Orakel).
function parseOptionalTeamId(value: string | undefined): string | null | undefined {
  if (value === undefined || value === "") return null;
  return UUID_SCHEMA.safeParse(value).success ? value.toLowerCase() : undefined;
}

function parseAttendeeIds(value: string | undefined): string[] | null {
  if (value === undefined || value === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > PROJECT_APPOINTMENT_MAX_ATTENDEES) return null;
    if (!parsed.every((item) => typeof item === "string")) return null;
    const ids = parsed.map((item) => item as string);
    if (new Set(ids).size !== ids.length) return null;
    return ids;
  } catch {
    return null;
  }
}

function normalizeWallClock(value: string, allDay: boolean): string {
  if (allDay && /^\d{4}-\d{2}-\d{2}$/u.test(value)) return `${value}T00:00:00`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return `${value}:00`;
  return value;
}

function commandCandidate(
  kind: string,
  entries: Record<string, string>,
): Record<string, unknown> | null {
  if (entries.schemaVersion !== PROJECT_APPOINTMENT_COMMAND_VERSION) return null;
  const base = {
    schemaVersion: entries.schemaVersion,
    kind,
    projectId: entries.projectId,
  };
  if (kind === "delete_appointment") {
    const expectedRevision = parseRevision(entries.expectedRevision);
    if (expectedRevision === null) return null;
    return { ...base, appointmentId: entries.appointmentId, expectedRevision };
  }
  const allDay = parseBoolean(entries.allDay);
  const attendees = parseAttendeeIds(entries.attendees);
  const teamId = parseOptionalTeamId(entries.teamId);
  if (allDay === null || attendees === null || teamId === undefined) return null;
  const editable = {
    title: entries.title,
    start: normalizeWallClock(entries.start, allDay),
    end: normalizeWallClock(entries.end, allDay),
    allDay,
    type: entries.type,
    location: parseOptionalText(entries.location),
    description: parseOptionalText(entries.description),
    calendarId: entries.calendarId,
    attendeeMembershipIds: attendees,
    teamId,
  };
  if (kind === "create_appointment") return { ...base, ...editable };
  const expectedRevision = parseRevision(entries.expectedRevision);
  if (expectedRevision === null) return null;
  return { ...base, appointmentId: entries.appointmentId, expectedRevision, ...editable };
}

function mapError(error: unknown): ProjectAppointmentActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof AppointmentValidationError) return { status: "invalid" };
  if (error instanceof AppointmentNotFoundError) return { status: "not_found" };
  if (error instanceof AppointmentConflictError) {
    return error.currentRevision === undefined
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  return null;
}

export async function changeProjectAppointment(
  rawWorkspaceId: string,
  rawBoundProjectId: string,
  _previousState: ProjectAppointmentActionState,
  formData: FormData,
): Promise<ProjectAppointmentActionState> {
  const route = z.strictObject({
    workspaceId: UUID_SCHEMA,
    projectId: UUID_SCHEMA,
  }).safeParse({ workspaceId: rawWorkspaceId, projectId: rawBoundProjectId });
  const kindValues = formData.getAll("kind");
  if (
    !route.success
    || kindValues.length !== 1
    || typeof kindValues[0] !== "string"
  ) return { status: "invalid" };

  const kind = kindValues[0];
  const allowed = kind === "create_appointment"
    ? CREATE_FIELDS
    : kind === "update_appointment"
      ? UPDATE_FIELDS
      : kind === "delete_appointment"
        ? DELETE_FIELDS
        : null;
  if (allowed === null) return { status: "invalid" };

  const entries = exactStringEntries(formData, allowed);
  const candidate = entries === null ? null : commandCandidate(kind, entries);
  const parsed = candidate === null ? null : projectAppointmentCommandV1Schema.safeParse(candidate);
  if (
    parsed === null
    || !parsed.success
    || parsed.data.projectId !== route.data.projectId
  ) return { status: "invalid" };

  // Serverseitige Byte-Grenze vor der Action (DoS-Schranke, analog note-actions).
  if (parsed.data.kind !== "delete_appointment") {
    if (new TextEncoder().encode(parsed.data.title).byteLength > APPOINTMENT_TITLE_MAX_LENGTH * 6 + 2) {
      return { status: "invalid" };
    }
    if (parsed.data.description !== null
      && new TextEncoder().encode(parsed.data.description).byteLength > APPOINTMENT_DESCRIPTION_MAX_LENGTH * 6 + 2) {
      return { status: "invalid" };
    }
    if (parsed.data.location !== null
      && new TextEncoder().encode(parsed.data.location).byteLength > APPOINTMENT_LOCATION_MAX_LENGTH * 6 + 2) {
      return { status: "invalid" };
    }
  }

  try {
    const result = await authorizedAction(
      route.data.workspaceId,
      "appointment.write",
      "project_appointment",
      (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, parsed.data),
    );
    revalidatePath(`/w/${route.data.workspaceId}/anfragen/${route.data.projectId}`);
    return {
      status: "success",
      operation: parsed.data.kind,
      appointmentId: result.appointmentId,
      revision: result.revision,
      changed: result.changed,
    };
  } catch (error) {
    const mapped = mapError(error);
    if (mapped?.status === "conflict") {
      revalidatePath(`/w/${route.data.workspaceId}/anfragen/${route.data.projectId}`);
    }
    return mapped ?? { status: "invalid" };
  }
}

export type ApplyAppointmentTemplateActionState =
  | { status: "idle" }
  | { status: "success"; appointmentId: string }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

// F16-05: Vorlage im Projekt anwenden (eigene Action: nur Template-ID,
// Kalender-ID und Start; Dauer/Titel aus der Vorlage).
export async function applyAppointmentTemplateAction(
  rawWorkspaceId: string,
  rawBoundProjectId: string,
  _previousState: ApplyAppointmentTemplateActionState,
  formData: FormData,
): Promise<ApplyAppointmentTemplateActionState> {
  const startValue = formData.get("start");
  const route = z.strictObject({
    workspaceId: UUID_SCHEMA,
    projectId: UUID_SCHEMA,
    templateId: UUID_SCHEMA,
    calendarId: UUID_SCHEMA,
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u),
  }).safeParse({
    workspaceId: rawWorkspaceId,
    projectId: rawBoundProjectId,
    templateId: formData.get("templateId"),
    calendarId: formData.get("calendarId"),
    start: typeof startValue === "string" ? startValue : null,
  });
  if (!route.success) return { status: "invalid" };
  try {
    const result = await authorizedAction(
      route.data.workspaceId,
      "appointment.write",
      "project_appointment",
      (tx, ctx) => applyAppointmentTemplate(tx, ctx, {
        schemaVersion: APPOINTMENT_TEMPLATE_SCHEMA_VERSION,
        templateId: route.data.templateId,
        projectId: route.data.projectId,
        calendarId: route.data.calendarId,
        start: route.data.start,
      }),
    );
    revalidatePath(`/w/${route.data.workspaceId}/anfragen/${route.data.projectId}`);
    return { status: "success", appointmentId: result.appointmentId };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (
      error instanceof AppointmentTemplateNotFoundError
      || error instanceof AppointmentNotFoundError
    ) return { status: "not_found" };
    if (
      error instanceof AppointmentTemplateValidationError
      || error instanceof AppointmentTemplateConflictError
      || error instanceof AppointmentValidationError
    ) return { status: "invalid" };
    throw error;
  }
}
