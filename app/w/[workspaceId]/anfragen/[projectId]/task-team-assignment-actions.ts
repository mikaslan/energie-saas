"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  authorizedAction,
  authorizedQuery,
  NotAuthenticatedError,
} from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PROJECT_TASK_TEAM_ASSIGNMENT_COMMAND_VERSION,
  changeTaskTeamAssignment as persistTaskTeamAssignment,
  getTaskTeamAssignmentContext,
  projectTaskTeamAssignmentCommandV1Schema,
  ProjectTaskArchivedError,
  TaskTeamAssignmentConflictError,
  TaskTeamAssignmentLimitError,
  TaskTeamAssignmentNotFoundError,
  TaskTeamAssignmentTargetError,
  TaskTeamAssignmentValidationError,
  type TaskTeamAssignmentContext,
} from "@/modules/tasks";
import { listTeamOptions, type TeamOption } from "@/modules/teams";

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const TEAM_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "taskId",
  "expectedTeamAssignmentRevision",
  "teamId",
]);

export type TaskTeamAssignmentActionState =
  | { status: "idle" }
  | {
      status: "success";
      taskId: string;
      teamAssignmentRevision: number;
      changed: boolean;
    }
  | { status: "invalid" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "target_unavailable" }
  | { status: "limit_reached" }
  | { status: "not_found" }
  | { status: "archived" }
  | { status: "denied" }
  | { status: "unauthenticated" };

export type TaskTeamAssignmentLoadState =
  | { status: "ready"; context: TaskTeamAssignmentContext; teamOptions: TeamOption[]; commandVersion: string }
  | { status: "hidden" }
  | { status: "error" };

function exactStringEntries(
  formData: FormData,
  allowedFields: ReadonlySet<string>,
): Record<string, string> | null {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
    if (name.startsWith("$ACTION")) {
      if (!REACT_ACTION_FIELD_PATTERN.test(name)) return null;
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

function mapMutationError(error: unknown): TaskTeamAssignmentActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof TaskTeamAssignmentValidationError) return { status: "invalid" };
  if (error instanceof TaskTeamAssignmentTargetError) return { status: "target_unavailable" };
  if (error instanceof TaskTeamAssignmentLimitError) return { status: "limit_reached" };
  if (error instanceof TaskTeamAssignmentNotFoundError) return { status: "not_found" };
  if (error instanceof ProjectTaskArchivedError) return { status: "archived" };
  if (error instanceof TaskTeamAssignmentConflictError) {
    return typeof error.currentRevision !== "number"
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  return null;
}

function revalidateTaskTeamPaths(workspaceId: string, projectId: string): void {
  revalidatePath(`/w/${workspaceId}/anfragen/${projectId}`);
  revalidatePath(`/w/${workspaceId}/aufgaben`);
}

export async function loadTaskTeamAssignment(
  rawWorkspaceId: string,
  rawProjectId: string,
  rawTaskId: string,
): Promise<TaskTeamAssignmentLoadState> {
  const route = z.strictObject({
    workspaceId: UUID_SCHEMA,
    projectId: UUID_SCHEMA,
    taskId: UUID_SCHEMA,
  }).safeParse({ workspaceId: rawWorkspaceId, projectId: rawProjectId, taskId: rawTaskId });
  if (!route.success) return { status: "error" };

  try {
    const loaded = await authorizedQuery(
      route.data.workspaceId,
      "task.read",
      "project_task_team_assignment",
      async (tx, ctx) => ({
        context: await getTaskTeamAssignmentContext(tx, ctx, route.data.taskId),
        // F1-12-Guard: nur aktive Teams — ohne Leserecht bleibt die
        // Liste leer statt hart zu scheitern (Sektion zeigt Hinweis).
        teamOptions: await listTeamOptions(tx, ctx).catch((error: unknown) => {
          if (error instanceof PermissionDeniedError) return [];
          throw error;
        }),
      }),
    );
    if (loaded.context === null) return { status: "hidden" };
    // Befehls-Version kommt vom Server (Client importiert keine Modul-Konstanten).
    return { status: "ready", context: loaded.context, teamOptions: loaded.teamOptions, commandVersion: PROJECT_TASK_TEAM_ASSIGNMENT_COMMAND_VERSION };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "error" };
    if (error instanceof PermissionDeniedError) return { status: "hidden" };
    return { status: "error" };
  }
}

export async function changeTaskTeamAssignment(
  rawWorkspaceId: string,
  rawProjectId: string,
  _previousState: TaskTeamAssignmentActionState,
  formData: FormData,
): Promise<TaskTeamAssignmentActionState> {
  const route = z.strictObject({
    workspaceId: UUID_SCHEMA,
    projectId: UUID_SCHEMA,
  }).safeParse({ workspaceId: rawWorkspaceId, projectId: rawProjectId });
  const kindValues = formData.getAll("kind");
  if (
    !route.success
    || kindValues.length !== 1
    || typeof kindValues[0] !== "string"
  ) return { status: "invalid" };

  const entries = exactStringEntries(formData, TEAM_FIELDS);
  if (
    entries === null
    || !NON_NEGATIVE_INTEGER_PATTERN.test(entries.expectedTeamAssignmentRevision ?? "")
  ) return { status: "invalid" };

  const parsed = projectTaskTeamAssignmentCommandV1Schema.safeParse({
    ...entries,
    schemaVersion: entries.schemaVersion ?? PROJECT_TASK_TEAM_ASSIGNMENT_COMMAND_VERSION,
    expectedTeamAssignmentRevision: Number(entries.expectedTeamAssignmentRevision),
  });
  if (!parsed.success) return { status: "invalid" };

  const routeTask = UUID_SCHEMA.safeParse(parsed.data.taskId);
  if (!routeTask.success) return { status: "invalid" };
  const workspaceId = route.data.workspaceId;
  const projectId = route.data.projectId;

  try {
    const result = await authorizedAction(workspaceId, "task.write", "project_task_team_assignment", (tx, ctx) =>
      persistTaskTeamAssignment(tx, ctx, parsed.data));
    revalidateTaskTeamPaths(workspaceId, projectId);
    return {
      status: "success",
      taskId: result.taskId,
      teamAssignmentRevision: result.teamAssignmentRevision,
      changed: result.changed,
    };
  } catch (error) {
    const mapped = mapMutationError(error);
    if (mapped?.status === "conflict") {
      revalidateTaskTeamPaths(workspaceId, projectId);
    }
    if (mapped) return mapped;
    throw error;
  }
}
