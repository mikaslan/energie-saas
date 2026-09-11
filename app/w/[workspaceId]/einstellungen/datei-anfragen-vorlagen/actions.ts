"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { FILE_REQUEST_TEMPLATE_SCHEMA_VERSION } from "@/lib/file-request-template";
import {
  archiveFileRequestTemplate,
  createFileRequestTemplate,
  FileRequestTemplateConflictError,
  FileRequestTemplateNotFoundError,
  FileRequestTemplateValidationError,
  restoreFileRequestTemplate,
  updateFileRequestTemplate,
} from "@/modules/file-requests";

const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());
const idSchema = z.uuid();

export type FileRequestTemplateActionState =
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

function parseOptionalText(value: FormDataEntryValue | null, max: number): string | null | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.normalize("NFKC").trim();
  if (text.length === 0) return null;
  if (text.length > max || /[\p{Cc}\p{Cf}]/u.test(text)) return undefined;
  return text;
}

function parseFields(formData: FormData):
  | { name: string; title: string; description: string | null; position: number }
  | null {
  const name = parseText(formData.get("name"), 200);
  const title = parseText(formData.get("title"), 160);
  const description = parseOptionalText(formData.get("description"), 2000);
  const positionValue = formData.get("position");
  if (name === null || title === null || description === undefined) return null;
  if (typeof positionValue !== "string" || !/^\d+$/u.test(positionValue)) return null;
  const position = Number(positionValue);
  if (!Number.isSafeInteger(position) || position < 0) return null;
  return { name, title, description, position };
}

function mapError(error: unknown): FileRequestTemplateActionState {
  if (error instanceof FileRequestTemplateValidationError) return { status: "invalid" };
  if (error instanceof FileRequestTemplateConflictError) return { status: "conflict" };
  if (error instanceof FileRequestTemplateNotFoundError) return { status: "not_found" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  throw error;
}

const SETTINGS_PATH = (workspace: string): string => `/w/${workspace}/einstellungen/datei-anfragen-vorlagen`;

export async function createFileRequestTemplateAction(
  _previous: FileRequestTemplateActionState,
  formData: FormData,
): Promise<FileRequestTemplateActionState> {
  const workspace = parseWorkspace(formData);
  if (!workspace) return { status: "invalid" };
  const fields = parseFields(formData);
  if (!fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "project.write", "file_request_template", (tx, ctx) =>
      createFileRequestTemplate(tx, ctx, {
        schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
        ...fields,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Vorlage angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

export async function updateFileRequestTemplateAction(
  _previous: FileRequestTemplateActionState,
  formData: FormData,
): Promise<FileRequestTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  if (!workspace || typeof idValue !== "string") return { status: "invalid" };
  const parsedId = idSchema.safeParse(idValue);
  const fields = parseFields(formData);
  if (!parsedId.success || !fields) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "project.write", "file_request_template", (tx, ctx) =>
      updateFileRequestTemplate(tx, ctx, {
        schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
        id: parsedId.data,
        ...fields,
      }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message: "Vorlage gespeichert." };
  } catch (error) {
    return mapError(error);
  }
}

async function setActive(
  formData: FormData,
  active: boolean,
  message: string,
): Promise<FileRequestTemplateActionState> {
  const workspace = parseWorkspace(formData);
  const idValue = formData.get("id");
  if (!workspace || typeof idValue !== "string") return { status: "invalid" };
  const parsedId = idSchema.safeParse(idValue);
  if (!parsedId.success) return { status: "invalid" };
  try {
    await authorizedAction(workspace, "project.write", "file_request_template", (tx, ctx) =>
      active
        ? restoreFileRequestTemplate(tx, ctx, {
          schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
          id: parsedId.data,
          active,
        })
        : archiveFileRequestTemplate(tx, ctx, {
          schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
          id: parsedId.data,
          active,
        }),
    );
    revalidatePath(SETTINGS_PATH(workspace));
    return { status: "success", message };
  } catch (error) {
    return mapError(error);
  }
}

export async function archiveFileRequestTemplateAction(
  _previous: FileRequestTemplateActionState,
  formData: FormData,
): Promise<FileRequestTemplateActionState> {
  return setActive(formData, false, "Vorlage archiviert.");
}

export async function restoreFileRequestTemplateAction(
  _previous: FileRequestTemplateActionState,
  formData: FormData,
): Promise<FileRequestTemplateActionState> {
  return setActive(formData, true, "Vorlage reaktiviert.");
}
