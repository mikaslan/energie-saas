"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  CHECKLIST_TEMPLATE_SCHEMA_VERSION,
  checklistTemplateItemsSchema,
  checklistTemplateTargetsSchema,
} from "@/lib/integrations/checklists/template-contract";
import {
  archiveChecklistTemplate,
  ChecklistConflictError,
  ChecklistNotFoundError,
  ChecklistValidationError,
  createChecklistTemplate,
  restoreChecklistTemplate,
  updateChecklistTemplate,
} from "@/modules/checklists";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type TemplateActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseWorkspace(formData: FormData): string | null {
  const value = formData.get("workspaceId");
  if (typeof value !== "string") return null;
  const parsed = workspaceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseFields(formData: FormData):
  | { name: string; description: string | null; position: number; targets: string[]; items: unknown }
  | null {
  const nameValue = formData.get("name");
  const positionValue = formData.get("position");
  if (typeof nameValue !== "string" || typeof positionValue !== "string") return null;
  const name = nameValue.normalize("NFKC").trim();
  if (name.length < 1 || name.length > 200) return null;
  const position = /^\d+$/u.test(positionValue) ? Number(positionValue) : NaN;
  if (!Number.isSafeInteger(position) || position < 0) return null;

  const descriptionValue = formData.get("description");
  const description = typeof descriptionValue === "string" && descriptionValue.trim() !== ""
    ? descriptionValue.normalize("NFKC").trim()
    : null;

  const targetsValue = formData.get("targets");
  let targets: string[] = [];
  if (typeof targetsValue === "string" && targetsValue.trim() !== "") {
    targets = targetsValue.split(",").map((v) => v.normalize("NFKC").trim()).filter((v) => v !== "");
  }
  if (!checklistTemplateTargetsSchema.safeParse(targets).success) return null;

  const itemsValue = formData.get("items");
  let items: unknown = [];
  if (typeof itemsValue === "string" && itemsValue.trim() !== "") {
    try {
      items = JSON.parse(itemsValue);
    } catch {
      return null;
    }
  }
  if (!checklistTemplateItemsSchema.safeParse(items).success) return null;

  return { name, description, position, targets, items };
}

function mapError(error: unknown): TemplateActionState {
  if (error instanceof ChecklistValidationError) return { status: "invalid" };
  if (error instanceof ChecklistConflictError) return { status: "conflict" };
  if (error instanceof ChecklistNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

export async function createTemplateAction(
  _previous: TemplateActionState,
  formData: FormData,
): Promise<TemplateActionState> {
  const workspace = parseWorkspace(formData);
  const fields = parseFields(formData);
  if (!workspace || !fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "checklist.write", "checklist_template", (tx, ctx) =>
      createChecklistTemplate(tx, ctx, {
        schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
        name: fields.name,
        description: fields.description,
        position: fields.position,
        targets: fields.targets,
        items: fields.items as never,
      }),
    );
    revalidatePath(`/w/${workspace}/einstellungen/checklisten-vorlagen`);
    return { status: "success", message: "Vorlage angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updateTemplateAction(
  _previous: TemplateActionState,
  formData: FormData,
): Promise<TemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  const fields = parseFields(formData);
  if (!workspace || !id?.success || !fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "checklist.write", "checklist_template", (tx, ctx) =>
      updateChecklistTemplate(tx, ctx, {
        schemaVersion: CHECKLIST_TEMPLATE_SCHEMA_VERSION,
        id: id.data,
        name: fields.name,
        description: fields.description,
        position: fields.position,
        targets: fields.targets,
        items: fields.items as never,
      }),
    );
    revalidatePath(`/w/${workspace}/einstellungen/checklisten-vorlagen`);
    return { status: "success", message: "Vorlage aktualisiert." };
  } catch (error) {
    return mapError(error);
  }
}

async function toggleActive(
  workspace: string,
  id: string,
  active: boolean,
): Promise<TemplateActionState> {
  try {
    await authorizedAction(workspace, "checklist.write", "checklist_template", (tx, ctx) =>
      active
        ? restoreChecklistTemplate(tx, ctx, id)
        : archiveChecklistTemplate(tx, ctx, id),
    );
    revalidatePath(`/w/${workspace}/einstellungen/checklisten-vorlagen`);
    return { status: "success", message: active ? "Vorlage reaktiviert." : "Vorlage archiviert." };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveTemplateAction(
  _previous: TemplateActionState,
  formData: FormData,
): Promise<TemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleActive(workspace, id.data, false);
}

export async function restoreTemplateAction(
  _previous: TemplateActionState,
  formData: FormData,
): Promise<TemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleActive(workspace, id.data, true);
}
