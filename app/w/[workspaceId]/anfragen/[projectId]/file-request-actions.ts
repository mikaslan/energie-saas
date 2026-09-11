"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { authorizedAction, authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  createFileRequest,
  downloadFileRequest,
  FileRequestConflictError,
  FileRequestNotFoundError,
  FileRequestValidationError,
  fileRequestStatuses,
  transitionFileRequest,
  type FileRequestStatus,
} from "@/modules/file-requests";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

export type FileRequestActionState =
  | { status: "idle" }
  | { status: "success"; message: string }
  | { status: "invalid" }
  | { status: "conflict" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

export type FileRequestDownloadState =
  | { status: "idle" }
  | { status: "ready"; filename: string; contentType: string; base64: string }
  | { status: "invalid" }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

function parseIds(formData: FormData): { workspaceId: string; projectId: string } | null {
  const workspaceId = workspaceIdSchema.safeParse(formData.get("workspaceId"));
  const projectId = uuidSchema.safeParse(formData.get("projectId"));
  if (!workspaceId.success || !projectId.success) return null;
  return { workspaceId: workspaceId.data, projectId: projectId.data };
}

function parseRequestId(formData: FormData): string | null {
  const parsed = uuidSchema.safeParse(formData.get("requestId"));
  return parsed.success ? parsed.data : null;
}

function detailPath(workspaceId: string, projectId: string): string {
  return `/w/${workspaceId}/anfragen/${projectId}`;
}

function mapError(error: unknown): FileRequestActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof FileRequestNotFoundError) return { status: "not_found" };
  if (error instanceof FileRequestConflictError) return { status: "conflict" };
  if (error instanceof FileRequestValidationError) return { status: "invalid" };
  throw error;
}

// F10-04: Anfrage anlegen (Titel + optionale Beschreibung).
export async function createFileRequestAction(
  _previous: FileRequestActionState,
  formData: FormData,
): Promise<FileRequestActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid" };
  const title = formData.get("title");
  const description = formData.get("description");
  if (typeof title !== "string") return { status: "invalid" };
  if (description !== null && typeof description !== "string") return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "project.write", "file_request", (tx, ctx) =>
      createFileRequest(tx, ctx, {
        projectId: ids.projectId,
        title,
        description: description && description.trim().length > 0 ? description : null,
      }),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Datei-Anfrage angelegt." };
  } catch (error) {
    return mapError(error);
  }
}

// F10-04: Folge-Übergänge (storniert aus offen, erledigt aus hochgeladen).
export async function transitionFileRequestAction(
  _previous: FileRequestActionState,
  formData: FormData,
): Promise<FileRequestActionState> {
  const ids = parseIds(formData);
  const requestId = parseRequestId(formData);
  const status = formData.get("status");
  if (!ids || !requestId || typeof status !== "string") return { status: "invalid" };
  if (!(fileRequestStatuses as readonly string[]).includes(status)) return { status: "invalid" };
  try {
    await authorizedAction(ids.workspaceId, "project.write", "file_request", (tx, ctx) =>
      transitionFileRequest(tx, ctx, {
        projectId: ids.projectId,
        requestId,
        status: status as FileRequestStatus,
      }),
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: "Datei-Anfrage aktualisiert." };
  } catch (error) {
    return mapError(error);
  }
}

// F10-04: Beleg laden (Base64-Daten-URL im Client; kein signierter
// URL-Umweg, kein neues Routen-Segment). project.read genügt.
export async function downloadFileRequestAction(
  _previous: FileRequestDownloadState,
  formData: FormData,
): Promise<FileRequestDownloadState> {
  const ids = parseIds(formData);
  const requestId = parseRequestId(formData);
  if (!ids || !requestId) return { status: "invalid" };
  try {
    const got = await authorizedQuery(ids.workspaceId, "project.read", "file_request", (tx, ctx) =>
      downloadFileRequest(tx, ctx, { projectId: ids.projectId, requestId }),
    );
    return {
      status: "ready",
      filename: got.filename,
      contentType: got.contentType,
      base64: got.body.toString("base64"),
    };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { status: "denied" };
    if (error instanceof FileRequestNotFoundError) return { status: "not_found" };
    if (error instanceof FileRequestValidationError) return { status: "invalid" };
    throw error;
  }
}

export type { FileRequestStatus };
