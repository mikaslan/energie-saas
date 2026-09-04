"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CHECKLIST_SCHEMA_VERSION,
  checklistBlocksSchema,
  type ChecklistBlocksV1,
} from "@/lib/integrations/checklists/contract";
import {
  ChecklistConflictError,
  ChecklistNotFoundError,
  ChecklistValidationError,
  saveProjectChecklist,
} from "@/modules/checklists";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type ChecklistActionState =
  | { status: "idle" }
  | { status: "success"; version: number }
  | { status: "invalid" }
  | { status: "conflict"; currentVersion?: number }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

export async function saveProjectChecklistAction(
  _previous: ChecklistActionState,
  formData: FormData,
): Promise<ChecklistActionState> {
  const workspaceValue = formData.get("workspaceId");
  const projectValue = formData.get("projectId");
  const baseVersionValue = formData.get("baseVersion");
  const blocksValue = formData.get("blocks");
  if (
    typeof workspaceValue !== "string"
    || typeof projectValue !== "string"
    || typeof baseVersionValue !== "string"
    || typeof blocksValue !== "string"
  ) {
    return { status: "invalid" };
  }
  const workspace = workspaceIdSchema.safeParse(workspaceValue);
  const projectId = uuidSchema.safeParse(projectValue);
  const baseVersion = /^\d+$/u.test(baseVersionValue) ? Number(baseVersionValue) : null;
  if (!workspace.success || !projectId.success || baseVersion === null) {
    return { status: "invalid" };
  }

  let rawBlocks: unknown;
  try {
    rawBlocks = JSON.parse(blocksValue);
  } catch {
    return { status: "invalid" };
  }
  const parsedBlocks = checklistBlocksSchema.safeParse(rawBlocks);
  if (!parsedBlocks.success) return { status: "invalid" };
  const blocks = parsedBlocks.data as ChecklistBlocksV1;

  try {
    const result = await authorizedAction(
      workspace.data,
      "checklist.write",
      "project_checklist",
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        projectId: projectId.data,
        baseVersion,
        blocks,
      }),
    );
    revalidatePath(`/w/${workspace.data}/anfragen/${projectId.data}/checkliste`);
    return { status: "success", version: result.version };
  } catch (error) {
    if (error instanceof ChecklistConflictError) {
      return { status: "conflict", currentVersion: error.currentVersion };
    }
    if (error instanceof ChecklistNotFoundError) return { status: "not_found" };
    if (error instanceof ChecklistValidationError) return { status: "invalid" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    throw error;
  }
}
