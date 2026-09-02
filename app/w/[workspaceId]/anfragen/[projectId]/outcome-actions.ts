"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PROJECT_OUTCOME_COMMAND_VERSION,
  ProjectLossReasonUnavailableError,
  ProjectOutcomeCannotFulfilLockedError,
  ProjectOutcomeConflictError,
  ProjectOutcomeIllegalTransitionError,
  ProjectOutcomeNotFoundError,
  ProjectOutcomeValidationError,
  changeProjectOutcome,
  projectOutcomeCommandV1Schema,
} from "@/modules/projects";

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const NON_NEGATIVE_INTEGER_PATTERN = /^(?:0|[1-9]\d*)$/u;
const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const COMMON_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "projectId",
  "expectedOutcomeRevision",
  "confirmation",
]);
const LOST_FIELDS = new Set([...COMMON_FIELDS, "lossReasonId", "lossReasonText"]);

export type ProjectOutcomeActionState =
  | { status: "idle" }
  | { status: "success"; outcome: "open" | "won" | "lost" | "cannot_fulfill"; outcomeRevision: number }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "illegal_transition" }
  | { status: "locked" }
  | { status: "loss_reason_unavailable" }
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

function mapError(error: unknown): ProjectOutcomeActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof ProjectOutcomeValidationError) return { status: "invalid" };
  if (error instanceof ProjectOutcomeNotFoundError) return { status: "not_found" };
  if (error instanceof ProjectOutcomeIllegalTransitionError) {
    return { status: "illegal_transition" };
  }
  if (error instanceof ProjectOutcomeCannotFulfilLockedError) {
    return { status: "locked" };
  }
  if (error instanceof ProjectLossReasonUnavailableError) {
    return { status: "loss_reason_unavailable" };
  }
  if (error instanceof ProjectOutcomeConflictError) {
    return error.currentRevision === undefined
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  return null;
}

export async function changeProjectOutcomeAction(
  rawWorkspaceId: string,
  _previousState: ProjectOutcomeActionState,
  formData: FormData,
): Promise<ProjectOutcomeActionState> {
  const parsedWorkspace = UUID_SCHEMA.safeParse(rawWorkspaceId);
  const kindValues = formData.getAll("kind");
  if (
    !parsedWorkspace.success
    || kindValues.length !== 1
    || typeof kindValues[0] !== "string"
  ) return { status: "invalid" };
  const fields = kindValues[0] === "mark_lost" ? LOST_FIELDS : COMMON_FIELDS;
  const entries = exactStringEntries(formData, fields);
  if (
    entries === null
    || !NON_NEGATIVE_INTEGER_PATTERN.test(entries.expectedOutcomeRevision ?? "")
  ) return { status: "invalid" };

  const candidate = {
    ...entries,
    schemaVersion: entries.schemaVersion ?? PROJECT_OUTCOME_COMMAND_VERSION,
    expectedOutcomeRevision: Number(entries.expectedOutcomeRevision),
    ...(entries.kind === "mark_lost"
      ? { lossReasonText: entries.lossReasonText === "" ? null : entries.lossReasonText }
      : {}),
  };
  const parsed = projectOutcomeCommandV1Schema.safeParse(candidate);
  if (!parsed.success) return { status: "invalid" };
  const workspaceId = parsedWorkspace.data;

  try {
    const result = await authorizedAction(
      workspaceId,
      "project.outcome.write",
      "project_outcome",
      (tx, ctx) => changeProjectOutcome(tx, ctx, parsed.data),
    );
    revalidatePath(`/w/${workspaceId}/anfragen`);
    revalidatePath(`/w/${workspaceId}/anfragen/abgeschlossen`);
    revalidatePath(`/w/${workspaceId}/anfragen/${result.projectId}`);
    return {
      status: "success",
      outcome: result.outcome,
      outcomeRevision: result.outcomeRevision,
    };
  } catch (error) {
    const mapped = mapError(error);
    if (
      mapped?.status === "conflict"
      || mapped?.status === "illegal_transition"
      || mapped?.status === "loss_reason_unavailable"
      || mapped?.status === "not_found"
    ) {
      const projectId = parsed.data.projectId;
      revalidatePath(`/w/${workspaceId}/anfragen`);
      revalidatePath(`/w/${workspaceId}/anfragen/abgeschlossen`);
      revalidatePath(`/w/${workspaceId}/anfragen/${projectId}`);
    }
    if (mapped) return mapped;
    throw error;
  }
}
