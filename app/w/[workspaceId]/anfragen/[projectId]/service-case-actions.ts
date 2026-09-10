"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  createServiceCase,
  ServiceCaseNotFoundError,
  ServiceCaseValidationError,
  setServiceCaseStatus,
  type ServiceCaseStatus,
} from "@/modules/service-cases";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type ServiceCaseActionState =
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

function mapError(error: unknown): ServiceCaseActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof ServiceCaseNotFoundError) return { status: "not_found" };
  if (error instanceof ServiceCaseValidationError) return { status: "invalid" };
  throw error;
}

export async function createServiceCaseAction(
  _previous: ServiceCaseActionState,
  formData: FormData,
): Promise<ServiceCaseActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const titleValue = formData.get("title");
  const descriptionValue = formData.get("description");
  const dueDateValue = formData.get("dueDate");
  const title = typeof titleValue === "string" ? titleValue : "";
  const description = typeof descriptionValue === "string" && descriptionValue.trim() !== ""
    ? descriptionValue
    : null;
  const dueDate = typeof dueDateValue === "string" && dueDateValue !== "" ? dueDateValue : null;
  if (title.trim() === "") return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "service_case", (tx, ctx) =>
      createServiceCase(tx, ctx, {
        projectId: ids.projectId,
        title,
        description,
        dueDate,
      }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Servicevorgang angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

const statuses: readonly ServiceCaseStatus[] = ["open", "in_progress", "done", "cancelled"];

export async function setServiceCaseStatusAction(
  _previous: ServiceCaseActionState,
  formData: FormData,
): Promise<ServiceCaseActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const idValue = formData.get("id");
  const statusValue = formData.get("status");
  const id = typeof idValue === "string" ? idValue : "";
  const status = typeof statusValue === "string" ? statusValue : "";
  if (!statuses.includes(status as ServiceCaseStatus)) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "service_case", (tx, ctx) =>
      setServiceCaseStatus(tx, ctx, { id, status: status as ServiceCaseStatus }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Status geändert." };
  } catch (error) {
    if (error instanceof ServiceCaseValidationError) return { status: "conflict" };
    return mapError(error);
  }
}
