"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { PROJECT_TASK_MAX_ASSIGNEES, PROJECT_TASK_MAX_CHECKLIST_ITEMS, PROJECT_TASK_MAX_LABELS, taskLabelColors, type TaskLabelColor } from "@/lib/integrations/tasks/contract";
import { TASK_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/tasks/template-contract";
import {
  archiveTaskTemplate,
  createTaskTemplate,
  restoreTaskTemplate,
  searchTaskTemplateMembers,
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

export type TaskTemplateMemberSearchState =
  | { status: "idle" }
  | {
      status: "results";
      query: string;
      members: { membershipId: string; label: string }[];
      hasMore: boolean;
    }
  | { status: "empty"; query: string }
  | { status: "invalid" }
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

function parseIdList(value: FormDataEntryValue | null): string[] | null {
  if (typeof value !== "string" || value.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    const ids = [...new Set(parsed)];
    if (!ids.every((id) => typeof id === "string" && z.string().uuid().safeParse(id).success)) {
      return null;
    }
    return ids as string[];
  } catch {
    return null;
  }
}

// F16-04d: Checklisten-Textarea (eine Zeile je Punkt; leer = ohne).
// Trim + Leerzeilen-Drop serverseitig; Text-Bereich/Steuerzeichen und
// Cap prüft der Service fail-closed (nichts still kappen).
function parseChecklistItems(value: FormDataEntryValue | null): { text: string }[] | null {
  if (typeof value !== "string" || value.trim() === "") return [];
  const items = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((text) => ({ text }));
  if (items.length > PROJECT_TASK_MAX_CHECKLIST_ITEMS) return null;
  if (!items.every((item) => item.text.length <= 500)) return null;
  return items;
}

// F16-04e: Label-Textarea (eine Zeile je Label: `Name` oder
// `Name | farbe`; Farbe eine der sechs Task-Farben, Default slate).
// Trim + Leerzeilen-Drop serverseitig; Bereich/Duplikat/Cap prüft der
// Service fail-closed (nichts still kappen).
const TEMPLATE_LABEL_COLORS = new Set<string>(taskLabelColors);
function parseLabelItems(value: FormDataEntryValue | null): { name: string; color: TaskLabelColor }[] | null {
  if (typeof value !== "string" || value.trim() === "") return [];
  const items: { name: string; color: TaskLabelColor }[] = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === "") continue;
    const [rawName, rawColor, ...rest] = line.split("|");
    if (rest.length > 0) return null;
    const name = (rawName ?? "").normalize("NFKC").trim();
    if (name.length < 1 || name.length > 40 || /[\p{Cc}\p{Cf}]/u.test(name)) return null;
    let color: TaskLabelColor = "slate";
    if (rawColor !== undefined) {
      const parsed = rawColor.normalize("NFKC").trim().toLowerCase();
      if (!TEMPLATE_LABEL_COLORS.has(parsed)) return null;
      color = parsed as TaskLabelColor;
    }
    items.push({ name, color });
  }
  if (items.length > PROJECT_TASK_MAX_LABELS) return null;
  return items;
}

function parseFields(formData: FormData):
  | { name: string; title: string; dueOffsetDays: number | null; position: number; assigneeMembershipIds: string[]; checklistItems: { text: string }[]; labelItems: { name: string; color: TaskLabelColor }[] }
  | null {
  const name = parseText(formData.get("name"), 200);
  const title = parseText(formData.get("title"), 200);
  const positionValue = formData.get("position");
  const dueOffsetDays = parseDueOffset(formData.get("dueOffsetDays"));
  if (name === null || title === null || dueOffsetDays === undefined) return null;
  if (typeof positionValue !== "string" || !/^\d+$/u.test(positionValue)) return null;
  const position = Number(positionValue);
  if (!Number.isSafeInteger(position) || position < 0) return null;
  // F16-04b: Bearbeiter als JSON-Liste (UUIDs, max Cap); fehlend = leer.
  // F16-04c: erhaltene Ausgeschiedene als zweite JSON-Liste (gleiche
  // Form); Union geht an den Service — Create verweigert sie (nicht
  // live), Update erhält nur bereits gespeicherte (Service-Guard).
  const assigneeMembershipIds = parseIdList(formData.get("assigneeMembershipIds"));
  const departedIds = parseIdList(formData.get("departedAssigneeMembershipIds"));
  if (assigneeMembershipIds === null || departedIds === null) return null;
  const merged = [...new Set([...assigneeMembershipIds, ...departedIds])];
  if (merged.length > PROJECT_TASK_MAX_ASSIGNEES) return null;
  const checklistItems = parseChecklistItems(formData.get("checklistText"));
  if (checklistItems === null) return null;
  const labelItems = parseLabelItems(formData.get("labelText"));
  if (labelItems === null) return null;
  return { name, title, dueOffsetDays, position, assigneeMembershipIds: merged, checklistItems, labelItems };
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
        assigneeMembershipIds: fields.assigneeMembershipIds,
        checklistItems: fields.checklistItems,
        labelItems: fields.labelItems,
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
        assigneeMembershipIds: fields.assigneeMembershipIds,
        checklistItems: fields.checklistItems,
        labelItems: fields.labelItems,
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

// F16-04b: workspace-weite Mitgliedersuche für Bearbeiter-Auswahl
// (task.write wie Vorlagen-CRUD; Query ≥ 2 Zeichen serverseitig,
// Limit wie Projektsuche — keine Voll-Enumeration).
export async function searchTaskTemplateMembersAction(
  rawWorkspaceId: string,
  _previousState: TaskTemplateMemberSearchState,
  formData: FormData,
): Promise<TaskTemplateMemberSearchState> {
  const workspace = workspaceIdSchema.safeParse(rawWorkspaceId);
  const queryValue = formData.get("query");
  if (!workspace.success || typeof queryValue !== "string") return { status: "invalid" };
  try {
    const page = await authorizedQuery(
      workspace.data,
      "task.write",
      "task_template",
      (tx, ctx) => searchTaskTemplateMembers(tx, ctx, { query: queryValue }),
    );
    return page.members.length === 0
      ? { status: "empty", query: page.query }
      : {
          status: "results",
          query: page.query,
          members: page.members,
          hasMore: page.hasMore,
        };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    return { status: "invalid" };
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
