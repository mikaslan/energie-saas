// F7-16 Projekt-Dateien: interner Upload + Liste + Download je Projekt
// (PDF/JPEG/PNG, 25 MiB, WORM unter immutable/<projekt>/project-files/).
// INTERN-NUR auf Service-Ebene (alle 3 Ops): project.read ist NICHT
// internalOnly — ohne explizites Gate saehen externe Projektleser interne
// Dateien (Visible-Flag-Folgeslice). Berechtigung: project.read/write
// (KEINE neuen Keys). Re-Upload derselben Bytes = NEUE Zeile (kein
// Dedupe, kein Ueberschreiben — append-only; WORM-Konflikt faellt
// fail-closed, nur bei UUID-Kollision moeglich).
import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { immutableKey, resolveObjectStorage } from "@/lib/storage";

export class ProjectFileNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super("project file not found");
    this.name = "ProjectFileNotFoundError";
  }
}

export class ProjectFileValidationError extends Error {
  constructor(message = "project file validation failed") {
    super(message);
    this.name = "ProjectFileValidationError";
  }
}

// Upload-Grenzen (ESTIMATE, reversibel): 25 MiB, PDF/JPEG/PNG.
// Groesser als 10-MiB-foto/file-request (Plaene/Datenblaetter-PDFs).
export const PROJECT_FILE_MAX_BYTES = 26_214_400;
export const PROJECT_FILE_NAME_MAX = 180;
export const PROJECT_FILE_CONTENT_TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;

// Spiegelt den DB-CHECK (0181); Service-Key plus Download-Guard.
export const PROJECT_FILE_KEY_PATTERN =
  /^immutable\/[0-9a-f-]{36}\/project-files\/[0-9a-f-]{36}_[0-9a-f]{8}\.(pdf|jpg|jpeg|png)$/;

export type ProjectFileDto = {
  id: string;
  originalFilename: string;
  contentType: string;
  byteSize: number;
  createdAt: string;
};

type ProjectFileRow = {
  id: string;
  original_filename: string;
  content_type: string;
  byte_size: number;
  created_at: Date | string;
  [key: string]: unknown;
};

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const uploadSchema = z.strictObject({
  projectId: uuidSchema,
  filename: z.string().trim().min(1).max(PROJECT_FILE_NAME_MAX),
  contentType: z.string().min(1).max(128),
});

function requireRead(ctx: ServiceCtx, projectId: string): void {
  if (isExternalOnly(ctx) || !can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", "project_file", projectId, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx, projectId: string): void {
  if (isExternalOnly(ctx) || !can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", "project_file", projectId, ctx.actor);
  }
}

async function requireProject(tx: TenantTx, ctx: ServiceCtx, projectId: string): Promise<void> {
  const project = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     limit 1
  `);
  if (!project.rows[0]) throw new ProjectFileNotFoundError(projectId);
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export type UploadProjectFileInput = {
  projectId: string;
  bytes: Uint8Array;
  filename: string;
  contentType: string;
};

export async function uploadProjectFile(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UploadProjectFileInput,
): Promise<{ fileId: string }> {
  requireWrite(ctx, input.projectId);
  const parsed = uploadSchema.safeParse({
    projectId: input.projectId,
    filename: input.filename,
    contentType: input.contentType,
  });
  if (!parsed.success) throw new ProjectFileValidationError();
  const { projectId, filename } = parsed.data;
  const contentType = parsed.data.contentType.toLowerCase();
  const expectedExt = (PROJECT_FILE_CONTENT_TYPES as Record<string, string>)[contentType];
  if (!expectedExt) throw new ProjectFileValidationError("content type not allowed");
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > PROJECT_FILE_MAX_BYTES) {
    throw new ProjectFileValidationError("byte size out of range");
  }
  // jpeg-Endungstoleranz (foto-Muster): .jpg/.jpeg, sonst exakter Match.
  // Die validierte Endung bleibt erhalten (kein Normalisieren auf jpg).
  const lowerName = filename.toLowerCase();
  const actualExt = lowerName.includes(".") ? lowerName.split(".").pop()! : "";
  const extensionOk = contentType === "image/jpeg"
    ? actualExt === "jpg" || actualExt === "jpeg"
    : actualExt === expectedExt;
  if (!extensionOk) throw new ProjectFileValidationError("filename extension mismatch");

  // Fail-fast VOR dem Storage-Put: kein Orphan bei Fremdprojekt.
  await requireProject(tx, ctx, projectId);

  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const fileId = randomUUID();
  const storageKey = immutableKey(
    projectId,
    "project-files",
    `${fileId}_${sha256.slice(0, 8)}.${actualExt}`,
  );
  let stored: { key: string; sha256: string };
  try {
    stored = await resolveObjectStorage().putImmutable(
      storageKey, Buffer.from(input.bytes), contentType,
    );
  } catch (error) {
    // WORM-Konflikt fail-closed (keine Idempotenz — der Key enthaelt
    // eine frische UUID; nur bei Kollision moeglich). Konflikt-
    // Erkennung wie foto (LocalStorage + S3-Conditional-Write-412).
    const statusCode = (error as { $metadata?: { httpStatusCode?: unknown } })
      ?.$metadata?.httpStatusCode;
    const isConflict = error instanceof Error
      && (error.message.includes("existiert bereits")
        || error.message.includes("PreconditionFailed")
        || error.message.includes("412")
        || statusCode === 412);
    if (isConflict) throw new ProjectFileValidationError("storage conflict");
    throw error;
  }
  if (stored.sha256 !== sha256) {
    throw new ProjectFileValidationError("receipt integrity mismatch");
  }

  const inserted = await tx.execute<{ id: string }>(sql`
    insert into project_file (
      id, workspace_id, project_id, storage_key, file_sha256,
      content_type, byte_size, original_filename, created_by
    )
    values (
      ${fileId}::uuid, ${ctx.workspaceId}::uuid, ${projectId}::uuid,
      ${storageKey}, ${stored.sha256}, ${contentType},
      ${input.bytes.byteLength}, ${filename}, ${ctx.actor}::uuid
    )
    returning id
  `);
  const row = inserted.rows[0];
  if (!row) throw new ProjectFileNotFoundError(projectId);
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project_file.uploaded",
    resource: "project",
    allowed: true,
    details: { projectId, fileId, filename },
  });
  return { fileId };
}

export async function listProjectFiles(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string },
): Promise<ProjectFileDto[]> {
  requireRead(ctx, input.projectId);
  if (!uuidSchema.safeParse(input.projectId).success) {
    throw new ProjectFileValidationError();
  }
  // Key/Pruefsumme nie in die Liste (F10-04-QR-Muster: Empfangs-QR nur
  // intern); newest-first (Ablage-UX, Gegenpol zu file_request_upload).
  const found = await tx.execute<ProjectFileRow>(sql`
    select id, original_filename, content_type, byte_size, created_at
      from project_file
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
     order by created_at desc, id desc
  `);
  return found.rows.map((row) => ({
    id: row.id,
    originalFilename: row.original_filename,
    contentType: row.content_type,
    byteSize: row.byte_size,
    createdAt: toIso(row.created_at),
  }));
}

export async function downloadProjectFile(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; fileId: string },
): Promise<{ filename: string; contentType: string; body: Buffer }> {
  requireRead(ctx, input.projectId);
  if (!uuidSchema.safeParse(input.projectId).success) {
    throw new ProjectFileValidationError();
  }
  if (!uuidSchema.safeParse(input.fileId).success) {
    throw new ProjectFileValidationError();
  }
  const found = await tx.execute<ProjectFileRow & { storage_key: string }>(sql`
    select id, storage_key, original_filename, content_type, byte_size, created_at
      from project_file
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
       and id = ${input.fileId}::uuid
     limit 1
  `);
  const row = found.rows[0];
  if (!row) throw new ProjectFileNotFoundError(input.projectId);
  if (!row.storage_key.startsWith("immutable/") || !PROJECT_FILE_KEY_PATTERN.test(row.storage_key)) {
    throw new ProjectFileValidationError("receipt key mismatch");
  }
  const storage = resolveObjectStorage();
  const got = await storage.get(row.storage_key);
  return {
    filename: row.original_filename,
    contentType: row.content_type,
    body: got.body,
  };
}
