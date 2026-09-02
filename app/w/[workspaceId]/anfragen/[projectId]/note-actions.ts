"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  executeProjectNoteCommand,
  NOTE_TEXT_MAX_LENGTH,
  PROJECT_NOTE_COMMAND_VERSION,
  PROJECT_NOTE_MAX_REVISION,
  projectNoteCommandV1Schema,
  NoteConflictError,
  NoteNotFoundError,
  NoteValidationError,
  type ProjectNoteCommandV1,
} from "@/modules/notes";

const UUID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());
const POSITIVE_INTEGER_PATTERN = /^[1-9]\d*$/u;
const NOTE_TEXT_MAX_BYTES = NOTE_TEXT_MAX_LENGTH * 6 + 2;

export type ProjectNoteActionState =
  | { status: "idle" }
  | {
      status: "success";
      operation: ProjectNoteCommandV1["kind"];
      noteId: string;
      revision: number;
      changed: boolean;
    }
  | { status: "invalid" }
  | { status: "conflict"; currentRevision?: number }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

const CREATE_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "projectId",
  "textMarkdown",
  "pinned",
]);
const UPDATE_TEXT_FIELDS = new Set([
  ...CREATE_FIELDS,
  "noteId",
  "expectedRevision",
]);
const PIN_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "projectId",
  "noteId",
  "expectedRevision",
  "pinned",
]);
const DELETE_FIELDS = new Set([
  "schemaVersion",
  "kind",
  "projectId",
  "noteId",
  "expectedRevision",
]);

function exactStringEntries(
  formData: FormData,
  allowedFields: ReadonlySet<string>,
): Record<string, string> | null {
  const values = new Map<string, string>();
  for (const [name, value] of formData.entries()) {
    if (typeof value !== "string" || values.has(name)) return null;
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

function parseRevision(value: string | undefined): number | null {
  if (!value || !POSITIVE_INTEGER_PATTERN.test(value)) return null;
  const revision = Number(value);
  return Number.isSafeInteger(revision) && revision <= PROJECT_NOTE_MAX_REVISION
    ? revision
    : null;
}

function parseBoolean(value: string | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function commandCandidate(
  kind: string,
  entries: Record<string, string>,
): Record<string, unknown> | null {
  if (entries.schemaVersion !== PROJECT_NOTE_COMMAND_VERSION) return null;
  const base = { schemaVersion: entries.schemaVersion, kind, projectId: entries.projectId };
  if (kind === "create_note") {
    return { ...base, textMarkdown: entries.textMarkdown, pinned: entries.pinned === "true" };
  }
  const expectedRevision = parseRevision(entries.expectedRevision);
  if (expectedRevision === null) return null;
  const revisionBase = { ...base, noteId: entries.noteId, expectedRevision };
  if (kind === "update_note_text") {
    return { ...revisionBase, textMarkdown: entries.textMarkdown };
  }
  if (kind === "set_note_pinned") {
    const pinned = parseBoolean(entries.pinned);
    if (pinned === null) return null;
    return { ...revisionBase, pinned };
  }
  if (kind === "delete_note") return revisionBase;
  return null;
}

function mapError(error: unknown): ProjectNoteActionState | null {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NoteValidationError) return { status: "invalid" };
  if (error instanceof NoteNotFoundError) return { status: "not_found" };
  if (error instanceof NoteConflictError) {
    return error.currentRevision === undefined
      ? { status: "conflict" }
      : { status: "conflict", currentRevision: error.currentRevision };
  }
  return null;
}

export async function changeProjectNote(
  rawWorkspaceId: string,
  rawBoundProjectId: string,
  _previousState: ProjectNoteActionState,
  formData: FormData,
): Promise<ProjectNoteActionState> {
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

  const kind = kindValues[0];
  const allowed = kind === "create_note"
    ? CREATE_FIELDS
    : kind === "update_note_text"
      ? UPDATE_TEXT_FIELDS
      : kind === "set_note_pinned"
        ? PIN_FIELDS
        : kind === "delete_note"
          ? DELETE_FIELDS
          : null;
  if (allowed === null) return { status: "invalid" };

  const entries = exactStringEntries(formData, allowed);
  const candidate = entries === null ? null : commandCandidate(kind, entries);
  const parsed = candidate === null ? null : projectNoteCommandV1Schema.safeParse(candidate);
  if (
    parsed === null
    || !parsed.success
    || parsed.data.projectId !== route.data.projectId
  ) return { status: "invalid" };

  // Serverseitige Byte-Grenze vor der Action (DoS-Schranke, analog task-actions).
  if (
    parsed.data.kind === "create_note" || parsed.data.kind === "update_note_text"
  ) {
    if (new TextEncoder().encode(parsed.data.textMarkdown).byteLength > NOTE_TEXT_MAX_BYTES) {
      return { status: "invalid" };
    }
  }

  try {
    const result = await authorizedAction(
      route.data.workspaceId,
      "note.write",
      "project_note",
      (tx, ctx) => executeProjectNoteCommand(tx, ctx, parsed.data),
    );
    revalidatePath(`/w/${route.data.workspaceId}/anfragen/${route.data.projectId}`);
    return {
      status: "success",
      operation: parsed.data.kind,
      noteId: result.noteId,
      revision: result.revision,
      changed: result.changed,
    };
  } catch (error) {
    const mapped = mapError(error);
    if (mapped?.status === "conflict") {
      revalidatePath(`/w/${route.data.workspaceId}/anfragen/${route.data.projectId}`);
    }
    return mapped ?? { status: "invalid" };
  }
}
