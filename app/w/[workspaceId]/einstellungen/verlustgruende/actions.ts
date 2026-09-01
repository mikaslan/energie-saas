"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PROJECT_LOSS_REASON_COMMAND_VERSION,
  ProjectLossReasonConflictError,
  ProjectLossReasonNotFoundError,
  ProjectLossReasonValidationError,
  changeProjectLossReason,
  projectLossReasonCommandV1Schema,
} from "@/modules/projects";

const REACT_ACTION_FIELD_PATTERN = /^(?:\$ACTION_KEY|\$ACTION_(?:ID|REF)_[A-Za-z0-9_-]+|\$ACTION_[A-Za-z0-9_-]+:\d+)$/u;
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;
const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const CREATE_FIELDS = new Set(["schemaVersion", "kind", "label"]);
const REACTIVATE_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "reasonId",
  "expectedRevision",
]);
const ARCHIVE_FIELDS = new Set([...REACTIVATE_FIELDS, "archiveConfirmation"]);

export type ProjectLossReasonActionState =
  | { status: "idle" }
  | { status: "success"; operation: "create" | "archive" | "reactivate"; revision: number }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "conflict"; currentRevision?: number }
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

function mapError(error: unknown): ProjectLossReasonActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof ProjectLossReasonValidationError) return { status: "invalid" };
  if (error instanceof ProjectLossReasonNotFoundError) return { status: "not_found" };
  if (error instanceof ProjectLossReasonConflictError) {
    return error.currentRevision === undefined
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  return null;
}

export async function changeProjectLossReasonAction(
  rawWorkspaceId: string,
  _previousState: ProjectLossReasonActionState,
  formData: FormData,
): Promise<ProjectLossReasonActionState> {
  const parsedWorkspace = UUID_SCHEMA.safeParse(rawWorkspaceId);
  const kindValues = formData.getAll("kind");
  if (
    !parsedWorkspace.success
    || kindValues.length !== 1
    || typeof kindValues[0] !== "string"
  ) return { status: "invalid" };
  const fields = kindValues[0] === "create"
    ? CREATE_FIELDS
    : kindValues[0] === "archive" ? ARCHIVE_FIELDS : REACTIVATE_FIELDS;
  const entries = exactStringEntries(formData, fields);
  if (entries === null) return { status: "invalid" };
  if (
    entries.kind !== "create"
    && !POSITIVE_INTEGER_PATTERN.test(entries.expectedRevision ?? "")
  ) return { status: "invalid" };

  const parsed = projectLossReasonCommandV1Schema.safeParse({
    ...entries,
    schemaVersion: entries.schemaVersion ?? PROJECT_LOSS_REASON_COMMAND_VERSION,
    ...(entries.kind === "create"
      ? {}
      : { expectedRevision: Number(entries.expectedRevision) }),
  });
  if (!parsed.success) return { status: "invalid" };
  const workspaceId = parsedWorkspace.data;

  try {
    const record = await authorizedAction(
      workspaceId,
      "settings.manage",
      "project_loss_reason",
      (tx, ctx) => changeProjectLossReason(tx, ctx, parsed.data),
    );
    revalidatePath(`/w/${workspaceId}/einstellungen/verlustgruende`);
    revalidatePath(`/w/${workspaceId}/anfragen`, "layout");
    return {
      status: "success",
      operation: parsed.data.kind,
      revision: record.revision,
    };
  } catch (error) {
    const mapped = mapError(error);
    if (mapped?.status === "conflict") {
      revalidatePath(`/w/${workspaceId}/einstellungen/verlustgruende`);
    }
    if (mapped) return mapped;
    throw error;
  }
}
