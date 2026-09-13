import "server-only";

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  hashSignatureToken,
  generateSignatureToken,
  signatureRequestAnalogV1Schema,
  signatureRequestCreateV1Schema,
  signatureRequestSignV1Schema,
  signatureRequestWithdrawV1Schema,
  SIGNATURE_STATUS,
  SIGNATURE_MODE,
  SIGNATURE_WITHDRAWAL_REASON,
  type SignatureMode,
  type SignatureRequestStatus,
  type SignatureWithdrawalReason,
} from "@/lib/integrations/offers/signature-contract";
import { hashPortalToken } from "@/lib/integrations/portal/portal-contract";
import { PortalNotFoundError, resolvePortalByToken } from "@/modules/portal";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type Action,
  type ServiceCtx,
} from "@/lib/permissions";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const instantSchema = z.union([z.date(), z.string().min(1)])
  .transform((value) => new Date(value).toISOString());
const nullableInstantSchema = instantSchema.nullable();
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);

export const SIGNATURE_CONFLICT_CODES = [
  "invalid_ttl",
  "invalid_binding",
  "issuance_not_approved",
  "artifact_missing",
  "signer_missing",
  "variant_revision_changed",
  "request_already_exists",
  "transition_conflict",
  "revocation_window_closed",
  "withdrawal_conflict",
  "project_outcome_conflict",
  "project_outcome_revision_exhausted",
] as const;

const createResultSchema = z.strictObject({
  status: z.enum(SIGNATURE_STATUS),
  requestId: uuidSchema,
  offerId: uuidSchema,
  issuanceId: uuidSchema,
  expiresAt: instantSchema,
  replayed: z.boolean(),
});

const signResultSchema = z.strictObject({
  status: z.enum([...SIGNATURE_STATUS, "already_signed"]),
  requestId: uuidSchema,
  projectId: uuidSchema.optional(),
  offerId: uuidSchema.optional(),
  attestationId: uuidSchema.optional(),
  signerName: z.string().optional(),
  signedAt: instantSchema.optional(),
});

const revokeResultSchema = z.strictObject({
  status: z.enum([...SIGNATURE_STATUS, "conflict"]),
  requestId: uuidSchema,
  offerId: uuidSchema.optional(),
  revokedByCustomerAt: instantSchema.optional(),
  replayed: z.boolean().optional(),
  code: z.string().optional(),
});

const viewResultSchema = z.strictObject({
  status: z.enum([...SIGNATURE_STATUS, "not_found"]),
  requestId: uuidSchema.optional(),
  viewCount: z.int().safe().min(0).optional(),
  firstViewedAt: instantSchema.nullable().optional(),
});

const conflictResultSchema = z.strictObject({
  status: z.literal("conflict"),
  code: z.string(),
});

const notFoundResultSchema = z.strictObject({ status: z.literal("not_found") });

export class SignatureValidationError extends Error {
  constructor(public readonly paths: string[] = []) {
    super("signature request command is invalid");
    this.name = "SignatureValidationError";
  }
}

export class SignatureNotFoundError extends Error {
  constructor() {
    super("signature request was not found");
    this.name = "SignatureNotFoundError";
  }
}

export class SignatureConflictError extends Error {
  constructor(public readonly code: string) {
    super("signature request state changed");
    this.name = "SignatureConflictError";
  }
}

export class SignatureIntegrityError extends Error {
  constructor() {
    super("stored signature request failed integrity validation");
    this.name = "SignatureIntegrityError";
  }
}

export class SignaturePersistenceError extends Error {
  constructor() {
    super("signature request persistence failed");
    this.name = "SignaturePersistenceError";
  }
}

export type SignatureCreateResult = {
  requestId: string;
  token: string;
  offerId: string;
  issuanceId: string;
  status: SignatureRequestStatus;
  expiresAt: string;
  replayed: boolean;
};

export type SignatureSignResult = {
  requestId: string;
  projectId: string | null;
  offerId: string | null;
  attestationId: string | null;
  status: SignatureRequestStatus | "already_signed";
  signerName: string | null;
  signedAt: string | null;
};

export type SignatureRevokeResult = {
  requestId: string;
  offerId: string | null;
  status: SignatureRequestStatus;
  revokedByCustomerAt: string | null;
  replayed: boolean;
};

export type SignatureViewResult = {
  requestId: string | null;
  status: SignatureRequestStatus | "not_found";
  viewCount: number;
  firstViewedAt: string | null;
};

export type SignatureAttestationDto = {
  mode: SignatureMode;
  signerName: string;
  signedAt: string;
  contentSha256Hex: string;
  artifactMimeType: string | null;
  artifactSha256Hex: string | null;
  artifactSizeBytes: number | null;
};

export type SignatureRequestDto = {
  requestId: string;
  offerId: string;
  variantId: string;
  issuanceId: string;
  status: SignatureRequestStatus;
  expiresAt: string;
  contentSha256Hex: string;
  createdAt: string;
  signerName: string | null;
  signedAt: string | null;
  withdrawnAt: string | null;
  withdrawnBy: string | null;
  withdrawalReason: SignatureWithdrawalReason | null;
  revokedByCustomerAt: string | null;
  viewCount: number;
  firstViewedAt: string | null;
  attestation: SignatureAttestationDto | null;
};

export type SignaturePublicView = {
  status: SignatureRequestStatus;
  expiresAt: string;
  signerName: string | null;
  signedAt: string | null;
  attestationMode: SignatureMode | null;
  documentMimeType: string | null;
  documentSha256Hex: string | null;
  documentSizeBytes: number | null;
  documentBytes: Buffer | null;
};

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => (
    issue.path.length === 0
      ? "/"
      : `/${issue.path.map((part) => String(part)).join("/")}`
  )))].slice(0, 20);
}

function parseCommand<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new SignatureValidationError(issuePaths(parsed.error));
  return parsed.data;
}

function requireInternalAccess(ctx: ServiceCtx, action: Action, resource: string): void {
  if (!can(ctx, action)) {
    throw new PermissionDeniedError(action, resource, undefined, ctx.actor);
  }
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(action, resource, "external_only_without_assignment", ctx.actor);
  }
}

function requireSameWorkspace(ctx: ServiceCtx, workspaceId: string): void {
  if (ctx.workspaceId !== workspaceId) throw new SignatureNotFoundError();
}

async function executeFunction(tx: TenantTx, statement: ReturnType<typeof sql>): Promise<unknown> {
  let rows: unknown[];
  try {
    rows = (await tx.execute(statement)).rows;
  } catch {
    throw new SignaturePersistenceError();
  }
  if (rows.length === 0) throw new SignaturePersistenceError();
  if (rows.length !== 1) throw new SignatureIntegrityError();
  const row = z.strictObject({ result: z.unknown() }).safeParse(rows[0]);
  if (!row.success) throw new SignatureIntegrityError();
  return row.data.result;
}

async function recordSuccess(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { action: Action; eventType: string; offerId: string; details: Record<string, unknown> },
): Promise<void> {
  try {
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "offer",
      aggregateId: input.offerId,
      eventType: input.eventType,
      actor: ctx.actor,
      payload: input.details,
    });
    await writeAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      action: input.action,
      resource: "signature_request",
      allowed: true,
      details: input.details,
    });
  } catch {
    throw new SignaturePersistenceError();
  }
}

function sha256Hex(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isPdfMagic(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

function isJpegMagic(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPngMagic(bytes: Buffer): boolean {
  return bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
}

function assertArtifactMagic(mimeType: string, bytes: Buffer): void {
  const ok = mimeType === "application/pdf" ? isPdfMagic(bytes)
    : mimeType === "image/jpeg" ? isJpegMagic(bytes)
      : mimeType === "image/png" ? isPngMagic(bytes)
        : false;
  if (!ok) throw new SignatureValidationError(["/artifactBytes"]);
}

export async function createSignatureRequest(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<SignatureCreateResult> {
  requireInternalAccess(ctx, "offer.signature.create", "signature_request");
  const command = parseCommand(signatureRequestCreateV1Schema, value);
  requireSameWorkspace(ctx, command.workspaceId);
  const { token, tokenHash } = generateSignatureToken();
  const raw = await executeFunction(tx, sql`
    select public.create_signature_request(
      ${command.workspaceId}::uuid,
      ${command.offerId}::uuid,
      ${command.variantId}::uuid,
      ${command.ttlDays}::integer,
      ${tokenHash}
    ) as result
  `);
  const parsed = createResultSchema.safeParse(raw);
  if (!parsed.success) return mapNonSuccess(raw);
  const result = parsed.data;
  if (
    result.offerId !== command.offerId
    || (result.replayed && result.status !== "pending")
  ) throw new SignatureIntegrityError();
  await recordSuccess(tx, ctx, {
    action: "offer.signature.create",
    eventType: result.replayed ? "signature.request_created_replayed" : "signature.request_created",
    offerId: result.offerId,
    details: {
      requestId: result.requestId,
      offerId: result.offerId,
      issuanceId: result.issuanceId,
      status: result.status,
      expiresAt: result.expiresAt,
      replayed: result.replayed,
    },
  });
  return { ...result, token };
}

export async function withdrawSignatureRequest(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<{ requestId: string; offerId: string; status: "withdrawn"; reasonCode: SignatureWithdrawalReason }> {
  requireInternalAccess(ctx, "offer.signature.withdraw", "signature_request");
  const command = parseCommand(signatureRequestWithdrawV1Schema, value);
  requireSameWorkspace(ctx, command.workspaceId);
  let rows: unknown[];
  try {
    rows = (await tx.execute(sql`
      update public.signature_request
         set status = 'withdrawn',
             withdrawn_by = ${ctx.actor}::uuid,
             withdrawal_reason = ${command.reasonCode}::text,
             withdrawn_at = pg_catalog.statement_timestamp()
       where workspace_id = ${command.workspaceId}::uuid
         and id = ${command.requestId}::uuid
         and status = 'pending'
       returning id, offer_id, withdrawal_reason
    `)).rows;
  } catch {
    throw new SignaturePersistenceError();
  }
  if (rows.length === 0) {
    // Kein Treffer: entweder nicht vorhanden, fremd oder kein pending mehr.
    const existing = await readRows(tx, sql`
      select id, status from public.signature_request
       where workspace_id = ${command.workspaceId}::uuid and id = ${command.requestId}::uuid
    `);
    if (existing.length === 0) throw new SignatureNotFoundError();
    throw new SignatureConflictError("withdrawal_conflict");
  }
  if (rows.length !== 1) throw new SignatureIntegrityError();
  const row = z.strictObject({
    id: uuidSchema,
    offer_id: uuidSchema,
    withdrawal_reason: z.enum(SIGNATURE_WITHDRAWAL_REASON),
  }).safeParse(rows[0]);
  if (!row.success) throw new SignatureIntegrityError();
  await recordSuccess(tx, ctx, {
    action: "offer.signature.withdraw",
    eventType: "signature.request_withdrawn",
    offerId: row.data.offer_id,
    details: { requestId: row.data.id, offerId: row.data.offer_id, reasonCode: row.data.withdrawal_reason },
  });
  return {
    requestId: row.data.id,
    offerId: row.data.offer_id,
    status: "withdrawn",
    reasonCode: row.data.withdrawal_reason,
  };
}

export async function uploadAnalogSignature(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<{
  requestId: string;
  projectId: string;
  offerId: string;
  status: "signed";
  mode: "analog";
}> {
  requireInternalAccess(ctx, "offer.signature.upload_analog", "signature_request");
  const command = parseCommand(signatureRequestAnalogV1Schema, value);
  requireSameWorkspace(ctx, command.workspaceId);
  assertArtifactMagic(command.mimeType, command.artifactBytes);
  const signingDate = new Date(command.signingDate);
  const maxFuture = Date.now() + 24 * 60 * 60 * 1000;
  if (Number.isNaN(signingDate.getTime()) || signingDate.getTime() > maxFuture) {
    throw new SignatureValidationError(["/signingDate"]);
  }

  // Die DB-Kapsel ist die einzige analoge Terminalkante. Sie autorisiert und
  // sperrt Project -> Request -> Variant, schreibt Request + Attestierung und
  // laesst den Attestation-Trigger Outcome/Event/Audit atomar erzeugen.
  const rows = await readRows(tx, sql`
    select public.sign_signature_analog(
      ${command.workspaceId}::uuid,
      ${command.requestId}::uuid,
      ${command.signingDate}::timestamptz,
      ${command.mimeType}::text,
      ${command.artifactBytes}::bytea
    ) as result
  `);
  if (rows.length !== 1) throw new SignatureIntegrityError();
  const envelope = z.strictObject({ result: z.unknown() }).safeParse(rows[0]);
  if (!envelope.success) throw new SignatureIntegrityError();
  const parsedResult = signResultSchema.safeParse(envelope.data.result);
  if (!parsedResult.success) mapNonSuccess(envelope.data.result);
  if (
    parsedResult.data.status !== "signed"
    || !parsedResult.data.projectId
    || !parsedResult.data.offerId
    || !parsedResult.data.attestationId
  ) {
    throw new SignatureIntegrityError();
  }
  return {
    requestId: parsedResult.data.requestId,
    projectId: parsedResult.data.projectId,
    offerId: parsedResult.data.offerId,
    status: "signed",
    mode: "analog",
  };
}

async function readRows(tx: TenantTx, statement: ReturnType<typeof sql>): Promise<unknown[]> {
  try {
    return (await tx.execute(statement)).rows;
  } catch {
    throw new SignaturePersistenceError();
  }
}

function mapNonSuccess(value: unknown): never {
  if (notFoundResultSchema.safeParse(value).success) throw new SignatureNotFoundError();
  const conflict = conflictResultSchema.safeParse(value);
  if (conflict.success) throw new SignatureConflictError(conflict.data.code);
  throw new SignatureIntegrityError();
}

const REQUEST_SELECT = sql.raw(`
  request_record.id, request_record.offer_id, request_record.variant_id,
  request_record.issuance_id,
  case
    when request_record.status = 'pending'
      and request_record.expires_at <= pg_catalog.statement_timestamp()
      then 'expired'
    else request_record.status
  end as status,
  request_record.expires_at,
  encode(request_record.content_sha256, 'hex') as content_sha256_hex,
  request_record.created_at, request_record.signer_name, request_record.signed_at,
  request_record.withdrawn_at, request_record.withdrawn_by,
  request_record.withdrawal_reason, request_record.revoked_by_customer_at,
  coalesce(view_stats.view_count, 0)::integer as view_count,
  view_stats.first_viewed_at,
  attestation_record.mode as attestation_mode,
  attestation_record.signer_name as attestation_signer_name,
  attestation_record.signed_at as attestation_signed_at,
  encode(attestation_record.content_sha256, 'hex') as attestation_content_sha256_hex,
  attestation_record.artifact_mime_type as attestation_artifact_mime_type,
  encode(attestation_record.artifact_sha256, 'hex') as attestation_artifact_sha256_hex,
  attestation_record.artifact_size_bytes as attestation_artifact_size_bytes
`);

const requestRowSchema = z.strictObject({
  id: uuidSchema,
  offer_id: uuidSchema,
  variant_id: uuidSchema,
  issuance_id: uuidSchema,
  status: z.enum(SIGNATURE_STATUS),
  expires_at: instantSchema,
  content_sha256_hex: sha256HexSchema,
  created_at: instantSchema,
  signer_name: z.string().nullable(),
  signed_at: nullableInstantSchema,
  withdrawn_at: nullableInstantSchema,
  withdrawn_by: uuidSchema.nullable(),
  withdrawal_reason: z.enum(SIGNATURE_WITHDRAWAL_REASON).nullable(),
  revoked_by_customer_at: nullableInstantSchema,
  view_count: z.int().safe().min(0),
  first_viewed_at: nullableInstantSchema,
  attestation_mode: z.enum(SIGNATURE_MODE).nullable(),
  attestation_signer_name: z.string().nullable(),
  attestation_signed_at: nullableInstantSchema,
  attestation_content_sha256_hex: sha256HexSchema.nullable(),
  attestation_artifact_mime_type: z.string().nullable(),
  attestation_artifact_sha256_hex: sha256HexSchema.nullable(),
  attestation_artifact_size_bytes: z.int().safe().nullable(),
});

function requestDto(row: unknown): SignatureRequestDto {
  const parsed = requestRowSchema.safeParse(row);
  if (!parsed.success) throw new SignatureIntegrityError();
  const data = parsed.data;
  return {
    requestId: data.id,
    offerId: data.offer_id,
    variantId: data.variant_id,
    issuanceId: data.issuance_id,
    status: data.status,
    expiresAt: data.expires_at,
    contentSha256Hex: data.content_sha256_hex,
    createdAt: data.created_at,
    signerName: data.signer_name,
    signedAt: data.signed_at,
    withdrawnAt: data.withdrawn_at,
    withdrawnBy: data.withdrawn_by,
    withdrawalReason: data.withdrawal_reason,
    revokedByCustomerAt: data.revoked_by_customer_at,
    viewCount: data.view_count,
    firstViewedAt: data.first_viewed_at,
    attestation: data.attestation_mode === null
      ? null
      : {
          mode: data.attestation_mode,
          signerName: data.attestation_signer_name ?? "",
          signedAt: data.attestation_signed_at ?? "",
          contentSha256Hex: data.attestation_content_sha256_hex ?? "",
          artifactMimeType: data.attestation_artifact_mime_type,
          artifactSha256Hex: data.attestation_artifact_sha256_hex,
          artifactSizeBytes: data.attestation_artifact_size_bytes,
        },
  };
}

export async function listSignatureRequests(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<SignatureRequestDto[]> {
  requireInternalAccess(ctx, "offer.signature.read", "signature_request");
  const key = parseCommand(z.strictObject({ workspaceId: uuidSchema, offerId: uuidSchema }), value);
  requireSameWorkspace(ctx, key.workspaceId);
  const rows = await readRows(tx, sql`
    select ${REQUEST_SELECT}
      from public.signature_request as request_record
      left join lateral (
        select count(*) as view_count, min(view_record.viewed_at) as first_viewed_at
          from public.signature_view_log as view_record
         where view_record.workspace_id = request_record.workspace_id
           and view_record.signature_request_id = request_record.id
      ) as view_stats on true
      left join public.signature_attestation as attestation_record
        on attestation_record.workspace_id = request_record.workspace_id
       and attestation_record.signature_request_id = request_record.id
     where request_record.workspace_id = ${key.workspaceId}::uuid
       and request_record.offer_id = ${key.offerId}::uuid
     order by request_record.created_at desc, request_record.id desc
  `);
  return rows.map(requestDto);
}

export type SignatureLeadTimeStats = {
  /** Anzahl signierter Vorgaenge (gedeckelt, s. capped). */
  signedCount: number;
  /** true, wenn mehr als das Auswertungslimit signiert sind. */
  capped: boolean;
  /** Median Erzeugung -> Unterschrift in Tagen (null ohne Signierte). */
  medianDays: number | null;
};

/** Auswertungslimit fuer die Signaturdauer (ehrliches „+"). */
const SIGNATURE_LEAD_TIME_LIMIT = 500;

/**
 * DASH-03 Signaturdauer: Median (signed_at - created_at) ueber signierte
 * Vorgaenge des Workspaces (neueste zuerst, gedeckelt). Rein lesend;
 * keine neue Permission (offer.signature.read, viewer+, internal).
 */
export async function getSignatureLeadTimeStats(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<SignatureLeadTimeStats> {
  requireInternalAccess(ctx, "offer.signature.read", "signature_request");
  const rows = await readRows(tx, sql`
    select extract(epoch from (request_record.signed_at - request_record.created_at)) as lead_seconds
      from public.signature_request as request_record
     where request_record.workspace_id = ${ctx.workspaceId}::uuid
       and request_record.signed_at is not null
     order by request_record.signed_at desc, request_record.id desc
     limit ${SIGNATURE_LEAD_TIME_LIMIT + 1}
  `) as Array<{ lead_seconds: string | number }>;
  const capped = rows.length > SIGNATURE_LEAD_TIME_LIMIT;
  const leads = rows
    .slice(0, SIGNATURE_LEAD_TIME_LIMIT)
    .map((row) => Number(row.lead_seconds))
    .filter((seconds) => Number.isFinite(seconds) && seconds >= 0)
    .sort((a, b) => a - b);
  if (leads.length === 0) return { signedCount: 0, capped: false, medianDays: null };
  const middle = Math.floor(leads.length / 2);
  const medianSeconds = leads.length % 2 === 1
    ? leads[middle]!
    : (leads[middle - 1]! + leads[middle]!) / 2;
  return {
    signedCount: leads.length,
    capped,
    medianDays: Math.round((medianSeconds / 86_400) * 10) / 10,
  };
}

export async function getSignatureRequest(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<SignatureRequestDto> {
  requireInternalAccess(ctx, "offer.signature.read", "signature_request");
  const key = parseCommand(z.strictObject({
    workspaceId: uuidSchema,
    requestId: uuidSchema,
  }), value);
  requireSameWorkspace(ctx, key.workspaceId);
  const rows = await readRows(tx, sql`
    select ${REQUEST_SELECT}
      from public.signature_request as request_record
      left join lateral (
        select count(*) as view_count, min(view_record.viewed_at) as first_viewed_at
          from public.signature_view_log as view_record
         where view_record.workspace_id = request_record.workspace_id
           and view_record.signature_request_id = request_record.id
      ) as view_stats on true
      left join public.signature_attestation as attestation_record
        on attestation_record.workspace_id = request_record.workspace_id
       and attestation_record.signature_request_id = request_record.id
     where request_record.workspace_id = ${key.workspaceId}::uuid
       and request_record.id = ${key.requestId}::uuid
     limit 2
  `);
  if (rows.length === 0) throw new SignatureNotFoundError();
  if (rows.length !== 1) throw new SignatureIntegrityError();
  return requestDto(rows[0]);
}

// ═══════════════════════════════════════════════════════════════════════
// Öffentlicher Token-Pfad (rollenlos). Nimmt bewusst einen rohen Pool entgegen,
// da der Aufrufer keinen Mandantenkontext besitzt; die Autorisierung ist allein
// das hoch-entropische Token (SECURITY-DEFINER-Funktionen).
// ═══════════════════════════════════════════════════════════════════════

async function poolRows(pool: Pool, text: string, values: unknown[]): Promise<unknown[]> {
  const result = await pool.query(text, values);
  return result.rows;
}

export async function signSignatureByToken(
  pool: Pool,
  value: unknown,
): Promise<SignatureSignResult> {
  const command = parseCommand(signatureRequestSignV1Schema, value);
  if (command.mode === "draw") {
    if (!command.artifactBytes || !command.artifactMimeType) {
      throw new SignatureValidationError(["/artifactBytes"]);
    }
    assertArtifactMagic(command.artifactMimeType, command.artifactBytes);
  }
  const tokenHash = hashSignatureToken(command.token);
  const rows = await poolRows(pool, `
    select public.sign_signature_by_token($1::bytea, $2::text, $3::text, $4::bytea) as result
  `, [tokenHash, command.mode, command.artifactMimeType, command.artifactBytes]);
  const raw = z.strictObject({ result: z.unknown() }).safeParse(rows[0]);
  if (!raw.success || rows.length !== 1) throw new SignatureIntegrityError();
  const parsed = signResultSchema.safeParse(raw.data.result);
  if (!parsed.success) return mapNonSuccess(raw.data.result);
  return {
    requestId: parsed.data.requestId,
    projectId: parsed.data.projectId ?? null,
    offerId: parsed.data.offerId ?? null,
    attestationId: parsed.data.attestationId ?? null,
    status: parsed.data.status,
    signerName: parsed.data.signerName ?? null,
    signedAt: parsed.data.signedAt ?? null,
  };
}

export async function revokeSignatureByCustomer(
  pool: Pool,
  value: unknown,
): Promise<SignatureRevokeResult> {
  const command = parseCommand(z.strictObject({ token: z.string().min(1) }), value);
  const tokenHash = hashSignatureToken(command.token);
  const rows = await poolRows(pool, `
    select public.revoke_signature_by_customer($1::bytea) as result
  `, [tokenHash]);
  const raw = z.strictObject({ result: z.unknown() }).safeParse(rows[0]);
  if (!raw.success || rows.length !== 1) throw new SignatureIntegrityError();
  const parsed = revokeResultSchema.safeParse(raw.data.result);
  if (!parsed.success) return mapNonSuccess(raw.data.result);
  return {
    requestId: parsed.data.requestId,
    offerId: parsed.data.offerId ?? null,
    status: parsed.data.status === "conflict" ? "signed" : parsed.data.status,
    revokedByCustomerAt: parsed.data.revokedByCustomerAt ?? null,
    replayed: parsed.data.replayed ?? false,
  };
}

// F10-02c Portal-Signatur schreiben: Invite-Kapseln (dritter anonymer
// Schreibpfad des Portals nach F10-04/F13-06). Toter Invite fällt uniform
// auf NotFound (kein Orakel); Kapsel-Antworten werden wie die
// Token-Pendants gemappt (already_signed/replayed = Replay-ok).
const inviteCapsuleInputSchema = z.strictObject({
  token: z.string().min(1),
  issuanceId: uuidSchema,
});

async function resolveInviteTokenHash(pool: Pool, token: string): Promise<Buffer> {
  try {
    await resolvePortalByToken(pool, { token });
  } catch (error) {
    if (error instanceof PortalNotFoundError) throw new SignatureNotFoundError();
    throw error;
  }
  const tokenHash = hashPortalToken(token);
  if (tokenHash === null) throw new SignatureValidationError(["/token"]);
  return tokenHash;
}

export async function signSignatureByInviteToken(
  pool: Pool,
  value: unknown,
): Promise<SignatureSignResult> {
  const command = parseCommand(inviteCapsuleInputSchema, value);
  const tokenHash = await resolveInviteTokenHash(pool, command.token);
  const rows = await poolRows(pool, `
    select public.sign_signature_by_invite($1::bytea, $2::uuid) as result
  `, [tokenHash, command.issuanceId]);
  const raw = z.strictObject({ result: z.unknown() }).safeParse(rows[0]);
  if (!raw.success || rows.length !== 1) throw new SignatureIntegrityError();
  const parsed = signResultSchema.safeParse(raw.data.result);
  if (!parsed.success) return mapNonSuccess(raw.data.result);
  // Falscher Stand (weder signiert noch Replay) fällt uniform auf
  // NotFound — kein Orakel über Request-Existenz oder -Stand.
  if (parsed.data.status !== "signed" && parsed.data.status !== "already_signed") {
    throw new SignatureNotFoundError();
  }
  return {
    requestId: parsed.data.requestId,
    projectId: parsed.data.projectId ?? null,
    offerId: parsed.data.offerId ?? null,
    attestationId: parsed.data.attestationId ?? null,
    status: parsed.data.status,
    signerName: parsed.data.signerName ?? null,
    signedAt: parsed.data.signedAt ?? null,
  };
}

export async function revokeSignatureByInviteToken(
  pool: Pool,
  value: unknown,
): Promise<SignatureRevokeResult> {
  const command = parseCommand(inviteCapsuleInputSchema, value);
  const tokenHash = await resolveInviteTokenHash(pool, command.token);
  const rows = await poolRows(pool, `
    select public.revoke_signature_by_invite($1::bytea, $2::uuid) as result
  `, [tokenHash, command.issuanceId]);
  const raw = z.strictObject({ result: z.unknown() }).safeParse(rows[0]);
  if (!raw.success || rows.length !== 1) throw new SignatureIntegrityError();
  const parsed = revokeResultSchema.safeParse(raw.data.result);
  if (!parsed.success) return mapNonSuccess(raw.data.result);
  // Falscher Stand (z. B. pending widerrufen) fällt uniform auf NotFound —
  // kein Orakel über Request-Existenz oder -Stand.
  if (parsed.data.status !== "revoked_by_customer") {
    throw new SignatureNotFoundError();
  }
  return {
    requestId: parsed.data.requestId,
    offerId: parsed.data.offerId ?? null,
    status: parsed.data.status,
    revokedByCustomerAt: parsed.data.revokedByCustomerAt ?? null,
    replayed: parsed.data.replayed ?? false,
  };
}

export async function recordSignatureView(
  pool: Pool,
  value: unknown,
): Promise<SignatureViewResult> {
  const command = parseCommand(z.strictObject({ token: z.string().min(1) }), value);
  const tokenHash = hashSignatureToken(command.token);
  const rows = await poolRows(pool, `
    select public.record_signature_view($1::bytea) as result
  `, [tokenHash]);
  const raw = z.strictObject({ result: z.unknown() }).safeParse(rows[0]);
  if (!raw.success || rows.length !== 1) throw new SignatureIntegrityError();
  const parsed = viewResultSchema.safeParse(raw.data.result);
  if (!parsed.success) return mapNonSuccess(raw.data.result);
  return {
    requestId: parsed.data.requestId ?? null,
    status: parsed.data.status,
    viewCount: parsed.data.viewCount ?? 0,
    firstViewedAt: parsed.data.firstViewedAt ?? null,
  };
}

export async function resolveSignatureByToken(
  pool: Pool,
  value: unknown,
): Promise<SignaturePublicView> {
  const command = parseCommand(z.strictObject({ token: z.string().min(1) }), value);
  const tokenHash = hashSignatureToken(command.token);
  const rows = await poolRows(pool, `
    select * from public.resolve_signature_public_view($1::bytea)
  `, [tokenHash]);
  if (rows.length === 0) throw new SignatureNotFoundError();
  const row = z.strictObject({
    status: z.enum(SIGNATURE_STATUS),
    expires_at: instantSchema,
    signer_name: z.string().nullable(),
    signed_at: nullableInstantSchema,
    attestation_mode: z.enum(SIGNATURE_MODE).nullable(),
    document_mime_type: z.string().nullable(),
    document_sha256: z.custom<Buffer | null>((value) => value === null || Buffer.isBuffer(value)),
    document_size_bytes: z.int().safe().nullable(),
    document_bytes: z.custom<Buffer | null>((value) => value === null || Buffer.isBuffer(value)),
  }).safeParse(rows[0]);
  if (!row.success) throw new SignatureIntegrityError();
  return {
    status: row.data.status,
    expiresAt: row.data.expires_at,
    signerName: row.data.signer_name,
    signedAt: row.data.signed_at,
    attestationMode: row.data.attestation_mode,
    documentMimeType: row.data.document_mime_type,
    documentSha256Hex: row.data.document_sha256 ? sha256Hex(row.data.document_sha256) : null,
    documentSizeBytes: row.data.document_size_bytes,
    documentBytes: row.data.document_bytes,
  };
}
