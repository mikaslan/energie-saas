"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  executeProjectTaskCommand,
  PROJECT_TASK_MAX_CHECKLIST_ITEMS,
  PROJECT_TASK_MAX_CHECKLIST_TEXT_LENGTH,
  PROJECT_TASK_MAX_REVISION,
  projectTaskCommandV1Schema,
  projectTaskMemberSearchV1Schema,
  ProjectTaskArchivedError,
  ProjectTaskConflictError,
  ProjectTaskIllegalTransitionError,
  ProjectTaskLimitError,
  ProjectTaskNotFoundError,
  ProjectTaskValidationError,
  TASK_RICH_TEXT_MAX_BYTES,
  TASK_RICH_TEXT_MAX_DEPTH,
  TASK_RICH_TEXT_MAX_NODES,
  type ProjectTaskCommandV1,
  searchProjectTaskMembers as findProjectTaskMembers,
  type ProjectTaskMemberOptionV1,
} from "@/modules/tasks";

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const MAX_REACT_ACTION_FIELDS = 16;
const MAX_REACT_ACTION_FIELD_NAME_LENGTH = 256;
const MAX_REACT_ACTION_METADATA_BYTES = 128 * 1024;
// JSON.stringify kann ein einzelnes, unverbundenes UTF-16-Surrogat als
// sechs ASCII-Bytes ("\\ud800") ausgeben. 128 Bytes pro Eintrag decken Keys,
// Boolean, optionale UUID und Trennzeichen ab.
const MAX_JSON_BYTES_PER_UTF16_CODE_UNIT = 6;
const MAX_CHECKLIST_ITEM_JSON_OVERHEAD_BYTES = 128;
const MAX_CHECKLIST_JSON_BYTES = 2 + PROJECT_TASK_MAX_CHECKLIST_ITEMS * (
  PROJECT_TASK_MAX_CHECKLIST_TEXT_LENGTH * MAX_JSON_BYTES_PER_UTF16_CODE_UNIT
  + MAX_CHECKLIST_ITEM_JSON_OVERHEAD_BYTES
);
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;
const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const QUICK_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "projectId",
  "title",
]);
const CREATE_FIELDS = new Set([
  ...QUICK_FIELDS,
  "bodyJson",
  "dueDate",
  "assigneeIdsJson",
  "checklistJson",
  "labelsJson",
]);
const UPDATE_FIELDS = new Set([
  ...CREATE_FIELDS,
  "taskId",
  "expectedRevision",
]);
const REVISION_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "projectId",
  "taskId",
  "expectedRevision",
]);
const TOGGLE_FIELDS = new Set([
  ...REVISION_FIELDS,
  "checklistItemId",
  "done",
]);
const ARCHIVE_FIELDS = new Set([...REVISION_FIELDS, "archiveConfirmation"]);
const MEMBER_SEARCH_FIELDS = new Set(["query"]);
const JSON_FIELD_LIMITS = {
  bodyJson: TASK_RICH_TEXT_MAX_BYTES + 2_048,
  assigneeIdsJson: 4_096,
  checklistJson: MAX_CHECKLIST_JSON_BYTES,
  labelsJson: 8 * 1_024,
} as const;

export type ProjectTaskActionState =
  | { status: "idle" }
  | {
      status: "success";
      operation: ProjectTaskCommandV1["kind"];
      taskId: string;
      revision: number;
      changed: boolean;
    }
  | { status: "invalid" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "illegal_transition" }
  | { status: "archived" }
  | { status: "limit_reached" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

export type ProjectTaskMemberSearchState =
  | { status: "idle" }
  | {
      status: "results";
      query: string;
      members: ProjectTaskMemberOptionV1[];
      hasMore: boolean;
    }
  | { status: "empty"; query: string }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function exactStringEntries(
  formData: FormData,
  allowedFields: ReadonlySet<string>,
): Record<string, string> | null {
  const values = new Map<string, string>();
  let reactFieldCount = 0;
  let reactMetadataBytes = 0;
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
    if (name.startsWith("$ACTION")) {
      if (
        name.length > MAX_REACT_ACTION_FIELD_NAME_LENGTH
        || value.length > MAX_REACT_ACTION_METADATA_BYTES
        || !REACT_ACTION_FIELD_PATTERN.test(name)
      ) return null;
      reactFieldCount += 1;
      reactMetadataBytes += new TextEncoder().encode(name).byteLength;
      reactMetadataBytes += new TextEncoder().encode(value).byteLength;
      if (
        reactFieldCount > MAX_REACT_ACTION_FIELDS
        || reactMetadataBytes > MAX_REACT_ACTION_METADATA_BYTES
      ) return null;
      values.set(name, value);
      continue;
    }
    if (!allowedFields.has(name)) return null;
    values.set(name, value);
  }
  const domainEntries = [...values].filter(([name]) => !name.startsWith("$ACTION"));
  if (
    domainEntries.length !== allowedFields.size
    || ![...allowedFields].every((name) => values.has(name))
  ) return null;
  return Object.fromEntries(domainEntries);
}

function allowedFields(kind: string): ReadonlySet<string> | null {
  if (kind === "quick_create") return QUICK_FIELDS;
  if (kind === "create") return CREATE_FIELDS;
  if (kind === "update") return UPDATE_FIELDS;
  if (kind === "toggle_checklist_item") return TOGGLE_FIELDS;
  if (kind === "complete" || kind === "reopen") return REVISION_FIELDS;
  if (kind === "archive") return ARCHIVE_FIELDS;
  return null;
}

type ParsedJson = { ok: true; value: unknown } | { ok: false };

function parseBoundedJson(value: string, maxBytes: number): ParsedJson {
  if (new TextEncoder().encode(value).byteLength > maxBytes) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(value) as unknown };
  } catch {
    return { ok: false };
  }
}

function hasBoundedBodyJsonShape(value: unknown): boolean {
  const maxDepth = TASK_RICH_TEXT_MAX_DEPTH * 2 + 4;
  const maxValues = TASK_RICH_TEXT_MAX_NODES * 8 + 32;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    visited += 1;
    if (visited > maxValues || current.depth > maxDepth) return false;
    if (typeof current.value !== "object" || current.value === null) continue;
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (const child of children) {
      pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return true;
}

function parseRevision(value: string | undefined): number | null {
  if (!value || !POSITIVE_INTEGER_PATTERN.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision <= PROJECT_TASK_MAX_REVISION
    ? revision
    : null;
}

function parseFullFields(entries: Record<string, string>): {
  body: unknown;
  dueDate: string | null;
  assigneeMembershipIds: unknown;
  checklist: unknown;
  labels: unknown;
} | null {
  const body = parseBoundedJson(entries.bodyJson ?? "", JSON_FIELD_LIMITS.bodyJson);
  const assignees = parseBoundedJson(
    entries.assigneeIdsJson ?? "",
    JSON_FIELD_LIMITS.assigneeIdsJson,
  );
  const checklist = parseBoundedJson(
    entries.checklistJson ?? "",
    JSON_FIELD_LIMITS.checklistJson,
  );
  const labels = parseBoundedJson(entries.labelsJson ?? "", JSON_FIELD_LIMITS.labelsJson);
  if (
    !body.ok
    || !hasBoundedBodyJsonShape(body.value)
    || !assignees.ok
    || !checklist.ok
    || !labels.ok
  ) return null;
  return {
    body: body.value,
    dueDate: entries.dueDate === "" ? null : entries.dueDate ?? null,
    assigneeMembershipIds: assignees.value,
    checklist: checklist.value,
    labels: labels.value,
  };
}

function commandCandidate(
  kind: string,
  entries: Record<string, string>,
): Record<string, unknown> | null {
  const base = {
    schemaVersion: entries.schemaVersion,
    kind,
    projectId: entries.projectId,
  };
  if (kind === "quick_create") return { ...base, title: entries.title };

  if (kind === "create" || kind === "update") {
    const full = parseFullFields(entries);
    if (!full) return null;
    if (kind === "create") return { ...base, title: entries.title, ...full };
    const expectedRevision = parseRevision(entries.expectedRevision);
    if (expectedRevision === null) return null;
    return {
      ...base,
      taskId: entries.taskId,
      expectedRevision,
      title: entries.title,
      ...full,
    };
  }

  const expectedRevision = parseRevision(entries.expectedRevision);
  if (expectedRevision === null) return null;
  const revisionBase = {
    ...base,
    taskId: entries.taskId,
    expectedRevision,
  };
  if (kind === "toggle_checklist_item") {
    if (entries.done !== "true" && entries.done !== "false") return null;
    return {
      ...revisionBase,
      checklistItemId: entries.checklistItemId,
      done: entries.done === "true",
    };
  }
  if (kind === "archive") {
    return { ...revisionBase, archiveConfirmation: entries.archiveConfirmation };
  }
  if (kind === "complete" || kind === "reopen") return revisionBase;
  return null;
}

function mapError(error: unknown): ProjectTaskActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof ProjectTaskValidationError) return { status: "invalid" };
  if (error instanceof ProjectTaskNotFoundError) return { status: "not_found" };
  if (error instanceof ProjectTaskIllegalTransitionError) {
    return { status: "illegal_transition" };
  }
  if (error instanceof ProjectTaskArchivedError) return { status: "archived" };
  if (error instanceof ProjectTaskLimitError) return { status: "limit_reached" };
  if (error instanceof ProjectTaskConflictError) {
    return error.currentRevision === undefined
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  return null;
}

function revalidateTaskPaths(workspaceId: string, projectId: string): void {
  revalidatePath(`/w/${workspaceId}/anfragen/${projectId}`);
  revalidatePath(`/w/${workspaceId}/aufgaben`);
}

export async function searchProjectTaskMembers(
  rawWorkspaceId: string,
  rawProjectId: string,
  _previousState: ProjectTaskMemberSearchState,
  formData: FormData,
): Promise<ProjectTaskMemberSearchState> {
  const route = z.strictObject({
    workspaceId: UUID_SCHEMA,
    projectId: UUID_SCHEMA,
  }).safeParse({ workspaceId: rawWorkspaceId, projectId: rawProjectId });
  const entries = exactStringEntries(formData, MEMBER_SEARCH_FIELDS);
  const parsed = entries === null
    ? null
    : projectTaskMemberSearchV1Schema.safeParse(entries);
  if (!route.success || parsed === null || !parsed.success) {
    return { status: "invalid" };
  }

  try {
    const page = await authorizedQuery(
      route.data.workspaceId,
      "task.write",
      "project_task_member_search",
      (tx, ctx) => findProjectTaskMembers(
        tx,
        ctx,
        route.data.projectId,
        parsed.data,
      ),
    );
    if (page === null) return { status: "not_found" };
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
    if (error instanceof ProjectTaskNotFoundError) return { status: "not_found" };
    return { status: "invalid" };
  }
}

export async function changeProjectTask(
  rawWorkspaceId: string,
  rawBoundProjectId: string,
  _previousState: ProjectTaskActionState,
  formData: FormData,
): Promise<ProjectTaskActionState> {
  const route = z.strictObject({
    workspaceId: UUID_SCHEMA,
    projectId: UUID_SCHEMA,
  }).safeParse({ workspaceId: rawWorkspaceId, projectId: rawBoundProjectId });
  const kindValues = formData.getAll("kind");
  if (
    !route.success
    || kindValues.length !== 1
    || typeof kindValues[0] !== "string"
  ) return { status: "invalid" };

  const fields = allowedFields(kindValues[0]);
  const entries = fields === null ? null : exactStringEntries(formData, fields);
  const candidate = entries === null ? null : commandCandidate(kindValues[0], entries);
  const parsed = candidate === null ? null : projectTaskCommandV1Schema.safeParse(candidate);
  if (
    parsed === null
    || !parsed.success
    || parsed.data.projectId !== route.data.projectId
  ) return { status: "invalid" };

  try {
    const result = await authorizedAction(
      route.data.workspaceId,
      "task.write",
      "project_task",
      (tx, ctx) => executeProjectTaskCommand(tx, ctx, parsed.data),
    );
    revalidateTaskPaths(route.data.workspaceId, route.data.projectId);
    return {
      status: "success",
      operation: parsed.data.kind,
      taskId: result.taskId,
      revision: result.revision,
      changed: result.changed,
    };
  } catch (error) {
    const mapped = mapError(error);
    if (mapped?.status === "conflict") {
      revalidateTaskPaths(route.data.workspaceId, route.data.projectId);
    }
    return mapped ?? { status: "invalid" };
  }
}
