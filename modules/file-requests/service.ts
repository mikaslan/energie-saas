// F10-04 Datei-Anfragen: interne Bitte um Kundendatei je Projekt
// (v1 ein Beleg je Anfrage). Maschine: offen → hochgeladen (Kunde via
// Token-DEFINER fulfill_file_request) → erledigt; storniert nur aus
// offen, terminal. Berechtigung: project.read/write (KEINE neuen Keys).
import "server-only";

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { hashPortalToken } from "@/lib/integrations/portal/portal-contract";
import { PortalNotFoundError, resolvePortalByToken } from "@/modules/portal";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { immutableKey, resolveObjectStorage } from "@/lib/storage";

export class FileRequestNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super("file request not found");
    this.name = "FileRequestNotFoundError";
  }
}

export class FileRequestValidationError extends Error {
  constructor(message = "file request validation failed") {
    super(message);
    this.name = "FileRequestValidationError";
  }
}

export class FileRequestConflictError extends Error {
  constructor(message = "file request conflict") {
    super(message);
    this.name = "FileRequestConflictError";
  }
}

import {
  fileRequestStatuses,
  nextFileRequestStatuses,
  type FileRequestDto,
  type FileRequestStatus,
  type FileRequestUploadDto,
} from "@/lib/file-request";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const createSchema = z.strictObject({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2000).nullable(),
});

// Upload-Grenzen (ESTIMATE, reversibel): 10 MiB, PDF/JPEG/PNG.
export const FILE_REQUEST_MAX_BYTES = 10_485_760;
const ALLOWED_CONTENT_TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
} as const;

type FileRequestRow = {
  id: string;
  project_id: string;
  subsidy_case_id: string | null;
  title: string;
  description: string | null;
  allow_many: boolean;
  status: string;
  storage_key: string | null;
  file_sha256: string | null;
  content_type: string | null;
  byte_size: number | null;
  original_filename: string | null;
  uploaded_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  [key: string]: unknown;
};

const ROW_COLUMNS = sql`
  id, project_id, subsidy_case_id, title, description, allow_many, status,
  storage_key, file_sha256, content_type, byte_size, original_filename,
  uploaded_at, completed_at, created_at, updated_at
`;

type FileRequestUploadRow = {
  id: string;
  file_request_id: string;
  content_type: string | null;
  byte_size: number | null;
  original_filename: string | null;
  uploaded_at: Date | string;
  [key: string]: unknown;
};

function toUploadDto(row: FileRequestUploadRow): FileRequestUploadDto {
  return {
    id: row.id,
    requestId: row.file_request_id,
    contentType: row.content_type,
    byteSize: row.byte_size,
    originalFilename: row.original_filename,
    uploadedAt: toIso(row.uploaded_at),
  };
}

// F10-10: Folge-Belege je Anfrage (interne Sicht; Storage-Keys bleiben
// in der DB, nie im Portal).
async function listUploadsForRequests(
  tx: TenantTx,
  ctx: ServiceCtx,
  requestIds: string[],
): Promise<Map<string, FileRequestUploadDto[]>> {
  const grouped = new Map<string, FileRequestUploadDto[]>();
  if (requestIds.length === 0) return grouped;
  // Parametrisierte IN-Liste (kein Array-Literal: node-pg serialisiert
  // JS-Arrays nicht zu uuid[] — „malformed array literal", F10-10-Fund).
  const idList = sql.join(
    requestIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const found = await tx.execute<FileRequestUploadRow>(sql`
    select id, file_request_id, content_type, byte_size, original_filename, uploaded_at
      from file_request_upload
     where workspace_id = ${ctx.workspaceId}::uuid
       and file_request_id in (${idList})
     order by uploaded_at, id
  `);
  for (const row of found.rows) {
    const list = grouped.get(row.file_request_id) ?? [];
    list.push(toUploadDto(row));
    grouped.set(row.file_request_id, list);
  }
  return grouped;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDto(
  row: FileRequestRow,
  ctx: ServiceCtx,
  uploads: FileRequestUploadDto[] = [],
): FileRequestDto {
  return {
    id: row.id,
    projectId: row.project_id,
    subsidyCaseId: row.subsidy_case_id,
    title: row.title,
    description: row.description,
    allowMany: row.allow_many,
    uploads,
    status: row.status as FileRequestStatus,
    storageKey: row.storage_key,
    fileSha256: row.file_sha256,
    contentType: row.content_type,
    byteSize: row.byte_size,
    uploadedAt: row.uploaded_at === null ? null : toIso(row.uploaded_at),
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    originalFilename: row.original_filename,
    permissions: { canWrite: can(ctx, "project.write") },
  };
}

function requireRead(ctx: ServiceCtx, projectId: string): void {
  if (!can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", "file_request", projectId, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx, projectId: string): void {
  if (!can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", "file_request", projectId, ctx.actor);
  }
}

async function requireProject(tx: TenantTx, ctx: ServiceCtx, projectId: string): Promise<void> {
  if (!uuidSchema.safeParse(projectId).success) throw new FileRequestValidationError();
  const project = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     limit 1
  `);
  if (!project.rows[0]) throw new FileRequestNotFoundError(projectId);
}

export async function createFileRequest(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    projectId: string;
    title: unknown;
    description: unknown;
    subsidyCaseId?: unknown;
    allowMany?: unknown;
  },
): Promise<FileRequestDto> {
  requireWrite(ctx, input.projectId);
  await requireProject(tx, ctx, input.projectId);
  const parsed = createSchema.safeParse({
    title: input.title,
    description: input.description ?? null,
  });
  if (!parsed.success) throw new FileRequestValidationError();
  // F10-10: Allow-many je Anfrage (strikt boolean, Default single).
  if (input.allowMany !== undefined && typeof input.allowMany !== "boolean") {
    throw new FileRequestValidationError();
  }
  const allowMany = input.allowMany === true;
  // F13-07: optionale Akten-Verknüpfung — die Akte muss zum Projekt
  // gehören (uniform NotFound statt Orakel über fremde Akten).
  let subsidyCaseId: string | null = null;
  if (input.subsidyCaseId !== undefined && input.subsidyCaseId !== null) {
    if (!uuidSchema.safeParse(input.subsidyCaseId).success) {
      throw new FileRequestValidationError();
    }
    const linked = await tx.execute<{ id: string }>(sql`
      select id from subsidy_case
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${input.subsidyCaseId}::uuid
         and project_id = ${input.projectId}::uuid
       limit 1
    `);
    if (!linked.rows[0]) throw new FileRequestNotFoundError(input.projectId);
    subsidyCaseId = input.subsidyCaseId as string;
  }
  const inserted = await tx.execute<FileRequestRow>(sql`
    insert into file_request (workspace_id, project_id, subsidy_case_id, title, description, allow_many, created_by)
    values (
      ${ctx.workspaceId}::uuid, ${input.projectId}::uuid, ${subsidyCaseId}::uuid,
      ${parsed.data.title}, ${parsed.data.description}, ${allowMany},
      ${ctx.actor}::uuid
    )
    returning ${ROW_COLUMNS}
  `);
  const row = inserted.rows[0];
  if (!row) throw new FileRequestNotFoundError(input.projectId);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: input.projectId,
    eventType: "file_request.created",
    actor: ctx.actor,
    payload: subsidyCaseId === null ? { requestId: row.id } : { requestId: row.id, subsidyCaseId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "file_request.create",
    resource: "project",
    allowed: true,
    details: { projectId: input.projectId, requestId: row.id },
  });
  return toDto(row, ctx);
}

export type FileRequestDashboardStats = {
  offen: number;
  hochgeladen: number;
  erledigt: number;
  total: number;
};

// DASH-09 Beleg-Kachel: Datei-Anfragen je Stand (rein lesend, keine
// neue Permission — project.read wie listFileRequests).
export async function getFileRequestDashboardStats(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<FileRequestDashboardStats> {
  if (!can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", "file_request", undefined, ctx.actor);
  }
  const result = await tx.execute<{ status: string; count: number }>(sql`
    select status, count(*)::int as count
      from file_request
     where workspace_id = ${ctx.workspaceId}::uuid
     group by status
  `);
  const counts = new Map(result.rows.map((row) => [row.status, Number(row.count)]));
  const offen = counts.get("offen") ?? 0;
  const hochgeladen = counts.get("hochgeladen") ?? 0;
  const erledigt = counts.get("erledigt") ?? 0;
  return {
    offen,
    hochgeladen,
    erledigt,
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
  };
}

export async function listFileRequests(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  filter?: { subsidyCaseId?: unknown },
): Promise<FileRequestDto[]> {
  requireRead(ctx, projectId);
  if (!uuidSchema.safeParse(projectId).success) throw new FileRequestValidationError();
  // F13-07: optionaler Akten-Filter (Beleg-Liste der Akte).
  let subsidyCaseId: string | null = null;
  let filterCase = false;
  if (filter?.subsidyCaseId !== undefined && filter.subsidyCaseId !== null) {
    if (!uuidSchema.safeParse(filter.subsidyCaseId).success) {
      throw new FileRequestValidationError();
    }
    subsidyCaseId = filter.subsidyCaseId as string;
    filterCase = true;
  }
  const found = await tx.execute<FileRequestRow>(sql`
    select ${ROW_COLUMNS} from file_request
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
       and (${filterCase} = false or subsidy_case_id = ${subsidyCaseId}::uuid)
     order by created_at, id
  `);
  // F10-10: Folge-Belege je Liste in EINER Abfrage (kein N+1).
  const uploads = await listUploadsForRequests(tx, ctx, found.rows.map((row) => row.id));
  return found.rows.map((row) => toDto(row, ctx, uploads.get(row.id) ?? []));
}

export async function transitionFileRequest(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; requestId: string; status: FileRequestStatus },
): Promise<FileRequestDto> {
  requireWrite(ctx, input.projectId);
  if (!uuidSchema.safeParse(input.projectId).success) {
    throw new FileRequestValidationError();
  }
  if (!uuidSchema.safeParse(input.requestId).success) {
    throw new FileRequestValidationError();
  }
  if (!(fileRequestStatuses as readonly string[]).includes(input.status)) {
    throw new FileRequestValidationError();
  }
  const current = await tx.execute<FileRequestRow>(sql`
    select ${ROW_COLUMNS} from file_request
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
       and id = ${input.requestId}::uuid
     for update
  `);
  const row = current.rows[0];
  if (!row) throw new FileRequestNotFoundError(input.projectId);
  const from = row.status as FileRequestStatus;
  if (!nextFileRequestStatuses(from).includes(input.status)) {
    throw new FileRequestValidationError(`illegal transition ${from} -> ${input.status}`);
  }
  const updated = await tx.execute<FileRequestRow>(sql`
    update file_request
       set status = ${input.status},
           completed_at = case
             when ${input.status} = 'erledigt' then statement_timestamp()
             else completed_at end,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
       and id = ${input.requestId}::uuid
    returning ${ROW_COLUMNS}
  `);
  const next = updated.rows[0];
  if (!next) throw new FileRequestNotFoundError(input.projectId);
  // F10-10: Folge-Belege der einen Zeile mitgeben.
  const nextUploads = await listUploadsForRequests(tx, ctx, [next.id]);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: input.projectId,
    eventType: "file_request.status_changed",
    actor: ctx.actor,
    payload: { requestId: input.requestId, from, to: input.status },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "file_request.transition",
    resource: "project",
    allowed: true,
    details: { projectId: input.projectId, requestId: input.requestId, from, to: input.status },
  });
  return toDto(next, ctx, nextUploads.get(next.id) ?? []);
}

// Interner Beleg-Download: dient Bytes aus dem WORM-Objekt (kein
// signierter URL-Umweg); project.read genügt (Empfangs-QR, kein
// Schreibakt). Key fail-closed auf immutable/-Präfix.
export async function downloadFileRequest(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; requestId: string },
): Promise<{ filename: string; contentType: string; body: Buffer }> {
  requireRead(ctx, input.projectId);
  if (!uuidSchema.safeParse(input.projectId).success) {
    throw new FileRequestValidationError();
  }
  if (!uuidSchema.safeParse(input.requestId).success) {
    throw new FileRequestValidationError();
  }
  const found = await tx.execute<FileRequestRow>(sql`
    select ${ROW_COLUMNS} from file_request
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
       and id = ${input.requestId}::uuid
     limit 1
  `);
  const row = found.rows[0];
  if (!row || row.storage_key === null) throw new FileRequestNotFoundError(input.projectId);
  if (!row.storage_key.startsWith("immutable/") || row.original_filename === null) {
    throw new FileRequestValidationError("receipt key mismatch");
  }
  const storage = resolveObjectStorage();
  const got = await storage.get(row.storage_key);
  return {
    filename: row.original_filename,
    contentType: row.content_type ?? got.contentType,
    body: got.body,
  };
}

// F10-11: Einzel-Download eines Folge-Belegs (intern; project.read wie
// downloadFileRequest — Empfangs-QR, kein Schreibakt). Key fail-closed
// auf immutable/-Präfix; Anfrage-Bindung verhindert ID-Orakel über
// fremde Uploads (uniform NotFound).
export async function downloadFileRequestUpload(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; requestId: string; uploadId: string },
): Promise<{ filename: string; contentType: string; body: Buffer }> {
  requireRead(ctx, input.projectId);
  if (!uuidSchema.safeParse(input.projectId).success) {
    throw new FileRequestValidationError();
  }
  if (!uuidSchema.safeParse(input.requestId).success) {
    throw new FileRequestValidationError();
  }
  if (!uuidSchema.safeParse(input.uploadId).success) {
    throw new FileRequestValidationError();
  }
  const found = await tx.execute<FileRequestUploadRow & { storage_key: string | null }>(sql`
    select id, file_request_id, storage_key, content_type, byte_size, original_filename, uploaded_at
      from file_request_upload
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
       and file_request_id = ${input.requestId}::uuid
       and id = ${input.uploadId}::uuid
     limit 1
  `);
  const row = found.rows[0];
  if (!row) throw new FileRequestNotFoundError(input.projectId);
  const storageKey = row.storage_key;
  if (storageKey === null || !storageKey.startsWith("immutable/") || row.original_filename === null) {
    throw new FileRequestValidationError("receipt key mismatch");
  }
  const storage = resolveObjectStorage();
  const got = await storage.get(storageKey);
  return {
    filename: row.original_filename,
    contentType: row.content_type ?? got.contentType,
    body: got.body,
  };
}

export type FulfillFileRequestInput = {
  token: unknown;
  requestId: unknown;
  filename: unknown;
  contentType: unknown;
  bytes: Buffer;
};

export type FulfillFileRequestResult = {
  requestId: string;
  byteSize: number;
  sha256: string;
};

function sanitizeStorageStem(name: string): string {
  const stem = name.split(".").slice(0, -1).join(".") || name;
  const clean = stem.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return clean.length > 0 ? clean : "datei";
}

// Erster anonymer Schreibpfad des Portals (F10-04): Kunde erfüllt EINE
// offene Anfrage. Token zuerst auflösen (fail-fast ohne Storage-Orphan
// bei ungültigem Link); Mandant+Projekt stammen aus dem Invite, nie aus
// dem Request. Race (Withdraw zwischen Resolve und Fulfill) → conflict/
// not_found mit verwaistem WORM-Objekt (ESTIMATE, dokumentiert in 0104).
export async function fulfillFileRequestByToken(
  pool: Pool,
  input: FulfillFileRequestInput,
): Promise<FulfillFileRequestResult> {
  if (!Buffer.isBuffer(input.bytes)) throw new FileRequestValidationError("bytes missing");
  const parsed = z.strictObject({
    token: z.string().min(1),
    requestId: uuidSchema,
    filename: z.string().trim().min(1).max(255),
    contentType: z.string().min(1).max(128),
  }).safeParse({
    token: input.token,
    requestId: input.requestId,
    filename: input.filename,
    contentType: input.contentType,
  });
  if (!parsed.success) throw new FileRequestValidationError();
  const { token, requestId, filename } = parsed.data;
  const contentType = parsed.data.contentType.toLowerCase();
  const expectedExt = (ALLOWED_CONTENT_TYPES as Record<string, string>)[contentType];
  if (!expectedExt) throw new FileRequestValidationError("content type not allowed");
  if (input.bytes.byteLength < 1 || input.bytes.byteLength > FILE_REQUEST_MAX_BYTES) {
    throw new FileRequestValidationError("byte size out of range");
  }
  if (!filename.toLowerCase().endsWith(`.${expectedExt}`) && contentType !== "image/jpeg") {
    throw new FileRequestValidationError("filename extension mismatch");
  }
  if (contentType === "image/jpeg") {
    const lower = filename.toLowerCase();
    if (!lower.endsWith(".jpg") && !lower.endsWith(".jpeg")) {
      throw new FileRequestValidationError("filename extension mismatch");
    }
  }

  // Fail-fast: ungültiger/entzogener Link VOR dem Storage-Put.
  // Portal-NotFound wird uniform (kein Orakel zwischen „Link tot" und
  // „Anfrage fremd").
  let view;
  try {
    view = await resolvePortalByToken(pool, { token });
  } catch (error) {
    if (error instanceof PortalNotFoundError) throw new FileRequestNotFoundError("portal");
    throw error;
  }
  const tokenHash = hashPortalToken(token);
  if (tokenHash === null) throw new FileRequestValidationError("token rejected");

  // F10-10: Key ist inhalts-deterministisch (Request + Dateiname + Kurz-Hash
  // der Bytes): gleiche Datei erneut → gleicher Key → WORM-Conflict
  // (Duplikat); andere Datei (auch gleichen Namens) → eigener Key. Der
  // Hash steht VOR dem Put fest und wird gegen den Storage-Befund
  // gegengeprüft (Integrität, kein blindes Vertrauen).
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const storageKey = immutableKey(
    view.project.id,
    "file-requests",
    `${requestId}_${sanitizeStorageStem(filename)}_${sha256.slice(0, 8)}.${expectedExt}`,
  );
  let stored: { key: string; sha256: string };
  try {
    stored = await resolveObjectStorage().putImmutable(storageKey, input.bytes, contentType);
  } catch (error) {
    if (error instanceof Error && error.message.includes("existiert bereits")) {
      throw new FileRequestConflictError("already fulfilled");
    }
    throw error;
  }
  if (stored.sha256 !== sha256) {
    throw new FileRequestValidationError("receipt integrity mismatch");
  }

  const outcome = await pool.query(
    `select public.fulfill_file_request(
       $1::bytea, $2::uuid, $3::text, $4::text, $5::text, $6::integer, $7::text
     ) as result`,
    [
      tokenHash,
      requestId,
      storageKey,
      stored.sha256,
      contentType,
      input.bytes.byteLength,
      filename,
    ],
  );
  const result = z.strictObject({ result: z.string() }).safeParse(outcome.rows[0]);
  const status = result.success ? result.data.result : null;
  if (status === "ok") {
    return { requestId, byteSize: input.bytes.byteLength, sha256: stored.sha256 };
  }
  if (status === "invalid") throw new FileRequestValidationError("receipt rejected");
  if (status !== "conflict") throw new FileRequestNotFoundError(view.project.id);
  // F10-10: Bereits erfüllte Allow-many-Anfrage → Folge-Beleg-Kapsel mit
  // denselben Parametern (kein zweiter Storage-Put). Single-Anfragen und
  // terminale Stände melden dort erneut 'conflict'.
  const followup = await pool.query(
    `select public.fulfill_file_request_followup(
       $1::bytea, $2::uuid, $3::text, $4::text, $5::text, $6::integer, $7::text
     ) as result`,
    [
      tokenHash,
      requestId,
      storageKey,
      stored.sha256,
      contentType,
      input.bytes.byteLength,
      filename,
    ],
  );
  const followupResult = z.strictObject({ result: z.string() }).safeParse(followup.rows[0]);
  const followupStatus = followupResult.success ? followupResult.data.result : null;
  if (followupStatus === "ok") {
    return { requestId, byteSize: input.bytes.byteLength, sha256: stored.sha256 };
  }
  if (followupStatus === "invalid") throw new FileRequestValidationError("receipt rejected");
  if (followupStatus === "not_found") throw new FileRequestNotFoundError(view.project.id);
  throw new FileRequestConflictError("already fulfilled");
}
