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
import { berlinWallClockToIso } from "@/lib/integrations/time-tracking/berlin-wall-clock";
import {
  approveTimeEntry,
  archiveTimeEntry,
  createTimeEntry,
  endBreak,
  lockTimeEntryInstantsForUpdate,
  startBreak,
  TimeTrackingConflictError,
  TimeTrackingNotFoundError,
  TimeTrackingValidationError,
  unapproveTimeEntry,
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

function parseComment(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const trimmed = value.normalize("NFKC").trim();
  return trimmed.length >= 1 && trimmed.length <= TIME_COMMENT_MAX ? trimmed : null;
}

// F9.4 Slice C: GPS nur mit Consent (Hidden-Fields aus Geolocation).
// Beide oder keiner — halbe Paare, Unfug und crafted Files => invalid.
// Leere Felder (kein Consent/Verweigert) => { null, null }, nie ein Fehler.
function parseGps(formData: FormData): { startLat: number | null; startLng: number | null } | null {
  const rawLat = formData.get("startLat");
  const rawLng = formData.get("startLng");
  const empty = (value: FormDataEntryValue | null): boolean =>
    value === null || (typeof value === "string" && value.trim() === "");
  if (empty(rawLat) && empty(rawLng)) return { startLat: null, startLng: null };
  if (typeof rawLat !== "string" || typeof rawLng !== "string") return null;
  const startLat = Number(rawLat);
  const startLng = Number(rawLng);
  if (
    !Number.isFinite(startLat) || !Number.isFinite(startLng)
    || startLat < -90 || startLat > 90 || startLng < -180 || startLng > 180
  ) return null;
  return { startLat, startLng };
}

function parseFields(
  formData: FormData,
  preferredInstants?: { startAt: string; endAt: string | null },
  validateInstantOrder = true,
): CreateTimeEntryCommand["fields"] | null {
  const typeValue = formData.get("typeId");
  // Kimi-P3-4: crafted File-Wert → invalid statt still zu null.
  if (typeValue !== null && typeof typeValue !== "string") return null;
  const typeId = typeValue !== "" ? parseId(formData, "typeId") : null;
  if (typeValue !== "" && typeId === null) return null;

  const startValue = formData.get("startAt");
  const endValue = formData.get("endAt");
  const startAt = typeof startValue === "string"
    ? berlinWallClockToIso(startValue, preferredInstants?.startAt)
    : null;
  const endAt = typeof endValue === "string"
    ? berlinWallClockToIso(endValue, preferredInstants?.endAt)
    : null;
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
  if (validateInstantOrder && new Date(endAt) < new Date(startAt)) return null;
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
  // Vor Autorisierung nur Form/Syntax prüfen. In der doppelten Herbststunde
  // kann eine legitime End-Wandzeit kleiner als die Start-Wandzeit aussehen.
  const submittedFields = parseFields(formData, undefined, false);
  if (!workspace || !projectId || !id || !submittedFields) return { status: "invalid" };

  try {
    await authorizedAction(workspace, "time.write", "time_tracking", async (tx, ctx) => {
      // Der bevorzugte Fold/Sekundenanteil stammt unter derselben
      // Transaktionssperre aus der DB, nie aus manipulierbaren Hidden-Feldern.
      const storedInstants = await lockTimeEntryInstantsForUpdate(tx, ctx, id);
      const fields = parseFields(formData, storedInstants);
      if (!fields) throw new TimeTrackingValidationError();
      const command: UpdateTimeEntryCommand = {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        id,
        fields,
      };
      return updateTimeEntry(tx, ctx, command);
    });
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

// F9-05 Zeitfreigabe: freigeben = unveränderlich, entsperren = explizit.
export async function approveTimeEntryAction(
  _previous: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const workspace = parseWorkspace(formData);
  const projectId = parseId(formData, "projectId");
  const id = parseId(formData, "id");
  if (!workspace || !projectId || !id) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      approveTimeEntry(tx, ctx, id),
    );
    revalidate(workspace, projectId);
    return { status: "success", message: "Zeiteintrag freigegeben." };
  } catch (error) {
    if (error instanceof TimeTrackingConflictError) return { status: "conflict" };
    return mapError(error);
  }
}

export async function unapproveTimeEntryAction(
  _previous: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const workspace = parseWorkspace(formData);
  const projectId = parseId(formData, "projectId");
  const id = parseId(formData, "id");
  if (!workspace || !projectId || !id) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      unapproveTimeEntry(tx, ctx, id),
    );
    revalidate(workspace, projectId);
    return { status: "success", message: "Freigabe aufgehoben." };
  } catch (error) {
    if (error instanceof TimeTrackingConflictError) return { status: "conflict" };
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
  const gps = parseGps(formData);
  if (gps === null) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      startTimeEntry(tx, ctx, {
        schemaVersion: TIME_TRACKING_SCHEMA_VERSION,
        projectId,
        typeId,
        comment,
        startLat: gps.startLat,
        startLng: gps.startLng,
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

// F9-06 Pausen-Segmente: Start/Ende je Eintrag (gleiche Schranke und
// Zustände wie alle Zeit-Aktionen, Konflikt = offene/fehlende Pause).
export async function startBreakAction(
  _previous: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const workspace = parseWorkspace(formData);
  const projectId = parseId(formData, "projectId");
  const id = parseId(formData, "id");
  if (!workspace || !projectId || !id) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      startBreak(tx, ctx, { entryId: id }),
    );
    revalidate(workspace, projectId);
    return { status: "success", message: "Pause gestartet." };
  } catch (error) {
    if (error instanceof TimeTrackingConflictError) return { status: "conflict" };
    return mapError(error);
  }
}

export async function endBreakAction(
  _previous: TimeEntryActionState,
  formData: FormData,
): Promise<TimeEntryActionState> {
  const workspace = parseWorkspace(formData);
  const projectId = parseId(formData, "projectId");
  const id = parseId(formData, "id");
  if (!workspace || !projectId || !id) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "time.write", "time_tracking", (tx, ctx) =>
      endBreak(tx, ctx, { entryId: id }),
    );
    revalidate(workspace, projectId);
    return { status: "success", message: "Pause beendet." };
  } catch (error) {
    if (error instanceof TimeTrackingConflictError) return { status: "conflict" };
    return mapError(error);
  }
}
