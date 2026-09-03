import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { membership, workspace } from "./core";
import { offer, offerVariant, offerVariantRevision } from "./offers";
import { offerIssuance } from "./offer-issuance";
import { project } from "./project";
import { bytea } from "./types";

export type SignatureRequestStatus =
  | "pending"
  | "signed"
  | "expired"
  | "withdrawn"
  | "revoked_by_customer";

export type SignatureMode = "click" | "draw" | "analog";

export type SignatureWithdrawalReason =
  | "content_error"
  | "recipient_error"
  | "commercial_error"
  | "other";

export const signatureRequest = pgTable(
  "signature_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    variantRevisionId: uuid("variant_revision_id").notNull(),
    issuanceId: uuid("issuance_id").notNull(),
    paymentOptionId: uuid("payment_option_id"),
    status: text("status").$type<SignatureRequestStatus>().notNull().default("pending"),
    tokenHash: bytea("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    contentSha256: bytea("content_sha256").notNull(),
    signerName: text("signer_name"),
    signedVariantId: uuid("signed_variant_id"),
    signedPaymentOptionId: uuid("signed_payment_option_id"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnBy: uuid("withdrawn_by"),
    withdrawalReason: text("withdrawal_reason").$type<SignatureWithdrawalReason>(),
    revokedByCustomerAt: timestamp("revoked_by_customer_at", { withTimezone: true }),
  },
  (t) => [
    unique("signature_request_ws_id_uq").on(t.workspaceId, t.id),
    unique("signature_request_ws_issuance_uq").on(t.workspaceId, t.issuanceId),
    unique("signature_request_token_hash_uq").on(t.tokenHash),
    index("signature_request_ws_offer_idx").on(
      t.workspaceId,
      t.offerId,
      t.createdAt,
      t.id,
    ),
    index("signature_request_ws_status_idx").on(
      t.workspaceId,
      t.status,
      t.createdAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "signature_request_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "signature_request_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offer.workspaceId, offer.id],
      name: "signature_request_offer_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.variantId],
      foreignColumns: [offerVariant.workspaceId, offerVariant.id],
      name: "signature_request_variant_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.variantRevisionId],
      foreignColumns: [offerVariantRevision.workspaceId, offerVariantRevision.id],
      name: "signature_request_variant_revision_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.issuanceId],
      foreignColumns: [offerIssuance.workspaceId, offerIssuance.id],
      name: "signature_request_issuance_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "signature_request_created_by_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.withdrawnBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "signature_request_withdrawn_by_fk",
    }),
    check("signature_request_status_ck", sql`${t.status} in (
      'pending', 'signed', 'expired', 'withdrawn', 'revoked_by_customer'
    )`),
    check("signature_request_hash_ck", sql`
      octet_length(${t.tokenHash}) = 32
      and octet_length(${t.contentSha256}) = 32`),
    check("signature_request_expiry_ck", sql`${t.expiresAt} > ${t.createdAt}`),
    check("signature_request_payment_ck", sql`
      ${t.paymentOptionId} is null
      and ${t.signedPaymentOptionId} is null`),
    check("signature_request_withdrawal_reason_ck", sql`
      ${t.withdrawalReason} is null or ${t.withdrawalReason} in (
        'content_error', 'recipient_error', 'commercial_error', 'other'
      )`),
    check("signature_request_shape_ck", sql`case ${t.status}
      when 'pending' then
        ${t.signerName} is null
        and ${t.signedVariantId} is null
        and ${t.signedAt} is null
        and ${t.withdrawnAt} is null
        and ${t.withdrawnBy} is null
        and ${t.withdrawalReason} is null
        and ${t.revokedByCustomerAt} is null
      when 'signed' then
        ${t.signerName} is not null
        and ${t.signedVariantId} = ${t.variantId}
        and ${t.signedAt} is not null
        and ${t.withdrawnAt} is null
        and ${t.withdrawnBy} is null
        and ${t.withdrawalReason} is null
        and ${t.revokedByCustomerAt} is null
      when 'expired' then
        ${t.signerName} is null
        and ${t.signedVariantId} is null
        and ${t.signedAt} is null
        and ${t.withdrawnAt} is null
        and ${t.withdrawnBy} is null
        and ${t.withdrawalReason} is null
        and ${t.revokedByCustomerAt} is null
      when 'withdrawn' then
        ${t.signerName} is null
        and ${t.signedVariantId} is null
        and ${t.signedAt} is null
        and ${t.withdrawnAt} is not null
        and ${t.withdrawnBy} is not null
        and ${t.withdrawalReason} is not null
        and ${t.revokedByCustomerAt} is null
      when 'revoked_by_customer' then
        ${t.signerName} is not null
        and ${t.signedVariantId} = ${t.variantId}
        and ${t.signedAt} is not null
        and ${t.withdrawnAt} is null
        and ${t.withdrawnBy} is null
        and ${t.withdrawalReason} is null
        and ${t.revokedByCustomerAt} is not null
      else false end`),
  ],
);

export const signatureAttestation = pgTable(
  "signature_attestation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    signatureRequestId: uuid("signature_request_id").notNull(),
    mode: text("mode").$type<SignatureMode>().notNull(),
    signerName: text("signer_name").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull().defaultNow(),
    contentSha256: bytea("content_sha256").notNull(),
    signingDate: timestamp("signing_date", { withTimezone: true }),
    artifactMimeType: text("artifact_mime_type"),
    artifactSha256: bytea("artifact_sha256"),
    artifactSizeBytes: integer("artifact_size_bytes"),
    artifactBytes: bytea("artifact_bytes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("signature_attestation_ws_id_uq").on(t.workspaceId, t.id),
    unique("signature_attestation_ws_request_uq").on(t.workspaceId, t.signatureRequestId),
    index("signature_attestation_ws_request_idx").on(
      t.workspaceId,
      t.signatureRequestId,
      t.createdAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "signature_attestation_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.signatureRequestId],
      foreignColumns: [signatureRequest.workspaceId, signatureRequest.id],
      name: "signature_attestation_request_fk",
    }).onDelete("cascade"),
    check("signature_attestation_mode_ck", sql`${t.mode} in (
      'click', 'draw', 'analog'
    )`),
    check("signature_attestation_content_ck", sql`
      octet_length(${t.contentSha256}) = 32
      and length(btrim(${t.signerName})) between 1 and 200`),
    check("signature_attestation_artifact_ck", sql`(
      ${t.artifactMimeType} is null
      and ${t.artifactSha256} is null
      and ${t.artifactSizeBytes} is null
      and ${t.artifactBytes} is null
      and ${t.signingDate} is null
    ) or (
      ${t.artifactMimeType} in ('image/png', 'application/pdf', 'image/jpeg')
      and octet_length(${t.artifactSha256}) = 32
      and ${t.artifactSizeBytes} between 1 and 8388608
      and octet_length(${t.artifactBytes}) = ${t.artifactSizeBytes}
      and ${t.artifactSha256} = pg_catalog.sha256(${t.artifactBytes})
      and case
        when ${t.mode} = 'draw' then
          ${t.artifactMimeType} = 'image/png'
          and ${t.artifactSizeBytes} <= 524288
          and ${t.signingDate} is null
        when ${t.mode} = 'analog' then
          ${t.artifactMimeType} in ('application/pdf', 'image/jpeg')
          and ${t.signingDate} is not null
        else false
      end
    )`),
    check("signature_attestation_click_shape_ck", sql`
      ${t.mode} <> 'click' or (
        ${t.artifactMimeType} is null
        and ${t.artifactSha256} is null
        and ${t.artifactSizeBytes} is null
        and ${t.artifactBytes} is null
        and ${t.signingDate} is null
      )`),
  ],
);

export const signatureViewLog = pgTable(
  "signature_view_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    signatureRequestId: uuid("signature_request_id").notNull(),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("signature_view_log_ws_id_uq").on(t.workspaceId, t.id),
    index("signature_view_log_ws_request_idx").on(
      t.workspaceId,
      t.signatureRequestId,
      t.viewedAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "signature_view_log_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.signatureRequestId],
      foreignColumns: [signatureRequest.workspaceId, signatureRequest.id],
      name: "signature_view_log_request_fk",
    }).onDelete("cascade"),
  ],
);

// Token-Locator für den öffentlichen Signierlink (Muster
// erasure_operation_locator aus 0027): bewusst RLS-FREI, damit der
// Token-Pfad vor dem Workspace-Lookup den Token-Hash cross-tenant auflösen
// kann. Zugriff ausschließlich über SECURITY-DEFINER-Kapseln.
export const signatureTokenLocator = pgTable(
  "signature_token_locator",
  {
    tokenHash: bytea("token_hash").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    signatureRequestId: uuid("signature_request_id").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "signature_token_locator_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.signatureRequestId],
      foreignColumns: [signatureRequest.workspaceId, signatureRequest.id],
      name: "signature_token_locator_request_fk",
    }).onDelete("cascade"),
    check("signature_token_locator_hash_ck", sql`octet_length(${t.tokenHash}) = 32`),
  ],
);
