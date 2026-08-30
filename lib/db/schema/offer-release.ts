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
  OfferRecipientSnapshotV1,
  OfferReleaseApprovalCommandV1,
  OfferReleaseCandidateInputV1,
  OfferReleaseProfileSnapshotV1,
} from "@/lib/integrations/offers/release-contract";
import { membership, workspace } from "./core";
import { offer, offerPdfDraft, offerVariantRevision } from "./offers";
import { bytea } from "./types";

export type OfferReleaseCandidateState =
  | "queued"
  | "running"
  | "retry_wait"
  | "ready_for_approval"
  | "failed_final";

export type OfferReleasePublicationStatus = "not_issued";

export const offerReleaseProfile = pgTable(
  "offer_release_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    currentRevision: integer("current_revision").notNull().default(0),
    // Die zusammengesetzte Head -> Activation-FK ist zyklisch und wird in
    // der SQL-Migration DEFERRABLE ergaenzt. Der Drizzle-Stand bildet die
    // nullable Aktivierungsreferenz bereits explizit ab.
    activeActivationId: uuid("active_activation_id"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_release_profile_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_release_profile_workspace_uq").on(t.workspaceId),
    index("offer_release_profile_ws_updated_idx").on(t.workspaceId, t.updatedAt, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_release_profile_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_release_profile_created_by_fk",
    }),
    check("offer_release_profile_revision_ck", sql`${t.currentRevision} >= 0`),
  ],
);

export const offerReleaseProfileRevision = pgTable(
  "offer_release_profile_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    profileId: uuid("profile_id").notNull(),
    revision: integer("revision").notNull(),
    schemaVersion: text("schema_version").notNull(),
    canonicalizationVersion: text("canonicalization_version").notNull(),
    snapshot: jsonb("snapshot").$type<OfferReleaseProfileSnapshotV1>().notNull(),
    snapshotSha256: bytea("snapshot_sha256").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_release_profile_revision_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_release_profile_revision_ws_profile_revision_uq").on(
      t.workspaceId,
      t.profileId,
      t.revision,
    ),
    unique("offer_release_profile_revision_ws_binding_uq").on(
      t.workspaceId,
      t.id,
      t.profileId,
      t.revision,
      t.snapshotSha256,
    ),
    index("offer_release_profile_revision_ws_profile_idx").on(
      t.workspaceId,
      t.profileId,
      t.revision,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_release_profile_revision_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.profileId],
      foreignColumns: [offerReleaseProfile.workspaceId, offerReleaseProfile.id],
      name: "offer_release_profile_revision_profile_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_release_profile_revision_created_by_fk",
    }),
    check("offer_release_profile_revision_revision_ck", sql`${t.revision} > 0`),
    check("offer_release_profile_revision_version_ck", sql`
      ${t.schemaVersion} = 'offer-release-profile-snapshot.v1'
      and ${t.canonicalizationVersion} = 'offer-jcs.v1'`),
    check("offer_release_profile_revision_hash_ck", sql`
      octet_length(${t.snapshotSha256}) = 32
      and ${t.snapshotSha256} = pg_catalog.sha256(convert_to(
        public.canonicalize_offer_json_v1(${t.snapshot} - 'snapshotSha256'),
        'UTF8'
      ))`),
    check("offer_release_profile_revision_json_ck", sql`
      jsonb_typeof(${t.snapshot}) = 'object'
      and (${t.snapshot} - array[
        'schemaVersion', 'canonicalizationVersion', 'profileId',
        'profileRevisionId', 'workspaceId', 'revision', 'profileName',
        'locale', 'currency', 'sender', 'legalDocuments', 'createdBy',
        'createdAt', 'snapshotSha256'
      ]::text[]) = '{}'::jsonb
      and ${t.snapshot}->>'schemaVersion' = ${t.schemaVersion}
      and ${t.snapshot}->>'canonicalizationVersion' = ${t.canonicalizationVersion}
      and ${t.snapshot}->>'workspaceId' = ${t.workspaceId}::text
      and ${t.snapshot}->>'profileId' = ${t.profileId}::text
      and ${t.snapshot}->>'profileRevisionId' = ${t.id}::text
      and (${t.snapshot}->>'revision')::integer = ${t.revision}
      and ${t.snapshot}->>'createdBy' = ${t.createdBy}::text
      and (${t.snapshot}->>'createdAt')::timestamptz = ${t.createdAt}
      and ${t.snapshot}->>'snapshotSha256' = encode(${t.snapshotSha256}, 'hex')
      and ${t.snapshot}->>'locale' = 'de-DE'
      and ${t.snapshot}->>'currency' = 'EUR'
      and jsonb_typeof(${t.snapshot}->'sender') = 'object'
      and jsonb_typeof(${t.snapshot}->'legalDocuments') = 'object'`),
  ],
);

export const offerReleaseProfileActivation = pgTable(
  "offer_release_profile_activation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    profileId: uuid("profile_id").notNull(),
    profileRevisionId: uuid("profile_revision_id").notNull(),
    profileRevision: integer("profile_revision").notNull(),
    profileSnapshotSha256: bytea("profile_snapshot_sha256").notNull(),
    reviewState: text("review_state").$type<"operator_reviewed">().notNull(),
    activatedBy: uuid("activated_by").notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_release_profile_activation_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_release_profile_activation_ws_profile_revision_uq").on(
      t.workspaceId,
      t.profileId,
      t.profileRevision,
    ),
    unique("offer_release_profile_activation_ws_binding_uq").on(
      t.workspaceId,
      t.id,
      t.profileId,
      t.profileRevisionId,
      t.profileRevision,
      t.profileSnapshotSha256,
    ),
    index("offer_release_profile_activation_ws_profile_idx").on(
      t.workspaceId,
      t.profileId,
      t.activatedAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_release_profile_activation_workspace_id_fk",
    }),
    foreignKey({
      columns: [
        t.workspaceId,
        t.profileRevisionId,
        t.profileId,
        t.profileRevision,
        t.profileSnapshotSha256,
      ],
      foreignColumns: [
        offerReleaseProfileRevision.workspaceId,
        offerReleaseProfileRevision.id,
        offerReleaseProfileRevision.profileId,
        offerReleaseProfileRevision.revision,
        offerReleaseProfileRevision.snapshotSha256,
      ],
      name: "offer_release_profile_activation_revision_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.activatedBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_release_profile_activation_activated_by_fk",
    }),
    check("offer_release_profile_activation_review_ck", sql`
      ${t.reviewState} = 'operator_reviewed'
      and ${t.profileRevision} > 0
      and octet_length(${t.profileSnapshotSha256}) = 32`),
  ],
);

export const offerRecipient = pgTable(
  "offer_recipient",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    currentRevision: integer("current_revision").notNull().default(0),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_recipient_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_recipient_ws_offer_uq").on(t.workspaceId, t.offerId),
    unique("offer_recipient_ws_offer_id_uq").on(t.workspaceId, t.offerId, t.id),
    index("offer_recipient_ws_updated_idx").on(t.workspaceId, t.updatedAt, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_recipient_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offer.workspaceId, offer.id],
      name: "offer_recipient_offer_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_recipient_created_by_fk",
    }),
    check("offer_recipient_revision_ck", sql`${t.currentRevision} >= 0`),
  ],
);

export const offerRecipientRevision = pgTable(
  "offer_recipient_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    recipientId: uuid("recipient_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    revision: integer("revision").notNull(),
    schemaVersion: text("schema_version").notNull(),
    canonicalizationVersion: text("canonicalization_version").notNull(),
    snapshot: jsonb("snapshot").$type<OfferRecipientSnapshotV1>().notNull(),
    snapshotSha256: bytea("snapshot_sha256").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_recipient_revision_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_recipient_revision_ws_recipient_revision_uq").on(
      t.workspaceId,
      t.recipientId,
      t.revision,
    ),
    unique("offer_recipient_revision_ws_binding_uq").on(
      t.workspaceId,
      t.id,
      t.recipientId,
      t.offerId,
      t.revision,
      t.snapshotSha256,
    ),
    index("offer_recipient_revision_ws_offer_idx").on(
      t.workspaceId,
      t.offerId,
      t.revision,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_recipient_revision_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.offerId, t.recipientId],
      foreignColumns: [offerRecipient.workspaceId, offerRecipient.offerId, offerRecipient.id],
      name: "offer_recipient_revision_head_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_recipient_revision_created_by_fk",
    }),
    check("offer_recipient_revision_revision_ck", sql`${t.revision} > 0`),
    check("offer_recipient_revision_version_ck", sql`
      ${t.schemaVersion} = 'offer-recipient-snapshot.v1'
      and ${t.canonicalizationVersion} = 'offer-jcs.v1'`),
    check("offer_recipient_revision_hash_ck", sql`
      octet_length(${t.snapshotSha256}) = 32
      and ${t.snapshotSha256} = pg_catalog.sha256(convert_to(
        public.canonicalize_offer_json_v1(${t.snapshot} - 'snapshotSha256'),
        'UTF8'
      ))`),
    check("offer_recipient_revision_json_ck", sql`
      jsonb_typeof(${t.snapshot}) = 'object'
      and (${t.snapshot} - array[
        'schemaVersion', 'canonicalizationVersion', 'recipientRevisionId',
        'workspaceId', 'offerId', 'revision', 'displayName', 'company',
        'email', 'billingAddress', 'confirmation', 'createdBy', 'createdAt',
        'snapshotSha256'
      ]::text[]) = '{}'::jsonb
      and ${t.snapshot}->>'schemaVersion' = ${t.schemaVersion}
      and ${t.snapshot}->>'canonicalizationVersion' = ${t.canonicalizationVersion}
      and ${t.snapshot}->>'workspaceId' = ${t.workspaceId}::text
      and ${t.snapshot}->>'offerId' = ${t.offerId}::text
      and ${t.snapshot}->>'recipientRevisionId' = ${t.id}::text
      and (${t.snapshot}->>'revision')::integer = ${t.revision}
      and ${t.snapshot}->>'createdBy' = ${t.createdBy}::text
      and (${t.snapshot}->>'createdAt')::timestamptz = ${t.createdAt}
      and ${t.snapshot}->>'snapshotSha256' = encode(${t.snapshotSha256}, 'hex')
      and jsonb_typeof(${t.snapshot}->'billingAddress') = 'object'
      and jsonb_typeof(${t.snapshot}->'confirmation') = 'object'
      and ${t.snapshot}->'confirmation'->>'code' = 'recipient_billing_operator_confirmed'
      and (${t.snapshot}->'confirmation'->>'confirmed')::boolean = true
      and ${t.snapshot}->'confirmation'->>'confirmedBy' = ${t.createdBy}::text
      and (${t.snapshot}->'confirmation'->>'confirmedAt')::timestamptz = ${t.createdAt}`),
  ],
);

export const offerReleaseCandidate = pgTable(
  "offer_release_candidate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    offerNumber: text("offer_number").notNull(),
    variantId: uuid("variant_id").notNull(),
    variantRevisionId: uuid("variant_revision_id").notNull(),
    variantRevision: integer("variant_revision").notNull(),
    variantSnapshotSha256: bytea("variant_snapshot_sha256").notNull(),
    sourcePdfDraftId: uuid("source_pdf_draft_id").notNull(),
    sourcePdfDraftState: text("source_pdf_draft_state").$type<"succeeded">().notNull(),
    sourcePdfDraftInputSha256: bytea("source_pdf_draft_input_sha256").notNull(),
    sourcePdfDraftMimeType: text("source_pdf_draft_mime_type")
      .$type<"application/pdf">().notNull(),
    sourcePdfDraftArtifactSha256: bytea("source_pdf_draft_artifact_sha256").notNull(),
    sourcePdfDraftSizeBytes: integer("source_pdf_draft_size_bytes").notNull(),
    profileId: uuid("profile_id").notNull(),
    profileRevisionId: uuid("profile_revision_id").notNull(),
    profileRevision: integer("profile_revision").notNull(),
    profileSnapshotSha256: bytea("profile_snapshot_sha256").notNull(),
    profileActivationId: uuid("profile_activation_id").notNull(),
    recipientId: uuid("recipient_id").notNull(),
    recipientRevisionId: uuid("recipient_revision_id").notNull(),
    recipientRevision: integer("recipient_revision").notNull(),
    recipientSnapshotSha256: bytea("recipient_snapshot_sha256").notNull(),
    preparedAt: timestamp("prepared_at", { withTimezone: true }).notNull().defaultNow(),
    documentDate: date("document_date", { mode: "string" }).notNull(),
    validThrough: date("valid_through", { mode: "string" }).notNull(),
    inputVersion: text("input_version").notNull(),
    canonicalizationVersion: text("canonicalization_version").notNull(),
    templateVersion: text("template_version").notNull(),
    rendererRecipeVersion: text("renderer_recipe_version").notNull(),
    publicationStatus: text("publication_status")
      .$type<OfferReleasePublicationStatus>()
      .notNull()
      .default("not_issued"),
    reservationKey: bytea("reservation_key").notNull(),
    inputSnapshot: jsonb("input_snapshot").$type<OfferReleaseCandidateInputV1>().notNull(),
    inputSha256: bytea("input_sha256").notNull(),
    hasZeroTaxTreatment: boolean("has_zero_tax_treatment").notNull(),
    state: text("state").$type<OfferReleaseCandidateState>().notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
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
    unique("offer_release_candidate_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_release_candidate_ws_reservation_uq").on(t.workspaceId, t.reservationKey),
    unique("offer_release_candidate_ws_approval_binding_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
      t.offerId,
      t.variantId,
      t.variantRevisionId,
      t.variantRevision,
      t.variantSnapshotSha256,
      t.sourcePdfDraftId,
      t.sourcePdfDraftInputSha256,
      t.sourcePdfDraftArtifactSha256,
      t.profileActivationId,
      t.profileId,
      t.profileRevisionId,
      t.profileRevision,
      t.profileSnapshotSha256,
      t.recipientId,
      t.recipientRevisionId,
      t.recipientRevision,
      t.recipientSnapshotSha256,
      t.inputVersion,
      t.canonicalizationVersion,
      t.templateVersion,
      t.rendererRecipeVersion,
      t.inputSha256,
      t.publicationStatus,
      t.hasZeroTaxTreatment,
      t.artifactMimeType,
      t.artifactSha256,
      t.artifactSizeBytes,
      t.artifactVersion,
    ),
    index("offer_release_candidate_ws_offer_idx").on(
      t.workspaceId,
      t.offerId,
      t.createdAt,
      t.id,
    ),
    index("offer_release_candidate_due_idx").on(
      t.workspaceId,
      t.state,
      t.nextAttemptAt,
      t.createdAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_release_candidate_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offer.workspaceId, offer.id],
      name: "offer_release_candidate_offer_fk",
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
      name: "offer_release_candidate_variant_revision_fk",
    }),
    foreignKey({
      columns: [
        t.workspaceId,
        t.sourcePdfDraftId,
        t.projectId,
        t.offerId,
        t.variantId,
        t.variantRevisionId,
        t.variantRevision,
        t.variantSnapshotSha256,
        t.sourcePdfDraftState,
        t.sourcePdfDraftInputSha256,
        t.sourcePdfDraftMimeType,
        t.sourcePdfDraftArtifactSha256,
        t.sourcePdfDraftSizeBytes,
      ],
      foreignColumns: [
        offerPdfDraft.workspaceId,
        offerPdfDraft.id,
        offerPdfDraft.projectId,
        offerPdfDraft.offerId,
        offerPdfDraft.variantId,
        offerPdfDraft.variantRevisionId,
        offerPdfDraft.variantRevision,
        offerPdfDraft.variantSnapshotSha256,
        offerPdfDraft.state,
        offerPdfDraft.inputSha256,
        offerPdfDraft.artifactMimeType,
        offerPdfDraft.artifactSha256,
        offerPdfDraft.artifactSizeBytes,
      ],
      name: "offer_release_candidate_source_draft_fk",
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
      name: "offer_release_candidate_profile_activation_fk",
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
      name: "offer_release_candidate_recipient_revision_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_release_candidate_created_by_fk",
    }),
    check("offer_release_candidate_binding_ck", sql`
      ${t.variantRevision} > 0
      and ${t.profileRevision} > 0
      and ${t.recipientRevision} > 0
      and ${t.offerNumber} ~ '^ANG-[0-9]{4}-[0-9]{6}$'
      and ${t.sourcePdfDraftState} = 'succeeded'
      and ${t.sourcePdfDraftMimeType} = 'application/pdf'
      and ${t.sourcePdfDraftSizeBytes} between 100 and 8388608
      and octet_length(${t.variantSnapshotSha256}) = 32
      and octet_length(${t.sourcePdfDraftInputSha256}) = 32
      and octet_length(${t.sourcePdfDraftArtifactSha256}) = 32
      and octet_length(${t.profileSnapshotSha256}) = 32
      and octet_length(${t.recipientSnapshotSha256}) = 32
      and octet_length(${t.reservationKey}) = 32
      and octet_length(${t.inputSha256}) = 32`),
    check("offer_release_candidate_versions_ck", sql`
      ${t.inputVersion} = 'offer-release-candidate-input.v1'
      and ${t.canonicalizationVersion} = 'offer-jcs.v1'
      and ${t.templateVersion} = 'offer-release-candidate-template.v1'
      and ${t.rendererRecipeVersion} = 'offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac'`),
    check("offer_release_candidate_publication_ck", sql`
      ${t.publicationStatus} = 'not_issued'`),
    check("offer_release_candidate_dates_ck", sql`
      ${t.preparedAt} = ${t.createdAt}
      and (${t.preparedAt} at time zone 'Europe/Berlin')::date = ${t.documentDate}
      and (${t.validThrough} - ${t.documentDate}) between 1 and 60`),
    check("offer_release_candidate_input_ck", sql`
      jsonb_typeof(${t.inputSnapshot}) = 'object'
      and (${t.inputSnapshot} - array[
        'schemaVersion', 'canonicalizationVersion', 'templateVersion',
        'rendererRecipeVersion', 'documentStatus', 'preparedAt',
        'documentDate', 'validThrough', 'offerNumber', 'profile', 'sender',
        'recipient', 'installationSite', 'variant', 'commercialTerms',
        'sections', 'totals', 'legalDocuments'
      ]::text[]) = '{}'::jsonb
      and ${t.inputSnapshot}->>'schemaVersion' = ${t.inputVersion}
      and ${t.inputSnapshot}->>'canonicalizationVersion' = ${t.canonicalizationVersion}
      and ${t.inputSnapshot}->>'templateVersion' = ${t.templateVersion}
      and ${t.inputSnapshot}->>'rendererRecipeVersion' = ${t.rendererRecipeVersion}
      and ${t.inputSnapshot}->>'documentStatus' = ${t.publicationStatus}
      and (${t.inputSnapshot}->>'preparedAt')::timestamptz = ${t.preparedAt}
      and (${t.inputSnapshot}->>'documentDate')::date = ${t.documentDate}
      and (${t.inputSnapshot}->>'validThrough')::date = ${t.validThrough}
      and ${t.inputSnapshot}->>'offerNumber' = ${t.offerNumber}
      and (${t.inputSnapshot}->'profile'->>'revision')::integer = ${t.profileRevision}
      and (${t.inputSnapshot}->'variant'->>'revision')::integer = ${t.variantRevision}
      and jsonb_typeof(${t.inputSnapshot}->'sections') = 'array'
      and jsonb_array_length(${t.inputSnapshot}->'sections') between 1 and 25
      and ${t.hasZeroTaxTreatment} = jsonb_path_exists(
        ${t.inputSnapshot},
        '$.sections[*].lines[*] ? (@.taxRateBps == 0)'::jsonpath
      )`),
    check("offer_release_candidate_input_hash_ck", sql`
      ${t.inputSha256} = pg_catalog.sha256(convert_to(
        public.canonicalize_offer_json_v1(${t.inputSnapshot}),
        'UTF8'
      ))`),
    check("offer_release_candidate_state_ck", sql`${t.state} in (
      'queued', 'running', 'retry_wait', 'ready_for_approval', 'failed_final'
    )`),
    check("offer_release_candidate_attempt_ck", sql`${t.attemptCount} between 0 and 3`),
    check("offer_release_candidate_error_ck", sql`(
      ${t.errorCode} is null and ${t.errorRetryable} is null
    ) or (
      ${t.errorCode} ~ '^[a-z][a-z0-9_]{0,79}$' and ${t.errorRetryable} is not null
    )`),
    check("offer_release_candidate_artifact_ck", sql`(
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
      and ${t.artifactVersion} is not null
    )`),
    check("offer_release_candidate_shape_ck", sql`case ${t.state}
      when 'queued' then
        ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
        and ${t.finishedAt} is null and ${t.errorCode} is null
        and ${t.errorRetryable} is null and ${t.artifactBytes} is null
        and ${t.artifactVersion} is null
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

export const offerReleaseCandidateApproval = pgTable(
  "offer_release_candidate_approval",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    candidateId: uuid("candidate_id").notNull(),
    projectId: uuid("project_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    variantRevisionId: uuid("variant_revision_id").notNull(),
    variantRevision: integer("variant_revision").notNull(),
    variantSnapshotSha256: bytea("variant_snapshot_sha256").notNull(),
    sourcePdfDraftId: uuid("source_pdf_draft_id").notNull(),
    sourcePdfDraftInputSha256: bytea("source_pdf_draft_input_sha256").notNull(),
    sourcePdfDraftArtifactSha256: bytea("source_pdf_draft_artifact_sha256").notNull(),
    profileActivationId: uuid("profile_activation_id").notNull(),
    profileId: uuid("profile_id").notNull(),
    profileRevisionId: uuid("profile_revision_id").notNull(),
    profileRevision: integer("profile_revision").notNull(),
    profileSnapshotSha256: bytea("profile_snapshot_sha256").notNull(),
    recipientId: uuid("recipient_id").notNull(),
    recipientRevisionId: uuid("recipient_revision_id").notNull(),
    recipientRevision: integer("recipient_revision").notNull(),
    recipientSnapshotSha256: bytea("recipient_snapshot_sha256").notNull(),
    inputVersion: text("input_version").notNull(),
    canonicalizationVersion: text("canonicalization_version").notNull(),
    templateVersion: text("template_version").notNull(),
    rendererRecipeVersion: text("renderer_recipe_version").notNull(),
    inputSha256: bytea("input_sha256").notNull(),
    publicationStatus: text("publication_status")
      .$type<OfferReleasePublicationStatus>()
      .notNull(),
    hasZeroTaxTreatment: boolean("has_zero_tax_treatment").notNull(),
    artifactMimeType: text("artifact_mime_type").$type<"application/pdf">().notNull(),
    artifactSha256: bytea("artifact_sha256").notNull(),
    artifactSizeBytes: integer("artifact_size_bytes").notNull(),
    artifactVersion: uuid("artifact_version").notNull(),
    approvalVersion: text("approval_version").notNull(),
    approvalCommandVersion: text("approval_command_version").notNull(),
    approvalCommand: jsonb("approval_command").$type<OfferReleaseApprovalCommandV1>().notNull(),
    recipientBillingReviewed: boolean("recipient_billing_reviewed").notNull(),
    commercialContentReviewed: boolean("commercial_content_reviewed").notNull(),
    activeProfileReviewed: boolean("active_profile_reviewed").notNull(),
    notIssuedStatusUnderstood: boolean("not_issued_status_understood").notNull(),
    zeroTaxTreatmentReviewed: boolean("zero_tax_treatment_reviewed"),
    approvedBy: uuid("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_release_candidate_approval_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_release_candidate_approval_ws_candidate_uq").on(
      t.workspaceId,
      t.candidateId,
    ),
    index("offer_release_candidate_approval_ws_offer_idx").on(
      t.workspaceId,
      t.offerId,
      t.approvedAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_release_candidate_approval_workspace_id_fk",
    }),
    foreignKey({
      columns: [
        t.workspaceId,
        t.candidateId,
        t.projectId,
        t.offerId,
        t.variantId,
        t.variantRevisionId,
        t.variantRevision,
        t.variantSnapshotSha256,
        t.sourcePdfDraftId,
        t.sourcePdfDraftInputSha256,
        t.sourcePdfDraftArtifactSha256,
        t.profileActivationId,
        t.profileId,
        t.profileRevisionId,
        t.profileRevision,
        t.profileSnapshotSha256,
        t.recipientId,
        t.recipientRevisionId,
        t.recipientRevision,
        t.recipientSnapshotSha256,
        t.inputVersion,
        t.canonicalizationVersion,
        t.templateVersion,
        t.rendererRecipeVersion,
        t.inputSha256,
        t.publicationStatus,
        t.hasZeroTaxTreatment,
        t.artifactMimeType,
        t.artifactSha256,
        t.artifactSizeBytes,
        t.artifactVersion,
      ],
      foreignColumns: [
        offerReleaseCandidate.workspaceId,
        offerReleaseCandidate.id,
        offerReleaseCandidate.projectId,
        offerReleaseCandidate.offerId,
        offerReleaseCandidate.variantId,
        offerReleaseCandidate.variantRevisionId,
        offerReleaseCandidate.variantRevision,
        offerReleaseCandidate.variantSnapshotSha256,
        offerReleaseCandidate.sourcePdfDraftId,
        offerReleaseCandidate.sourcePdfDraftInputSha256,
        offerReleaseCandidate.sourcePdfDraftArtifactSha256,
        offerReleaseCandidate.profileActivationId,
        offerReleaseCandidate.profileId,
        offerReleaseCandidate.profileRevisionId,
        offerReleaseCandidate.profileRevision,
        offerReleaseCandidate.profileSnapshotSha256,
        offerReleaseCandidate.recipientId,
        offerReleaseCandidate.recipientRevisionId,
        offerReleaseCandidate.recipientRevision,
        offerReleaseCandidate.recipientSnapshotSha256,
        offerReleaseCandidate.inputVersion,
        offerReleaseCandidate.canonicalizationVersion,
        offerReleaseCandidate.templateVersion,
        offerReleaseCandidate.rendererRecipeVersion,
        offerReleaseCandidate.inputSha256,
        offerReleaseCandidate.publicationStatus,
        offerReleaseCandidate.hasZeroTaxTreatment,
        offerReleaseCandidate.artifactMimeType,
        offerReleaseCandidate.artifactSha256,
        offerReleaseCandidate.artifactSizeBytes,
        offerReleaseCandidate.artifactVersion,
      ],
      name: "offer_release_candidate_approval_candidate_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.approvedBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_release_candidate_approval_approved_by_fk",
    }),
    check("offer_release_candidate_approval_binding_ck", sql`
      ${t.approvalVersion} = 'offer-release-candidate-approval.v1'
      and ${t.approvalCommandVersion} = 'offer-release-approval-command.v1'
      and ${t.publicationStatus} = 'not_issued'
      and ${t.variantRevision} > 0
      and ${t.profileRevision} > 0
      and ${t.recipientRevision} > 0
      and octet_length(${t.variantSnapshotSha256}) = 32
      and octet_length(${t.sourcePdfDraftInputSha256}) = 32
      and octet_length(${t.sourcePdfDraftArtifactSha256}) = 32
      and octet_length(${t.profileSnapshotSha256}) = 32
      and octet_length(${t.recipientSnapshotSha256}) = 32
      and octet_length(${t.inputSha256}) = 32
      and ${t.artifactMimeType} = 'application/pdf'
      and octet_length(${t.artifactSha256}) = 32
      and ${t.artifactSizeBytes} between 100 and 8388608
      and ${t.artifactVersion} is not null`),
    check("offer_release_candidate_approval_ack_ck", sql`
      ${t.recipientBillingReviewed} = true
      and ${t.commercialContentReviewed} = true
      and ${t.activeProfileReviewed} = true
      and ${t.notIssuedStatusUnderstood} = true`),
    check("offer_release_candidate_approval_zero_tax_ck", sql`(
      ${t.hasZeroTaxTreatment} = true
      and ${t.zeroTaxTreatmentReviewed} = true
      and ${t.approvalCommand} ? 'zeroTaxTreatmentReviewed'
    ) or (
      ${t.hasZeroTaxTreatment} = false
      and ${t.zeroTaxTreatmentReviewed} is null
      and not (${t.approvalCommand} ? 'zeroTaxTreatmentReviewed')
    )`),
    check("offer_release_candidate_approval_json_ck", sql`
      jsonb_typeof(${t.approvalCommand}) = 'object'
      and (${t.approvalCommand} - array[
        'schemaVersion', 'workspaceId', 'offerId', 'candidateId',
        'expectedArtifactVersion',
        'recipientBillingReviewed', 'commercialContentReviewed',
        'activeProfileReviewed', 'notIssuedStatusUnderstood',
        'zeroTaxTreatmentReviewed'
      ]::text[]) = '{}'::jsonb
      and ${t.approvalCommand}->>'schemaVersion' = ${t.approvalCommandVersion}
      and ${t.approvalCommand}->>'workspaceId' = ${t.workspaceId}::text
      and ${t.approvalCommand}->>'offerId' = ${t.offerId}::text
      and ${t.approvalCommand}->>'candidateId' = ${t.candidateId}::text
      and ${t.approvalCommand}->>'expectedArtifactVersion' = ${t.artifactVersion}::text
      and (${t.approvalCommand}->>'recipientBillingReviewed')::boolean = ${t.recipientBillingReviewed}
      and (${t.approvalCommand}->>'commercialContentReviewed')::boolean = ${t.commercialContentReviewed}
      and (${t.approvalCommand}->>'activeProfileReviewed')::boolean = ${t.activeProfileReviewed}
      and (${t.approvalCommand}->>'notIssuedStatusUnderstood')::boolean = ${t.notIssuedStatusUnderstood}
      and case when ${t.hasZeroTaxTreatment}
        then (${t.approvalCommand}->>'zeroTaxTreatmentReviewed')::boolean = ${t.zeroTaxTreatmentReviewed}
        else not (${t.approvalCommand} ? 'zeroTaxTreatmentReviewed')
      end`),
  ],
);
