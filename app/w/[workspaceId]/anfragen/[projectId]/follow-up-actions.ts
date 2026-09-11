"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { berlinDateToIso } from "@/lib/follow-up";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  FollowUpNotFoundError,
  FollowUpValidationError,
  setProjectFollowUp,
} from "@/modules/projects";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type FollowUpActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseIds(formData: FormData): { workspaceId: string; projectId: string } | null {
  const workspaceId = workspaceIdSchema.safeParse(formData.get("workspaceId"));
  const projectId = uuidSchema.safeParse(formData.get("projectId"));
  if (!workspaceId.success || !projectId.success) return null;
  return { workspaceId: workspaceId.data, projectId: projectId.data };
}

function mapError(error: unknown): FollowUpActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof FollowUpNotFoundError) return { status: "not_found" };
  if (error instanceof FollowUpValidationError) return { status: "invalid" };
  throw error;
}

// F1-06: <input type="date"> liefert ein Kalenderdatum ohne Zone —
// 09:00 Berlin, DST-sicher (Bänder sind tagesbasiert).
export async function setFollowUpAction(
  _previous: FollowUpActionState,
  formData: FormData,
): Promise<FollowUpActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const dateValue = formData.get("followUpDate");
  const followUpAt = typeof dateValue === "string" ? berlinDateToIso(dateValue) : null;
  if (followUpAt === null) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "project.write", "project", (tx, ctx) =>
      setProjectFollowUp(tx, ctx, { projectId: ids.projectId, followUpAt }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    revalidatePath(`/w/${ids.workspaceId}/anfragen`);
    return { status: "success", message: "Wiedervorlage gespeichert." };
  } catch (error) {
    return mapError(error);
  }
}

export async function clearFollowUpAction(
  _previous: FollowUpActionState,
  formData: FormData,
): Promise<FollowUpActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "project.write", "project", (tx, ctx) =>
      setProjectFollowUp(tx, ctx, { projectId: ids.projectId, followUpAt: null }),
    );
    revalidatePath(`/w/${ids.workspaceId}/anfragen/${ids.projectId}`);
    revalidatePath(`/w/${ids.workspaceId}/anfragen`);
    return { status: "success", message: "Wiedervorlage gelöscht." };
  } catch (error) {
    return mapError(error);
  }
}
