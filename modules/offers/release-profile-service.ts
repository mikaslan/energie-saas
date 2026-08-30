import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  offerRecipientReviseCommandV1Schema,
  offerRecipientSnapshotV1Schema,
  offerReleaseProfileActivateCommandV1Schema,
  offerReleaseProfileReviseCommandV1Schema,
  offerReleaseProfileSnapshotV1Schema,
  type OfferRecipientSnapshotV1,
  type OfferReleaseProfileSnapshotV1,
} from "@/lib/integrations/offers/release-contract";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type Action,
  type ServiceCtx,
} from "@/lib/permissions";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());
const revisionSchema = z.int().safe().min(1);
const nonnegativeRevisionSchema = z.int().safe().min(0);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
const databaseInstantSchema = z.union([z.date(), z.string().min(1)])
  .transform((value, context) => {
    const parsed = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      context.addIssue({ code: "custom", message: "invalid database instant" });
      return z.NEVER;
    }
    return parsed.toISOString();
  });

const workspaceKeySchema = z.strictObject({
  workspaceId: uuidSchema,
});

const offerKeySchema = workspaceKeySchema.extend({
  offerId: uuidSchema,
});

const functionRowSchema = z.strictObject({
  result: z.unknown(),
});

const notFoundResultSchema = z.strictObject({
  status: z.literal("not_found"),
});

const conflictResultSchema = z.strictObject({
  status: z.literal("conflict"),
  currentRevision: nonnegativeRevisionSchema,
});

const revisedProfileResultSchema = z.strictObject({
  status: z.literal("revised"),
  workspaceId: uuidSchema,
  profileId: uuidSchema,
  profileRevisionId: uuidSchema,
  revision: revisionSchema,
  snapshot: offerReleaseProfileSnapshotV1Schema,
  snapshotSha256: sha256Schema,
  createdBy: uuidSchema,
  createdAt: databaseInstantSchema,
});

const activateProfileResultSchema = z.strictObject({
  status: z.literal("activated"),
  workspaceId: uuidSchema,
  activationId: uuidSchema,
  profileId: uuidSchema,
  profileRevisionId: uuidSchema,
  profileRevision: revisionSchema,
  profileSnapshotSha256: sha256Schema,
  reviewState: z.literal("operator_reviewed"),
  reviewedBy: uuidSchema,
  reviewedAt: databaseInstantSchema,
  snapshot: offerReleaseProfileSnapshotV1Schema,
});

const revisedRecipientResultSchema = z.strictObject({
  status: z.literal("revised"),
  workspaceId: uuidSchema,
  offerId: uuidSchema,
  recipientId: uuidSchema,
  recipientRevisionId: uuidSchema,
  revision: revisionSchema,
  snapshot: offerRecipientSnapshotV1Schema,
  snapshotSha256: sha256Schema,
  createdBy: uuidSchema,
  createdAt: databaseInstantSchema,
});

const profileReadRowSchema = z.strictObject({
  workspace_id: uuidSchema,
  profile_id: uuidSchema,
  current_profile_revision_id: uuidSchema,
  current_revision: revisionSchema,
  current_snapshot: z.unknown(),
  current_snapshot_sha256_hex: sha256Schema,
  active_activation_id: uuidSchema.nullable(),
  active_profile_revision_id: uuidSchema.nullable(),
  active_profile_revision: revisionSchema.nullable(),
  active_snapshot: z.unknown().nullable(),
  active_snapshot_sha256_hex: sha256Schema.nullable(),
  active_review_state: z.literal("operator_reviewed").nullable(),
  active_reviewed_at: databaseInstantSchema.nullable(),
});

const recipientReadRowSchema = z.strictObject({
  workspace_id: uuidSchema,
  offer_id: uuidSchema,
  recipient_id: uuidSchema,
  recipient_revision_id: uuidSchema,
  revision: revisionSchema,
  snapshot: z.unknown(),
  snapshot_sha256_hex: sha256Schema,
});

export class OfferReleaseProfileValidationError extends Error {
  constructor(public readonly paths: string[] = []) {
    super("offer release profile or recipient command is invalid");
    this.name = "OfferReleaseProfileValidationError";
  }
}

export class OfferReleaseProfileConflictError extends Error {
  constructor(public readonly currentRevision?: number) {
    super("offer release profile or recipient changed since it was loaded");
    this.name = "OfferReleaseProfileConflictError";
  }
}

// Profile, activation and offer-recipient misses intentionally share one
// indistinguishable error. Cross-tenant inputs use the same shape and cannot
// become an existence oracle.
export class OfferReleaseProfileNotFoundError extends Error {
  constructor() {
    super("offer release profile or recipient was not found");
    this.name = "OfferReleaseProfileNotFoundError";
  }
}

export class OfferReleaseProfileIntegrityError extends Error {
  constructor() {
    super("stored offer release profile or recipient failed integrity validation");
    this.name = "OfferReleaseProfileIntegrityError";
  }
}

export class OfferReleaseProfilePersistenceError extends Error {
  constructor() {
    super("offer release profile or recipient persistence failed");
    this.name = "OfferReleaseProfilePersistenceError";
  }
}

export type OfferReleaseProfileRevisionResult = {
  profileId: string;
  profileRevisionId: string;
  revision: number;
  snapshot: OfferReleaseProfileSnapshotV1;
};

export type OfferReleaseProfileActivationResult = {
  activationId: string;
  profileId: string;
  profileRevisionId: string;
  profileRevision: number;
  reviewState: "operator_reviewed";
  reviewedAt: string;
  snapshot: OfferReleaseProfileSnapshotV1;
};

export type CurrentOfferReleaseProfileResult = {
  profileId: string;
  currentRevision: number;
  current: OfferReleaseProfileSnapshotV1;
  active: null | {
    activationId: string;
    profileRevisionId: string;
    profileRevision: number;
    reviewState: "operator_reviewed";
    reviewedAt: string;
    snapshot: OfferReleaseProfileSnapshotV1;
  };
};

export type OfferRecipientRevisionResult = {
  recipientId: string;
  recipientRevisionId: string;
  revision: number;
  snapshot: OfferRecipientSnapshotV1;
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
  if (!parsed.success) {
    throw new OfferReleaseProfileValidationError(issuePaths(parsed.error));
  }
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
  if (workspaceId !== ctx.workspaceId) throw new OfferReleaseProfileNotFoundError();
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
    throw new OfferReleaseProfilePersistenceError();
  }
  if (rows.length === 0) throw new OfferReleaseProfilePersistenceError();
  if (rows.length !== 1) throw new OfferReleaseProfileIntegrityError();
  const row = functionRowSchema.safeParse(rows[0]);
  if (!row.success) throw new OfferReleaseProfileIntegrityError();
  return row.data.result;
}

function mapNonSuccess(value: unknown): never {
  const missing = notFoundResultSchema.safeParse(value);
  if (missing.success) throw new OfferReleaseProfileNotFoundError();
  const conflict = conflictResultSchema.safeParse(value);
  if (conflict.success) {
    throw new OfferReleaseProfileConflictError(conflict.data.currentRevision);
  }
  throw new OfferReleaseProfileIntegrityError();
}

async function recordSuccess(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    action: Action;
    resource: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    details: Record<string, string | number>;
  },
): Promise<void> {
  try {
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
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
    throw new OfferReleaseProfilePersistenceError();
  }
}

function validateProfileSnapshotBindings(input: {
  snapshot: OfferReleaseProfileSnapshotV1;
  workspaceId: string;
  profileId: string;
  profileRevisionId: string;
  revision: number;
  snapshotSha256: string;
  createdBy?: string;
  createdAt?: string;
}): void {
  if (
    input.snapshot.workspaceId !== input.workspaceId
    || input.snapshot.profileId !== input.profileId
    || input.snapshot.profileRevisionId !== input.profileRevisionId
    || input.snapshot.revision !== input.revision
    || input.snapshot.snapshotSha256 !== input.snapshotSha256
    || (input.createdBy !== undefined && input.snapshot.createdBy !== input.createdBy)
    || (input.createdAt !== undefined && input.snapshot.createdAt !== input.createdAt)
  ) throw new OfferReleaseProfileIntegrityError();
}

function validateRecipientSnapshotBindings(input: {
  snapshot: OfferRecipientSnapshotV1;
  workspaceId: string;
  offerId: string;
  recipientRevisionId: string;
  revision: number;
  snapshotSha256: string;
  createdBy?: string;
  createdAt?: string;
}): void {
  if (
    input.snapshot.workspaceId !== input.workspaceId
    || input.snapshot.offerId !== input.offerId
    || input.snapshot.recipientRevisionId !== input.recipientRevisionId
    || input.snapshot.revision !== input.revision
    || input.snapshot.snapshotSha256 !== input.snapshotSha256
    || (input.createdBy !== undefined && input.snapshot.createdBy !== input.createdBy)
    || (input.createdAt !== undefined && input.snapshot.createdAt !== input.createdAt)
    || (input.createdBy !== undefined
      && input.snapshot.confirmation.confirmedBy !== input.createdBy)
    || (input.createdAt !== undefined
      && input.snapshot.confirmation.confirmedAt !== input.createdAt)
  ) throw new OfferReleaseProfileIntegrityError();
}

/*
 * Required SECURITY DEFINER database boundary (all functions remain RLS- and
 * verified-app-actor-gated and return exactly one strict JSONB envelope):
 *
 * public.revise_offer_release_profile(
 *   workspace_id uuid, expected_current_revision integer, profile_name text,
 *   sender jsonb, legal_documents jsonb
 * ) returns jsonb
 *   -> revised envelope | {status:'conflict',currentRevision} | not_found
 *
 * public.activate_offer_release_profile(
 *   workspace_id uuid, profile_id uuid, profile_revision_id uuid,
 *   expected_profile_revision integer
 * ) returns jsonb
 *   -> activated/operator_reviewed envelope | conflict | not_found
 *
 * public.revise_offer_recipient(
 *   workspace_id uuid, offer_id uuid, expected_current_revision integer,
 *   display_name text, company text, email text, billing_address jsonb,
 *   billing_details_confirmed boolean
 * ) returns jsonb
 *   -> revised envelope | conflict | not_found
 *
 * The functions derive actor from public.app_actor_id(), generate every ID,
 * allocate revisions under locks, use transaction_timestamp(), construct the
 * snapshots, and calculate their canonical SHA-256. The service never sends
 * actor IDs, generated IDs, timestamps or hashes into these mutation calls.
 */
export async function reviseOfferReleaseProfile(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferReleaseProfileRevisionResult> {
  requireInternalAccess(ctx, "settings.manage", "offer_release_profile");
  const command = parseCommand(offerReleaseProfileReviseCommandV1Schema, value);
  requireSameWorkspace(ctx, command.workspaceId);

  const raw = await executeFunction(tx, sql`
    select public.revise_offer_release_profile(
      ${command.workspaceId}::uuid,
      ${command.expectedCurrentRevision}::integer,
      ${command.profileName}::text,
      ${JSON.stringify(command.sender)}::jsonb,
      ${JSON.stringify(command.legalDocuments)}::jsonb
    ) as result
  `);
  const parsed = revisedProfileResultSchema.safeParse(raw);
  if (!parsed.success) return mapNonSuccess(raw);
  const result = parsed.data;
  if (
    result.workspaceId !== command.workspaceId
    || result.revision !== command.expectedCurrentRevision + 1
    || result.createdBy !== ctx.actor
  ) throw new OfferReleaseProfileIntegrityError();
  validateProfileSnapshotBindings({
    snapshot: result.snapshot,
    workspaceId: result.workspaceId,
    profileId: result.profileId,
    profileRevisionId: result.profileRevisionId,
    revision: result.revision,
    snapshotSha256: result.snapshotSha256,
    createdBy: result.createdBy,
    createdAt: result.createdAt,
  });
  await recordSuccess(tx, ctx, {
    action: "settings.manage",
    resource: "offer_release_profile",
    aggregateType: "offer_release_profile",
    aggregateId: result.profileId,
    eventType: "offer.release_profile_revised",
    details: {
      profileId: result.profileId,
      profileRevisionId: result.profileRevisionId,
      revision: result.revision,
      status: result.status,
    },
  });
  return {
    profileId: result.profileId,
    profileRevisionId: result.profileRevisionId,
    revision: result.revision,
    snapshot: result.snapshot,
  };
}

export async function activateOfferReleaseProfile(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferReleaseProfileActivationResult> {
  requireInternalAccess(ctx, "settings.manage", "offer_release_profile_activation");
  const command = parseCommand(offerReleaseProfileActivateCommandV1Schema, value);
  requireSameWorkspace(ctx, command.workspaceId);

  const raw = await executeFunction(tx, sql`
    select public.activate_offer_release_profile(
      ${command.workspaceId}::uuid,
      ${command.profileId}::uuid,
      ${command.profileRevisionId}::uuid,
      ${command.expectedProfileRevision}::integer
    ) as result
  `);
  const parsed = activateProfileResultSchema.safeParse(raw);
  if (!parsed.success) return mapNonSuccess(raw);
  const result = parsed.data;
  if (
    result.workspaceId !== command.workspaceId
    || result.profileId !== command.profileId
    || result.profileRevisionId !== command.profileRevisionId
    || result.profileRevision !== command.expectedProfileRevision
    || result.reviewedBy !== ctx.actor
  ) throw new OfferReleaseProfileIntegrityError();
  validateProfileSnapshotBindings({
    snapshot: result.snapshot,
    workspaceId: result.workspaceId,
    profileId: result.profileId,
    profileRevisionId: result.profileRevisionId,
    revision: result.profileRevision,
    snapshotSha256: result.profileSnapshotSha256,
  });
  await recordSuccess(tx, ctx, {
    action: "settings.manage",
    resource: "offer_release_profile_activation",
    aggregateType: "offer_release_profile",
    aggregateId: result.profileId,
    eventType: "offer.release_profile_activated",
    details: {
      profileId: result.profileId,
      profileRevisionId: result.profileRevisionId,
      profileRevision: result.profileRevision,
      activationId: result.activationId,
      reviewState: result.reviewState,
      status: result.status,
    },
  });
  return {
    activationId: result.activationId,
    profileId: result.profileId,
    profileRevisionId: result.profileRevisionId,
    profileRevision: result.profileRevision,
    reviewState: result.reviewState,
    reviewedAt: result.reviewedAt,
    snapshot: result.snapshot,
  };
}

export async function readCurrentOfferReleaseProfile(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<CurrentOfferReleaseProfileResult> {
  requireInternalAccess(ctx, "project.read", "offer_release_profile");
  const key = parseCommand(workspaceKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);
  let rows: unknown[];
  try {
    const result = await tx.execute(sql`
      select profile.workspace_id,
             profile.id as profile_id,
             current_revision.id as current_profile_revision_id,
             current_revision.revision as current_revision,
             current_revision.snapshot as current_snapshot,
             encode(current_revision.snapshot_sha256, 'hex')
               as current_snapshot_sha256_hex,
             activation.id as active_activation_id,
             active_revision.id as active_profile_revision_id,
             active_revision.revision as active_profile_revision,
             active_revision.snapshot as active_snapshot,
             encode(active_revision.snapshot_sha256, 'hex')
               as active_snapshot_sha256_hex,
             activation.review_state as active_review_state,
             activation.activated_at as active_reviewed_at
        from offer_release_profile profile
        join offer_release_profile_revision current_revision
          on current_revision.workspace_id = profile.workspace_id
         and current_revision.profile_id = profile.id
         and current_revision.revision = profile.current_revision
        left join offer_release_profile_activation activation
          on activation.workspace_id = profile.workspace_id
         and activation.id = profile.active_activation_id
         and activation.profile_id = profile.id
        left join offer_release_profile_revision active_revision
          on active_revision.workspace_id = activation.workspace_id
         and active_revision.id = activation.profile_revision_id
         and active_revision.profile_id = activation.profile_id
         and active_revision.revision = activation.profile_revision
         and active_revision.snapshot_sha256 = activation.profile_snapshot_sha256
       where profile.workspace_id = ${key.workspaceId}::uuid
       order by profile.created_at, profile.id
       limit 2
    `);
    rows = result.rows;
  } catch {
    throw new OfferReleaseProfilePersistenceError();
  }
  if (rows.length === 0) throw new OfferReleaseProfileNotFoundError();
  if (rows.length !== 1) throw new OfferReleaseProfileIntegrityError();
  const parsed = profileReadRowSchema.safeParse(rows[0]);
  if (!parsed.success) throw new OfferReleaseProfileIntegrityError();
  const row = parsed.data;
  const current = offerReleaseProfileSnapshotV1Schema.safeParse(row.current_snapshot);
  if (!current.success) throw new OfferReleaseProfileIntegrityError();
  if (row.workspace_id !== key.workspaceId) throw new OfferReleaseProfileIntegrityError();
  validateProfileSnapshotBindings({
    snapshot: current.data,
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    profileRevisionId: row.current_profile_revision_id,
    revision: row.current_revision,
    snapshotSha256: row.current_snapshot_sha256_hex,
  });

  const activeParts = [
    row.active_activation_id,
    row.active_profile_revision_id,
    row.active_profile_revision,
    row.active_snapshot,
    row.active_snapshot_sha256_hex,
    row.active_review_state,
    row.active_reviewed_at,
  ];
  if (activeParts.every((part) => part === null)) {
    return {
      profileId: row.profile_id,
      currentRevision: row.current_revision,
      current: current.data,
      active: null,
    };
  }
  if (activeParts.some((part) => part === null)) {
    throw new OfferReleaseProfileIntegrityError();
  }
  const active = offerReleaseProfileSnapshotV1Schema.safeParse(row.active_snapshot);
  if (!active.success) throw new OfferReleaseProfileIntegrityError();
  validateProfileSnapshotBindings({
    snapshot: active.data,
    workspaceId: row.workspace_id,
    profileId: row.profile_id,
    profileRevisionId: row.active_profile_revision_id as string,
    revision: row.active_profile_revision as number,
    snapshotSha256: row.active_snapshot_sha256_hex as string,
  });
  return {
    profileId: row.profile_id,
    currentRevision: row.current_revision,
    current: current.data,
    active: {
      activationId: row.active_activation_id as string,
      profileRevisionId: row.active_profile_revision_id as string,
      profileRevision: row.active_profile_revision as number,
      reviewState: row.active_review_state as "operator_reviewed",
      reviewedAt: row.active_reviewed_at as string,
      snapshot: active.data,
    },
  };
}

export async function reviseOfferRecipient(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferRecipientRevisionResult> {
  requireInternalAccess(ctx, "offer.release.prepare", "offer_recipient");
  const command = parseCommand(offerRecipientReviseCommandV1Schema, value);
  requireSameWorkspace(ctx, command.workspaceId);

  const raw = await executeFunction(tx, sql`
    select public.revise_offer_recipient(
      ${command.workspaceId}::uuid,
      ${command.offerId}::uuid,
      ${command.expectedCurrentRevision}::integer,
      ${command.displayName}::text,
      ${command.company}::text,
      ${command.email}::text,
      ${JSON.stringify(command.billingAddress)}::jsonb,
      ${command.billingDetailsConfirmed}::boolean
    ) as result
  `);
  const parsed = revisedRecipientResultSchema.safeParse(raw);
  if (!parsed.success) return mapNonSuccess(raw);
  const result = parsed.data;
  if (
    result.workspaceId !== command.workspaceId
    || result.offerId !== command.offerId
    || result.revision !== command.expectedCurrentRevision + 1
    || result.createdBy !== ctx.actor
  ) throw new OfferReleaseProfileIntegrityError();
  validateRecipientSnapshotBindings({
    snapshot: result.snapshot,
    workspaceId: result.workspaceId,
    offerId: result.offerId,
    recipientRevisionId: result.recipientRevisionId,
    revision: result.revision,
    snapshotSha256: result.snapshotSha256,
    createdBy: result.createdBy,
    createdAt: result.createdAt,
  });
  await recordSuccess(tx, ctx, {
    action: "offer.release.prepare",
    resource: "offer_recipient",
    aggregateType: "offer",
    aggregateId: result.offerId,
    eventType: "offer.recipient_revised",
    details: {
      offerId: result.offerId,
      recipientId: result.recipientId,
      recipientRevisionId: result.recipientRevisionId,
      revision: result.revision,
      status: result.status,
    },
  });
  return {
    recipientId: result.recipientId,
    recipientRevisionId: result.recipientRevisionId,
    revision: result.revision,
    snapshot: result.snapshot,
  };
}

export async function readCurrentOfferRecipient(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferRecipientRevisionResult> {
  requireInternalAccess(ctx, "project.read", "offer_recipient");
  const key = parseCommand(offerKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);
  let rows: unknown[];
  try {
    const result = await tx.execute(sql`
      select recipient.workspace_id,
             recipient.offer_id,
             recipient.id as recipient_id,
             revision.id as recipient_revision_id,
             revision.revision,
             revision.snapshot,
             encode(revision.snapshot_sha256, 'hex') as snapshot_sha256_hex
        from offer_recipient recipient
        join offer_recipient_revision revision
          on revision.workspace_id = recipient.workspace_id
         and revision.offer_id = recipient.offer_id
         and revision.recipient_id = recipient.id
         and revision.revision = recipient.current_revision
       where recipient.workspace_id = ${key.workspaceId}::uuid
         and recipient.offer_id = ${key.offerId}::uuid
       limit 2
    `);
    rows = result.rows;
  } catch {
    throw new OfferReleaseProfilePersistenceError();
  }
  if (rows.length === 0) throw new OfferReleaseProfileNotFoundError();
  if (rows.length !== 1) throw new OfferReleaseProfileIntegrityError();
  const parsed = recipientReadRowSchema.safeParse(rows[0]);
  if (!parsed.success) throw new OfferReleaseProfileIntegrityError();
  const row = parsed.data;
  const snapshot = offerRecipientSnapshotV1Schema.safeParse(row.snapshot);
  if (!snapshot.success) throw new OfferReleaseProfileIntegrityError();
  if (
    row.workspace_id !== key.workspaceId
    || row.offer_id !== key.offerId
  ) throw new OfferReleaseProfileIntegrityError();
  validateRecipientSnapshotBindings({
    snapshot: snapshot.data,
    workspaceId: row.workspace_id,
    offerId: row.offer_id,
    recipientRevisionId: row.recipient_revision_id,
    revision: row.revision,
    snapshotSha256: row.snapshot_sha256_hex,
  });
  return {
    recipientId: row.recipient_id,
    recipientRevisionId: row.recipient_revision_id,
    revision: row.revision,
    snapshot: snapshot.data,
  };
}
