import "server-only";

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  OFFER_CANONICALIZATION_VERSION,
  canonicalizeOfferJson,
  validateOfferVariantSnapshot,
  type OfferVariantSnapshotV1,
} from "@/lib/integrations/offers/contract";
import {
  OFFER_PDF_DRAFT_INPUT_VERSION,
  OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
  OFFER_PDF_DRAFT_TEMPLATE_VERSION,
  buildOfferPdfDraftInput,
  hashOfferPdfDraftInput,
  validateOfferPdfDraftInput,
  type OfferPdfDraftInputV1,
} from "@/lib/integrations/offers/pdf-contract";
import { renderOfferPdfDraftHtml } from "@/lib/integrations/offers/pdf-template";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type Action,
  type ServiceCtx,
} from "@/lib/permissions";

const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OFFER_NUMBER_PATTERN = /^ANG-[0-9]{4}-[0-9]{6}$/u;

const requestSchema = z.strictObject({
  workspaceId: z.uuid(),
  offerId: z.uuid(),
  variantId: z.uuid(),
  expectedVariantRevision: z.int().safe().min(1),
});

const offerKeySchema = z.strictObject({
  workspaceId: z.uuid(),
  offerId: z.uuid(),
});

const jobKeySchema = offerKeySchema.extend({
  jobId: z.uuid(),
});

const stateSchema = z.enum([
  "queued",
  "running",
  "retry_wait",
  "succeeded",
  "failed_final",
]);

export type OfferPdfDraftState = z.infer<typeof stateSchema>;

export class OfferPdfDraftValidationError extends Error {
  constructor(public readonly paths: string[] = []) {
    super("offer PDF draft request is invalid");
    this.name = "OfferPdfDraftValidationError";
  }
}

export class OfferPdfDraftConflictError extends Error {
  constructor(public readonly currentRevision?: number) {
    super("offer PDF draft source changed since it was loaded");
    this.name = "OfferPdfDraftConflictError";
  }
}

export class OfferPdfDraftNotFoundError extends Error {
  constructor() {
    super("offer PDF draft was not found");
    this.name = "OfferPdfDraftNotFoundError";
  }
}

export class OfferPdfDraftIntegrityError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("stored offer PDF draft data failed integrity validation", options);
    this.name = "OfferPdfDraftIntegrityError";
  }
}

export class OfferPdfDraftPersistenceError extends Error {
  constructor() {
    super("offer PDF draft persistence failed");
    this.name = "OfferPdfDraftPersistenceError";
  }
}

export class OfferPdfDraftDispatchError extends Error {
  readonly code = "dispatch_unavailable" as const;

  constructor() {
    super("offer PDF draft dispatch is unavailable");
    this.name = "OfferPdfDraftDispatchError";
  }
}

export type OfferPdfDraftRequestResult = {
  jobId: string;
  offerId: string;
  variantId: string;
  variantRevision: number;
  state: OfferPdfDraftState;
  replayed: boolean;
};

export type OfferPdfDraftStatusResult = {
  jobId: string;
  offerId: string;
  variantId: string;
  variantRevision: number;
  state: OfferPdfDraftState;
  attemptCount: number;
  nextAttemptAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  canDownload: boolean;
};

export type OfferPdfDraftArtifactResult = {
  jobId: string;
  offerId: string;
  variantId: string;
  variantRevision: number;
  filename: string;
  mimeType: "application/pdf";
  sha256: string;
  sizeBytes: number;
  bytes: Buffer;
};

type OfferRow = {
  id: string;
  project_id: string;
  offer_number: string;
  [key: string]: unknown;
};

type VariantRow = {
  id: string;
  current_revision: number;
  [key: string]: unknown;
};

type RevisionRow = {
  id: string;
  project_id: string;
  revision: number;
  revision_snapshot: unknown;
  snapshot_sha256_hex: string;
  [key: string]: unknown;
};

type StoredDraftRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  offer_id: string;
  variant_id: string;
  variant_revision_id: string;
  variant_revision: number;
  variant_snapshot_sha256_hex: string;
  input_version: string;
  canonicalization_version: string;
  template_version: string;
  renderer_recipe_version: string;
  reservation_key_hex: string;
  input_snapshot: unknown;
  input_sha256_hex: string;
  state: string;
  attempt_count: number;
  next_attempt_at: Date | string;
  created_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
  error_code: string | null;
  [key: string]: unknown;
};

type ArtifactRow = {
  id: string;
  offer_id: string;
  variant_id: string;
  variant_revision: number;
  offer_number: string;
  state: string;
  artifact_mime_type: string | null;
  artifact_sha256_hex: string | null;
  artifact_size_bytes: number | null;
  artifact_bytes: unknown;
  [key: string]: unknown;
};

type InsertedDraftRow = {
  input_snapshot: unknown;
  input_sha256_hex: string;
  reservation_key_hex: string;
  created_at: Date | string;
  [key: string]: unknown;
};

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => (
    issue.path.length === 0 ? "/" : `/${issue.path.map(String).join("/")}`
  )))].slice(0, 20);
}

function parseCommand<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new OfferPdfDraftValidationError(issuePaths(parsed.error));
  return parsed.data;
}

function requireAccess(ctx: ServiceCtx, action: Action, resource: string): void {
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
  if (workspaceId !== ctx.workspaceId) throw new OfferPdfDraftNotFoundError();
}

function asIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new OfferPdfDraftIntegrityError();
  return parsed.toISOString();
}

function optionalIso(value: Date | string | null): string | null {
  return value === null ? null : asIso(value);
}

function parseState(value: unknown): OfferPdfDraftState {
  const parsed = stateSchema.safeParse(value);
  if (!parsed.success) throw new OfferPdfDraftIntegrityError();
  return parsed.data;
}

function safeErrorCode(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,79}$/u.test(value)) {
    throw new OfferPdfDraftIntegrityError();
  }
  return value;
}

function statusResult(row: StoredDraftRow): OfferPdfDraftStatusResult {
  const state = parseState(row.state);
  if (!Number.isSafeInteger(row.attempt_count) || row.attempt_count < 0 || row.attempt_count > 3) {
    throw new OfferPdfDraftIntegrityError();
  }
  return {
    jobId: row.id,
    offerId: row.offer_id,
    variantId: row.variant_id,
    variantRevision: row.variant_revision,
    state,
    attemptCount: row.attempt_count,
    nextAttemptAt: asIso(row.next_attempt_at),
    createdAt: asIso(row.created_at),
    startedAt: optionalIso(row.started_at),
    finishedAt: optionalIso(row.finished_at),
    errorCode: safeErrorCode(row.error_code),
    canDownload: state === "succeeded",
  };
}

async function readOfferProjectId(
  tx: TenantTx,
  workspaceId: string,
  offerId: string,
): Promise<string> {
  const result = await tx.execute<{ project_id: string; [key: string]: unknown }>(sql`
    select project_id
      from offer
     where workspace_id = ${workspaceId}::uuid
       and id = ${offerId}::uuid
     limit 1
  `);
  const projectId = result.rows[0]?.project_id;
  if (!projectId) throw new OfferPdfDraftNotFoundError();
  return projectId;
}

type SourceInput = z.infer<typeof requestSchema>;

type SourceRows = {
  offer: OfferRow;
  variant: VariantRow;
  revision: RevisionRow;
};

async function fetchSourceRows(
  tx: TenantTx,
  input: SourceInput,
  lock: boolean,
): Promise<SourceRows> {
  const projectId = await readOfferProjectId(tx, input.workspaceId, input.offerId);
  const lockFragment = lock ? sql` for update` : sql``;
  const projectLock = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from project
     where workspace_id = ${input.workspaceId}::uuid
       and id = ${projectId}::uuid${lockFragment}
  `);
  if (projectLock.rows.length !== 1) throw new OfferPdfDraftNotFoundError();

  const offerResult = await tx.execute<OfferRow>(sql`
    select id, project_id, offer_number
      from offer
     where workspace_id = ${input.workspaceId}::uuid
       and id = ${input.offerId}::uuid
       and project_id = ${projectId}::uuid${lockFragment}
  `);
  const offer = offerResult.rows[0];
  if (!offer) throw new OfferPdfDraftNotFoundError();

  const variantResult = await tx.execute<VariantRow>(sql`
    select id, current_revision
      from offer_variant
     where workspace_id = ${input.workspaceId}::uuid
       and offer_id = ${offer.id}::uuid
       and id = ${input.variantId}::uuid${lockFragment}
  `);
  const variant = variantResult.rows[0];
  if (!variant) throw new OfferPdfDraftNotFoundError();
  // Reihenfolge wie historisch in lockSource: Conflict vor Revisions-SELECT.
  if (variant.current_revision !== input.expectedVariantRevision) {
    throw new OfferPdfDraftConflictError(variant.current_revision);
  }

  const revisionResult = await tx.execute<RevisionRow>(sql`
    select id, project_id, revision, revision_snapshot,
           encode(snapshot_sha256, 'hex') as snapshot_sha256_hex
      from offer_variant_revision
     where workspace_id = ${input.workspaceId}::uuid
       and offer_id = ${offer.id}::uuid
       and variant_id = ${variant.id}::uuid
       and revision = ${variant.current_revision}
     limit 1
  `);
  const revision = revisionResult.rows[0];
  if (!revision) throw new OfferPdfDraftIntegrityError();
  return { offer, variant, revision };
}

function validateSourceRows(
  rows: SourceRows,
  input: SourceInput,
): OfferVariantSnapshotV1 {
  const { offer, variant, revision } = rows;
  // Conflict wurde bereits in fetchSourceRows geprüft (Reihenfolge wie lockSource);
  // hier folgt die Snapshot-Integrität.
  const validated = validateOfferVariantSnapshot(revision.revision_snapshot);
  if (
    !validated.ok
    || revision.project_id !== offer.project_id
    || revision.revision !== variant.current_revision
    || validated.value.workspaceId !== input.workspaceId
    || validated.value.offerId !== offer.id
    || validated.value.variantId !== variant.id
    || validated.value.revision !== revision.revision
    || validated.value.sourceBindings.projectId !== offer.project_id
    || validated.value.snapshotSha256 !== revision.snapshot_sha256_hex
  ) throw new OfferPdfDraftIntegrityError();
  return validated.value;
}

async function lockSource(
  tx: TenantTx,
  input: SourceInput,
): Promise<{
  offer: OfferRow;
  variant: VariantRow;
  revision: RevisionRow;
  snapshot: OfferVariantSnapshotV1;
}> {
  const rows = await fetchSourceRows(tx, input, true);
  const snapshot = validateSourceRows(rows, input);
  return { ...rows, snapshot };
}

async function readSource(
  tx: TenantTx,
  input: SourceInput,
): Promise<{
  offer: OfferRow;
  variant: VariantRow;
  revision: RevisionRow;
  snapshot: OfferVariantSnapshotV1;
}> {
  const rows = await fetchSourceRows(tx, input, false);
  const snapshot = validateSourceRows(rows, input);
  return { ...rows, snapshot };
}

function reservationKey(input: {
  workspaceId: string;
  variantId: string;
  variantRevision: number;
  variantSnapshotSha256: string;
}): Buffer {
  const material = JSON.stringify({
    schemaVersion: "offer-pdf-draft-reservation.v1",
    workspaceId: input.workspaceId,
    variantId: input.variantId,
    variantRevision: input.variantRevision,
    variantSnapshotSha256: input.variantSnapshotSha256,
    inputVersion: OFFER_PDF_DRAFT_INPUT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    templateVersion: OFFER_PDF_DRAFT_TEMPLATE_VERSION,
    rendererRecipeVersion: OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
  });
  return createHash("sha256").update(material, "utf8").digest();
}

function validateStoredDraft(
  row: StoredDraftRow,
  source: Awaited<ReturnType<typeof lockSource>>,
  workspaceId: string,
): OfferPdfDraftInputV1 {
  const parsedInput = validateOfferPdfDraftInput(row.input_snapshot);
  if (
    !parsedInput.ok
    || row.workspace_id !== workspaceId
    || row.project_id !== source.offer.project_id
    || row.offer_id !== source.offer.id
    || row.variant_id !== source.variant.id
    || row.variant_revision_id !== source.revision.id
    || row.variant_revision !== source.revision.revision
    || row.variant_snapshot_sha256_hex !== source.revision.snapshot_sha256_hex
    || row.input_version !== OFFER_PDF_DRAFT_INPUT_VERSION
    || row.canonicalization_version !== OFFER_CANONICALIZATION_VERSION
    || row.template_version !== OFFER_PDF_DRAFT_TEMPLATE_VERSION
    || row.renderer_recipe_version !== OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION
    || parsedInput.value.schemaVersion !== row.input_version
    || parsedInput.value.canonicalizationVersion !== row.canonicalization_version
    || parsedInput.value.templateVersion !== row.template_version
    || parsedInput.value.rendererRecipeVersion !== row.renderer_recipe_version
    || parsedInput.value.offerNumber !== source.offer.offer_number
    || parsedInput.value.variant.revision !== source.revision.revision
    || parsedInput.value.preparedAt !== asIso(row.created_at)
    || row.reservation_key_hex !== reservationKey({
      workspaceId,
      variantId: source.variant.id,
      variantRevision: source.revision.revision,
      variantSnapshotSha256: source.revision.snapshot_sha256_hex,
    }).toString("hex")
    || !SHA256_PATTERN.test(row.input_sha256_hex)
    || hashOfferPdfDraftInput(parsedInput.value) !== row.input_sha256_hex
  ) throw new OfferPdfDraftIntegrityError();
  return parsedInput.value;
}

async function findStoredDraft(
  tx: TenantTx,
  source: Awaited<ReturnType<typeof lockSource>>,
  workspaceId: string,
): Promise<StoredDraftRow | null> {
  const result = await tx.execute<StoredDraftRow>(sql`
    select id, workspace_id, project_id, offer_id, variant_id,
           variant_revision_id, variant_revision,
           encode(variant_snapshot_sha256, 'hex') as variant_snapshot_sha256_hex,
           input_version, canonicalization_version, template_version,
           renderer_recipe_version,
           encode(reservation_key, 'hex') as reservation_key_hex,
           input_snapshot,
           encode(input_sha256, 'hex') as input_sha256_hex,
           state, attempt_count, next_attempt_at, created_at, started_at,
           finished_at, error_code
      from offer_pdf_draft
     where workspace_id = ${workspaceId}::uuid
       and variant_id = ${source.variant.id}::uuid
       and variant_revision = ${source.revision.revision}
       and template_version = ${OFFER_PDF_DRAFT_TEMPLATE_VERSION}
       and renderer_recipe_version = ${OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION}
     for update
  `);
  if (result.rows.length > 1) throw new OfferPdfDraftIntegrityError();
  return result.rows[0] ?? null;
}

async function databaseNow(tx: TenantTx): Promise<string> {
  const result = await tx.execute<{ db_now: Date | string; [key: string]: unknown }>(sql`
    select pg_catalog.transaction_timestamp() as db_now
  `);
  const value = result.rows[0]?.db_now;
  if (!value) throw new OfferPdfDraftPersistenceError();
  return asIso(value);
}

export async function enqueueOfferPdfDraftDispatch(
  tx: TenantTx,
  workspaceId: string,
  jobId: string,
): Promise<void> {
  const parsed = z.strictObject({ workspaceId: z.uuid(), jobId: z.uuid() })
    .safeParse({ workspaceId, jobId });
  if (!parsed.success) throw new OfferPdfDraftValidationError(issuePaths(parsed.error));
  const gate = await tx.execute<{
    dispatch_signature: string | null;
    current_role: string;
    session_role: string;
    database_name: string;
    [key: string]: unknown;
  }>(sql`
    select pg_catalog.to_regprocedure(
             'pgboss.enqueue_offer_pdf_draft(uuid,uuid)'
           )::text as dispatch_signature,
           current_user::text as current_role,
           session_user::text as session_role,
           pg_catalog.current_database()::text as database_name
  `);
  const row = gate.rows[0];
  if (!row?.dispatch_signature) {
    const explicitTestSkip = row !== undefined
      && row.current_role === row.session_role
      && (row.current_role === "app_test" || row.current_role === "app_ci")
      && row.database_name.includes("test");
    if (explicitTestSkip) return;
    throw new OfferPdfDraftDispatchError();
  }
  await tx.execute(sql`
    select pgboss.enqueue_offer_pdf_draft(
      ${workspaceId}::uuid,
      ${jobId}::uuid
    )
  `);
}

export async function requestOfferPdfDraft(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferPdfDraftRequestResult> {
  requireAccess(ctx, "project.write", "offer_pdf_draft");
  const command = parseCommand(requestSchema, value);
  requireSameWorkspace(ctx, command.workspaceId);
  const source = await lockSource(tx, command);
  const existing = await findStoredDraft(tx, source, command.workspaceId);
  if (existing !== null) {
    validateStoredDraft(existing, source, command.workspaceId);
    const state = parseState(existing.state);
    if (state === "queued" || state === "running" || state === "retry_wait") {
      await enqueueOfferPdfDraftDispatch(tx, command.workspaceId, existing.id);
    }
    // Jeder autorisierte User-Replay ist echte Offer-Aktivitaet. Die Buchung
    // liegt in derselben Tenant-Transaktion wie eine etwaige queued-Dispatch-
    // Reparatur; reine Worker-/Recovery-Retries durchlaufen diesen Pfad nicht.
    await tx.execute(sql`
      update offer
         set updated_at = pg_catalog.transaction_timestamp()
       where workspace_id = ${command.workspaceId}::uuid
         and id = ${source.offer.id}::uuid
    `);
    return {
      jobId: existing.id,
      offerId: existing.offer_id,
      variantId: existing.variant_id,
      variantRevision: existing.variant_revision,
      state,
      replayed: true,
    };
  }

  const preparedAt = await databaseNow(tx);
  let input: OfferPdfDraftInputV1;
  let inputSha256: string;
  try {
    // Roh-Snapshot (Siegel-Hash konsistent): source.snapshot ist der
    // Upgrade-View (v3-Normalform mit stale Hash) und wuerde die
    // Siegelpruefung in buildOfferPdfDraftInput zu Unrecht werfen (f162).
    input = buildOfferPdfDraftInput({
      offerNumber: source.offer.offer_number,
      preparedAt,
      variantSnapshot: source.revision.revision_snapshot,
    });
    inputSha256 = hashOfferPdfDraftInput(input);
  } catch {
    throw new OfferPdfDraftIntegrityError();
  }
  if (
    input.variant.revision !== source.revision.revision
    || input.offerNumber !== source.offer.offer_number
    || !SHA256_PATTERN.test(inputSha256)
  ) throw new OfferPdfDraftIntegrityError();

  const jobId = randomUUID();
  const reservation = reservationKey({
    workspaceId: command.workspaceId,
    variantId: source.variant.id,
    variantRevision: source.revision.revision,
    variantSnapshotSha256: source.revision.snapshot_sha256_hex,
  });
  let inserted: InsertedDraftRow | undefined;
  try {
    const result = await tx.execute<InsertedDraftRow>(sql`
      insert into offer_pdf_draft (
        id, workspace_id, project_id, offer_id, variant_id,
        variant_revision_id, variant_revision, variant_snapshot_sha256,
        input_version, canonicalization_version, template_version,
        renderer_recipe_version, created_by
      ) values (
        ${jobId}::uuid, ${command.workspaceId}::uuid,
        ${source.offer.project_id}::uuid, ${source.offer.id}::uuid,
        ${source.variant.id}::uuid, ${source.revision.id}::uuid,
        ${source.revision.revision},
        decode(${source.revision.snapshot_sha256_hex}, 'hex'),
        ${OFFER_PDF_DRAFT_INPUT_VERSION}, ${OFFER_CANONICALIZATION_VERSION},
        ${OFFER_PDF_DRAFT_TEMPLATE_VERSION},
        ${OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION}, ${ctx.actor}::uuid
      )
      returning input_snapshot,
                encode(input_sha256, 'hex') as input_sha256_hex,
                encode(reservation_key, 'hex') as reservation_key_hex,
                created_at
    `);
    inserted = result.rows[0];
  } catch (error) {
    if (error instanceof OfferPdfDraftDispatchError) throw error;
    throw new OfferPdfDraftPersistenceError();
  }
  const persistedInput = validateOfferPdfDraftInput(inserted?.input_snapshot);
  if (
    !inserted
    || !persistedInput.ok
    || canonicalizeOfferJson(persistedInput.value) !== canonicalizeOfferJson(input)
    || inserted.input_sha256_hex !== inputSha256
    || inserted.reservation_key_hex !== reservation.toString("hex")
    || asIso(inserted.created_at) !== preparedAt
  ) throw new OfferPdfDraftIntegrityError();

  await enqueueOfferPdfDraftDispatch(tx, command.workspaceId, jobId);
  await tx.execute(sql`
    update offer
       set updated_at = pg_catalog.transaction_timestamp()
     where workspace_id = ${command.workspaceId}::uuid
       and id = ${source.offer.id}::uuid
  `);
  const details = {
    projectId: source.offer.project_id,
    offerId: source.offer.id,
    variantId: source.variant.id,
    variantRevision: source.revision.revision,
    jobId,
    state: "queued" as const,
  };
  await emitEvent(tx, {
    workspaceId: command.workspaceId,
    aggregateType: "offer",
    aggregateId: source.offer.id,
    eventType: "offer.pdf_draft_requested",
    actor: ctx.actor,
    payload: details,
  });
  await writeAudit(tx, {
    workspaceId: command.workspaceId,
    actor: ctx.actor,
    action: "project.write",
    resource: "offer_pdf_draft",
    allowed: true,
    details,
  });
  return {
    jobId,
    offerId: source.offer.id,
    variantId: source.variant.id,
    variantRevision: source.revision.revision,
    state: "queued",
    replayed: false,
  };
}

export async function listOfferPdfDrafts(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferPdfDraftStatusResult[]> {
  requireAccess(ctx, "project.read", "offer_pdf_draft");
  const key = parseCommand(offerKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);
  const exists = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from offer
     where workspace_id = ${key.workspaceId}::uuid
       and id = ${key.offerId}::uuid
     limit 1
  `);
  if (exists.rows.length !== 1) throw new OfferPdfDraftNotFoundError();
  const result = await tx.execute<StoredDraftRow>(sql`
    select id, offer_id, variant_id, variant_revision, state, attempt_count,
           next_attempt_at, created_at, started_at, finished_at, error_code
      from offer_pdf_draft
     where workspace_id = ${key.workspaceId}::uuid
       and offer_id = ${key.offerId}::uuid
     order by created_at desc, id desc
  `);
  return result.rows.map(statusResult);
}

export async function getOfferPdfDraftStatus(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferPdfDraftStatusResult> {
  requireAccess(ctx, "project.read", "offer_pdf_draft");
  const key = parseCommand(jobKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);
  const result = await tx.execute<StoredDraftRow>(sql`
    select id, offer_id, variant_id, variant_revision, state, attempt_count,
           next_attempt_at, created_at, started_at, finished_at, error_code
      from offer_pdf_draft
     where workspace_id = ${key.workspaceId}::uuid
       and offer_id = ${key.offerId}::uuid
       and id = ${key.jobId}::uuid
     limit 1
  `);
  const row = result.rows[0];
  if (!row) throw new OfferPdfDraftNotFoundError();
  return statusResult(row);
}

export async function readOfferPdfDraftArtifact(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferPdfDraftArtifactResult> {
  requireAccess(ctx, "project.read", "offer_pdf_draft_artifact");
  const key = parseCommand(jobKeySchema, value);
  requireSameWorkspace(ctx, key.workspaceId);
  const result = await tx.execute<ArtifactRow>(sql`
    select draft.id, draft.offer_id, draft.variant_id,
           draft.variant_revision, offer_record.offer_number, draft.state,
           draft.artifact_mime_type,
           encode(draft.artifact_sha256, 'hex') as artifact_sha256_hex,
           draft.artifact_size_bytes, draft.artifact_bytes
      from offer_pdf_draft draft
      join offer offer_record
        on offer_record.workspace_id = draft.workspace_id
       and offer_record.id = draft.offer_id
     where draft.workspace_id = ${key.workspaceId}::uuid
       and draft.offer_id = ${key.offerId}::uuid
       and draft.id = ${key.jobId}::uuid
       and draft.state = 'succeeded'
     limit 1
  `);
  const row = result.rows[0];
  if (!row) throw new OfferPdfDraftNotFoundError();
  if (
    row.state !== "succeeded"
    || row.artifact_mime_type !== "application/pdf"
    || typeof row.artifact_sha256_hex !== "string"
    || !SHA256_PATTERN.test(row.artifact_sha256_hex)
    || !Number.isSafeInteger(row.artifact_size_bytes)
    || (row.artifact_size_bytes as number) < 100
    || (row.artifact_size_bytes as number) > MAX_ARTIFACT_BYTES
    || !Buffer.isBuffer(row.artifact_bytes)
    || row.artifact_bytes.length !== row.artifact_size_bytes
    || !OFFER_NUMBER_PATTERN.test(row.offer_number)
    || !Number.isSafeInteger(row.variant_revision)
    || row.variant_revision < 1
  ) throw new OfferPdfDraftIntegrityError();
  const actual = createHash("sha256").update(row.artifact_bytes).digest();
  const expected = Buffer.from(row.artifact_sha256_hex, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new OfferPdfDraftIntegrityError();
  }
  return {
    jobId: row.id,
    offerId: row.offer_id,
    variantId: row.variant_id,
    variantRevision: row.variant_revision,
    filename: `${row.offer_number}-Variante-R${row.variant_revision}.pdf`,
    mimeType: "application/pdf",
    sha256: row.artifact_sha256_hex,
    sizeBytes: row.artifact_size_bytes,
    bytes: Buffer.from(row.artifact_bytes),
  };
}

export type OfferPreviewHtmlResult = {
  offerId: string;
  variantId: string;
  variantRevision: number;
  html: string;
};

export async function getOfferPreviewHtml(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferPreviewHtmlResult> {
  requireAccess(ctx, "project.read", "offer_preview");
  const command = parseCommand(requestSchema, value);
  requireSameWorkspace(ctx, command.workspaceId);
  // Zustandslos: readSource ohne FOR UPDATE, kein Touch, kein Event, kein Audit.
  const source = await readSource(tx, command);
  const preparedAt = await databaseNow(tx);
  let input: OfferPdfDraftInputV1;
  try {
    // Roh-Snapshot (Siegel-Hash konsistent) — siehe Draft-Pfad oben.
    input = buildOfferPdfDraftInput({
      offerNumber: source.offer.offer_number,
      preparedAt,
      variantSnapshot: source.revision.revision_snapshot,
    });
  } catch (error) {
    // Cause bleibt lesbar (rls.test.ts-Muster); Typ/Meldung unveraendert.
    throw new OfferPdfDraftIntegrityError({ cause: error });
  }
  if (
    input.variant.revision !== source.revision.revision
    || input.offerNumber !== source.offer.offer_number
  ) throw new OfferPdfDraftIntegrityError();
  // Parität zum Draft-Pfad: gebautes Input-Objekt validieren, nicht nur Snapshot.
  if (!validateOfferPdfDraftInput(input).ok) throw new OfferPdfDraftIntegrityError();
  return {
    offerId: source.offer.id,
    variantId: source.variant.id,
    variantRevision: source.revision.revision,
    html: renderOfferPdfDraftHtml(input),
  };
}
