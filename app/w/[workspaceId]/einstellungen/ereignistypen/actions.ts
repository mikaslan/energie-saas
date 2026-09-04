"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  TIME_COLOR_PATTERN,
  TIME_NAME_MAX,
  TIME_TRACKING_SCHEMA_VERSION,
  type CreateTimeEventTypeCommand,
  type UpdateTimeEventTypeCommand,
} from "@/lib/integrations/time-tracking/contract";
import {
  archiveTimeEventType,
  createTimeEventType,
  restoreTimeEventType,
  TimeTrackingConflictError,
  TimeTrackingNotFoundError,
  TimeTrackingValidationError,
  updateTimeEventType,
} from "@/modules/time-tracking";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type TimeEventTypeActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid"; message?: string }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseName(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.normalize("NFKC").trim();
  if (trimmed.length < 1 || trimmed.length > TIME_NAME_MAX) return null;
  return trimmed;
}

function parsePosition(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

// Kimi-P3-2: unbekannter Domain-Wert (crafted Request) → "invalid" statt
// still zu null zu koerzieren — symmetrisch zur Farb-Validierung.


function parseColor(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.trim();
  return TIME_COLOR_PATTERN.test(trimmed) ? trimmed : null;
}

function mapError(error: unknown): TimeEventTypeActionState {
  if (error instanceof TimeTrackingValidationError) return { status: "invalid" };
  if (error instanceof TimeTrackingConflictError) return { status: "conflict" };
  if (error instanceof TimeTrackingNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

function parseWorkspace(formData: FormData): string | null {
  const workspaceValue = formData.get("workspaceId");
  if (typeof workspaceValue !== "string") return null;
  const workspace = workspaceIdSchema.safeParse(workspaceValue);
  return workspace.success ? workspace.data : null;
}

export async function createTimeEventTypeAction(
  _previous: TimeEventTypeActionState,
  formData: FormData,
): Promise<TimeEventTypeActionState> {
  const workspace = parseWorkspace(formData);
  const name = parseName(formData.get("name"));
  if (!workspace || name === null) return { status: "invalid" };
  const position = parsePosition(formData.get("position"));
  if (position === null) return { status: "invalid" };
  const textColorValue = formData.get("textColor");
  const backgroundColorValue = formData.get("backgroundColor");
  const textColor = parseColor(textColorValue);
  const backgroundColor = parseColor(backgroundColorValue);
  if (textColorValue && typeof textColorValue === "string" && textColorValue.trim() !== "" && textColor === null) {
    return { status: "invalid", message: "Die Textfarbe muss im Format #RRGGBB angegeben werden." };
  }
  if (backgroundColorValue && typeof backgroundColorValue === "string" && backgroundColorValue.trim() !== "" && backgroundColor === null) {
    return { status: "invalid", message: "Die Hintergrundfarbe muss im Format #RRGGBB angegeben werden." };
  }

  const command: CreateTimeEventTypeCommand = {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    name,
    position,
    textColor,
    backgroundColor,
  };
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      createTimeEventType(tx, ctx, command),
    );
    revalidatePath(`/w/${workspace}/einstellungen/ereignistypen`);
    return { status: "success", message: "Ereignistyp angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updateTimeEventTypeAction(
  _previous: TimeEventTypeActionState,
  formData: FormData,
): Promise<TimeEventTypeActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  const name = parseName(formData.get("name"));
  if (!workspace || !id?.success || name === null) return { status: "invalid" };
  const position = parsePosition(formData.get("position"));
  if (position === null) return { status: "invalid" };
  const textColorValue = formData.get("textColor");
  const backgroundColorValue = formData.get("backgroundColor");
  const textColor = parseColor(textColorValue);
  const backgroundColor = parseColor(backgroundColorValue);
  if (textColorValue && typeof textColorValue === "string" && textColorValue.trim() !== "" && textColor === null) {
    return { status: "invalid", message: "Die Textfarbe muss im Format #RRGGBB angegeben werden." };
  }
  if (backgroundColorValue && typeof backgroundColorValue === "string" && backgroundColorValue.trim() !== "" && backgroundColor === null) {
    return { status: "invalid", message: "Die Hintergrundfarbe muss im Format #RRGGBB angegeben werden." };
  }

  const command: UpdateTimeEventTypeCommand = {
    schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
    id: id.data,
    name,
    position,
    textColor,
    backgroundColor,
  };
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      updateTimeEventType(tx, ctx, command),
    );
    revalidatePath(`/w/${workspace}/einstellungen/ereignistypen`);
    return { status: "success", message: "Ereignistyp aktualisiert." };
  } catch (error) {
    return mapError(error);
  }
}

async function toggleArchived(
  workspace: string,
  id: string,
  archive: boolean,
): Promise<TimeEventTypeActionState> {
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      archive ? archiveTimeEventType(tx, ctx, id) : restoreTimeEventType(tx, ctx, id),
    );
    revalidatePath(`/w/${workspace}/einstellungen/ereignistypen`);
    return {
      status: "success",
      message: archive ? "Ereignistyp archiviert." : "Ereignistyp reaktiviert.",
    };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveTimeEventTypeAction(
  _previous: TimeEventTypeActionState,
  formData: FormData,
): Promise<TimeEventTypeActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleArchived(workspace, id.data, true);
}

export async function restoreTimeEventTypeAction(
  _previous: TimeEventTypeActionState,
  formData: FormData,
): Promise<TimeEventTypeActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleArchived(workspace, id.data, false);
}
