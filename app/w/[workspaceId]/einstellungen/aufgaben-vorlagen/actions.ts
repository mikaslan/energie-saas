"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { TASK_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/tasks/template-contract";
import {
  archiveTaskTemplate,
  createTaskTemplate,
  restoreTaskTemplate,
  TaskTemplateConflictError,
  TaskTemplateNotFoundError,
  TaskTemplateValidationError,
  updateTaskTemplate,
} from "@/modules/tasks";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type TaskTemplateActionState =
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

function parseText(value: FormDataEntryValue | null, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.normalize("NFKC").trim();
  if (text.length < 1 || text.length > max || /[\p{Cc}\p{Cf}]/u.test(text)) return null;
  return text;
}

// Leer = ohne Fälligkeit (null); sonst ganze Tage 0..3650.
function parseDueOffset(value: FormDataEntryValue | null): number | null | undefined {
  if (typeof value !== "string" || value.trim() === "") return null;
  if (!/^\d{1,4}$/u.test(value.trim())) return undefined;
  const days = Number(value.trim());
  return Number.isSafeInteger(days) && days <= 3650 ? days : undefined;
}

function parseFields(formData: FormData):
  | { name: string; title: string; dueOffsetDays: number | null; position: number }
  | null {
  const name = parseText(formData.get("name"), 200);
  const title = parseText(formData.get("title"), 200);
  const positionValue = formData.get("position");
  const dueOffsetDays = parseDueOffset(formData.get("dueOffsetDays"));
  if (name === null || title === null || dueOffsetDays === undefined) return null;
  if (typeof positionValue !== "string" || !/^\d+$/u.test(positionValue)) return null;
  const position = Number(positionValue);
  if (!Number.isSafeInteger(position) || position < 0) return null;
  return { name, title, dueOffsetDays, position };
}

function mapError(error: unknown): TaskTemplateActionState {
  if (error instanceof TaskTemplateValidationError) return { status: "invalid" };
  if (error instanceof TaskTemplateConflictError) return { status: "conflict" };
  if (error instanceof TaskTemplateNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

const SETTINGS_PATH = (workspace: string): string => `/w/${workspace}/einstellungen/aufgaben-vorlagen`;

export async function createTaskTemplateAction(
  _previous: TaskTemplateActionState,
  formData: FormData,
): Promise<TaskTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const fields = parseFields(formData);
  if (!workspace || !fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "task.write", "task_template", (tx, ctx) =>
      createTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        name: fields.name,
        title: fields.title,
        dueOffsetDays: fields.dueOffsetDays,
        position: fields.position,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Vorlage angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updateTaskTemplateAction(
  _previous: TaskTemplateActionState,
  formData: FormData,
): Promise<TaskTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  const fields = parseFields(formData);
  if (!workspace || !id?.success || !fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "task.write", "task_template", (tx, ctx) =>
      updateTaskTemplate(tx, ctx, {
        schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
        id: id.data,
        name: fields.name,
        title: fields.title,
        dueOffsetDays: fields.dueOffsetDays,
        position: fields.position,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Vorlage aktualisiert." };
  } catch (error) {
    return mapError(error);
  }
}

async function toggleActive(
  workspace: string,
  id: string,
  active: boolean,
): Promise<TaskTemplateActionState> {
  try {
    await authorizedAction(workspace, "task.write", "task_template", (tx, ctx) =>
      active
        ? restoreTaskTemplate(tx, ctx, {
          schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
          id,
          active: true,
        })
        : archiveTaskTemplate(tx, ctx, {
          schemaVersion: TASK_TEMPLATE_SCHEMA_VERSION,
          id,
          active: false,
        }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: active ? "Vorlage reaktiviert." : "Vorlage archiviert." };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveTaskTemplateAction(
  _previous: TaskTemplateActionState,
  formData: FormData,
): Promise<TaskTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleActive(workspace, id.data, false);
}

export async function restoreTaskTemplateAction(
  _previous: TaskTemplateActionState,
  formData: FormData,
): Promise<TaskTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  const id = typeof idValue === "string" ? idSchema.safeParse(idValue) : null;
  if (!workspace || !id?.success) return { status: "invalid" };
  return toggleActive(workspace, id.data, true);
}
