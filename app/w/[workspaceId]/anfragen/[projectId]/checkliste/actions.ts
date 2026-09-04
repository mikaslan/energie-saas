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
    // Bewusst KEIN revalidatePath im Save-Pfad: die Page rendert den
    // Manager mit key={checklist.version} (Remount bei Versionswechsel);
    // ein revalidatePath wuerde die Serverdaten sofort aktualisieren,
    // den Manager remounten und damit den Erfolgs-Toast (useActionState)
    // zerstoeren. Die Client-Ableitung traegt die neue Version
    // (baseVersion aus dem Action-State), ein Reload liest ohnehin
    // frische Serverdaten.
    return { status: "success", version: result.version };
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
    return { status: "success", version: result.version };
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
