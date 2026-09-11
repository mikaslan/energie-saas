"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  AppointmentConflictError,
  AppointmentNotFoundError,
  AppointmentValidationError,
  executeProjectAppointmentCommand,
  listProjectAppointments,
  PROJECT_APPOINTMENT_COMMAND_VERSION,
} from "@/modules/calendar";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u);
const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/u)
  .refine((v) => {
    const [year, month, day] = v.split("-").map(Number);
    const probe = new Date(Date.UTC(year!, month! - 1, day!));
    return probe.getUTCFullYear() === year
      && probe.getUTCMonth() === month! - 1
      && probe.getUTCDate() === day;
  });

export type PlanningBoardCreateState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function text(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function mapError(error: unknown): PlanningBoardCreateState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof AppointmentNotFoundError) return { status: "not_found" };
  if (error instanceof AppointmentConflictError) return { status: "conflict" };
  if (error instanceof AppointmentValidationError) return { status: "invalid" };
  throw error;
}

// F7-05 Slice 2: Termin-Anlage von der Tafel. Alle Felder fail-closed
// validiert; Uhrzeiten sind Berlin-Wanduhr (M1-15b ADR 0021 E6).
export async function createPlanningBoardEntryAction(
  _previous: PlanningBoardCreateState,
  formData: FormData,
): Promise<PlanningBoardCreateState> {
  const workspaceId = workspaceIdSchema.safeParse(formData.get("workspaceId"));
  const projectId = uuidSchema.safeParse(formData.get("projectId"));
  const calendarId = uuidSchema.safeParse(formData.get("calendarId"));
  const memberId = uuidSchema.safeParse(formData.get("attendeeMembershipId"));
  const date = daySchema.safeParse(formData.get("date"));
  const startTime = timeSchema.safeParse(formData.get("startTime"));
  const endTime = timeSchema.safeParse(formData.get("endTime"));
  const title = text(formData.get("title"));
  const type = z.enum(["on_site", "phone", "installation", "maintenance", "consultation", "other"])
    .safeParse(formData.get("type"));
  const location = text(formData.get("location"));
  // F7-06: optionale Team-Bindung bei Anlage (leer = ohne Team; unbekannt/
  // fremd/archiviert lehnt der F1-12-Service-Guard als Validation ab).
  const rawTeam = formData.get("teamId");
  const teamId = rawTeam === "" || rawTeam === null || rawTeam === undefined
    ? { success: true as const, data: null as string | null }
    : uuidSchema.safeParse(rawTeam);
  if (
    !workspaceId.success
    || !projectId.success
    || !calendarId.success
    || !memberId.success
    || !date.success
    || !startTime.success
    || !endTime.success
    || title === null
    || title.length > 2000
    || !type.success
    || (location !== null && location.length > 2000)
    || !teamId.success
  ) {
    return { status: "invalid" };
  }
  try {
    await authorizedAction(
      workspaceId.data,
      "appointment.write",
      "planning_board_create",
      (tx, ctx) => executeProjectAppointmentCommand(tx, ctx, {
        schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
        kind: "create_appointment",
        projectId: projectId.data,
        title,
        start: `${date.data}T${startTime.data}:00`,
        end: `${date.data}T${endTime.data}:00`,
        allDay: false,
        type: type.data,
        location,
        description: null,
        calendarId: calendarId.data,
        attendeeMembershipIds: [memberId.data],
        teamId: teamId.data,
      }),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/w/${workspaceId.data}/plantafel`);
  return { status: "success", message: "Termin angelegt — er steht in der Tafelwoche." };
}

export type PlanningBoardAssignState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

// F7-06 Team-Blockzuweisung: Team je Tafeleintrag setzen/entziehen.
// Läuft über update_appointment mit Voll-Resend des aktuellen Stands +
// Revision-CAS (kein direkter Feldschrieb): Fremd/archiviert/unbekannt
// lehnt der F1-12-Service-Guard als Validation ab (kein Orakel).
export async function assignPlanningBoardEntryTeamAction(
  _previous: PlanningBoardAssignState,
  formData: FormData,
): Promise<PlanningBoardAssignState> {
  const workspaceId = workspaceIdSchema.safeParse(formData.get("workspaceId"));
  const projectId = uuidSchema.safeParse(formData.get("projectId"));
  const appointmentId = uuidSchema.safeParse(formData.get("appointmentId"));
  const expectedRevision = z.coerce.number().int().min(1).safeParse(formData.get("revision"));
  const startWall = z.string().min(1).safeParse(formData.get("start"));
  const endWall = z.string().min(1).safeParse(formData.get("end"));
  const rawTeam = formData.get("teamId");
  const teamId = rawTeam === "" || rawTeam === null
    ? { success: true as const, data: null as string | null }
    : uuidSchema.safeParse(rawTeam);
  if (
    !workspaceId.success
    || !projectId.success
    || !appointmentId.success
    || !expectedRevision.success
    || !startWall.success
    || !endWall.success
    || !teamId.success
  ) {
    return { status: "invalid" };
  }
  try {
    const assigned = await authorizedAction(
      workspaceId.data,
      "appointment.write",
      "planning_board_assign_team",
      async (tx, ctx) => {
        const range = await listProjectAppointments(tx, ctx, projectId.data, {
          rangeStart: startWall.data,
          rangeEnd: endWall.data,
          view: "week",
        });
        const current = range?.items.find((item) => item.id === appointmentId.data) ?? null;
        if (current === null) throw new AppointmentNotFoundError();
        return executeProjectAppointmentCommand(tx, ctx, {
          schemaVersion: PROJECT_APPOINTMENT_COMMAND_VERSION,
          kind: "update_appointment",
          projectId: projectId.data,
          appointmentId: appointmentId.data,
          expectedRevision: expectedRevision.data,
          title: current.title,
          start: current.start,
          end: current.end,
          allDay: current.allDay,
          type: current.type,
          location: current.location,
          description: current.description,
          attendeeMembershipIds: current.attendees.map((attendee) => attendee.membershipId),
          calendarId: current.calendarId,
          teamId: teamId.data,
        });
      },
    );
    void assigned;
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof AppointmentNotFoundError) return { status: "not_found" };
    if (error instanceof AppointmentConflictError) return { status: "conflict" };
    if (error instanceof AppointmentValidationError) return { status: "invalid" };
    throw error;
  }
  revalidatePath(`/w/${workspaceId.data}/plantafel`);
  return {
    status: "success",
    message: teamId.data === null
      ? "Team entzogen — der Eintrag steht ohne Team in der Tafelwoche."
      : "Team zugewiesen — der Eintrag trägt das Team in der Tafelwoche.",
  };
}
