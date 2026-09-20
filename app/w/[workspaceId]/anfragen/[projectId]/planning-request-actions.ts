"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  checkPlanningRequestOverdue,
  PlanningRequestConflictError,
  PlanningRequestNotFoundError,
  PlanningRequestValidationError,
  requestPlanning,
  setPlanningStatus,
  type PlanningDeadlineKind,
  type PlanningRequestStatus,
} from "@/modules/planning-requests";
// F13-14 Revisions-Service (Backend-Namen, gegen gelandetes
// modules/planning-request-revisions abgeglichen — kein Conflict-Typ:
// Zweit-Signatur ist ValidationError, siehe signPlanningRevisionAction).
import {
  createPlanningRequestRevision,
  PlanningRequestRevisionNotFoundError,
  PlanningRequestRevisionValidationError,
  signPlanningRequestRevision,
} from "@/modules/planning-request-revisions";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type PlanningRequestActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseIds(formData: FormData): { workspaceId: string; projectId: string } | null {
  const workspaceId = workspaceIdSchema.safeParse(formData.get("workspaceId"));
  const projectId = uuidSchema.safeParse(formData.get("projectId"));
  if (!workspaceId.success || !projectId.success) return null;
  return { workspaceId: workspaceId.data, projectId: projectId.data };
}

function mapError(error: unknown): PlanningRequestActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof PlanningRequestNotFoundError) return { status: "not_found" };
  if (error instanceof PlanningRequestConflictError) return { status: "conflict" };
  if (error instanceof PlanningRequestValidationError) return { status: "invalid" };
  if (error instanceof PlanningRequestRevisionNotFoundError) return { status: "not_found" };
  if (error instanceof PlanningRequestRevisionValidationError) return { status: "invalid" };
  throw error;
}

const deadlineKinds: readonly PlanningDeadlineKind[] = ["express_24h", "standard_48h", "date"];

export async function requestPlanningAction(
  _previous: PlanningRequestActionState,
  formData: FormData,
): Promise<PlanningRequestActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const offerId = uuidSchema.safeParse(formData.get("offerId"));
  const deadlineKind = z.enum(deadlineKinds).safeParse(formData.get("deadlineKind"));
  if (!offerId.success || !deadlineKind.success) return { status: "invalid" };
  const dateValue = formData.get("deadlineDate");
  const deadlineDate = typeof dateValue === "string" && dateValue !== "" ? dateValue : null;
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "planning_request", (tx, ctx) =>
      requestPlanning(tx, ctx, {
        projectId: ids.projectId,
        offerId: offerId.data,
        deadlineKind: deadlineKind.data,
        deadlineDate,
      }),);
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Planungsanfrage gestellt." };
  } catch (error) {
    return mapError(error);
  }
}

const statuses: readonly PlanningRequestStatus[] = [
  "requested",
  "in_progress",
  "finished",
  "accepted",
];

export async function setPlanningStatusAction(
  _previous: PlanningRequestActionState,
  formData: FormData,
): Promise<PlanningRequestActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const id = uuidSchema.safeParse(formData.get("id"));
  const status = z.enum(statuses).safeParse(formData.get("status"));
  if (!id.success || !status.success) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "planning_request", (tx, ctx) =>
      setPlanningStatus(tx, ctx, { id: id.data, status: status.data }),);
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Planungsstatus gesetzt." };
  } catch (error) {
    return mapError(error);
  }
}

// F13-14 Revisionsnotiz anlegen (installation.write; Backend-Regel 1..2000
// Zeichen, getrimmt — Leertext vorab invalid, Rest prüft der Service).
export async function createPlanningRevisionAction(
  _previous: PlanningRequestActionState,
  formData: FormData,
): Promise<PlanningRequestActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const planningRequestId = uuidSchema.safeParse(formData.get("planningRequestId"));
  const note = formData.get("note");
  if (!planningRequestId.success || typeof note !== "string" || note.trim() === "") {
    return { status: "invalid" };
  }
  try {
    await authorizedAction(
      ids.workspaceId,
      "installation.write",
      "planning_request_revision",
      (tx, ctx) =>
        createPlanningRequestRevision(tx, ctx, {
          projectId: ids.projectId,
          planningRequestId: planningRequestId.data,
          note: note.trim(),
        }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Revisionsnotiz angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

// F13-14 Revisionsnotiz per Click-Signatur zeichnen (installation.write).
// Zweit-Signatur meldet der Service als ValidationError („already
// signed") — Eingaben sind hier vorvalidiert (UUID), daher bedeutet
// ValidationError aus dem Service immer „bereits signiert" → conflict.
export async function signPlanningRevisionAction(
  _previous: PlanningRequestActionState,
  formData: FormData,
): Promise<PlanningRequestActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const revisionId = uuidSchema.safeParse(formData.get("revisionId"));
  if (!revisionId.success) return { status: "invalid" };
  try {
    await authorizedAction(
      ids.workspaceId,
      "installation.write",
      "planning_request_revision",
      (tx, ctx) => signPlanningRequestRevision(tx, ctx, { id: revisionId.data }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Revisionsnotiz signiert." };
  } catch (error) {
    if (error instanceof PlanningRequestRevisionValidationError) return { status: "conflict" };
    return mapError(error);
  }
}

// F13-14 Überfälligkeit manuell prüfen (installation.write; Service wirft
// ValidationError, wenn (noch) nicht überfällig). Manueller Auslöser, keine
// Automatik; Ergebnis nur als Feedback (Event-Pin deckt die DB-Seite,
// kein Event-Pin im E2E). Eingaben sind vorvalidiert (UUID), daher ist
// Service-ValidationError hier immer der Negativ-Befund → Erfolgs-Feedback.
export async function checkPlanningOverdueAction(
  _previous: PlanningRequestActionState,
  formData: FormData,
): Promise<PlanningRequestActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const requestId = uuidSchema.safeParse(formData.get("requestId"));
  if (!requestId.success) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "planning_request", (tx, ctx) =>
      checkPlanningRequestOverdue(tx, ctx, { requestId: requestId.data }),);
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Die Planungsanfrage ist überfällig." };
  } catch (error) {
    if (error instanceof PlanningRequestValidationError) {
      return { status: "success", message: "Die Planungsanfrage ist nicht überfällig." };
    }
    return mapError(error);
  }
}
