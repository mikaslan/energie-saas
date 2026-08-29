"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { moveProjectCard, ProjectMoveConflictError } from "@/modules/boards";

const moveInputSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
  expectedColumnId: z.uuid(),
  targetColumnId: z.uuid(),
});

export type MoveProjectState =
  | { status: "idle" }
  | {
      status: "success";
      projectId: string;
      sourceColumnId: string;
      targetColumnId: string;
      changed: boolean;
    }
  | { status: "conflict"; projectId: string }
  | { status: "invalid" }
  | { status: "unauthenticated" }
  | { status: "denied" };

export async function moveProjectAction(
  workspaceId: string,
  _previousState: MoveProjectState,
  formData: FormData,
): Promise<MoveProjectState> {
  const parsed = moveInputSchema.safeParse({
    workspaceId,
    projectId: formData.get("projectId"),
    expectedColumnId: formData.get("expectedColumnId"),
    targetColumnId: formData.get("targetColumnId"),
  });
  if (!parsed.success) return { status: "invalid" };

  const input = parsed.data;
  try {
    const result = await authorizedAction(
      input.workspaceId,
      "project.write",
      "project_kanban",
      (tx, ctx) => moveProjectCard(tx, ctx, {
        projectId: input.projectId,
        expectedColumnId: input.expectedColumnId,
        targetColumnId: input.targetColumnId,
      }),
    );
    revalidatePath(`/w/${input.workspaceId}/anfragen`);
    revalidatePath(`/w/${input.workspaceId}/anfragen/${input.projectId}`);
    return {
      status: "success",
      projectId: result.projectId,
      sourceColumnId: input.expectedColumnId,
      targetColumnId: result.columnId,
      changed: result.changed,
    };
  } catch (error) {
    if (error instanceof ProjectMoveConflictError) {
      revalidatePath(`/w/${input.workspaceId}/anfragen`);
      return { status: "conflict", projectId: input.projectId };
    }
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    throw error;
  }
}
