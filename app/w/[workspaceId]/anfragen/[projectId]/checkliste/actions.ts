"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CHECKLIST_SCHEMA_VERSION,
  checklistPhaseSchema,
  editableChecklistBlocksSchema,
} from "@/lib/integrations/checklists/contract";
import {
  ChecklistConflictError,
  ChecklistNotFoundError,
  ChecklistSegmentIncompleteError,
  ChecklistValidationError,
  completeChecklistSegment,
  saveProjectChecklist,
  unlockChecklistSegment,
} from "@/modules/checklists";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type ChecklistActionState =
  | { status: "idle" }
  | {
      status: "success";
      operation: "save" | "apply" | "complete" | "unlock";
      version: number;
    }
  | { status: "incomplete"; remainingRequired: number }
  | { status: "invalid" }
  | { status: "conflict"; currentVersion?: number }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" }
  // W3-Härtung (f7-02-Diagnose): unerwartete Fehler nie still `idle`
  // lassen — sichtbarer Fehlerzustand, Details im Server-Log.
  | { status: "error" };

export async function saveProjectChecklistAction(
  _previous: ChecklistActionState,
  formData: FormData,
): Promise<ChecklistActionState> {
  const workspaceValue = formData.get("workspaceId");
  const projectValue = formData.get("projectId");
  const checklistValue = formData.get("checklistId");
  const phaseValue = formData.get("phase");
  const titleValue = formData.get("title");
  const baseVersionValue = formData.get("baseVersion");
  const blocksValue = formData.get("blocks");
  if (
    typeof workspaceValue !== "string"
    || typeof projectValue !== "string"
    || typeof checklistValue !== "string"
    || typeof phaseValue !== "string"
    || typeof titleValue !== "string"
    || typeof baseVersionValue !== "string"
    || typeof blocksValue !== "string"
  ) {
    return { status: "invalid" };
  }
  const workspace = workspaceIdSchema.safeParse(workspaceValue);
  const projectId = uuidSchema.safeParse(projectValue);
  const checklistId = checklistValue === "" ? null : uuidSchema.safeParse(checklistValue);
  const phase = checklistPhaseSchema.safeParse(phaseValue);
  const baseVersion = /^\d+$/u.test(baseVersionValue) ? Number(baseVersionValue) : null;
  if (
    !workspace.success
    || !projectId.success
    || (checklistId !== null && !checklistId.success)
    || !phase.success
    || titleValue.trim() === ""
    || baseVersion === null
  ) {
    return { status: "invalid" };
  }

  let rawBlocks: unknown;
  try {
    rawBlocks = JSON.parse(blocksValue);
  } catch {
    return { status: "invalid" };
  }
  const parsedBlocks = editableChecklistBlocksSchema.safeParse(rawBlocks);
  if (!parsedBlocks.success) return { status: "invalid" };

  try {
    const result = await authorizedAction(
      workspace.data,
      "checklist.write",
      "project_checklist",
      (tx, ctx) => saveProjectChecklist(tx, ctx, {
        schemaVersion: CHECKLIST_SCHEMA_VERSION,
        checklistId: checklistId === null ? null : checklistId.data,
        projectId: projectId.data,
        phase: phase.data,
        title: titleValue,
        baseVersion,
        blocks: parsedBlocks.data,
      }),
    );
    // Frische Serverdaten liefern bei einer Neuanlage auch die vom Server
    // erzeugte Checklist-ID. Der Manager ist nicht versions-gekeyed; sein
    // Action-Feedback bleibt beim Refresh erhalten.
    revalidatePath(`/w/${workspace.data}/anfragen/${projectId.data}/checkliste`);
    return { status: "success", operation: "save", version: result.version };
  } catch (error) {
    if (error instanceof ChecklistConflictError) {
      return { status: "conflict", currentVersion: typeof error.detail === "number" ? error.detail : undefined };
    }
    if (error instanceof ChecklistNotFoundError) return { status: "not_found" };
    if (error instanceof ChecklistValidationError) return { status: "invalid" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    console.error("[checkliste] saveProjectChecklistAction: unerwarteter Fehler", error);
    return { status: "error" };
  }
}

// F7.3: Vorlage auf dieses Projekt anwenden (ESTIMATE-Mapping).
import { applyChecklistTemplate } from "@/modules/checklists";

export async function applyTemplateAction(
  _previous: ChecklistActionState,
  formData: FormData,
): Promise<ChecklistActionState> {
  const workspaceValue = formData.get("workspaceId");
  const projectValue = formData.get("projectId");
  const templateValue = formData.get("templateId");
  if (
    typeof workspaceValue !== "string"
    || typeof projectValue !== "string"
    || typeof templateValue !== "string"
  ) {
    return { status: "invalid" };
  }
  const workspace = z.uuid().safeParse(workspaceValue);
  const projectId = z.uuid().safeParse(projectValue);
  const templateId = z.uuid().safeParse(templateValue);
  if (!workspace.success || !projectId.success || !templateId.success) {
    return { status: "invalid" };
  }
  try {
    const result = await authorizedAction(
      workspace.data,
      "checklist.write",
      "project_checklist",
      (tx, ctx) => applyChecklistTemplate(tx, ctx, {
        templateId: templateId.data,
        projectId: projectId.data,
      }),
    );
    // Apply MUSS revalidieren: die Server-Blocks aendern sich, und der
    // Manager uebernimmt sie ueber die versions-getaggte Ableitung
    // (kein Remount noetig — key entfernt, s. Page/Manager).
    revalidatePath(`/w/${workspace.data}/anfragen/${projectId.data}/checkliste`);
    return { status: "success", operation: "apply", version: result.version };
  } catch (error) {
    if (error instanceof ChecklistConflictError) return { status: "conflict" };
    if (error instanceof ChecklistNotFoundError) return { status: "not_found" };
    if (error instanceof ChecklistValidationError) return { status: "invalid" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    console.error("[checkliste] applyTemplateAction: unerwarteter Fehler", error);
    return { status: "error" };
  }
}

async function mutateSegment(
  operation: "complete" | "unlock",
  formData: FormData,
): Promise<ChecklistActionState> {
  const parsed = z.object({
    workspaceId: workspaceIdSchema,
    projectId: uuidSchema,
    checklistId: uuidSchema,
    segmentId: uuidSchema,
    baseVersion: z.string().regex(/^\d+$/u).transform(Number).pipe(z.number().int().min(1)),
  }).safeParse({
    workspaceId: formData.get("workspaceId"),
    projectId: formData.get("projectId"),
    checklistId: formData.get("checklistId"),
    segmentId: formData.get("segmentId"),
    baseVersion: formData.get("baseVersion"),
  });
  if (!parsed.success) return { status: "invalid" };

  const { workspaceId, ...command } = parsed.data;
  try {
    const result = await authorizedAction(
      workspaceId,
      operation === "complete" ? "checklist.write" : "checklist.unlock",
      "project_checklist",
      (tx, ctx) => operation === "complete"
        ? completeChecklistSegment(tx, ctx, {
            schemaVersion: CHECKLIST_SCHEMA_VERSION,
            ...command,
          })
        : unlockChecklistSegment(tx, ctx, {
            schemaVersion: CHECKLIST_SCHEMA_VERSION,
            ...command,
          }),
    );
    revalidatePath(`/w/${workspaceId}/anfragen/${command.projectId}/checkliste`);
    return { status: "success", operation, version: result.version };
  } catch (error) {
    if (error instanceof ChecklistSegmentIncompleteError) {
      return { status: "incomplete", remainingRequired: error.remainingRequired };
    }
    if (error instanceof ChecklistConflictError) {
      return {
        status: "conflict",
        currentVersion: typeof error.detail === "number" ? error.detail : undefined,
      };
    }
    if (error instanceof ChecklistNotFoundError) return { status: "not_found" };
    if (error instanceof ChecklistValidationError) return { status: "invalid" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    console.error(`[checkliste] ${operation}ChecklistSegmentAction: unerwarteter Fehler`, error);
    return { status: "error" };
  }
}

export async function mutateChecklistSegmentAction(
  _previous: ChecklistActionState,
  formData: FormData,
): Promise<ChecklistActionState> {
  const operation = z.enum(["complete", "unlock"]).safeParse(formData.get("operation"));
  if (!operation.success) return { status: "invalid" };
  return mutateSegment(operation.data, formData);
}
