"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  confirmProjectSitePin,
  SitePinNotConfirmableError,
} from "@/modules/projects";

const confirmPinInputSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
});

export type ConfirmProjectPinState =
  | { status: "idle" }
  | { status: "success" }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" }
  | { status: "not_confirmable" };

export async function confirmProjectSitePinAction(
  _previousState: ConfirmProjectPinState,
  formData: FormData,
): Promise<ConfirmProjectPinState> {
  const parsed = confirmPinInputSchema.safeParse({
    workspaceId: formData.get("workspaceId"),
    projectId: formData.get("projectId"),
  });
  if (!parsed.success) return { status: "invalid" };

  const { workspaceId, projectId } = parsed.data;
  try {
    await authorizedAction(
      workspaceId,
      "project.write",
      "site_pin",
      (tx, ctx) => confirmProjectSitePin(tx, ctx, { projectId }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      return { status: "unauthenticated" };
    }
    if (error instanceof PermissionDeniedError) {
      return { status: "denied" };
    }
    if (error instanceof SitePinNotConfirmableError) {
      return { status: "not_confirmable" };
    }
    throw error;
  }

  revalidatePath(`/w/${workspaceId}/anfragen/${projectId}`);
  revalidatePath(`/w/${workspaceId}/anfragen`);
  return { status: "success" };
}
