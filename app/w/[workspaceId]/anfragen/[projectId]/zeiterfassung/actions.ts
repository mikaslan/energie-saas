"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  TIME_COMMENT_MAX,
  TIME_MINUTES_MAX,
  TIME_TRACKING_SCHEMA_VERSION,
  type CreateTimeEntryCommand,
  type UpdateTimeEntryCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  archiveTimeEntry,
  createTimeEntry,
  TimeTrackingConflictError,
  TimeTrackingNotFoundError,
  TimeTrackingValidationError,
  updateTimeEntry,
} from "@/modules/time-tracking";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type TimeEntryActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "conflict" }
  | { status: "invalid"; message?: string }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseWorkspace(formData: FormData): string | null {
  const value = formData.get("workspaceId");
  if (typeof value !== "string") return null;
  const parsed = workspaceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseId(formData: FormData, key: string): string | null {
  const value = formData.get(key);
  if (typeof value !== "string") return null;
  const parsed = uuidSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseMinutes(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= TIME_MINUTES_MAX ? parsed : null;
}

// Kimi-P1-2: datetime-local kommt OHNE Zone aus dem Browser. Der naive Wert
// wird deshalb explizit als UTC geparst ("…:00Z" — unabhängig von der
// Server-Zone) und anschließend um den mitgelieferten Browser-Offset
// (getTimezoneOffset() = UTC − Lokalzeit) korrigiert:
//   Browser-lokal 08:00 (UTC+2) → 08:00Z + (−120 min) = 06:00Z.
function parseLocalDateTime(value: FormDataEntryValue | null, tzOffsetMinutes: number): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(`${value}:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  const utc = new Date(parsed.getTime() + tzOffsetMinutes * 60_000);
  return utc.toISOString();
}

function parseTzOffset(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && Math.abs(parsed) <= 14 * 60 ? parsed : null;
}

function parseComment(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.normalize("NFKC").trim();
  return trimmed.length >= 1 && trimmed.length <= TIME_COMMENT_MAX ? trimmed : null;
}

function parseFields(formData: FormData): CreateTimeEntryCommand["fields"] | null {
  const typeValue = formData.get("typeId");
  // Kimi-P3-4: crafted File-Wert → invalid statt still zu null.
  if (typeValue !== null && typeof typeValue !== "string") return null;
  const typeId = typeValue !== "" ? parseId(formData, "typeId") : null;
  if (typeValue !== "" && typeId === null) return null;

  const tzOffsetMinutes = parseTzOffset(formData.get("tzOffsetMinutes"));
  if (tzOffsetMinutes === null) return null;
  const startAt = parseLocalDateTime(formData.get("startAt"), tzOffsetMinutes);
  const endAt = parseLocalDateTime(formData.get("endAt"), tzOffsetMinutes);
  const workingTimeMinutes = parseMinutes(formData.get("workingTimeMinutes"));
  const breakDurationMinutes = parseMinutes(formData.get("breakDurationMinutes"));
  const commentValue = formData.get("comment");
  const comment = parseComment(commentValue);
  if (commentValue && typeof commentValue === "string" && commentValue.trim() !== "" && comment === null) {
    return null;
  }
  if (startAt === null || endAt === null || workingTimeMinutes === null || breakDurationMinutes === null) {
    return null;
  }
  if (new Date(endAt) < new Date(startAt)) return null;
  if (breakDurationMinutes > workingTimeMinutes) return null;
  return { typeId, startAt, endAt, workingTimeMinutes, breakDurationMinutes, comment };
}

function mapError(error: unknown): TimeEntryActionState {
  if (error instanceof TimeTrackingValidationError) return { status: "invalid" };
  if (error instanceof TimeTrackingNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

function revalidate(workspace: string, projectId: string): void {
  revalidatePath(`/w/${workspace}/anfragen/${projectId}/zeiterfassung`);
}

export async function createTimeEntryAction(
  _previous: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const workspace = parseWorkspace(formData);
  const projectId = parseId(formData, "projectId");
  const fields = parseFields(formData);
  if (!workspace || !projectId || !fields) return { status: "invalid" };

  const command: CreateTimeEntryCommand = {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    projectId,
    fields,
  };
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      createTimeEntry(tx, ctx, command),
    );
    revalidate(workspace, projectId);
    return { status: "success", message: "Zeiteintrag angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updateTimeEntryAction(
  _previous: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const workspace = parseWorkspace(formData);
  const projectId = parseId(formData, "projectId");
  const id = parseId(formData, "id");
  const fields = parseFields(formData);
  if (!workspace || !projectId || !id || !fields) return { status: "invalid" };

  const command: UpdateTimeEntryCommand = {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    id,
    fields,
  };
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      updateTimeEntry(tx, ctx, command),
    );
    revalidate(workspace, projectId);
    return { status: "success", message: "Zeiteintrag aktualisiert." };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveTimeEntryAction(
  _previous: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const workspace = parseWorkspace(formData);
  const projectId = parseId(formData, "projectId");
  const id = parseId(formData, "id");
  if (!workspace || !projectId || !id) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      archiveTimeEntry(tx, ctx, id),
    );
    revalidate(workspace, projectId);
    return { status: "success", message: "Zeiteintrag archiviert." };
  } catch (error) {
    return mapError(error);
  }
}

// F9.2 Stoppuhr-Actions
import {
  discardTimeEntry,
  startTimeEntry,
  stopTimeEntry,
} from "@/modules/time-tracking";

export async function startTimeEntryAction(
  _previous: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const workspace = parseWorkspace(formData);
  const projectId = parseId(formData, "projectId");
  const typeValue = formData.get("typeId");
  const typeId = typeValue && typeof typeValue === "string" && typeValue !== ""
    ? parseId(formData, "typeId")
    : null;
  const commentValue = formData.get("comment");
  const comment = parseComment(commentValue);
  if (commentValue && typeof commentValue === "string" && commentValue.trim() !== "" && comment === null) {
    return { status: "invalid" };
  }
  if (!workspace || !projectId) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId,
        typeId,
        comment,
      }),
    );
    revalidate(workspace, projectId);
    return { status: "success", message: "Stoppuhr gestartet." };
  } catch (error) {
    if (error instanceof TimeTrackingConflictError) {
      return { status: "conflict" };
    }
    return mapError(error);
  }
}

export async function stopTimeEntryAction(
  _previous: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const workspace = parseWorkspace(formData);
  const projectId = parseId(formData, "projectId");
  const id = parseId(formData, "id");
  const workingTimeMinutes = parseMinutes(formData.get("workingTimeMinutes"));
  const breakDurationMinutes = parseMinutes(formData.get("breakDurationMinutes"));
  const commentValue = formData.get("comment");
  const comment = parseComment(commentValue);
  if (
    !workspace || !projectId || !id
    || workingTimeMinutes === null || workingTimeMinutes < 1
    || breakDurationMinutes === null || breakDurationMinutes > workingTimeMinutes
  ) {
    return { status: "invalid" };
  }
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      stopTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id,
        workingTimeMinutes,
        breakDurationMinutes,
        comment,
      }),
    );
    revalidate(workspace, projectId);
    return { status: "success", message: "Stoppuhr gestoppt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function discardTimeEntryAction(
  _previous: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const workspace = parseWorkspace(formData);
  const projectId = parseId(formData, "projectId");
  const id = parseId(formData, "id");
  if (!workspace || !projectId || !id) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      discardTimeEntry(tx, ctx, id),
    );
    revalidate(workspace, projectId);
    return { status: "success", message: "Laufender Eintrag verworfen." };
  } catch (error) {
    return mapError(error);
  }
}
