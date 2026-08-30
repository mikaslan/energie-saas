import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  OFFER_CANONICALIZATION_VERSION,
  canonicalizeOfferJson,
} from "@/lib/integrations/offers/contract";
import {
  OFFER_RELEASE_APPROVAL_COMMAND_VERSION,
  OFFER_RELEASE_CANDIDATE_DISPATCH_VERSION,
  OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
  OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
  OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
  hashOfferReleaseCandidateInput,
  offerReleaseApprovalCommandV1Schema,
  offerReleaseCandidateDispatchV1Schema,
  offerReleaseCandidateInputV1Schema,
  offerReleaseCandidateRequestV1Schema,
  type OfferReleaseApprovalCommandV1,
  type OfferReleaseCandidateInputV1,
  type OfferReleaseCandidateRequestV1,
} from "@/lib/integrations/offers/release-contract";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type Action,
  type ServiceCtx,
} from "@/lib/permissions";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const APPROVAL_VERSION = "offer-release-candidate-approval.v1" as const;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,79}$/u;
const OFFER_NUMBER_PATTERN = /^ANG-[0-9]{4}-[0-9]{6}$/u;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const positiveRevisionSchema = z.int().safe().min(1);
const nonnegativeAttemptSchema = z.int().safe().min(0).max(3);
const sha256Schema = z.string().regex(SHA256_PATTERN);
const databaseInstantSchema = z.union([
  z.date(),
  z.string().min(1),
]).transform((value, context) => {
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

export type OfferReleaseRenderState = z.infer<typeof renderStateSchema>;
export type OfferReleaseStatusState =
  | OfferReleaseRenderState
  | "approved_not_issued";

const offerKeySchema = z.strictObject({
  workspaceId: uuidSchema,
  offerId: uuidSchema,
});

const candidateKeySchema = offerKeySchema.extend({
  candidateId: uuidSchema,
});

const functionRowSchema = z.strictObject({ result: z.unknown() });
const notFoundResultSchema = z.strictObject({ status: z.literal("not_found") });

export const OFFER_RELEASE_CONFLICT_CODES = [
  "variant_revision_changed",
  "profile_revision_changed",
  "recipient_revision_changed",
  "source_pdf_draft_changed",
  "profile_activation_changed",
  "hidden_line_present",
  "validity_window_changed",
  "candidate_not_ready",
  "candidate_source_changed",
  "artifact_integrity_changed",
  "approval_conflict",
  "zero_tax_review_required",
  "zero_tax_review_forbidden",
] as const;

const REVISION_CONFLICT_CODES = new Set<string>([
  "variant_revision_changed",
  "profile_revision_changed",
  "recipient_revision_changed",
]);

const conflictResultSchema = z.strictObject({
  status: z.literal("conflict"),
  code: z.enum(OFFER_RELEASE_CONFLICT_CODES),
  currentRevision: z.int().safe().min(0).optional(),
}).superRefine((result, context) => {
  const revisionConflict = REVISION_CONFLICT_CODES.has(result.code);
  if (revisionConflict !== (result.currentRevision !== undefined)) {
    context.addIssue({
      code: "custom",
      path: ["currentRevision"],
      message: "revision conflicts require exactly one current revision",
    });
  }
});

const candidateBindingShape = {
  workspaceId: uuidSchema,
  candidateId: uuidSchema,
  projectId: uuidSchema,
  offerId: uuidSchema,
  variantId: uuidSchema,
  variantRevisionId: uuidSchema,
  variantRevision: positiveRevisionSchema,
  variantSnapshotSha256: sha256Schema,
  sourcePdfDraftId: uuidSchema,
  sourcePdfDraftInputSha256: sha256Schema,
  sourcePdfDraftArtifactSha256: sha256Schema,
  profileActivationId: uuidSchema,
  profileId: uuidSchema,
  profileRevisionId: uuidSchema,
  profileRevision: positiveRevisionSchema,
  profileSnapshotSha256: sha256Schema,
  recipientId: uuidSchema,
  recipientRevisionId: uuidSchema,
  recipientRevision: positiveRevisionSchema,
  recipientSnapshotSha256: sha256Schema,
  inputVersion: z.literal(OFFER_RELEASE_CANDIDATE_INPUT_VERSION),
  canonicalizationVersion: z.literal(OFFER_CANONICALIZATION_VERSION),
  templateVersion: z.literal(OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION),
  rendererRecipeVersion: z.literal(OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION),
  inputSnapshot: offerReleaseCandidateInputV1Schema,
  inputSha256: sha256Schema,
  publicationStatus: z.literal("not_issued"),
  hasZeroTaxTreatment: z.boolean(),
};

const preparedResultSchema = z.strictObject({
  status: z.literal("prepared"),
  ...candidateBindingShape,
  reservationKeySha256: sha256Schema,
  state: renderStateSchema,
  attemptCount: nonnegativeAttemptSchema,
  nextAttemptAt: databaseInstantSchema,
  createdBy: uuidSchema,
  createdAt: databaseInstantSchema,
  startedAt: nullableDatabaseInstantSchema,
  finishedAt: nullableDatabaseInstantSchema,
  errorCode: safeErrorCodeSchema.nullable(),
  replayed: z.boolean(),
});

const approvedResultSchema = z.strictObject({
  status: z.literal("approved"),
  ...candidateBindingShape,
  approvalId: uuidSchema,
  candidateState: z.literal("ready_for_approval"),
  candidateCreatedAt: databaseInstantSchema,
  candidateFinishedAt: databaseInstantSchema,
  artifactMimeType: z.literal("application/pdf"),
  artifactSha256: sha256Schema,
  artifactSizeBytes: z.int().safe().min(100).max(MAX_ARTIFACT_BYTES),
  artifactVersion: uuidSchema,
  approvalVersion: z.literal(APPROVAL_VERSION),
  approvalCommandVersion: z.literal(OFFER_RELEASE_APPROVAL_COMMAND_VERSION),
  approvalCommand: offerReleaseApprovalCommandV1Schema,
  approvedBy: uuidSchema,
  approvedAt: databaseInstantSchema,
  derivedState: z.literal("approved_not_issued"),
  replayed: z.boolean(),
});

const statusRowSchema = z.strictObject({
  workspace_id: uuidSchema,
  id: uuidSchema,
  offer_id: uuidSchema,
  variant_id: uuidSchema,
  variant_revision: positiveRevisionSchema,
  profile_revision: positiveRevisionSchema,
  recipient_revision: positiveRevisionSchema,
  publication_status: z.literal("not_issued"),
  has_zero_tax_treatment: z.boolean(),
  state: renderStateSchema,
  attempt_count: nonnegativeAttemptSchema,
  next_attempt_at: databaseInstantSchema,
  created_at: databaseInstantSchema,
  started_at: nullableDatabaseInstantSchema,
  finished_at: nullableDatabaseInstantSchema,
  error_code: safeErrorCodeSchema.nullable(),
  approval_artifact_version: uuidSchema.nullable(),
  approval_id: uuidSchema.nullable(),
  approval_version: z.literal(APPROVAL_VERSION).nullable(),
  approval_command_version: z.literal(OFFER_RELEASE_APPROVAL_COMMAND_VERSION).nullable(),
  approved_at: nullableDatabaseInstantSchema,
});

const artifactRowSchema = statusRowSchema.extend({
  offer_number: z.string().regex(OFFER_NUMBER_PATTERN),
  artifact_mime_type: z.literal("application/pdf"),
  artifact_sha256_hex: sha256Schema,
  artifact_size_bytes: z.int().safe().min(100).max(MAX_ARTIFACT_BYTES),
  artifact_bytes: z.custom<Buffer>((value) => Buffer.isBuffer(value)),
});

const dispatchGateSchema = z.strictObject({
  dispatch_signature: z.literal(
    "pgboss.enqueue_offer_release_candidate(uuid,uuid)",
  ).nullable(),
  current_role: z.string().min(1),
  session_role: z.string().min(1),
  database_name: z.string().min(1),
});

export class OfferReleaseValidationError extends Error {
  constructor(public readonly paths: string[] = []) {
    super("offer release command is invalid");
    this.name = "OfferReleaseValidationError";
  }
}

export class OfferReleaseConflictError extends Error {
  constructor(
    public readonly code: typeof OFFER_RELEASE_CONFLICT_CODES[number],
    public readonly currentRevision?: number,
  ) {
    super("offer release sources changed or are not currently releasable");
    this.name = "OfferReleaseConflictError";
  }
}

// Every missing or cross-workspace candidate/offer deliberately shares this
// form so the application boundary cannot become a tenant-existence oracle.
export class OfferReleaseNotFoundError extends Error {
  constructor() {
    super("offer release candidate was not found");
    this.name = "OfferReleaseNotFoundError";
  }
}

export class OfferReleaseIntegrityError extends Error {
  constructor() {
    super("stored offer release candidate failed integrity validation");
    this.name = "OfferReleaseIntegrityError";
  }
}

export class OfferReleasePersistenceError extends Error {
  constructor() {
    super("offer release candidate persistence failed");
    this.name = "OfferReleasePersistenceError";
  }
}

export class OfferReleaseDispatchError extends Error {
  readonly code = "dispatch_unavailable" as const;

  constructor() {
    super("offer release candidate dispatch is unavailable");
    this.name = "OfferReleaseDispatchError";
  }
}

export type OfferReleaseRequestResult = {
  candidateId: string;
  offerId: string;
  variantId: string;
  variantRevision: number;
  profileRevision: number;
  recipientRevision: number;
  state: OfferReleaseRenderState;
  publicationStatus: "not_issued";
  replayed: boolean;
};

export type OfferReleaseApprovalResult = {
  approvalId: string;
  candidateId: string;
  offerId: string;
  variantId: string;
  variantRevision: number;
  profileRevision: number;
  recipientRevision: number;
  state: "approved_not_issued";
  publicationStatus: "not_issued";
  approvedAt: string;
  replayed: boolean;
};

export type OfferReleaseStatusResult = {
  candidateId: string;
  offerId: string;
  variantId: string;
  variantRevision: number;
  profileRevision: number;
  recipientRevision: number;
  state: OfferReleaseStatusState;
  renderState: OfferReleaseRenderState;
  publicationStatus: "not_issued";
  requiresZeroTaxReview: boolean;
  attemptCount: number;
  nextAttemptAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  approval: null | { approvalId: string; approvedAt: string };
  canDownload: boolean;
  approvalArtifactVersion?: string;
};

export type OfferReleaseArtifactResult = {
  candidateId: string;
  offerId: string;
  variantId: string;
  variantRevision: number;
  state: "ready_for_approval" | "approved_not_issued";
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
  if (!parsed.success) throw new OfferReleaseValidationError(issuePaths(parsed.error));
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
  if (ctx.workspaceId !== workspaceId) throw new OfferReleaseNotFoundError();
}

async function executeFunction(
  tx: TenantTx,
  statement: ReturnType<typeof sql>,
): Promise<unknown> {
  let rows: unknown[];
  try {
    const result = await tx.execute<{ result: unknown; [key: string]: unknown }>(statement);
    rows = result.rows;
  } catch {
    throw new OfferReleasePersistenceError();
  }
  if (rows.length === 0) throw new OfferReleasePersistenceError();
  if (rows.length !== 1) throw new OfferReleaseIntegrityError();
  const row = functionRowSchema.safeParse(rows[0]);
  if (!row.success) throw new OfferReleaseIntegrityError();
  return row.data.result;
}

function mapNonSuccess(value: unknown): never {
  if (notFoundResultSchema.safeParse(value).success) throw new OfferReleaseNotFoundError();
  const conflict = conflictResultSchema.safeParse(value);
  if (conflict.success) {
    throw new OfferReleaseConflictError(
      conflict.data.code,
      conflict.data.currentRevision,
    );
  }
  throw new OfferReleaseIntegrityError();
}

async function readRows(
  tx: TenantTx,
  statement: ReturnType<typeof sql>,
): Promise<unknown[]> {
  try {
    const result = await tx.execute(statement);
    return result.rows;
  } catch {
    throw new OfferReleasePersistenceError();
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
    throw new OfferReleasePersistenceError();
  }
}

function validateLifecycle(input: {
  state: OfferReleaseRenderState;
  attemptCount: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
}): void {
  const { state, attemptCount, createdAt, startedAt, finishedAt, errorCode } = input;
  const validShape = state === "queued"
    ? attemptCount < 3 && finishedAt === null && errorCode === null
    : state === "running"
      ? attemptCount >= 1 && startedAt !== null && finishedAt === null && errorCode === null
      : state === "retry_wait"
        ? attemptCount >= 1 && startedAt !== null && finishedAt === null && errorCode !== null
        : state === "ready_for_approval"
          ? attemptCount >= 1 && startedAt !== null && finishedAt !== null && errorCode === null
          : attemptCount >= 1 && startedAt !== null && finishedAt !== null && errorCode !== null;
  if (!validShape) throw new OfferReleaseIntegrityError();
  const createdMs = Date.parse(createdAt);
  const startedMs = startedAt === null ? null : Date.parse(startedAt);
  const finishedMs = finishedAt === null ? null : Date.parse(finishedAt);
  if (
    (startedMs !== null && startedMs < createdMs)
    || (finishedMs !== null && (startedMs === null || finishedMs < startedMs))
  ) throw new OfferReleaseIntegrityError();
}

function hasZeroTaxTreatment(input: OfferReleaseCandidateInputV1): boolean {
  return input.sections.some((section) => (
    section.lines.some((line) => line.taxRateBps === 0)
  ));
}

function validateCandidateInputBinding(input: {
  snapshot: OfferReleaseCandidateInputV1;
  sha256: string;
  variantRevision: number;
  profileRevision: number;
  createdAt: string;
  validThrough?: string;
  hasZeroTaxTreatment: boolean;
}): void {
  let calculatedHash: string;
  try {
    calculatedHash = hashOfferReleaseCandidateInput(input.snapshot);
  } catch {
    throw new OfferReleaseIntegrityError();
  }
  if (
    calculatedHash !== input.sha256
    || input.snapshot.variant.revision !== input.variantRevision
    || input.snapshot.profile.revision !== input.profileRevision
    || input.snapshot.preparedAt !== input.createdAt
    || (input.validThrough !== undefined
      && input.snapshot.validThrough !== input.validThrough)
    || hasZeroTaxTreatment(input.snapshot) !== input.hasZeroTaxTreatment
  ) throw new OfferReleaseIntegrityError();
}

function validateRequestBinding(
  result: z.infer<typeof preparedResultSchema>,
  command: OfferReleaseCandidateRequestV1,
  ctx: ServiceCtx,
): void {
  if (
    result.workspaceId !== command.workspaceId
    || result.offerId !== command.offerId
    || result.variantId !== command.variantId
    || result.variantRevision !== command.expectedVariantRevision
    || result.sourcePdfDraftId !== command.sourcePdfDraftId
    || result.profileId !== command.documentProfileId
    || result.profileRevisionId !== command.documentProfileRevisionId
    || result.profileRevision !== command.expectedDocumentProfileRevision
    || result.recipientRevisionId !== command.recipientRevisionId
    || result.recipientRevision !== command.expectedRecipientRevision
    || (!result.replayed && result.createdBy !== ctx.actor)
    || (!result.replayed && result.state !== "queued")
  ) throw new OfferReleaseIntegrityError();
  validateLifecycle(result);
  validateCandidateInputBinding({
    snapshot: result.inputSnapshot,
    sha256: result.inputSha256,
    variantRevision: result.variantRevision,
    profileRevision: result.profileRevision,
    createdAt: result.createdAt,
    validThrough: command.validThrough,
    hasZeroTaxTreatment: result.hasZeroTaxTreatment,
  });
}

function validateApprovalBinding(
  result: z.infer<typeof approvedResultSchema>,
  command: OfferReleaseApprovalCommandV1,
  ctx: ServiceCtx,
): void {
  if (
    result.workspaceId !== command.workspaceId
    || result.offerId !== command.offerId
    || result.candidateId !== command.candidateId
    || result.artifactVersion !== command.expectedArtifactVersion
    || canonicalizeOfferJson(result.approvalCommand) !== canonicalizeOfferJson(command)
    || (!result.replayed && result.approvedBy !== ctx.actor)
    || Date.parse(result.candidateFinishedAt) < Date.parse(result.candidateCreatedAt)
    || Date.parse(result.approvedAt) < Date.parse(result.candidateFinishedAt)
  ) throw new OfferReleaseIntegrityError();
  validateCandidateInputBinding({
    snapshot: result.inputSnapshot,
    sha256: result.inputSha256,
    variantRevision: result.variantRevision,
    profileRevision: result.profileRevision,
    createdAt: result.candidateCreatedAt,
    hasZeroTaxTreatment: result.hasZeroTaxTreatment,
  });
  const zeroTaxAck = command.zeroTaxTreatmentReviewed;
  if (
    (result.hasZeroTaxTreatment && zeroTaxAck !== true)
    || (!result.hasZeroTaxTreatment && zeroTaxAck !== undefined)
  ) throw new OfferReleaseIntegrityError();
}

function statusResult(
  value: unknown,
  ctx: ServiceCtx,
  expected: { workspaceId: string; offerId: string; candidateId?: string },
): OfferReleaseStatusResult {
  const parsed = statusRowSchema.safeParse(value);
  if (!parsed.success) throw new OfferReleaseIntegrityError();
  const row = parsed.data;
  if (
    row.workspace_id !== expected.workspaceId
    || row.offer_id !== expected.offerId
    || (expected.candidateId !== undefined && row.id !== expected.candidateId)
  ) throw new OfferReleaseIntegrityError();
  validateLifecycle({
    state: row.state,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
  });

  const approvalParts = [
    row.approval_id,
    row.approval_version,
    row.approval_command_version,
    row.approved_at,
  ];
  const hasApproval = approvalParts.every((part) => part !== null);
  if (!hasApproval && approvalParts.some((part) => part !== null)) {
    throw new OfferReleaseIntegrityError();
  }
  if (
    hasApproval
    && (
      row.state !== "ready_for_approval"
      || row.finished_at === null
      || Date.parse(row.approved_at as string) < Date.parse(row.finished_at)
    )
  ) throw new OfferReleaseIntegrityError();

  const canApprove = can(ctx, "offer.release.approve") && !isExternalOnly(ctx);
  const exposesApprovalVersion = !hasApproval
    && row.state === "ready_for_approval"
    && canApprove;
  if (exposesApprovalVersion !== (row.approval_artifact_version !== null)) {
    throw new OfferReleaseIntegrityError();
  }

  return {
    candidateId: row.id,
    offerId: row.offer_id,
    variantId: row.variant_id,
    variantRevision: row.variant_revision,
    profileRevision: row.profile_revision,
    recipientRevision: row.recipient_revision,
    state: hasApproval ? "approved_not_issued" : row.state,
    renderState: row.state,
    publicationStatus: row.publication_status,
    requiresZeroTaxReview: row.has_zero_tax_treatment,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    errorCode: row.error_code,
    approval: hasApproval
      ? {
          approvalId: row.approval_id as string,
          approvedAt: row.approved_at as string,
        }
      : null,
    canDownload: row.state === "ready_for_approval"
      && (hasApproval || canApprove),
    ...(exposesApprovalVersion
      ? { approvalArtifactVersion: row.approval_artifact_version as string }
      : {}),
  };
}

/*
 * Required SECURITY DEFINER database boundary. Both functions derive actor,
 * generated IDs, DB timestamps, hashes and all document content themselves;
 * the browser/application passes only the strict IDs/revisions/date or fixed
 * acknowledgement booleans shown below. Each function returns exactly one
 * strict JSONB envelope as selected under the column name `result`.
 *
 * public.prepare_offer_release_candidate(
 *   workspace_id uuid, offer_id uuid, variant_id uuid,
 *   expected_variant_revision integer, source_pdf_draft_id uuid,
 *   document_profile_id uuid, document_profile_revision_id uuid,
 *   expected_document_profile_revision integer, recipient_revision_id uuid,
 *   expected_recipient_revision integer, valid_through date
 * ) returns jsonb
 *   -> {status:'prepared', workspaceId,candidateId,projectId,offerId,
 *       variantId,variantRevisionId,variantRevision,variantSnapshotSha256,
 *       sourcePdfDraftId,sourcePdfDraftInputSha256,
 *       sourcePdfDraftArtifactSha256,profileActivationId,profileId,
 *       profileRevisionId,profileRevision,profileSnapshotSha256,recipientId,
 *       recipientRevisionId,recipientRevision,recipientSnapshotSha256,
 *       inputVersion,canonicalizationVersion,templateVersion,
 *       rendererRecipeVersion,reservationKeySha256,inputSnapshot,inputSha256,
 *       publicationStatus:'not_issued',hasZeroTaxTreatment,state,attemptCount,
 *       nextAttemptAt,createdBy,createdAt,startedAt,finishedAt,errorCode,
 *       replayed}
 *   | {status:'conflict',code,currentRevision?} | {status:'not_found'}.
 *
 * public.approve_offer_release_candidate(
 *   workspace_id uuid, offer_id uuid, candidate_id uuid,
 *   expected_artifact_version uuid,
 *   recipient_billing_reviewed boolean, commercial_content_reviewed boolean,
 *   active_profile_reviewed boolean, not_issued_status_understood boolean,
 *   zero_tax_treatment_reviewed boolean
 * ) returns jsonb
 *   -> {status:'approved', the exact candidate binding/input fields above,
 *       approvalId,candidateState:'ready_for_approval',candidateCreatedAt,
 *       candidateFinishedAt,artifactMimeType,artifactSha256,
 *       artifactSizeBytes,approvalVersion,approvalCommandVersion,
 *       approvalCommand,approvedBy,approvedAt,
 *       derivedState:'approved_not_issued',replayed}
 *   | conflict | not_found.
 *
 * prepare_offer_release_candidate also records every authorized user replay
 * as offer activity while holding its domain locks. Worker recovery never
 * calls it and therefore never extends user activity.
 */
export async function enqueueOfferReleaseCandidateDispatch(
  tx: TenantTx,
  value: unknown,
): Promise<void> {
  const dispatch = parseCommand(offerReleaseCandidateDispatchV1Schema, value);
  let gateRows: unknown[];
  try {
    const gate = await tx.execute(sql`
      select pg_catalog.to_regprocedure(
               'pgboss.enqueue_offer_release_candidate(uuid,uuid)'
             )::text as dispatch_signature,
             current_user::text as current_role,
             session_user::text as session_role,
             pg_catalog.current_database()::text as database_name
    `);
    gateRows = gate.rows;
  } catch {
    throw new OfferReleaseDispatchError();
  }
  if (gateRows.length !== 1) throw new OfferReleaseDispatchError();
  const parsedGate = dispatchGateSchema.safeParse(gateRows[0]);
  if (!parsedGate.success) throw new OfferReleaseDispatchError();
  const gate = parsedGate.data;
  if (gate.dispatch_signature === null) {
    const explicitTestSkip = gate.current_role === gate.session_role
      && (gate.current_role === "app_test" || gate.current_role === "app_ci")
      && gate.database_name.includes("test");
    if (explicitTestSkip) return;
    throw new OfferReleaseDispatchError();
  }
  try {
    await tx.execute(sql`
      select pgboss.enqueue_offer_release_candidate(
        ${dispatch.workspaceId}::uuid,
        ${dispatch.candidateId}::uuid
      )
    `);
  } catch {
    throw new OfferReleaseDispatchError();
  }
}

export async function requestOfferReleaseCandidate(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferReleaseRequestResult> {
  requireInternalAccess(ctx, "offer.release.prepare", "offer_release_candidate");
  const command = parseCommand(offerReleaseCandidateRequestV1Schema, value);
  requireSameWorkspace(ctx, command.workspaceId);

  const raw = await executeFunction(tx, sql`
    select public.prepare_offer_release_candidate(
      ${command.workspaceId}::uuid,
      ${command.offerId}::uuid,
      ${command.variantId}::uuid,
      ${command.expectedVariantRevision}::integer,
      ${command.sourcePdfDraftId}::uuid,
      ${command.documentProfileId}::uuid,
      ${command.documentProfileRevisionId}::uuid,
      ${command.expectedDocumentProfileRevision}::integer,
      ${command.recipientRevisionId}::uuid,
      ${command.expectedRecipientRevision}::integer,
      ${command.validThrough}::date
    ) as result
  `);
  const parsed = preparedResultSchema.safeParse(raw);
  if (!parsed.success) return mapNonSuccess(raw);
  const result = parsed.data;
  validateRequestBinding(result, command, ctx);

  if (
    result.state === "queued"
    || result.state === "running"
    || result.state === "retry_wait"
  ) {
    await enqueueOfferReleaseCandidateDispatch(tx, {
      schemaVersion: OFFER_RELEASE_CANDIDATE_DISPATCH_VERSION,
      workspaceId: command.workspaceId,
      candidateId: result.candidateId,
    });
  }

  await recordSuccess(tx, ctx, {
    action: "offer.release.prepare",
    resource: "offer_release_candidate",
    eventType: "offer.release_candidate_requested",
    offerId: result.offerId,
    details: {
      candidateId: result.candidateId,
      projectId: result.projectId,
      offerId: result.offerId,
      variantId: result.variantId,
      variantRevision: result.variantRevision,
      profileRevision: result.profileRevision,
      recipientRevision: result.recipientRevision,
      state: result.state,
    },
  });
  return {
    candidateId: result.candidateId,
    offerId: result.offerId,
    variantId: result.variantId,
    variantRevision: result.variantRevision,
    profileRevision: result.profileRevision,
    recipientRevision: result.recipientRevision,
    state: result.state,
    publicationStatus: result.publicationStatus,
    replayed: result.replayed,
  };
}

export async function approveOfferReleaseCandidate(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferReleaseApprovalResult> {
  requireInternalAccess(ctx, "offer.release.approve", "offer_release_candidate_approval");
  const command = parseCommand(offerReleaseApprovalCommandV1Schema, value);
  requireSameWorkspace(ctx, command.workspaceId);

  const raw = await executeFunction(tx, sql`
    select public.approve_offer_release_candidate(
      ${command.workspaceId}::uuid,
      ${command.offerId}::uuid,
      ${command.candidateId}::uuid,
      ${command.expectedArtifactVersion}::uuid,
      ${command.recipientBillingReviewed}::boolean,
      ${command.commercialContentReviewed}::boolean,
      ${command.activeProfileReviewed}::boolean,
      ${command.notIssuedStatusUnderstood}::boolean,
      ${command.zeroTaxTreatmentReviewed ?? null}::boolean
    ) as result
  `);
  const parsed = approvedResultSchema.safeParse(raw);
  if (!parsed.success) return mapNonSuccess(raw);
  const result = parsed.data;
  validateApprovalBinding(result, command, ctx);

  await recordSuccess(tx, ctx, {
    action: "offer.release.approve",
    resource: "offer_release_candidate_approval",
    eventType: result.replayed
      ? "offer.release_candidate_approval_replayed"
      : "offer.release_candidate_approved_not_issued",
    offerId: result.offerId,
    details: {
      approvalId: result.approvalId,
      candidateId: result.candidateId,
      projectId: result.projectId,
      offerId: result.offerId,
      variantId: result.variantId,
      variantRevision: result.variantRevision,
      profileRevision: result.profileRevision,
      recipientRevision: result.recipientRevision,
      state: result.derivedState,
      replayed: result.replayed,
    },
  });
  return {
    approvalId: result.approvalId,
    candidateId: result.candidateId,
    offerId: result.offerId,
    variantId: result.variantId,
    variantRevision: result.variantRevision,
    profileRevision: result.profileRevision,
    recipientRevision: result.recipientRevision,
    state: result.derivedState,
    publicationStatus: result.publicationStatus,
    approvedAt: result.approvedAt,
    replayed: result.replayed,
  };
}

const STATUS_SELECT = sql.raw(`
  candidate.workspace_id, candidate.id, candidate.offer_id,
  candidate.variant_id, candidate.variant_revision, candidate.profile_revision,
  candidate.recipient_revision,
  candidate.publication_status, candidate.has_zero_tax_treatment,
  candidate.state, candidate.attempt_count,
  candidate.next_attempt_at, candidate.created_at, candidate.started_at,
  candidate.finished_at, candidate.error_code,
  candidate.approval_id, candidate.approval_version,
  candidate.approval_command_version, candidate.approved_at,
  candidate.approval_artifact_version
`);

export async function listOfferReleaseCandidates(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferReleaseStatusResult[]> {
  requireInternalAccess(ctx, "project.read", "offer_release_candidate");
  const key = parseCommand(offerKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);

  const offerRows = await readRows(tx, sql`
    select id
      from offer
     where workspace_id = ${key.workspaceId}::uuid
       and id = ${key.offerId}::uuid
     limit 1
  `);
  if (offerRows.length === 0) throw new OfferReleaseNotFoundError();
  if (offerRows.length !== 1) throw new OfferReleaseIntegrityError();
  const parsedOffer = z.strictObject({ id: uuidSchema }).safeParse(offerRows[0]);
  if (!parsedOffer.success || parsedOffer.data.id !== key.offerId) {
    throw new OfferReleaseIntegrityError();
  }

  const rows = await readRows(tx, sql`
    select ${STATUS_SELECT}
      from public.read_offer_release_candidate_status(
        ${key.workspaceId}::uuid,
        ${key.offerId}::uuid,
        null::uuid
      ) as candidate
     order by candidate.created_at desc, candidate.id desc
  `);
  return rows.map((row) => statusResult(row, ctx, key));
}

export async function getOfferReleaseCandidateStatus(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferReleaseStatusResult> {
  requireInternalAccess(ctx, "project.read", "offer_release_candidate");
  const key = parseCommand(candidateKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);

  const rows = await readRows(tx, sql`
    select ${STATUS_SELECT}
      from public.read_offer_release_candidate_status(
        ${key.workspaceId}::uuid,
        ${key.offerId}::uuid,
        ${key.candidateId}::uuid
      ) as candidate
     limit 2
  `);
  if (rows.length === 0) throw new OfferReleaseNotFoundError();
  if (rows.length !== 1) throw new OfferReleaseIntegrityError();
  return statusResult(rows[0], ctx, key);
}

export async function readOfferReleaseCandidateArtifact(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferReleaseArtifactResult> {
  requireInternalAccess(ctx, "project.read", "offer_release_candidate_artifact");
  const key = parseCommand(candidateKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);

  const status = await getOfferReleaseCandidateStatus(tx, ctx, key);
  if (status.renderState !== "ready_for_approval") {
    throw new OfferReleaseNotFoundError();
  }
  if (status.state === "ready_for_approval") {
    requireInternalAccess(
      ctx,
      "offer.release.approve",
      "offer_release_candidate_artifact",
    );
  }

  const rows = await readRows(tx, sql`
    select ${STATUS_SELECT}, candidate.offer_number,
           candidate.artifact_mime_type,
           candidate.artifact_sha256_hex,
           candidate.artifact_size_bytes, candidate.artifact_bytes
      from public.read_offer_release_candidate_artifact(
        ${key.workspaceId}::uuid,
        ${key.offerId}::uuid,
        ${key.candidateId}::uuid
      ) as candidate
     limit 2
  `);
  if (rows.length === 0) throw new OfferReleaseNotFoundError();
  if (rows.length !== 1) throw new OfferReleaseIntegrityError();

  const parsed = artifactRowSchema.safeParse(rows[0]);
  if (!parsed.success) throw new OfferReleaseIntegrityError();
  const row = parsed.data;
  if (
    row.workspace_id !== key.workspaceId
    || row.offer_id !== key.offerId
    || row.id !== key.candidateId
    || row.variant_id !== status.variantId
    || row.variant_revision !== status.variantRevision
    || row.state !== status.renderState
    || (row.approval_id !== null) !== (status.approval !== null)
    || row.approval_artifact_version !== null
  ) throw new OfferReleaseIntegrityError();

  if (row.artifact_bytes.length !== row.artifact_size_bytes) {
    throw new OfferReleaseIntegrityError();
  }
  const actual = createHash("sha256").update(row.artifact_bytes).digest();
  const expected = Buffer.from(row.artifact_sha256_hex, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new OfferReleaseIntegrityError();
  }

  return {
    candidateId: row.id,
    offerId: row.offer_id,
    variantId: row.variant_id,
    variantRevision: row.variant_revision,
    state: status.state as "ready_for_approval" | "approved_not_issued",
    publicationStatus: row.publication_status,
    filename: `${row.offer_number}-Freigabekandidat-R${row.variant_revision}.pdf`,
    mimeType: row.artifact_mime_type,
    sha256: row.artifact_sha256_hex,
    sizeBytes: row.artifact_size_bytes,
    bytes: Buffer.from(row.artifact_bytes),
  };
}
