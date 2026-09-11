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
        // F1-12: Plantafel-Termine ohne Team (Blockzuweisung Folge-Slice).
        teamId: null,
      }),
    );
  } catch (error) {
    return mapError(error);
  }
  revalidatePath(`/w/${workspaceId.data}/plantafel`);
  return { status: "success", message: "Termin angelegt — er steht in der Tafelwoche." };
}
