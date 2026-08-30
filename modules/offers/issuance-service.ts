import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  OFFER_ISSUANCE_DISPATCH_VERSION,
  offerIssuanceApprovalCommandV1Schema,
  offerIssuanceRequestV1Schema,
  offerIssuanceWithdrawalCommandV1Schema,
  type OfferIssuanceWithdrawalReasonV1,
} from "@/lib/integrations/offers/issuance-contract";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type Action,
  type ServiceCtx,
} from "@/lib/permissions";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/u;
const OFFER_NUMBER_PATTERN = /^ANG-[0-9]{4}-[0-9]{6}$/u;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const nonnegativeAttemptSchema = z.int().safe().min(0).max(3);
const databaseInstantSchema = z.union([z.date(), z.string().min(1)])
  .transform((value, context) => {
    const parsed = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      context.addIssue({ code: "custom", message: "invalid database instant" });
      return z.NEVER;
    }
    return parsed.toISOString();
  });
const nullableDatabaseInstantSchema = databaseInstantSchema.nullable();
const safeErrorCodeSchema = z.string().regex(SAFE_ERROR_CODE_PATTERN);

const renderStateSchema = z.enum([
  "queued",
  "running",
  "retry_wait",
  "ready_for_approval",
  "failed_final",
]);
const derivedStateSchema = z.enum([
  "queued",
  "running",
  "retry_wait",
  "ready_for_approval",
  "failed_final",
  "approval_pending",
  "approved_for_archive_not_issued",
  "withdrawn_before_archive",
]);
const withdrawalReasonSchema = z.enum([
  "content_error",
  "recipient_error",
  "legal_text_error",
  "commercial_error",
  "other",
]);

export type OfferIssuanceRenderState = z.infer<typeof renderStateSchema>;
export type OfferIssuanceStatusState = z.infer<typeof derivedStateSchema>;

const offerKeySchema = z.strictObject({
  workspaceId: uuidSchema,
  offerId: uuidSchema,
});
const issuanceKeySchema = offerKeySchema.extend({ issuanceId: uuidSchema });
const functionRowSchema = z.strictObject({ result: z.unknown() });
const notFoundResultSchema = z.strictObject({ status: z.literal("not_found") });

export const OFFER_ISSUANCE_CONFLICT_CODES = [
  "candidate_not_approved",
  "candidate_source_changed",
  "candidate_expired",
  "candidate_artifact_integrity_changed",
  "issuance_not_ready",
  "issuance_source_changed",
  "artifact_integrity_changed",
  "approval_conflict",
  "zero_tax_review_required",
  "zero_tax_review_forbidden",
  "approval_limit_reached",
  "withdrawn_before_archive",
  "withdrawal_conflict",
] as const;

const conflictResultSchema = z.strictObject({
  status: z.literal("conflict"),
  code: z.enum(OFFER_ISSUANCE_CONFLICT_CODES),
});

const preparedResultSchema = z.strictObject({
  status: z.literal("prepared"),
  workspaceId: uuidSchema,
  issuanceId: uuidSchema,
  projectId: uuidSchema,
  offerId: uuidSchema,
  candidateId: uuidSchema,
  state: renderStateSchema,
  approvalCount: z.int().safe().min(0).max(2),
  derivedState: derivedStateSchema,
  attemptCount: nonnegativeAttemptSchema,
  nextAttemptAt: databaseInstantSchema,
  createdAt: databaseInstantSchema,
  replayed: z.boolean(),
});

const approvedResultSchema = z.strictObject({
  status: z.literal("approved"),
  workspaceId: uuidSchema,
  issuanceId: uuidSchema,
  offerId: uuidSchema,
  approvalId: uuidSchema,
  approvalCount: z.union([z.literal(1), z.literal(2)]),
  derivedState: z.enum([
    "approval_pending",
    "approved_for_archive_not_issued",
  ]),
  approvedBy: uuidSchema,
  approvedAt: databaseInstantSchema,
  replayed: z.boolean(),
});

const withdrawnResultSchema = z.strictObject({
  status: z.literal("withdrawn"),
  workspaceId: uuidSchema,
  issuanceId: uuidSchema,
  offerId: uuidSchema,
  withdrawalId: uuidSchema,
  reasonCode: withdrawalReasonSchema,
  approvalCount: z.int().safe().min(0).max(2),
  derivedState: z.literal("withdrawn_before_archive"),
  withdrawnBy: uuidSchema,
  withdrawnAt: databaseInstantSchema,
  replayed: z.boolean(),
});

const statusRowSchema = z.strictObject({
  workspace_id: uuidSchema,
  id: uuidSchema,
  offer_id: uuidSchema,
  candidate_id: uuidSchema,
  artifact_intent: z.literal("offer_issuance_final"),
  has_zero_tax_treatment: z.boolean(),
  state: renderStateSchema,
  attempt_count: nonnegativeAttemptSchema,
  next_attempt_at: databaseInstantSchema,
  created_at: databaseInstantSchema,
  started_at: nullableDatabaseInstantSchema,
  finished_at: nullableDatabaseInstantSchema,
  error_code: safeErrorCodeSchema.nullable(),
  approval_count: z.int().safe().min(0).max(2),
  viewer_has_approved: z.boolean(),
  can_current_actor_approve: z.boolean(),
  derived_state: derivedStateSchema,
  withdrawal_id: uuidSchema.nullable(),
  withdrawal_reason_code: withdrawalReasonSchema.nullable(),
  withdrawn_at: nullableDatabaseInstantSchema,
  approval_artifact_version: uuidSchema.nullable(),
});

const artifactRowSchema = statusRowSchema.extend({
  offer_number: z.string().regex(OFFER_NUMBER_PATTERN),
  artifact_mime_type: z.literal("application/pdf"),
  artifact_sha256_hex: z.string().regex(SHA256_PATTERN),
  artifact_size_bytes: z.int().safe().min(100).max(MAX_ARTIFACT_BYTES),
  artifact_bytes: z.custom<Buffer>((value) => Buffer.isBuffer(value)),
});

const dispatchGateSchema = z.strictObject({
  dispatch_signature: z.literal("pgboss.enqueue_offer_issuance(uuid,uuid)").nullable(),
  current_role: z.string().min(1),
  session_role: z.string().min(1),
  database_name: z.string().min(1),
});

export class OfferIssuanceValidationError extends Error {
  constructor(public readonly paths: string[] = []) {
    super("offer issuance command is invalid");
    this.name = "OfferIssuanceValidationError";
  }
}

export class OfferIssuanceNotFoundError extends Error {
  constructor() {
    super("offer issuance was not found");
    this.name = "OfferIssuanceNotFoundError";
  }
}

export class OfferIssuanceConflictError extends Error {
  constructor(public readonly code: typeof OFFER_ISSUANCE_CONFLICT_CODES[number]) {
    super("offer issuance sources or state changed");
    this.name = "OfferIssuanceConflictError";
  }
}

export class OfferIssuanceIntegrityError extends Error {
  constructor() {
    super("stored offer issuance failed integrity validation");
    this.name = "OfferIssuanceIntegrityError";
  }
}

export class OfferIssuancePersistenceError extends Error {
  constructor() {
    super("offer issuance persistence failed");
    this.name = "OfferIssuancePersistenceError";
  }
}

export class OfferIssuanceDispatchError extends Error {
  readonly code = "dispatch_unavailable" as const;

  constructor() {
    super("offer issuance dispatch is unavailable");
    this.name = "OfferIssuanceDispatchError";
  }
}

export type OfferIssuanceRequestResult = {
  issuanceId: string;
  offerId: string;
  candidateId: string;
  state: OfferIssuanceStatusState;
  approvalCount: number;
  publicationStatus: "not_issued";
  replayed: boolean;
};

export type OfferIssuanceApprovalResult = {
  issuanceId: string;
  offerId: string;
  approvalId: string;
  state: "approval_pending" | "approved_for_archive_not_issued";
  approvalCount: 1 | 2;
  publicationStatus: "not_issued";
  approvedAt: string;
  replayed: boolean;
};

export type OfferIssuanceWithdrawalResult = {
  issuanceId: string;
  offerId: string;
  withdrawalId: string;
  state: "withdrawn_before_archive";
  approvalCount: number;
  publicationStatus: "not_issued";
  reasonCode: OfferIssuanceWithdrawalReasonV1;
  withdrawnAt: string;
  replayed: boolean;
};

export type OfferIssuanceStatusResult = {
  issuanceId: string;
  offerId: string;
  candidateId: string;
  state: OfferIssuanceStatusState;
  renderState: OfferIssuanceRenderState;
  approvalCount: number;
  publicationStatus: "not_issued";
  requiresZeroTaxReview: boolean;
  attemptCount: number;
  nextAttemptAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  viewerHasApproved: boolean;
  canCurrentActorApprove: boolean;
  withdrawal: null | {
    withdrawalId: string;
    reasonCode: OfferIssuanceWithdrawalReasonV1;
    withdrawnAt: string;
  };
  canDownload: boolean;
};

export type OfferIssuanceArtifactResult = {
  issuanceId: string;
  offerId: string;
  candidateId: string;
  state: "ready_for_approval" | "approval_pending" | "approved_for_archive_not_issued";
  approvalCount: number;
  publicationStatus: "not_issued";
  filename: string;
  mimeType: "application/pdf";
  sha256: string;
  sizeBytes: number;
  bytes: Buffer;
};

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => (
    issue.path.length === 0
      ? "/"
      : `/${issue.path.map((part) => String(part)
        .replaceAll("~", "~0")
        .replaceAll("/", "~1")).join("/")}`
  )))].slice(0, 20);
}

function parseCommand<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new OfferIssuanceValidationError(issuePaths(parsed.error));
  return parsed.data;
}

function requireInternalAccess(ctx: ServiceCtx, action: Action, resource: string): void {
  if (!can(ctx, action)) {
    throw new PermissionDeniedError(action, resource, undefined, ctx.actor);
  }
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      action,
      resource,
      "external_only_without_assignment",
      ctx.actor,
    );
  }
}

function requireSameWorkspace(ctx: ServiceCtx, workspaceId: string): void {
  if (ctx.workspaceId !== workspaceId) throw new OfferIssuanceNotFoundError();
}

async function executeFunction(
  tx: TenantTx,
  statement: ReturnType<typeof sql>,
): Promise<unknown> {
  let rows: unknown[];
  try {
    rows = (await tx.execute(statement)).rows;
  } catch {
    throw new OfferIssuancePersistenceError();
  }
  if (rows.length === 0) throw new OfferIssuancePersistenceError();
  if (rows.length !== 1) throw new OfferIssuanceIntegrityError();
  const row = functionRowSchema.safeParse(rows[0]);
  if (!row.success) throw new OfferIssuanceIntegrityError();
  return row.data.result;
}

function mapNonSuccess(value: unknown): never {
  if (notFoundResultSchema.safeParse(value).success) {
    throw new OfferIssuanceNotFoundError();
  }
  const conflict = conflictResultSchema.safeParse(value);
  if (conflict.success) throw new OfferIssuanceConflictError(conflict.data.code);
  throw new OfferIssuanceIntegrityError();
}

async function readRows(
  tx: TenantTx,
  statement: ReturnType<typeof sql>,
): Promise<unknown[]> {
  try {
    return (await tx.execute(statement)).rows;
  } catch {
    throw new OfferIssuancePersistenceError();
  }
}

async function recordSuccess(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    action: Action;
    resource: string;
    eventType: string;
    offerId: string;
    details: Record<string, string | number | boolean>;
  },
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
      resource: input.resource,
      allowed: true,
      details: input.details,
    });
  } catch {
    throw new OfferIssuancePersistenceError();
  }
}

function validateLifecycle(input: {
  state: OfferIssuanceRenderState;
  attemptCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
}): void {
  const { state, attemptCount, createdAt, startedAt, finishedAt, errorCode } = input;
  const validShape = state === "queued"
    ? attemptCount < 3 && startedAt === null && finishedAt === null && errorCode === null
    : state === "running"
      ? attemptCount >= 1 && startedAt !== null && finishedAt === null && errorCode === null
      : state === "retry_wait"
        ? attemptCount >= 1 && attemptCount < 3 && startedAt !== null
          && finishedAt === null && errorCode !== null
        : state === "ready_for_approval"
          ? attemptCount >= 1 && startedAt !== null && finishedAt !== null
            && errorCode === null
          : attemptCount >= 1 && startedAt !== null && finishedAt !== null
            && errorCode !== null;
  if (!validShape) throw new OfferIssuanceIntegrityError();
  const createdMs = Date.parse(createdAt);
  const startedMs = startedAt === null ? null : Date.parse(startedAt);
  const finishedMs = finishedAt === null ? null : Date.parse(finishedAt);
  if (
    (startedMs !== null && startedMs < createdMs)
    || (finishedMs !== null && (startedMs === null || finishedMs < startedMs))
  ) throw new OfferIssuanceIntegrityError();
}

function statusResult(
  value: unknown,
  ctx: ServiceCtx,
  expected: { workspaceId: string; offerId: string; issuanceId?: string },
): OfferIssuanceStatusResult {
  const parsed = statusRowSchema.safeParse(value);
  if (!parsed.success) throw new OfferIssuanceIntegrityError();
  const row = parsed.data;
  if (
    row.workspace_id !== expected.workspaceId
    || row.offer_id !== expected.offerId
    || (expected.issuanceId !== undefined && row.id !== expected.issuanceId)
  ) throw new OfferIssuanceIntegrityError();
  validateLifecycle({
    state: row.state,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
  });

  const withdrawalParts = [
    row.withdrawal_id,
    row.withdrawal_reason_code,
    row.withdrawn_at,
  ];
  const withdrawn = withdrawalParts.every((part) => part !== null);
  if (!withdrawn && withdrawalParts.some((part) => part !== null)) {
    throw new OfferIssuanceIntegrityError();
  }
  if (withdrawn && Date.parse(row.withdrawn_at as string) < Date.parse(row.created_at)) {
    throw new OfferIssuanceIntegrityError();
  }
  if (row.approval_count > 0 && row.state !== "ready_for_approval") {
    throw new OfferIssuanceIntegrityError();
  }
  const expectedState: OfferIssuanceStatusState = withdrawn
    ? "withdrawn_before_archive"
    : row.approval_count === 2
      ? "approved_for_archive_not_issued"
      : row.approval_count === 1
        ? "approval_pending"
        : row.state;
  if (row.derived_state !== expectedState) throw new OfferIssuanceIntegrityError();

  const canApprove = can(ctx, "offer.issue.approve") && !isExternalOnly(ctx);
  const expectedCanCurrentActorApprove = canApprove
    && row.state === "ready_for_approval"
    && !withdrawn
    && row.approval_count < 2
    && !row.viewer_has_approved;
  if (
    (row.viewer_has_approved && row.approval_count === 0)
    || row.can_current_actor_approve !== expectedCanCurrentActorApprove
  ) throw new OfferIssuanceIntegrityError();
  if (
    row.approval_artifact_version !== null
    && (row.state !== "ready_for_approval" || withdrawn || !canApprove)
  ) throw new OfferIssuanceIntegrityError();
  const canDownload = row.state === "ready_for_approval"
    && !withdrawn
    && (row.approval_count === 2 || canApprove);

  return {
    issuanceId: row.id,
    offerId: row.offer_id,
    candidateId: row.candidate_id,
    state: expectedState,
    renderState: row.state,
    approvalCount: row.approval_count,
    publicationStatus: "not_issued",
    requiresZeroTaxReview: row.has_zero_tax_treatment,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    viewerHasApproved: row.viewer_has_approved,
    canCurrentActorApprove: row.can_current_actor_approve,
    withdrawal: withdrawn
      ? {
          withdrawalId: row.withdrawal_id as string,
          reasonCode: row.withdrawal_reason_code as OfferIssuanceWithdrawalReasonV1,
          withdrawnAt: row.withdrawn_at as string,
        }
      : null,
    canDownload,
  };
}

export async function enqueueOfferIssuanceDispatch(
  tx: TenantTx,
  value: unknown,
): Promise<void> {
  const dispatchSchema = z.strictObject({
    schemaVersion: z.literal(OFFER_ISSUANCE_DISPATCH_VERSION),
    workspaceId: uuidSchema,
    issuanceId: uuidSchema,
  });
  const dispatch = parseCommand(dispatchSchema, value);
  let rows: unknown[];
  try {
    rows = (await tx.execute(sql`
      select pg_catalog.to_regprocedure(
               'pgboss.enqueue_offer_issuance(uuid,uuid)'
             )::text as dispatch_signature,
             current_user::text as current_role,
             session_user::text as session_role,
             pg_catalog.current_database()::text as database_name
    `)).rows;
  } catch {
    throw new OfferIssuanceDispatchError();
  }
  if (rows.length !== 1) throw new OfferIssuanceDispatchError();
  const gate = dispatchGateSchema.safeParse(rows[0]);
  if (!gate.success) throw new OfferIssuanceDispatchError();
  if (gate.data.dispatch_signature === null) {
    const explicitTestSkip = gate.data.current_role === gate.data.session_role
      && (gate.data.current_role === "app_test" || gate.data.current_role === "app_ci")
      && gate.data.database_name.includes("test");
    if (explicitTestSkip) return;
    throw new OfferIssuanceDispatchError();
  }
  try {
    await tx.execute(sql`
      select pgboss.enqueue_offer_issuance(
        ${dispatch.workspaceId}::uuid,
        ${dispatch.issuanceId}::uuid
      )
    `);
  } catch {
    throw new OfferIssuanceDispatchError();
  }
}

export async function requestOfferIssuance(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferIssuanceRequestResult> {
  requireInternalAccess(ctx, "offer.issue.prepare", "offer_issuance");
  const command = parseCommand(offerIssuanceRequestV1Schema, value);
  requireSameWorkspace(ctx, command.workspaceId);
  const raw = await executeFunction(tx, sql`
    select public.prepare_offer_issuance(
      ${command.workspaceId}::uuid,
      ${command.offerId}::uuid,
      ${command.candidateId}::uuid
    ) as result
  `);
  const parsed = preparedResultSchema.safeParse(raw);
  if (!parsed.success) return mapNonSuccess(raw);
  const result = parsed.data;
  if (
    result.workspaceId !== command.workspaceId
    || result.offerId !== command.offerId
    || result.candidateId !== command.candidateId
    || (!result.replayed && (
      result.state !== "queued"
      || result.derivedState !== "queued"
      || result.approvalCount !== 0
      || result.attemptCount !== 0
    ))
  ) throw new OfferIssuanceIntegrityError();
  const expectedDerivedState: OfferIssuanceStatusState =
    result.derivedState === "withdrawn_before_archive"
      ? "withdrawn_before_archive"
      : result.approvalCount === 2
        ? "approved_for_archive_not_issued"
        : result.approvalCount === 1
          ? "approval_pending"
          : result.state;
  if (result.derivedState !== expectedDerivedState) {
    throw new OfferIssuanceIntegrityError();
  }

  if (
    result.derivedState !== "withdrawn_before_archive"
    && ["queued", "running", "retry_wait"].includes(result.state)
  ) {
    await enqueueOfferIssuanceDispatch(tx, {
      schemaVersion: OFFER_ISSUANCE_DISPATCH_VERSION,
      workspaceId: command.workspaceId,
      issuanceId: result.issuanceId,
    });
  }
  await recordSuccess(tx, ctx, {
    action: "offer.issue.prepare",
    resource: "offer_issuance",
    eventType: "offer.issuance_requested",
    offerId: result.offerId,
    details: {
      issuanceId: result.issuanceId,
      projectId: result.projectId,
      offerId: result.offerId,
      candidateId: result.candidateId,
      state: result.derivedState,
      approvalCount: result.approvalCount,
      replayed: result.replayed,
    },
  });
  return {
    issuanceId: result.issuanceId,
    offerId: result.offerId,
    candidateId: result.candidateId,
    state: result.derivedState,
    approvalCount: result.approvalCount,
    publicationStatus: "not_issued",
    replayed: result.replayed,
  };
}

export async function approveOfferIssuance(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferIssuanceApprovalResult> {
  requireInternalAccess(ctx, "offer.issue.approve", "offer_issuance_approval");
  const command = parseCommand(offerIssuanceApprovalCommandV1Schema, value);
  const raw = await executeFunction(tx, sql`
    select public.approve_offer_issuance(
      ${ctx.workspaceId}::uuid,
      ${command.issuanceId}::uuid,
      ${command.recipientAndScopeReviewed}::boolean,
      ${command.commercialTotalsReviewed}::boolean,
      ${command.legalProfileReviewed}::boolean,
      ${command.finalPdfForArchiveUnderstood}::boolean,
      ${command.zeroTaxTreatmentReviewed ?? null}::boolean
    ) as result
  `);
  const parsed = approvedResultSchema.safeParse(raw);
  if (!parsed.success) return mapNonSuccess(raw);
  const result = parsed.data;
  if (
    result.workspaceId !== ctx.workspaceId
    || result.issuanceId !== command.issuanceId
    || result.approvedBy !== ctx.actor
    || (result.approvalCount === 1) !== (result.derivedState === "approval_pending")
  ) throw new OfferIssuanceIntegrityError();

  await recordSuccess(tx, ctx, {
    action: "offer.issue.approve",
    resource: "offer_issuance_approval",
    eventType: result.replayed
      ? "offer.issuance_approval_replayed"
      : result.derivedState === "approved_for_archive_not_issued"
        ? "offer.issuance_approved_for_archive_not_issued"
        : "offer.issuance_first_approval_recorded",
    offerId: result.offerId,
    details: {
      issuanceId: result.issuanceId,
      offerId: result.offerId,
      approvalId: result.approvalId,
      approvalCount: result.approvalCount,
      state: result.derivedState,
      replayed: result.replayed,
    },
  });
  return {
    issuanceId: result.issuanceId,
    offerId: result.offerId,
    approvalId: result.approvalId,
    state: result.derivedState,
    approvalCount: result.approvalCount,
    publicationStatus: "not_issued",
    approvedAt: result.approvedAt,
    replayed: result.replayed,
  };
}

export async function withdrawOfferIssuance(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferIssuanceWithdrawalResult> {
  requireInternalAccess(ctx, "offer.issue.withdraw", "offer_issuance_withdrawal");
  const command = parseCommand(offerIssuanceWithdrawalCommandV1Schema, value);
  const raw = await executeFunction(tx, sql`
    select public.withdraw_offer_issuance(
      ${ctx.workspaceId}::uuid,
      ${command.issuanceId}::uuid,
      ${command.reasonCode}::text
    ) as result
  `);
  const parsed = withdrawnResultSchema.safeParse(raw);
  if (!parsed.success) return mapNonSuccess(raw);
  const result = parsed.data;
  if (
    result.workspaceId !== ctx.workspaceId
    || result.issuanceId !== command.issuanceId
    || result.reasonCode !== command.reasonCode
    || result.withdrawnBy !== ctx.actor
  ) throw new OfferIssuanceIntegrityError();

  await recordSuccess(tx, ctx, {
    action: "offer.issue.withdraw",
    resource: "offer_issuance_withdrawal",
    eventType: result.replayed
      ? "offer.issuance_withdrawal_replayed"
      : "offer.issuance_withdrawn_before_archive",
    offerId: result.offerId,
    details: {
      issuanceId: result.issuanceId,
      offerId: result.offerId,
      withdrawalId: result.withdrawalId,
      approvalCount: result.approvalCount,
      reasonCode: result.reasonCode,
      state: result.derivedState,
      replayed: result.replayed,
    },
  });
  return {
    issuanceId: result.issuanceId,
    offerId: result.offerId,
    withdrawalId: result.withdrawalId,
    state: result.derivedState,
    approvalCount: result.approvalCount,
    publicationStatus: "not_issued",
    reasonCode: result.reasonCode,
    withdrawnAt: result.withdrawnAt,
    replayed: result.replayed,
  };
}

const STATUS_SELECT = sql.raw(`
  issuance.workspace_id, issuance.id, issuance.offer_id,
  issuance.candidate_id, issuance.artifact_intent,
  issuance.has_zero_tax_treatment, issuance.state,
  issuance.attempt_count, issuance.next_attempt_at, issuance.created_at,
  issuance.started_at, issuance.finished_at, issuance.error_code,
  issuance.approval_count, issuance.viewer_has_approved,
  issuance.can_current_actor_approve, issuance.derived_state,
  issuance.withdrawal_id, issuance.withdrawal_reason_code,
  issuance.withdrawn_at, issuance.approval_artifact_version
`);

export async function listOfferIssuances(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferIssuanceStatusResult[]> {
  requireInternalAccess(ctx, "project.read", "offer_issuance");
  const key = parseCommand(offerKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);
  const offerRows = await readRows(tx, sql`
    select id
      from offer
     where workspace_id = ${key.workspaceId}::uuid
       and id = ${key.offerId}::uuid
     limit 1
  `);
  if (offerRows.length === 0) throw new OfferIssuanceNotFoundError();
  if (offerRows.length !== 1) throw new OfferIssuanceIntegrityError();
  const parsedOffer = z.strictObject({ id: uuidSchema }).safeParse(offerRows[0]);
  if (!parsedOffer.success || parsedOffer.data.id !== key.offerId) {
    throw new OfferIssuanceIntegrityError();
  }
  const rows = await readRows(tx, sql`
    select ${STATUS_SELECT}
      from public.read_offer_issuance_status(
        ${key.workspaceId}::uuid,
        ${key.offerId}::uuid,
        null::uuid
      ) as issuance
     order by issuance.created_at desc, issuance.id desc
  `);
  return rows.map((row) => statusResult(row, ctx, key));
}

export async function getOfferIssuanceStatus(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferIssuanceStatusResult> {
  requireInternalAccess(ctx, "project.read", "offer_issuance");
  const key = parseCommand(issuanceKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);
  const rows = await readRows(tx, sql`
    select ${STATUS_SELECT}
      from public.read_offer_issuance_status(
        ${key.workspaceId}::uuid,
        ${key.offerId}::uuid,
        ${key.issuanceId}::uuid
      ) as issuance
     limit 2
  `);
  if (rows.length === 0) throw new OfferIssuanceNotFoundError();
  if (rows.length !== 1) throw new OfferIssuanceIntegrityError();
  return statusResult(rows[0], ctx, key);
}

export async function readOfferIssuanceArtifact(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferIssuanceArtifactResult> {
  requireInternalAccess(ctx, "project.read", "offer_issuance_artifact");
  const key = parseCommand(issuanceKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);
  const status = await getOfferIssuanceStatus(tx, ctx, key);
  if (status.renderState !== "ready_for_approval" || status.withdrawal !== null) {
    throw new OfferIssuanceNotFoundError();
  }
  if (status.approvalCount < 2) {
    requireInternalAccess(ctx, "offer.issue.approve", "offer_issuance_artifact");
  }
  const rows = await readRows(tx, sql`
    select ${STATUS_SELECT}, issuance.offer_number,
           issuance.artifact_mime_type, issuance.artifact_sha256_hex,
           issuance.artifact_size_bytes, issuance.artifact_bytes
      from public.read_offer_issuance_artifact(
        ${key.workspaceId}::uuid,
        ${key.offerId}::uuid,
        ${key.issuanceId}::uuid
      ) as issuance
     limit 2
  `);
  if (rows.length === 0) throw new OfferIssuanceNotFoundError();
  if (rows.length !== 1) throw new OfferIssuanceIntegrityError();
  const parsed = artifactRowSchema.safeParse(rows[0]);
  if (!parsed.success) throw new OfferIssuanceIntegrityError();
  const row = parsed.data;
  const {
    offer_number: ignoredOfferNumber,
    artifact_mime_type: ignoredArtifactMimeType,
    artifact_sha256_hex: ignoredArtifactSha256,
    artifact_size_bytes: ignoredArtifactSizeBytes,
    artifact_bytes: ignoredArtifactBytes,
    ...statusColumns
  } = row;
  void ignoredOfferNumber;
  void ignoredArtifactMimeType;
  void ignoredArtifactSha256;
  void ignoredArtifactSizeBytes;
  void ignoredArtifactBytes;
  const artifactStatus = statusResult(statusColumns, ctx, key);
  if (
    artifactStatus.state !== status.state
    || artifactStatus.approvalCount !== status.approvalCount
    || row.artifact_bytes.length !== row.artifact_size_bytes
  ) throw new OfferIssuanceIntegrityError();
  const actual = createHash("sha256").update(row.artifact_bytes).digest();
  const expected = Buffer.from(row.artifact_sha256_hex, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new OfferIssuanceIntegrityError();
  }
  return {
    issuanceId: row.id,
    offerId: row.offer_id,
    candidateId: row.candidate_id,
    state: status.state as OfferIssuanceArtifactResult["state"],
    approvalCount: status.approvalCount,
    publicationStatus: "not_issued",
    filename: `${row.offer_number}-NICHT-AUSGESTELLT-Ausstellungsfassung.pdf`,
    mimeType: row.artifact_mime_type,
    sha256: row.artifact_sha256_hex,
    sizeBytes: row.artifact_size_bytes,
    bytes: Buffer.from(row.artifact_bytes),
  };
}
