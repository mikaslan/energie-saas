// F7-16 Projekt-Dateien: interner Upload + Liste + Download je Projekt
// (PDF/JPEG/PNG, 25 MiB, WORM unter immutable/<projekt>/project-files/).
// INTERN-NUR auf Service-Ebene (alle internen Ops): project.read ist
// NICHT internalOnly — ohne explizites Gate saehen externe Projektleser
// interne Dateien. Berechtigung: project.read/write (KEINE neuen Keys).
// Re-Upload derselben Bytes = NEUE Zeile (kein Dedupe, kein
// Ueberschreiben — append-only; WORM-Konflikt faellt fail-closed, nur
// bei UUID-Kollision moeglich).
// F10-17: Kunden-Sichtbarkeit je Datei (Toggle, Default unsichtbar) +
// rollenloser Portal-Download per Token-Kapsel (F10-07-Muster).
import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { immutableKey, resolveObjectStorage } from "@/lib/storage";
import {
  hashPortalToken,
  PortalNotFoundError,
  resolvePortalByToken,
} from "@/modules/portal";

export class ProjectFileNotFoundError extends Error {
  // F10-17: Default für den rollenlosen Portal-Pfad (dort ist kein
  // Projektkontext bekannt — F10-07-Muster, uniforme Meldung).
  constructor(public readonly projectId: string = "") {
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

export class ProjectFileIntegrityError extends Error {
  constructor(message = "project file integrity mismatch") {
    super(message);
    this.name = "ProjectFileIntegrityError";
  }
}

export class ProjectFilePersistenceError extends Error {
  constructor(message = "project file persistence failed") {
    super(message);
    this.name = "ProjectFilePersistenceError";
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
  visibleToCustomer: boolean;
  withdrawn: boolean;
};

type ProjectFileRow = {
  id: string;
  original_filename: string;
  content_type: string;
  byte_size: number;
  created_at: Date | string;
  visible_to_customer: boolean;
  withdrawn: boolean;
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
    select id, original_filename, content_type, byte_size, created_at,
           visible_to_customer, withdrawn
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
    visibleToCustomer: row.visible_to_customer,
    withdrawn: row.withdrawn,
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

const visibilitySchema = z.strictObject({
  projectId: uuidSchema,
  fileId: uuidSchema,
  visible: z.boolean(),
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

// F10-17: Kunden-Sichtbarkeit je Datei (intern-nur, project.write).
// Plain UPDATE per (workspace, projekt, id) — die Zeile existiert immer
// (kein Upsert-Tanz); fehlende Zeile = uniform NotFound. Audit je Flip
// (kein PII), KEIN Domain-Event (kein Konsument).
export async function setProjectFileVisibility(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; fileId: string; visible: boolean },
): Promise<{ fileId: string; visibleToCustomer: boolean }> {
  requireWrite(ctx, input.projectId);
  const parsed = visibilitySchema.safeParse(input);
  if (!parsed.success) throw new ProjectFileValidationError();
  const command = parsed.data;
  const updated = await tx.execute<{ id: string }>(sql`
    update project_file
       set visible_to_customer = ${command.visible}
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
       and id = ${command.fileId}::uuid
    returning id
  `);
  if (!updated.rows[0]) throw new ProjectFileNotFoundError(command.projectId);
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project_file.visibility_set",
    resource: "project",
    allowed: true,
    details: { projectId: command.projectId, fileId: command.fileId, visible: command.visible },
  });
  return { fileId: command.fileId, visibleToCustomer: command.visible };
}

const withdrawSchema = z.strictObject({
  projectId: uuidSchema,
  fileId: uuidSchema,
});

// F7-16b: Datei-Zurückziehung (intern-nur, project.write). One-way,
// terminal (kein Re-Activate in diesem Slice — storniert-Muster);
// SELECT FOR UPDATE per (workspace, projekt, id), 0 Zeilen = uniform
// NotFound. Idempotent: bereits zurückgezogen → Erfolg OHNE Audit
// (Flip-only, kein Rauschen bei Retry). Audit je Flip (kein PII),
// KEIN Domain-Event (kein Konsument, F10-17-Muster).
export async function withdrawProjectFile(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; fileId: string },
): Promise<{ fileId: string; withdrawn: true }> {
  requireWrite(ctx, input.projectId);
  const parsed = withdrawSchema.safeParse(input);
  if (!parsed.success) throw new ProjectFileValidationError();
  const command = parsed.data;
  const found = await tx.execute<{ withdrawn: boolean }>(sql`
    select withdrawn from project_file
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
       and id = ${command.fileId}::uuid
     limit 1
     for update
  `);
  const row = found.rows[0];
  if (!row) throw new ProjectFileNotFoundError(command.projectId);
  if (row.withdrawn) return { fileId: command.fileId, withdrawn: true };
  await tx.execute(sql`
    update project_file
       set withdrawn = true
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
       and id = ${command.fileId}::uuid
  `);
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project_file.withdrawn",
    resource: "project",
    allowed: true,
    details: { projectId: command.projectId, fileId: command.fileId },
  });
  return { fileId: command.fileId, withdrawn: true };
}

export type PortalProjectFileArtifactResult = {
  fileId: string;
  filename: string;
  mimeType: "application/pdf" | "image/jpeg" | "image/png";
  sha256: string;
  sizeBytes: number;
  bytes: Buffer;
};

const portalArtifactRowSchema = z.strictObject({
  original_filename: z.string().min(1).max(PROJECT_FILE_NAME_MAX),
  content_type: z.string(),
  byte_size: z.number(),
  file_sha256: z.string(),
  storage_key: z.string(),
});

// F10-17 Portal-Datei-Download (My-Files): token-gebundener Lesezugriff
// auf freigeschaltete Projekt-Dateien (Dateiname aus der Ablage,
// Inhalt exakt die versiegelten Bytes). Autorisierung ist allein das
// Portal-Token (publicTokenCapsule, kein Mandantenkontext — F10-07-
// Muster 1:1): erst die Portal-Projektion (uniform NotFound, kein
// Orakel), dann Zugehoerigkeit zur projizierten Datei-Liste (gleicher
// Fehler — unsichtbar faellt hier automatisch heraus), dann die
// DEFINER-Funktion 0182 (eigener Sichtbarkeits-WHERE). Integritaet
// (SHA/Groesse/Key) wie am internen Pfad. Keine neue Permission
// (rollenloser Token-Pfad).
export async function readPortalProjectFileByToken(
  pool: Pool,
  value: unknown,
): Promise<PortalProjectFileArtifactResult> {
  const parsed = z.strictObject({ token: z.string().min(1), fileId: uuidSchema })
    .safeParse(value);
  if (!parsed.success) throw new ProjectFileValidationError();
  const command = parsed.data;
  let view;
  try {
    view = await resolvePortalByToken(pool, { token: command.token });
  } catch (error) {
    if (error instanceof PortalNotFoundError) throw new ProjectFileNotFoundError();
    throw error;
  }
  if (!view.projectFiles.some((entry) => entry.id === command.fileId)) {
    throw new ProjectFileNotFoundError();
  }
  const tokenHash = hashPortalToken(command.token);
  if (tokenHash === null) throw new ProjectFileNotFoundError();
  let rows: unknown[];
  try {
    const result = await pool.query(
      `select * from public.read_portal_project_file_artifact($1::bytea, $2::uuid)`,
      [tokenHash, command.fileId],
    );
    rows = result.rows;
  } catch {
    throw new ProjectFilePersistenceError();
  }
  if (rows.length === 0) throw new ProjectFileNotFoundError();
  if (rows.length !== 1) throw new ProjectFileIntegrityError();
  const rowParsed = portalArtifactRowSchema.safeParse(rows[0]);
  if (!rowParsed.success) throw new ProjectFileIntegrityError();
  const row = rowParsed.data;
  const mimeType = row.content_type.toLowerCase() as PortalProjectFileArtifactResult["mimeType"];
  if (
    !Object.prototype.hasOwnProperty.call(PROJECT_FILE_CONTENT_TYPES, mimeType)
    || !SHA256_PATTERN.test(row.file_sha256)
    || !Number.isSafeInteger(row.byte_size)
    || row.byte_size < 1
    || row.byte_size > PROJECT_FILE_MAX_BYTES
    || !row.storage_key.startsWith("immutable/")
    || !PROJECT_FILE_KEY_PATTERN.test(row.storage_key)
  ) throw new ProjectFileIntegrityError();
  let body: Buffer;
  try {
    body = (await resolveObjectStorage().get(row.storage_key)).body;
  } catch {
    throw new ProjectFileIntegrityError("storage read mismatch");
  }
  if (body.length !== row.byte_size) throw new ProjectFileIntegrityError("size mismatch");
  const actual = createHash("sha256").update(body).digest();
  const expected = Buffer.from(row.file_sha256, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new ProjectFileIntegrityError("sha256 mismatch");
  }
  return {
    fileId: command.fileId,
    filename: row.original_filename,
    mimeType,
    sha256: row.file_sha256,
    sizeBytes: row.byte_size,
    bytes: Buffer.from(body),
  };
}
