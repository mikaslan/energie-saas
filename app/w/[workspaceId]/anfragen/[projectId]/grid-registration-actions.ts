"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  ensureGridRegistration,
  GridRegistrationNotFoundError,
  gridRegistrationStatuses,
  GridRegistrationValidationError,
  setGridRegistrationDetails,
  transitionGridRegistration,
  type GridRegistrationStatus,
} from "@/modules/grid-registration";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type GridRegistrationActionState =
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

function mapError(error: unknown): GridRegistrationActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof GridRegistrationNotFoundError) return { status: "not_found" };
  if (error instanceof GridRegistrationValidationError) return { status: "invalid" };
  throw error;
}

function detailPath(workspaceId: string, projectId: string): string {
  return `/w/${workspaceId}/anfragen/${projectId}`;
}

// F13-02: Anlage ist idempotent (ein Datensatz je Projekt).
export async function ensureGridRegistrationAction(
  _previous: GridRegistrationActionState,
  formData: FormData,
): Promise<GridRegistrationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "grid_registration", (tx, ctx) =>
      ensureGridRegistration(tx, ctx, ids.projectId),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Netzanmeldung angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

function optionalText(value: FormDataEntryValue | null, max: number): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return value.trim().slice(0, max);
}

export async function setGridRegistrationDetailsAction(
  _previous: GridRegistrationActionState,
  formData: FormData,
): Promise<GridRegistrationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const operatorName = optionalText(formData.get("operatorName"), 160);
  const meterNumber = optionalText(formData.get("meterNumber"), 64);
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "grid_registration", (tx, ctx) =>
      setGridRegistrationDetails(tx, ctx, {
        projectId: ids.projectId,
        operatorName,
        meterNumber,
      }),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Angaben gespeichert." };
  } catch (error) {
    return mapError(error);
  }
}

export async function transitionGridRegistrationAction(
  _previous: GridRegistrationActionState,
  formData: FormData,
): Promise<GridRegistrationActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const statusValue = formData.get("status");
  const status = typeof statusValue === "string" ? statusValue : "";
  if (!(gridRegistrationStatuses as readonly string[]).includes(status)) {
    return { status: "invalid" };
  }
  try {
    await authorizedAction(ids.workspaceId, "installation.write", "grid_registration", (tx, ctx) =>
      transitionGridRegistration(tx, ctx, {
        projectId: ids.projectId,
        status: status as GridRegistrationStatus,
      }),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Status geändert." };
  } catch (error) {
    if (error instanceof GridRegistrationValidationError) return { status: "conflict" };
    return mapError(error);
  }
}
