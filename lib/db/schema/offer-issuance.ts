import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  OfferIssuanceApprovalCommandV1,
  OfferIssuanceInputV1,
  OfferIssuanceWithdrawalCommandV1,
} from "@/lib/integrations/offers/issuance-contract";
import { membership, workspace } from "./core";
import {
  offerReleaseCandidate,
  offerReleaseCandidateApproval,
  offerReleaseProfileActivation,
  offerRecipientRevision,
} from "./offer-release";
import { offer, offerVariantRevision } from "./offers";
import { project } from "./project";
import { bytea } from "./types";

export type OfferIssuanceRenderState =
  | "queued"
  | "running"
  | "retry_wait"
  | "ready_for_approval"
  | "failed_final";

export type OfferIssuanceWithdrawalReason =
  | "content_error"
  | "recipient_error"
  | "legal_text_error"
  | "commercial_error"
  | "other";

export const offerIssuance = pgTable(
  "offer_issuance",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    offerNumber: text("offer_number").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    candidateApprovalId: uuid("candidate_approval_id").notNull(),
    candidateApprovedBy: uuid("candidate_approved_by").notNull(),
    candidateApprovedAt: timestamp("candidate_approved_at", { withTimezone: true })
      .notNull(),
    candidateInputVersion: text("candidate_input_version").notNull(),
    candidateCanonicalizationVersion: text("candidate_canonicalization_version")
      .notNull(),
    candidateTemplateVersion: text("candidate_template_version").notNull(),
    candidateRendererRecipeVersion: text("candidate_renderer_recipe_version")
      .notNull(),
    candidateInputSha256: bytea("candidate_input_sha256").notNull(),
    candidateApprovalVersion: text("candidate_approval_version").notNull(),
    candidateApprovalCommandVersion: text("candidate_approval_command_version")
      .notNull(),
    candidateArtifactMimeType: text("candidate_artifact_mime_type")
      .$type<"application/pdf">().notNull(),
    candidateArtifactSha256: bytea("candidate_artifact_sha256").notNull(),
    candidateArtifactSizeBytes: integer("candidate_artifact_size_bytes").notNull(),
    candidateArtifactVersion: uuid("candidate_artifact_version").notNull(),
    variantId: uuid("variant_id").notNull(),
    variantRevisionId: uuid("variant_revision_id").notNull(),
    variantRevision: integer("variant_revision").notNull(),
    variantSnapshotSha256: bytea("variant_snapshot_sha256").notNull(),
    profileActivationId: uuid("profile_activation_id").notNull(),
    profileId: uuid("profile_id").notNull(),
    profileRevisionId: uuid("profile_revision_id").notNull(),
    profileRevision: integer("profile_revision").notNull(),
    profileSnapshotSha256: bytea("profile_snapshot_sha256").notNull(),
    recipientId: uuid("recipient_id").notNull(),
    recipientRevisionId: uuid("recipient_revision_id").notNull(),
    recipientRevision: integer("recipient_revision").notNull(),
    recipientSnapshotSha256: bytea("recipient_snapshot_sha256").notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true })
      .notNull().defaultNow(),
    documentDate: date("document_date", { mode: "string" }).notNull(),
    validThrough: date("valid_through", { mode: "string" }).notNull(),
    artifactIntent: text("artifact_intent")
      .$type<"offer_issuance_final">().notNull(),
    inputVersion: text("input_version").notNull(),
    canonicalizationVersion: text("canonicalization_version").notNull(),
    templateVersion: text("template_version").notNull(),
    rendererRecipeVersion: text("renderer_recipe_version").notNull(),
    reservationKey: bytea("reservation_key").notNull(),
    inputSnapshot: jsonb("input_snapshot").$type<OfferIssuanceInputV1>().notNull(),
    inputSha256: bytea("input_sha256").notNull(),
    hasZeroTaxTreatment: boolean("has_zero_tax_treatment").notNull(),
    state: text("state").$type<OfferIssuanceRenderState>().notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull().defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorRetryable: boolean("error_retryable"),
    artifactMimeType: text("artifact_mime_type").$type<"application/pdf">(),
    artifactSha256: bytea("artifact_sha256"),
    artifactSizeBytes: integer("artifact_size_bytes"),
    artifactBytes: bytea("artifact_bytes"),
    artifactVersion: uuid("artifact_version"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("offer_issuance_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_issuance_ws_reservation_uq").on(t.workspaceId, t.reservationKey),
    unique("offer_issuance_ws_approval_binding_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
      t.offerId,
      t.candidateId,
      t.candidateApprovalId,
      t.candidateApprovedBy,
      t.artifactIntent,
      t.inputVersion,
      t.canonicalizationVersion,
      t.templateVersion,
      t.rendererRecipeVersion,
      t.inputSha256,
      t.hasZeroTaxTreatment,
      t.artifactMimeType,
      t.artifactSha256,
      t.artifactSizeBytes,
      t.artifactVersion,
    ),
    unique("offer_issuance_ws_withdrawal_binding_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
      t.offerId,
      t.candidateId,
      t.candidateApprovalId,
      t.inputVersion,
      t.canonicalizationVersion,
      t.templateVersion,
      t.rendererRecipeVersion,
      t.inputSha256,
    ),
    index("offer_issuance_ws_offer_idx").on(t.workspaceId, t.offerId, t.createdAt, t.id),
    index("offer_issuance_due_idx").on(
      t.workspaceId,
      t.state,
      t.nextAttemptAt,
      t.createdAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_issuance_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "offer_issuance_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offer.workspaceId, offer.id],
      name: "offer_issuance_offer_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.candidateId],
      foreignColumns: [offerReleaseCandidate.workspaceId, offerReleaseCandidate.id],
      name: "offer_issuance_candidate_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.candidateApprovalId],
      foreignColumns: [
        offerReleaseCandidateApproval.workspaceId,
        offerReleaseCandidateApproval.id,
      ],
      name: "offer_issuance_candidate_approval_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        t.workspaceId,
        t.variantRevisionId,
        t.offerId,
        t.variantId,
        t.projectId,
        t.variantRevision,
        t.variantSnapshotSha256,
      ],
      foreignColumns: [
        offerVariantRevision.workspaceId,
        offerVariantRevision.id,
        offerVariantRevision.offerId,
        offerVariantRevision.variantId,
        offerVariantRevision.projectId,
        offerVariantRevision.revision,
        offerVariantRevision.snapshotSha256,
      ],
      name: "offer_issuance_variant_revision_fk",
    }),
    foreignKey({
      columns: [
        t.workspaceId,
        t.profileActivationId,
        t.profileId,
        t.profileRevisionId,
        t.profileRevision,
        t.profileSnapshotSha256,
      ],
      foreignColumns: [
        offerReleaseProfileActivation.workspaceId,
        offerReleaseProfileActivation.id,
        offerReleaseProfileActivation.profileId,
        offerReleaseProfileActivation.profileRevisionId,
        offerReleaseProfileActivation.profileRevision,
        offerReleaseProfileActivation.profileSnapshotSha256,
      ],
      name: "offer_issuance_profile_activation_fk",
    }),
    foreignKey({
      columns: [
        t.workspaceId,
        t.recipientRevisionId,
        t.recipientId,
        t.offerId,
        t.recipientRevision,
        t.recipientSnapshotSha256,
      ],
      foreignColumns: [
        offerRecipientRevision.workspaceId,
        offerRecipientRevision.id,
        offerRecipientRevision.recipientId,
        offerRecipientRevision.offerId,
        offerRecipientRevision.revision,
        offerRecipientRevision.snapshotSha256,
      ],
      name: "offer_issuance_recipient_revision_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.candidateApprovedBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_issuance_candidate_approved_by_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_issuance_created_by_fk",
    }),
    check("offer_issuance_source_ck", sql`
      ${t.offerNumber} ~ '^ANG-[0-9]{4}-[0-9]{6}$'
      and ${t.variantRevision} > 0
      and ${t.profileRevision} > 0
      and ${t.recipientRevision} > 0
      and ${t.candidateInputVersion} = 'offer-release-candidate-input.v1'
      and ${t.candidateCanonicalizationVersion} = 'offer-jcs.v1'
      and ${t.candidateTemplateVersion} = 'offer-release-candidate-template.v1'
      and ${t.candidateRendererRecipeVersion} ~
        '^offer-release-candidate-renderer-recipe\\.v1-linux-amd64-pw1\\.62\\.1-[0-9a-f]{64}$'
      and octet_length(${t.candidateInputSha256}) = 32
      and ${t.candidateApprovalVersion} =
        'offer-release-candidate-approval.v1'
      and ${t.candidateApprovalCommandVersion} =
        'offer-release-approval-command.v1'
      and ${t.candidateArtifactMimeType} = 'application/pdf'
      and octet_length(${t.candidateArtifactSha256}) = 32
      and ${t.candidateArtifactSizeBytes} between 100 and 8388608
      and octet_length(${t.variantSnapshotSha256}) = 32
      and octet_length(${t.profileSnapshotSha256}) = 32
      and octet_length(${t.recipientSnapshotSha256}) = 32
      and (${t.validThrough} - ${t.documentDate}) between 1 and 60`),
    check("offer_issuance_intent_ck", sql`
      ${t.artifactIntent} = 'offer_issuance_final'
      and ${t.inputVersion} = 'offer-issuance-input.v1'
      and ${t.canonicalizationVersion} = 'offer-jcs.v1'
      and ${t.templateVersion} = 'offer-issuance-template.v1'
      and ${t.rendererRecipeVersion} ~
        '^offer-issuance-renderer-recipe\\.v1-linux-amd64-pw1\\.62\\.1-[0-9a-f]{64}$'
      and octet_length(${t.reservationKey}) = 32
      and octet_length(${t.inputSha256}) = 32`),
    check("offer_issuance_input_ck", sql`
      jsonb_typeof(${t.inputSnapshot}) = 'object'
      and (${t.inputSnapshot} - array[
        'schemaVersion', 'canonicalizationVersion', 'templateVersion',
        'rendererRecipeVersion', 'artifactIntent', 'issuanceId', 'preparedAt',
        'source', 'document'
      ]::text[]) = '{}'::jsonb
      and ${t.inputSnapshot}->>'schemaVersion' = ${t.inputVersion}
      and ${t.inputSnapshot}->>'canonicalizationVersion' =
        ${t.canonicalizationVersion}
      and ${t.inputSnapshot}->>'templateVersion' = ${t.templateVersion}
      and ${t.inputSnapshot}->>'rendererRecipeVersion' =
        ${t.rendererRecipeVersion}
      and ${t.inputSnapshot}->>'artifactIntent' = ${t.artifactIntent}
      and ${t.inputSnapshot}->>'issuanceId' = ${t.id}::text
      and (${t.inputSnapshot}->>'preparedAt')::timestamptz = ${t.preparedAt}
      and ${t.preparedAt} = ${t.createdAt}
      and ${t.preparedAt} >= ${t.candidateApprovedAt}
      and jsonb_typeof(${t.inputSnapshot}->'source') = 'object'
      and ((${t.inputSnapshot}->'source') - array[
        'workspaceId', 'projectId', 'offerId', 'candidateId',
        'candidateApprovalId', 'candidateApprovedAt',
        'candidateArtifactVersion', 'candidateArtifactMimeType',
        'candidateArtifactSha256', 'candidateArtifactSizeBytes',
        'candidateInputVersion', 'candidateCanonicalizationVersion',
        'candidateTemplateVersion', 'candidateRendererRecipeVersion',
        'candidateInputSha256', 'candidateApprovalVersion',
        'candidateApprovalCommandVersion', 'variant', 'profile', 'recipient'
      ]::text[]) = '{}'::jsonb
      and ${t.inputSnapshot}->'source'->>'workspaceId' = ${t.workspaceId}::text
      and ${t.inputSnapshot}->'source'->>'projectId' = ${t.projectId}::text
      and ${t.inputSnapshot}->'source'->>'offerId' = ${t.offerId}::text
      and ${t.inputSnapshot}->'source'->>'candidateId' = ${t.candidateId}::text
      and ${t.inputSnapshot}->'source'->>'candidateApprovalId' =
        ${t.candidateApprovalId}::text
      and (${t.inputSnapshot}->'source'->>'candidateApprovedAt')::timestamptz =
        ${t.candidateApprovedAt}
      and ${t.inputSnapshot}->'source'->>'candidateArtifactMimeType' =
        ${t.candidateArtifactMimeType}
      and (${t.inputSnapshot}->'source'->>'candidateArtifactSizeBytes')::integer =
        ${t.candidateArtifactSizeBytes}
      and ${t.inputSnapshot}->'source'->>'candidateInputVersion' =
        ${t.candidateInputVersion}
      and ${t.inputSnapshot}->'source'->>'candidateCanonicalizationVersion' =
        ${t.candidateCanonicalizationVersion}
      and ${t.inputSnapshot}->'source'->>'candidateTemplateVersion' =
        ${t.candidateTemplateVersion}
      and ${t.inputSnapshot}->'source'->>'candidateRendererRecipeVersion' =
        ${t.candidateRendererRecipeVersion}
      and ${t.inputSnapshot}->'source'->>'candidateInputSha256' =
        encode(${t.candidateInputSha256}, 'hex')
      and ${t.inputSnapshot}->'source'->>'candidateApprovalVersion' =
        ${t.candidateApprovalVersion}
      and ${t.inputSnapshot}->'source'->>'candidateApprovalCommandVersion' =
        ${t.candidateApprovalCommandVersion}
      and ${t.inputSnapshot}->'source'->>'candidateArtifactSha256' =
        encode(${t.candidateArtifactSha256}, 'hex')
      and ${t.inputSnapshot}->'source'->>'candidateArtifactVersion' =
        ${t.candidateArtifactVersion}::text
      and ((${t.inputSnapshot}->'source'->'variant') - array[
        'id', 'revisionId', 'revision', 'snapshotSha256'
      ]::text[]) = '{}'::jsonb
      and ${t.inputSnapshot}->'source'->'variant'->>'id' = ${t.variantId}::text
      and ${t.inputSnapshot}->'source'->'variant'->>'revisionId' =
        ${t.variantRevisionId}::text
      and (${t.inputSnapshot}->'source'->'variant'->>'revision')::integer =
        ${t.variantRevision}
      and ${t.inputSnapshot}->'source'->'variant'->>'snapshotSha256' =
        encode(${t.variantSnapshotSha256}, 'hex')
      and ((${t.inputSnapshot}->'source'->'profile') - array[
        'activationId', 'id', 'revisionId', 'revision', 'snapshotSha256'
      ]::text[]) = '{}'::jsonb
      and ${t.inputSnapshot}->'source'->'profile'->>'activationId' =
        ${t.profileActivationId}::text
      and ${t.inputSnapshot}->'source'->'profile'->>'id' = ${t.profileId}::text
      and ${t.inputSnapshot}->'source'->'profile'->>'revisionId' =
        ${t.profileRevisionId}::text
      and (${t.inputSnapshot}->'source'->'profile'->>'revision')::integer =
        ${t.profileRevision}
      and ${t.inputSnapshot}->'source'->'profile'->>'snapshotSha256' =
        encode(${t.profileSnapshotSha256}, 'hex')
      and ((${t.inputSnapshot}->'source'->'recipient') - array[
        'id', 'revisionId', 'revision', 'snapshotSha256'
      ]::text[]) = '{}'::jsonb
      and ${t.inputSnapshot}->'source'->'recipient'->>'id' = ${t.recipientId}::text
      and ${t.inputSnapshot}->'source'->'recipient'->>'revisionId' =
        ${t.recipientRevisionId}::text
      and (${t.inputSnapshot}->'source'->'recipient'->>'revision')::integer =
        ${t.recipientRevision}
      and ${t.inputSnapshot}->'source'->'recipient'->>'snapshotSha256' =
        encode(${t.recipientSnapshotSha256}, 'hex')
      and jsonb_typeof(${t.inputSnapshot}->'document') = 'object'
      and ${t.inputSnapshot}->'document'->>'offerNumber' = ${t.offerNumber}
      and (${t.inputSnapshot}->'document'->>'documentDate')::date =
        ${t.documentDate}
      and (${t.inputSnapshot}->'document'->>'validThrough')::date =
        ${t.validThrough}
      and (${t.inputSnapshot}->'document'->'variant'->>'revision')::integer =
        ${t.variantRevision}
      and (${t.inputSnapshot}->'document'->'profile'->>'revision')::integer =
        ${t.profileRevision}
      and jsonb_typeof(${t.inputSnapshot}->'document'->'sections') = 'array'
      and jsonb_array_length(${t.inputSnapshot}->'document'->'sections')
        between 1 and 25
      and ${t.hasZeroTaxTreatment} = jsonb_path_exists(
        ${t.inputSnapshot},
        '$.document.sections[*].lines[*] ? (@.taxRateBps == 0)'::jsonpath
      )`),
    check("offer_issuance_input_hash_ck", sql`
      ${t.inputSha256} = pg_catalog.sha256(convert_to(
        public.canonicalize_offer_json_v1(${t.inputSnapshot}), 'UTF8'
      ))`),
    check("offer_issuance_state_ck", sql`${t.state} in (
      'queued', 'running', 'retry_wait', 'ready_for_approval', 'failed_final'
    )`),
    check("offer_issuance_attempt_ck", sql`${t.attemptCount} between 0 and 3`),
    check("offer_issuance_error_ck", sql`(
      ${t.errorCode} is null and ${t.errorRetryable} is null
    ) or (
      ${t.errorCode} ~ '^[a-z][a-z0-9_]{0,79}$'
      and ${t.errorRetryable} is not null
    )`),
    check("offer_issuance_artifact_ck", sql`(
      ${t.artifactMimeType} is null
      and ${t.artifactSha256} is null
      and ${t.artifactSizeBytes} is null
      and ${t.artifactBytes} is null
      and ${t.artifactVersion} is null
    ) or (
      ${t.artifactMimeType} = 'application/pdf'
      and octet_length(${t.artifactSha256}) = 32
      and ${t.artifactSizeBytes} between 100 and 8388608
      and octet_length(${t.artifactBytes}) = ${t.artifactSizeBytes}
      and ${t.artifactSha256} = pg_catalog.sha256(${t.artifactBytes})
      and ${t.artifactSha256} <> ${t.candidateArtifactSha256}
      and ${t.artifactVersion} is not null
    )`),
    check("offer_issuance_shape_ck", sql`case ${t.state}
      when 'queued' then
        ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
        and ${t.startedAt} is null and ${t.finishedAt} is null
        and ${t.errorCode} is null and ${t.errorRetryable} is null
        and ${t.artifactBytes} is null and ${t.artifactVersion} is null
      when 'running' then
        ${t.leaseToken} is not null and ${t.leaseExpiresAt} is not null
        and ${t.startedAt} is not null and ${t.finishedAt} is null
        and ${t.errorCode} is null and ${t.errorRetryable} is null
        and ${t.artifactBytes} is null and ${t.artifactVersion} is null
      when 'retry_wait' then
        ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
        and ${t.startedAt} is not null and ${t.finishedAt} is null
        and ${t.errorCode} is not null and ${t.errorRetryable} = true
        and ${t.artifactBytes} is null and ${t.artifactVersion} is null
      when 'ready_for_approval' then
        ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
        and ${t.startedAt} is not null and ${t.finishedAt} is not null
        and ${t.errorCode} is null and ${t.errorRetryable} is null
        and ${t.artifactBytes} is not null and ${t.artifactVersion} is not null
      when 'failed_final' then
        ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
        and ${t.startedAt} is not null and ${t.finishedAt} is not null
        and ${t.errorCode} is not null and ${t.errorRetryable} = false
        and ${t.artifactBytes} is null and ${t.artifactVersion} is null
      else false end`),
  ],
);

export const offerIssuanceApproval = pgTable(
  "offer_issuance_approval",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    issuanceId: uuid("issuance_id").notNull(),
    projectId: uuid("project_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    candidateApprovalId: uuid("candidate_approval_id").notNull(),
    candidateApprovedBy: uuid("candidate_approved_by").notNull(),
    artifactIntent: text("artifact_intent").$type<"offer_issuance_final">().notNull(),
    inputVersion: text("input_version").notNull(),
    canonicalizationVersion: text("canonicalization_version").notNull(),
    templateVersion: text("template_version").notNull(),
    rendererRecipeVersion: text("renderer_recipe_version").notNull(),
    inputSha256: bytea("input_sha256").notNull(),
    hasZeroTaxTreatment: boolean("has_zero_tax_treatment").notNull(),
    artifactMimeType: text("artifact_mime_type").$type<"application/pdf">().notNull(),
    artifactSha256: bytea("artifact_sha256").notNull(),
    artifactSizeBytes: integer("artifact_size_bytes").notNull(),
    artifactVersion: uuid("artifact_version").notNull(),
    approvalVersion: text("approval_version").notNull(),
    approvalCommandVersion: text("approval_command_version").notNull(),
    approvalCommand: jsonb("approval_command")
      .$type<OfferIssuanceApprovalCommandV1>().notNull(),
    recipientAndScopeReviewed: boolean("recipient_and_scope_reviewed").notNull(),
    commercialTotalsReviewed: boolean("commercial_totals_reviewed").notNull(),
    legalProfileReviewed: boolean("legal_profile_reviewed").notNull(),
    finalPdfForArchiveUnderstood: boolean("final_pdf_for_archive_understood").notNull(),
    zeroTaxTreatmentReviewed: boolean("zero_tax_treatment_reviewed"),
    approvedBy: uuid("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_issuance_approval_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_issuance_approval_ws_issuance_actor_uq").on(
      t.workspaceId,
      t.issuanceId,
      t.approvedBy,
    ),
    index("offer_issuance_approval_ws_offer_idx").on(
      t.workspaceId,
      t.offerId,
      t.approvedAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_issuance_approval_workspace_id_fk",
    }),
    foreignKey({
      columns: [
        t.workspaceId,
        t.issuanceId,
        t.projectId,
        t.offerId,
        t.candidateId,
        t.candidateApprovalId,
        t.candidateApprovedBy,
        t.artifactIntent,
        t.inputVersion,
        t.canonicalizationVersion,
        t.templateVersion,
        t.rendererRecipeVersion,
        t.inputSha256,
        t.hasZeroTaxTreatment,
        t.artifactMimeType,
        t.artifactSha256,
        t.artifactSizeBytes,
        t.artifactVersion,
      ],
      foreignColumns: [
        offerIssuance.workspaceId,
        offerIssuance.id,
        offerIssuance.projectId,
        offerIssuance.offerId,
        offerIssuance.candidateId,
        offerIssuance.candidateApprovalId,
        offerIssuance.candidateApprovedBy,
        offerIssuance.artifactIntent,
        offerIssuance.inputVersion,
        offerIssuance.canonicalizationVersion,
        offerIssuance.templateVersion,
        offerIssuance.rendererRecipeVersion,
        offerIssuance.inputSha256,
        offerIssuance.hasZeroTaxTreatment,
        offerIssuance.artifactMimeType,
        offerIssuance.artifactSha256,
        offerIssuance.artifactSizeBytes,
        offerIssuance.artifactVersion,
      ],
      name: "offer_issuance_approval_issuance_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.approvedBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_issuance_approval_approved_by_fk",
    }),
    check("offer_issuance_approval_binding_ck", sql`
      ${t.artifactIntent} = 'offer_issuance_final'
      and ${t.inputVersion} = 'offer-issuance-input.v1'
      and ${t.canonicalizationVersion} = 'offer-jcs.v1'
      and ${t.templateVersion} = 'offer-issuance-template.v1'
      and ${t.rendererRecipeVersion} ~
        '^offer-issuance-renderer-recipe\\.v1-linux-amd64-pw1\\.62\\.1-[0-9a-f]{64}$'
      and octet_length(${t.inputSha256}) = 32
      and ${t.artifactMimeType} = 'application/pdf'
      and octet_length(${t.artifactSha256}) = 32
      and ${t.artifactSizeBytes} between 100 and 8388608`),
    check("offer_issuance_approval_ack_ck", sql`
      ${t.recipientAndScopeReviewed} = true
      and ${t.commercialTotalsReviewed} = true
      and ${t.legalProfileReviewed} = true
      and ${t.finalPdfForArchiveUnderstood} = true`),
    check("offer_issuance_approval_zero_tax_ck", sql`(
      ${t.hasZeroTaxTreatment} = true
      and ${t.zeroTaxTreatmentReviewed} = true
      and ${t.approvalCommand} ? 'zeroTaxTreatmentReviewed'
    ) or (
      ${t.hasZeroTaxTreatment} = false
      and ${t.zeroTaxTreatmentReviewed} is null
      and not (${t.approvalCommand} ? 'zeroTaxTreatmentReviewed')
    )`),
    check("offer_issuance_approval_json_ck", sql`
      jsonb_typeof(${t.approvalCommand}) = 'object'
      and (${t.approvalCommand} - array[
        'schemaVersion', 'issuanceId', 'recipientAndScopeReviewed',
        'commercialTotalsReviewed', 'legalProfileReviewed',
        'finalPdfForArchiveUnderstood', 'zeroTaxTreatmentReviewed'
      ]::text[]) = '{}'::jsonb
      and ${t.approvalCommand}->>'schemaVersion' = ${t.approvalCommandVersion}
      and ${t.approvalCommand}->>'issuanceId' = ${t.issuanceId}::text
      and (${t.approvalCommand}->>'recipientAndScopeReviewed')::boolean =
        ${t.recipientAndScopeReviewed}
      and (${t.approvalCommand}->>'commercialTotalsReviewed')::boolean =
        ${t.commercialTotalsReviewed}
      and (${t.approvalCommand}->>'legalProfileReviewed')::boolean =
        ${t.legalProfileReviewed}
      and (${t.approvalCommand}->>'finalPdfForArchiveUnderstood')::boolean =
        ${t.finalPdfForArchiveUnderstood}
      and case when ${t.hasZeroTaxTreatment}
        then (${t.approvalCommand}->>'zeroTaxTreatmentReviewed')::boolean =
          ${t.zeroTaxTreatmentReviewed}
        else not (${t.approvalCommand} ? 'zeroTaxTreatmentReviewed')
      end
      and ${t.approvalVersion} = 'offer-issuance-approval.v1'
      and ${t.approvalCommandVersion} = 'offer-issuance-approval-command.v1'`),
  ],
);

export const offerIssuanceWithdrawal = pgTable(
  "offer_issuance_withdrawal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    issuanceId: uuid("issuance_id").notNull(),
    projectId: uuid("project_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    candidateApprovalId: uuid("candidate_approval_id").notNull(),
    inputVersion: text("input_version").notNull(),
    canonicalizationVersion: text("canonicalization_version").notNull(),
    templateVersion: text("template_version").notNull(),
    rendererRecipeVersion: text("renderer_recipe_version").notNull(),
    inputSha256: bytea("input_sha256").notNull(),
    withdrawalVersion: text("withdrawal_version").notNull(),
    withdrawalCommandVersion: text("withdrawal_command_version").notNull(),
    withdrawalCommand: jsonb("withdrawal_command")
      .$type<OfferIssuanceWithdrawalCommandV1>().notNull(),
    reasonCode: text("reason_code").$type<OfferIssuanceWithdrawalReason>().notNull(),
    withdrawnBy: uuid("withdrawn_by").notNull(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_issuance_withdrawal_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_issuance_withdrawal_ws_issuance_uq").on(t.workspaceId, t.issuanceId),
    index("offer_issuance_withdrawal_ws_offer_idx").on(
      t.workspaceId,
      t.offerId,
      t.withdrawnAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_issuance_withdrawal_workspace_id_fk",
    }),
    foreignKey({
      columns: [
        t.workspaceId,
        t.issuanceId,
        t.projectId,
        t.offerId,
        t.candidateId,
        t.candidateApprovalId,
        t.inputVersion,
        t.canonicalizationVersion,
        t.templateVersion,
        t.rendererRecipeVersion,
        t.inputSha256,
      ],
      foreignColumns: [
        offerIssuance.workspaceId,
        offerIssuance.id,
        offerIssuance.projectId,
        offerIssuance.offerId,
        offerIssuance.candidateId,
        offerIssuance.candidateApprovalId,
        offerIssuance.inputVersion,
        offerIssuance.canonicalizationVersion,
        offerIssuance.templateVersion,
        offerIssuance.rendererRecipeVersion,
        offerIssuance.inputSha256,
      ],
      name: "offer_issuance_withdrawal_issuance_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.withdrawnBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_issuance_withdrawal_withdrawn_by_fk",
    }),
    check("offer_issuance_withdrawal_reason_ck", sql`${t.reasonCode} in (
      'content_error', 'recipient_error', 'legal_text_error',
      'commercial_error', 'other'
    )`),
    check("offer_issuance_withdrawal_json_ck", sql`
      ${t.withdrawalVersion} = 'offer-issuance-withdrawal.v1'
      and ${t.withdrawalCommandVersion} = 'offer-issuance-withdrawal-command.v1'
      and jsonb_typeof(${t.withdrawalCommand}) = 'object'
      and (${t.withdrawalCommand} - array[
        'schemaVersion', 'issuanceId', 'reasonCode'
      ]::text[]) = '{}'::jsonb
      and ${t.withdrawalCommand}->>'schemaVersion' =
        ${t.withdrawalCommandVersion}
      and ${t.withdrawalCommand}->>'issuanceId' = ${t.issuanceId}::text
      and ${t.withdrawalCommand}->>'reasonCode' = ${t.reasonCode}`),
  ],
);
