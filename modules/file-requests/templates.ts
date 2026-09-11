// F16-07 Datei-Anfragen-Vorlagen — Template-CRUD + Anwenden je Projekt.
// Muster modules/calendar/templates.ts (F16-05). Keine neuen Permissions:
// project.read/project.write. Anwenden legt eine Datei-Anfrage mit
// Titel-/Beschreibungs-Preset an (keine Akten-Verknüpfung, v1-Scope).
import "server-only";

import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
  applyFileRequestTemplateCommandSchema,
  archiveFileRequestTemplateCommandSchema,
  createFileRequestTemplateCommandSchema,
  fileRequestTemplateDtoSchema,
  updateFileRequestTemplateCommandSchema,
  type ApplyFileRequestTemplateCommand,
  type ArchiveFileRequestTemplateCommand,
  type CreateFileRequestTemplateCommand,
  type FileRequestTemplateDto,
  type UpdateFileRequestTemplateCommand,
} from "@/lib/file-request-template";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  createFileRequest,
  FileRequestNotFoundError,
  FileRequestValidationError,
} from "./service";
import type { FileRequestDto } from "@/lib/file-request";

export class FileRequestTemplateNotFoundError extends Error {
  constructor() {
    super("file request template not found");
    this.name = "FileRequestTemplateNotFoundError";
  }
}

export class FileRequestTemplateConflictError extends Error {
  constructor() {
    super("file request template conflict");
    this.name = "FileRequestTemplateConflictError";
  }
}

export class FileRequestTemplateValidationError extends Error {
  constructor() {
    super("file request template validation failed");
    this.name = "FileRequestTemplateValidationError";
  }
}

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", "file_request_template", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", "file_request_template", undefined, ctx.actor);
  }
}

function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

export function normalizeFileRequestTemplateName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

type TemplateRow = {
  id: string;
  name: string;
  title: string;
  description: string | null;
  allow_many: boolean;
  position: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const TEMPLATE_SELECT = sql`
  select id, name, title, description, allow_many,
         position, active, created_at, updated_at
    from file_request_template
`;

function toDto(row: TemplateRow, canWrite: boolean): FileRequestTemplateDto {
  return fileRequestTemplateDtoSchema.parse({
    schemaVersion: FILE_REQUEST_TEMPLATE_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    title: row.title,
    description: row.description,
    allowMany: row.allow_many,
    position: row.position,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

export async function listFileRequestTemplates(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { includeArchived?: boolean } = {},
): Promise<FileRequestTemplateDto[]> {
  requireRead(ctx);
  const includeArchived = query.includeArchived === true;
  const result = await tx.execute<TemplateRow>(sql`
    ${TEMPLATE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     ${includeArchived ? sql`` : sql`and active = true`}
   order by position asc, name asc, id asc
  `);
  const write = can(ctx, "project.write");
  return result.rows.map((row) => toDto(row, write));
}

export async function createFileRequestTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateFileRequestTemplateCommand,
): Promise<FileRequestTemplateDto> {
  requireWrite(ctx);
  const parsed = createFileRequestTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new FileRequestTemplateValidationError();
  const command = parsed.data;

  let row: TemplateRow;
  try {
    const inserted = await tx.execute<TemplateRow>(sql`
      insert into file_request_template (
        workspace_id, name, name_normalized, title, description, allow_many,
        position, created_by
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.name},
        ${normalizeFileRequestTemplateName(command.name)},
        ${command.title},
        ${command.description ?? null},
        ${command.allowMany},
        ${command.position ?? 0},
        ${ctx.actor}::uuid
      )
      returning id, name, title, description, allow_many,
                position, active, created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new FileRequestTemplateConflictError();
    if (code === "23514") throw new FileRequestTemplateValidationError();
    throw error;
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "file_request_template",
    aggregateId: row.id,
    eventType: "file_request_template.created",
    actor: ctx.actor,
    payload: { name: command.name },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "file_request_template.write",
    resource: "file_request_template",
    allowed: true,
    details: { name: command.name },
  });
  return toDto(row, true);
}

export async function updateFileRequestTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdateFileRequestTemplateCommand,
): Promise<FileRequestTemplateDto> {
  requireWrite(ctx);
  const parsed = updateFileRequestTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new FileRequestTemplateValidationError();
  const command = parsed.data;

  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update file_request_template
         set name = ${command.name},
             name_normalized = ${normalizeFileRequestTemplateName(command.name)},
             title = ${command.title},
             description = ${command.description ?? null},
             allow_many = ${command.allowMany},
             position = ${command.position},
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
      returning id, name, title, description, allow_many,
                position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new FileRequestTemplateConflictError();
    if (code === "23514") throw new FileRequestTemplateValidationError();
    throw error;
  }
  if (!rows[0]) throw new FileRequestTemplateNotFoundError();
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "file_request_template",
    aggregateId: command.id,
    eventType: "file_request_template.updated",
    actor: ctx.actor,
    payload: { name: command.name },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "file_request_template.write",
    resource: "file_request_template",
    allowed: true,
    details: { id: command.id },
  });
  return toDto(rows[0], true);
}

async function setTemplateActive(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveFileRequestTemplateCommand,
): Promise<FileRequestTemplateDto> {
  requireWrite(ctx);
  const parsed = archiveFileRequestTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new FileRequestTemplateValidationError();
  const command = parsed.data;
  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update file_request_template
         set active = ${command.active},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
         and active is distinct from ${command.active}
      returning id, name, title, description, allow_many,
                position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new FileRequestTemplateConflictError();
    if (code === "23514") throw new FileRequestTemplateValidationError();
    throw error;
  }
  const row = rows[0];
  if (!row) {
    const current = await tx.execute<TemplateRow>(sql`
      ${TEMPLATE_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.id}::uuid
     limit 1
    `);
    if (!current.rows[0]) throw new FileRequestTemplateNotFoundError();
    return toDto(current.rows[0], true);
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "file_request_template",
    aggregateId: command.id,
    eventType: command.active ? "file_request_template.restored" : "file_request_template.archived",
    actor: ctx.actor,
    payload: {},
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "file_request_template.write",
    resource: "file_request_template",
    allowed: true,
    details: { id: command.id, active: command.active },
  });
  return toDto(row, true);
}

export function archiveFileRequestTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveFileRequestTemplateCommand,
): Promise<FileRequestTemplateDto> {
  return setTemplateActive(tx, ctx, { ...input, active: false });
}

export function restoreFileRequestTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveFileRequestTemplateCommand,
): Promise<FileRequestTemplateDto> {
  return setTemplateActive(tx, ctx, { ...input, active: true });
}

// Vorlage im Projekt anwenden: Datei-Anfrage mit Titel-/Beschreibungs-
// Preset (Status offen). Nur aktive Vorlagen; Projekt-/Rechtesperren
// meldet der File-Request-Pfad selbst.
export async function applyFileRequestTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ApplyFileRequestTemplateCommand,
): Promise<{ request: FileRequestDto; templateId: string }> {
  requireWrite(ctx);
  const parsed = applyFileRequestTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new FileRequestTemplateValidationError();
  const command = parsed.data;
  const found = await tx.execute<TemplateRow>(sql`
    ${TEMPLATE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     and id = ${command.templateId}::uuid
     and active = true
   limit 1
  `);
  const template = found.rows[0];
  if (!template) throw new FileRequestTemplateNotFoundError();
  try {
    // F10-10: Allow-many wandert aus der Vorlage in die Anfrage.
    const request = await createFileRequest(tx, ctx, {
      projectId: command.projectId,
      title: template.title,
      description: template.description,
      allowMany: template.allow_many,
    });
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "file_request_template",
      aggregateId: template.id,
      eventType: "file_request_template.applied",
      actor: ctx.actor,
      payload: { projectId: command.projectId, requestId: request.id },
    });
    return { request, templateId: template.id };
  } catch (error) {
    if (error instanceof FileRequestValidationError) throw new FileRequestTemplateValidationError();
    if (error instanceof FileRequestNotFoundError) throw new FileRequestTemplateNotFoundError();
    throw error;
  }
}
