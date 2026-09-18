"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  authorizedAction,
  NotAuthenticatedError,
} from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PROJECT_TEAM_ASSIGNMENT_COMMAND_VERSION,
  changeProjectTeamAssignment as persistProjectTeamAssignment,
  projectTeamAssignmentCommandV1Schema,
  ProjectTeamAssignmentConflictError,
  ProjectTeamAssignmentLimitError,
  ProjectTeamAssignmentNotFoundError,
  ProjectTeamAssignmentTargetError,
  ProjectTeamAssignmentValidationError,
} from "@/modules/projects";

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const TEAM_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "projectId",
  "expectedTeamAssignmentRevision",
  "teamId",
]);

export type ProjectTeamAssignmentActionState =
  | { status: "idle" }
  | {
      status: "success";
      projectId: string;
      teamAssignmentRevision: number;
      changed: boolean;
    }
  | { status: "invalid" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "target_unavailable" }
  | { status: "limit_reached" }
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

function mapMutationError(error: unknown): ProjectTeamAssignmentActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof ProjectTeamAssignmentValidationError) return { status: "invalid" };
  if (error instanceof ProjectTeamAssignmentTargetError) return { status: "target_unavailable" };
  if (error instanceof ProjectTeamAssignmentLimitError) return { status: "limit_reached" };
  if (error instanceof ProjectTeamAssignmentNotFoundError) return { status: "not_found" };
  if (error instanceof ProjectTeamAssignmentConflictError) {
    return typeof error.currentRevision !== "number"
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  return null;
}

export async function changeProjectTeamAssignment(
  rawWorkspaceId: string,
  _previousState: ProjectTeamAssignmentActionState,
  formData: FormData,
): Promise<ProjectTeamAssignmentActionState> {
  const parsedWorkspace = UUID_SCHEMA.safeParse(rawWorkspaceId);
  const kindValues = formData.getAll("kind");
  if (
    !parsedWorkspace.success
    || kindValues.length !== 1
    || typeof kindValues[0] !== "string"
  ) return { status: "invalid" };

  const entries = exactStringEntries(formData, TEAM_FIELDS);
  if (
    entries === null
    || !NON_NEGATIVE_INTEGER_PATTERN.test(entries.expectedTeamAssignmentRevision ?? "")
  ) return { status: "invalid" };

  const parsed = projectTeamAssignmentCommandV1Schema.safeParse({
    ...entries,
    schemaVersion: entries.schemaVersion ?? PROJECT_TEAM_ASSIGNMENT_COMMAND_VERSION,
    expectedTeamAssignmentRevision: Number(entries.expectedTeamAssignmentRevision),
  });
  if (!parsed.success) return { status: "invalid" };

  const routeProject = UUID_SCHEMA.safeParse(parsed.data.projectId);
  if (!routeProject.success) return { status: "invalid" };
  const workspaceId = parsedWorkspace.data;

  try {
    const result = await authorizedAction(workspaceId, "project.assign", "project_team_assignment", (tx, ctx) =>
      persistProjectTeamAssignment(tx, ctx, parsed.data));
    revalidatePath(`/w/${workspaceId}/anfragen`);
    revalidatePath(`/w/${workspaceId}/anfragen/${result.projectId}`);
    return {
      status: "success",
      projectId: result.projectId,
      teamAssignmentRevision: result.teamAssignmentRevision,
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
