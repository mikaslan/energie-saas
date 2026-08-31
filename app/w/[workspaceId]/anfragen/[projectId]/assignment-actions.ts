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
  PROJECT_ASSIGNMENT_COMMAND_VERSION,
  changeProjectAssignment as persistProjectAssignment,
  getProjectAssignmentContext,
  projectAssignmentCommandV1Schema,
  projectAssignmentSearchV1Schema,
  ProjectAssignmentConflictError,
  ProjectAssignmentLimitError,
  ProjectAssignmentNotFoundError,
  ProjectAssignmentRoleError,
  ProjectAssignmentTargetError,
  ProjectAssignmentValidationError,
  type ProjectAssignmentSearchResult,
} from "@/modules/projects";

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const SEARCH_FIELDS = new Set(["query"]);
const CLEAR_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "projectId",
  "expectedAssignmentRevision",
]);
const TARGET_FIELDS = new Set([...CLEAR_FIELDS, "membershipId"]);

export type ProjectAssignmentActionState =
  | { status: "idle" }
  | {
      status: "success";
      projectId: string;
      assignmentRevision: number;
      changed: boolean;
    }
  | { status: "invalid" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "target_unavailable" }
  | { status: "limit_reached" }
  | { status: "key_account_requires_clear" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

export type ProjectAssignmentSearchState =
  | { status: "idle" }
  | { status: "results"; query: string; results: ProjectAssignmentSearchResult[] }
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

function validatedRouteIds(
  workspaceId: string,
  projectId: string,
): { workspaceId: string; projectId: string } | null {
  const parsed = z.strictObject({
    workspaceId: UUID_SCHEMA,
    projectId: UUID_SCHEMA,
  }).safeParse({ workspaceId, projectId });
  return parsed.success ? parsed.data : null;
}

function mapMutationError(error: unknown): ProjectAssignmentActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof ProjectAssignmentValidationError) return { status: "invalid" };
  if (error instanceof ProjectAssignmentTargetError) return { status: "target_unavailable" };
  if (error instanceof ProjectAssignmentLimitError) return { status: "limit_reached" };
  if (error instanceof ProjectAssignmentRoleError) {
    return { status: "key_account_requires_clear" };
  }
  if (error instanceof ProjectAssignmentNotFoundError) return { status: "not_found" };
  if (error instanceof ProjectAssignmentConflictError) {
    return error.currentRevision === undefined
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  return null;
}

export async function membershipSearch(
  workspaceId: string,
  projectId: string,
  _previousState: ProjectAssignmentSearchState,
  formData: FormData,
): Promise<ProjectAssignmentSearchState> {
  const route = validatedRouteIds(workspaceId, projectId);
  const entries = exactStringEntries(formData, SEARCH_FIELDS);
  const parsed = entries === null
    ? null
    : projectAssignmentSearchV1Schema.safeParse(entries);
  if (!route || !parsed || !parsed.success) return { status: "invalid" };

  try {
    const context = await authorizedQuery(
      route.workspaceId,
      "project.assign",
      "project_assignment_search",
      (tx, ctx) => getProjectAssignmentContext(
        tx,
        ctx,
        route.projectId,
        parsed.data,
      ),
    );
    if (context === null) return { status: "not_found" };
    return context.searchResults.length === 0
      ? { status: "empty", query: parsed.data.query }
      : {
          status: "results",
          query: parsed.data.query,
          results: context.searchResults,
        };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof ProjectAssignmentValidationError) return { status: "invalid" };
    throw error;
  }
}

export async function changeProjectAssignment(
  rawWorkspaceId: string,
  _previousState: ProjectAssignmentActionState,
  formData: FormData,
): Promise<ProjectAssignmentActionState> {
  const parsedWorkspace = UUID_SCHEMA.safeParse(rawWorkspaceId);
  const kindValues = formData.getAll("kind");
  if (
    !parsedWorkspace.success
    || kindValues.length !== 1
    || typeof kindValues[0] !== "string"
  ) return { status: "invalid" };

  const clear = kindValues[0] === "clear_key_account";
  const entries = exactStringEntries(formData, clear ? CLEAR_FIELDS : TARGET_FIELDS);
  if (
    entries === null
    || !NON_NEGATIVE_INTEGER_PATTERN.test(entries.expectedAssignmentRevision ?? "")
  ) return { status: "invalid" };

  const parsed = projectAssignmentCommandV1Schema.safeParse({
    ...entries,
    schemaVersion: entries.schemaVersion ?? PROJECT_ASSIGNMENT_COMMAND_VERSION,
    expectedAssignmentRevision: Number(entries.expectedAssignmentRevision),
  });
  if (!parsed.success) return { status: "invalid" };

  const routeProject = UUID_SCHEMA.safeParse(parsed.data.projectId);
  if (!routeProject.success) return { status: "invalid" };
  const workspaceId = parsedWorkspace.data;

  try {
    const result = await authorizedAction(workspaceId, "project.assign", "project_assignment", (tx, ctx) =>
      persistProjectAssignment(tx, ctx, parsed.data));
    revalidatePath(`/w/${workspaceId}/anfragen`);
    revalidatePath(`/w/${workspaceId}/anfragen/${result.projectId}`);
    return {
      status: "success",
      projectId: result.projectId,
      assignmentRevision: result.assignmentRevision,
      changed: result.changed,
    };
  } catch (error) {
    const mapped = mapMutationError(error);
    if (mapped?.status === "conflict") {
      revalidatePath(`/w/${workspaceId}/anfragen`);
      revalidatePath(`/w/${workspaceId}/anfragen/${parsed.data.projectId}`);
    }
    if (mapped) return mapped;
    throw error;
  }
}
