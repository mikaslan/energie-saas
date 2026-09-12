"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PlanningRequestConflictError,
  PlanningRequestNotFoundError,
  PlanningRequestValidationError,
  requestPlanning,
  setPlanningStatus,
  type PlanningDeadlineKind,
  type PlanningRequestStatus,
} from "@/modules/planning-requests";

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
