"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  ProjectFileNotFoundError,
  ProjectFileValidationError,
  setProjectFileVisibility,
} from "@/modules/project-files";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type ProjectFileActionState =
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

function parseFileId(formData: FormData): string | null {
  const parsed = uuidSchema.safeParse(formData.get("fileId"));
  return parsed.success ? parsed.data : null;
}

function detailPath(workspaceId: string, projectId: string): string {
  return `/w/${workspaceId}/anfragen/${projectId}`;
}

function mapError(error: unknown): ProjectFileActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof ProjectFileNotFoundError) return { status: "not_found" };
  if (error instanceof ProjectFileValidationError) return { status: "invalid" };
  throw error;
}

// F10-17: Kunden-Sichtbarkeit je Datei toggeln (Checkbox je Zeile;
// nur canWrite sieht das Formular — Loader-Gate in page.tsx).
export async function setProjectFileVisibilityAction(
  _previous: ProjectFileActionState,
  formData: FormData,
): Promise<ProjectFileActionState> {
  const ids = parseIds(formData);
  const fileId = parseFileId(formData);
  const visibleValue = formData.get("visible");
  if (!ids || !fileId || (visibleValue !== "true" && visibleValue !== "false")) {
    return { status: "invalid" };
  }
  const visible = visibleValue === "true";
  try {
    await authorizedAction(ids.workspaceId, "project.write", "project_file", (tx, ctx) =>
      setProjectFileVisibility(tx, ctx, {
        projectId: ids.projectId,
        fileId,
        visible,
      }),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return {
      status: "success",
      message: visible ? "Für Kunden sichtbar." : "Nicht mehr für Kunden sichtbar.",
    };
  } catch (error) {
    return mapError(error);
  }
}
