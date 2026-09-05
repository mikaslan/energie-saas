"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  completeInstallation,
  createInstallation,
  InstallationConflictError,
  InstallationNotFoundError,
  InstallationValidationError,
} from "@/modules/installations";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type InstallationActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseIds(formData: FormData): { workspaceId: string; projectId: string } | null {
  const workspaceValue = formData.get("workspaceId");
  const projectValue = formData.get("projectId");
  if (typeof workspaceValue !== "string" || typeof projectValue !== "string") return null;
  const workspace = workspaceIdSchema.safeParse(workspaceValue);
  const project = idSchema.safeParse(projectValue);
  if (!workspace.success || !project.success) return null;
  return { workspaceId: workspace.data, projectId: project.data };
}

function mapError(error: unknown): InstallationActionState {
  if (error instanceof InstallationValidationError) return { status: "invalid" };
  if (error instanceof InstallationConflictError) return { status: "conflict" };
  if (error instanceof InstallationNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

export async function createInstallationAction(
  _previous: InstallationActionState,
  formData: FormData,
): Promise<InstallationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "installation", (tx, ctx) =>
      createInstallation(tx, ctx, { projectId: ids.projectId }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Installation angelegt — das Projekt steht auf Installation." };
  } catch (error) {
    return mapError(error);
  }
}

export async function completeInstallationAction(
  _previous: InstallationActionState,
  formData: FormData,
): Promise<InstallationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "installation", (tx, ctx) =>
      completeInstallation(tx, ctx, { projectId: ids.projectId }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    return { status: "success", message: "Installation abgeschlossen." };
  } catch (error) {
    return mapError(error);
  }
}
