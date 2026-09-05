import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type {
  OfferContactContextV1,
  OfferInstallationSiteContextV1,
  OfferPriceAudienceDecisionV1,
  OfferSourceBindingsV1,
  OfferVariantSnapshotV1,
  OptionalBundlesV1,
} from "@/lib/integrations/offers/contract";
import type { OfferPdfDraftInputV1 } from "@/lib/integrations/offers/pdf-contract";
import { catalogComponentRevision, projectCatalogResolution } from "./catalog";
import { membership, workspace } from "./core";
import { projectCalculationRevision } from "./energy";
import { inboundReceipt, projectRequirement } from "./intake";
import { paymentOption } from "./payment-option";
import { project } from "./project";
import { bytea } from "./types";

type OfferSectionSnapshotV1 = OfferVariantSnapshotV1["sections"][number];
type OfferLineSnapshotV1 = OfferSectionSnapshotV1["lines"][number];

const moneyCheck = (column: AnyPgColumn) =>
  sql`${column} between 0 and 9000000000000000`;

export const offerNumberSeries = pgTable(
  "offer_number_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    seriesYear: integer("series_year").notNull(),
    prefix: text("prefix").notNull().default("ANG"),
    padding: integer("padding").notNull().default(6),
    lastSequence: integer("last_sequence").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_number_series_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_number_series_ws_year_uq").on(t.workspaceId, t.seriesYear),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_number_series_workspace_id_fk",
    }),
    check("offer_number_series_year_ck", sql`${t.seriesYear} between 2000 and 9999`),
    check("offer_number_series_format_ck", sql`${t.prefix} = 'ANG' and ${t.padding} = 6`),
    check("offer_number_series_sequence_ck", sql`${t.lastSequence} >= 0`),
  ],
);

export const offer = pgTable(
  "offer",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    siteId: uuid("site_id").notNull(),
    status: text("status").$type<"draft">().notNull().default("draft"),
    scope: text("scope").$type<"residential">().notNull().default("residential"),
    priceAudience: text("price_audience").$type<"b2c">().notNull().default("b2c"),
    priceAudienceDecision: jsonb("price_audience_decision")
      .$type<OfferPriceAudienceDecisionV1>().notNull(),
    offerNumber: text("offer_number").notNull(),
    numberYear: integer("number_year").notNull(),
    numberSequence: integer("number_sequence").notNull(),
    forecastValueNetCents: bigint("forecast_value_net_cents", { mode: "number" }),
    totalPriceOverrideNetCents: bigint("total_price_override_net_cents", { mode: "number" }),
    contactContext: jsonb("contact_context").$type<OfferContactContextV1>().notNull(),
    installationSiteContext: jsonb("installation_site_context")
      .$type<OfferInstallationSiteContextV1>().notNull(),
    sourceBindings: jsonb("source_bindings").$type<OfferSourceBindingsV1>().notNull(),
    inboundReceiptId: uuid("inbound_receipt_id").notNull(),
    inboundPayloadSha256: bytea("inbound_payload_sha256").notNull(),
    requirementId: uuid("requirement_id").notNull(),
    requirementRevision: integer("requirement_revision").notNull(),
    calculationRevisionId: uuid("calculation_revision_id").notNull(),
    calculationRevision: integer("calculation_revision").notNull(),
    calculationInputSha256: bytea("calculation_input_sha256").notNull(),
    calculationResultSha256: bytea("calculation_result_sha256").notNull(),
    resolutionId: uuid("resolution_id").notNull(),
    resolutionRevision: integer("resolution_revision").notNull(),
    resolutionSha256: bytea("resolution_sha256").notNull(),
    createDigest: bytea("create_digest").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_ws_project_uq").on(t.workspaceId, t.projectId),
    unique("offer_ws_number_uq").on(t.workspaceId, t.offerNumber),
    unique("offer_ws_year_sequence_uq").on(t.workspaceId, t.numberYear, t.numberSequence),
    index("offer_ws_updated_idx").on(t.workspaceId, t.updatedAt, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId, t.contactId, t.siteId],
      foreignColumns: [project.workspaceId, project.id, project.contactId, project.siteId],
      name: "offer_project_graph_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.inboundReceiptId, t.projectId, t.inboundPayloadSha256],
      foreignColumns: [
        inboundReceipt.workspaceId,
        inboundReceipt.id,
        inboundReceipt.projectId,
        inboundReceipt.bodySha256,
      ],
      name: "offer_inbound_receipt_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.requirementId, t.projectId, t.requirementRevision],
      foreignColumns: [
        projectRequirement.workspaceId,
        projectRequirement.id,
        projectRequirement.projectId,
        projectRequirement.revision,
      ],
      name: "offer_requirement_fk",
    }),
    foreignKey({
      columns: [
        t.workspaceId,
        t.calculationRevisionId,
        t.projectId,
        t.siteId,
        t.calculationRevision,
        t.calculationInputSha256,
        t.calculationResultSha256,
      ],
      foreignColumns: [
        projectCalculationRevision.workspaceId,
        projectCalculationRevision.id,
        projectCalculationRevision.projectId,
        projectCalculationRevision.siteId,
        projectCalculationRevision.revision,
        projectCalculationRevision.inputSha256,
        projectCalculationRevision.resultSha256,
      ],
      name: "offer_calculation_revision_fk",
    }),
    foreignKey({
      columns: [
        t.workspaceId,
        t.resolutionId,
        t.projectId,
        t.resolutionRevision,
        t.resolutionSha256,
      ],
      foreignColumns: [
        projectCatalogResolution.workspaceId,
        projectCatalogResolution.id,
        projectCatalogResolution.projectId,
        projectCatalogResolution.revision,
        projectCatalogResolution.resolutionSha256,
      ],
      name: "offer_resolution_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_created_by_fk",
    }),
    check("offer_status_scope_audience_ck", sql`${t.status} = 'draft'
      and ${t.scope} = 'residential' and ${t.priceAudience} = 'b2c'`),
    check("offer_price_audience_decision_ck", sql`
      jsonb_typeof(${t.priceAudienceDecision}) = 'object'
      and (${t.priceAudienceDecision} - array[
        'audience', 'confirmationCode', 'confirmedBy', 'confirmedAt'
      ]::text[]) = '{}'::jsonb
      and ${t.priceAudienceDecision}->>'audience' = ${t.priceAudience}
      and ${t.priceAudienceDecision}->>'confirmationCode' = 'b2c_operator_confirmed'
      and (${t.priceAudienceDecision}->>'confirmedBy')::uuid = ${t.createdBy}
      and (${t.priceAudienceDecision}->>'confirmedAt')::timestamptz = ${t.createdAt}`),
    check("offer_number_ck", sql`${t.offerNumber} ~ '^ANG-[0-9]{4}-[0-9]{6}$'`),
    check("offer_number_parts_ck", sql`${t.numberYear} between 2000 and 9999
      and ${t.numberSequence} between 1 and 999999`),
    check("offer_forecast_ck", sql`${t.forecastValueNetCents} is null
      or ${moneyCheck(t.forecastValueNetCents)}`),
    check("offer_total_override_ck", sql`${t.totalPriceOverrideNetCents} is null
      or ${moneyCheck(t.totalPriceOverrideNetCents)}`),
    check("offer_hashes_ck", sql`octet_length(${t.inboundPayloadSha256}) = 32
      and octet_length(${t.calculationInputSha256}) = 32
      and octet_length(${t.calculationResultSha256}) = 32
      and octet_length(${t.resolutionSha256}) = 32
      and octet_length(${t.createDigest}) = 32`),
    check("offer_context_json_ck", sql`jsonb_typeof(${t.contactContext}) = 'object'
      and jsonb_typeof(${t.installationSiteContext}) = 'object'
      and jsonb_typeof(${t.sourceBindings}) = 'object'`),
  ],
);

export const offerVariant = pgTable(
  "offer_variant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    currentRevision: integer("current_revision").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    isPrimary: boolean("is_primary").notNull().default(false),
    optionalBundles: jsonb("optional_bundles").$type<OptionalBundlesV1>().notNull().default([]),
    paymentOptionId: uuid("payment_option_id"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_variant_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_variant_ws_offer_id_uq").on(t.workspaceId, t.offerId, t.id),
    unique("offer_variant_ws_offer_ordinal_uq").on(t.workspaceId, t.offerId, t.ordinal),
    uniqueIndex("offer_variant_ws_offer_primary_uq")
      .on(t.workspaceId, t.offerId)
      .where(sql`${t.isPrimary} = true`),
    index("offer_variant_ws_offer_idx").on(t.workspaceId, t.offerId, t.ordinal),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_variant_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offer.workspaceId, offer.id],
      name: "offer_variant_offer_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_variant_created_by_fk",
    }),
    index("offer_variant_ws_payment_option_idx").on(t.workspaceId, t.paymentOptionId),
    foreignKey({
      columns: [t.workspaceId, t.paymentOptionId],
      foreignColumns: [paymentOption.workspaceId, paymentOption.id],
      name: "offer_variant_payment_option_fk",
    }),
    check("offer_variant_bundles_ck", sql`pg_catalog.jsonb_typeof(${t.optionalBundles}) = 'array'`),
    check("offer_variant_ordinal_ck", sql`${t.ordinal} between 1 and 12`),
    check("offer_variant_revision_ck", sql`${t.currentRevision} > 0`),
    check("offer_variant_name_ck", sql`length(btrim(${t.name})) between 1 and 120`),
    check("offer_variant_description_ck", sql`${t.description} is null
      or length(btrim(${t.description})) between 1 and 1000`),
  ],
);

export const offerVariantRevision = pgTable(
  "offer_variant_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    revision: integer("revision").notNull(),
    schemaVersion: text("schema_version").notNull(),
    canonicalizationVersion: text("canonicalization_version").notNull(),
    revisionSnapshot: jsonb("revision_snapshot").$type<OfferVariantSnapshotV1>().notNull(),
    snapshotSha256: bytea("snapshot_sha256").notNull(),
    resolutionId: uuid("resolution_id").notNull(),
    resolutionRevision: integer("resolution_revision").notNull(),
    resolutionSha256: bytea("resolution_sha256").notNull(),
    basisNetCents: bigint("basis_net_cents", { mode: "number" }).notNull(),
    basisTaxCents: bigint("basis_tax_cents", { mode: "number" }).notNull(),
    basisGrossCents: bigint("basis_gross_cents", { mode: "number" }).notNull(),
    optionalNetCents: bigint("optional_net_cents", { mode: "number" }).notNull(),
    optionalTaxCents: bigint("optional_tax_cents", { mode: "number" }).notNull(),
    optionalGrossCents: bigint("optional_gross_cents", { mode: "number" }).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_variant_revision_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_variant_revision_ws_graph_uq").on(
      t.workspaceId,
      t.id,
      t.offerId,
      t.variantId,
      t.projectId,
      t.revision,
    ),
    unique("offer_variant_revision_ws_variant_revision_uq").on(
      t.workspaceId,
      t.variantId,
      t.revision,
    ),
    unique("offer_variant_revision_ws_pdf_source_uq").on(
      t.workspaceId,
      t.id,
      t.offerId,
      t.variantId,
      t.projectId,
      t.revision,
      t.snapshotSha256,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_variant_revision_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.offerId, t.variantId],
      foreignColumns: [offerVariant.workspaceId, offerVariant.offerId, offerVariant.id],
      name: "offer_variant_revision_variant_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.resolutionId, t.projectId, t.resolutionRevision, t.resolutionSha256],
      foreignColumns: [
        projectCatalogResolution.workspaceId,
        projectCatalogResolution.id,
        projectCatalogResolution.projectId,
        projectCatalogResolution.revision,
        projectCatalogResolution.resolutionSha256,
      ],
      name: "offer_variant_revision_resolution_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_variant_revision_created_by_fk",
    }),
    check("offer_variant_revision_revision_ck", sql`${t.revision} > 0`),
    // F16.3 Slice D: Snapshot-v2 zugelassen (v1-Historie bleibt gültig).
    check("offer_variant_revision_version_ck", sql`${t.schemaVersion} in ('offer-variant-snapshot.v1', 'offer-variant-snapshot.v2', 'offer-variant-snapshot.v3')
      and ${t.canonicalizationVersion} = 'offer-jcs.v1'`),
    check("offer_variant_revision_hash_ck", sql`octet_length(${t.snapshotSha256}) = 32
      and octet_length(${t.resolutionSha256}) = 32`),
    check("offer_variant_revision_money_ck", sql`${moneyCheck(t.basisNetCents)}
      and ${moneyCheck(t.basisTaxCents)} and ${moneyCheck(t.basisGrossCents)}
      and ${moneyCheck(t.optionalNetCents)} and ${moneyCheck(t.optionalTaxCents)}
      and ${moneyCheck(t.optionalGrossCents)}
      and ${t.basisGrossCents} = ${t.basisNetCents} + ${t.basisTaxCents}
      and ${t.optionalGrossCents} = ${t.optionalNetCents} + ${t.optionalTaxCents}`),
    check("offer_variant_revision_json_ck", sql`jsonb_typeof(${t.revisionSnapshot}) = 'object'
      and ${t.revisionSnapshot}->>'schemaVersion' = ${t.schemaVersion}
      and ${t.revisionSnapshot}->>'canonicalizationVersion' = ${t.canonicalizationVersion}
      and ${t.revisionSnapshot}->>'workspaceId' = ${t.workspaceId}::text
      and ${t.revisionSnapshot}->>'offerId' = ${t.offerId}::text
      and ${t.revisionSnapshot}->>'variantId' = ${t.variantId}::text
      and (${t.revisionSnapshot}->>'revision')::integer = ${t.revision}
      and ${t.revisionSnapshot}->>'snapshotSha256' = encode(${t.snapshotSha256}, 'hex')
      and jsonb_typeof(${t.revisionSnapshot}->'sections') = 'array'
      and jsonb_array_length(${t.revisionSnapshot}->'sections') between 1 and 25`),
  ],
);

export type OfferPdfDraftState =
  | "queued"
  | "running"
  | "retry_wait"
  | "succeeded"
  | "failed_final";

/**
 * Erasure-faehiges Staging fuer interne PDF-Entwuerfe. Diese Relation ist
 * absichtlich kein WORM-Archiv: Erst ein spaeterer Issuance-Slice darf exakt
 * gehashte Bytes in einen empirisch geprueften Object-Lock-Bucket promoten.
 */
export const offerPdfDraft = pgTable(
  "offer_pdf_draft",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    variantRevisionId: uuid("variant_revision_id").notNull(),
    variantRevision: integer("variant_revision").notNull(),
    variantSnapshotSha256: bytea("variant_snapshot_sha256").notNull(),
    inputVersion: text("input_version").notNull(),
    canonicalizationVersion: text("canonicalization_version").notNull(),
    templateVersion: text("template_version").notNull(),
    rendererRecipeVersion: text("renderer_recipe_version").notNull(),
    reservationKey: bytea("reservation_key").notNull(),
    inputSnapshot: jsonb("input_snapshot").$type<OfferPdfDraftInputV1>().notNull(),
    inputSha256: bytea("input_sha256").notNull(),
    state: text("state").$type<OfferPdfDraftState>().notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorRetryable: boolean("error_retryable"),
    artifactMimeType: text("artifact_mime_type"),
    artifactSha256: bytea("artifact_sha256"),
    artifactSizeBytes: integer("artifact_size_bytes"),
    artifactBytes: bytea("artifact_bytes"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("offer_pdf_draft_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_pdf_draft_ws_reservation_uq").on(t.workspaceId, t.reservationKey),
    unique("offer_pdf_draft_ws_recipe_uq").on(
      t.workspaceId,
      t.variantId,
      t.variantRevision,
      t.templateVersion,
      t.rendererRecipeVersion,
    ),
    unique("offer_pdf_draft_ws_release_source_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
      t.offerId,
      t.variantId,
      t.variantRevisionId,
      t.variantRevision,
      t.variantSnapshotSha256,
      t.state,
      t.inputSha256,
      t.artifactMimeType,
      t.artifactSha256,
      t.artifactSizeBytes,
    ),
    index("offer_pdf_draft_ws_offer_idx").on(
      t.workspaceId,
      t.offerId,
      t.createdAt,
      t.id,
    ),
    index("offer_pdf_draft_due_idx").on(
      t.workspaceId,
      t.state,
      t.nextAttemptAt,
      t.createdAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_pdf_draft_workspace_id_fk",
    }),
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
      name: "offer_pdf_draft_variant_revision_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_pdf_draft_created_by_fk",
    }),
    check("offer_pdf_draft_binding_ck", sql`${t.variantRevision} > 0
      and octet_length(${t.variantSnapshotSha256}) = 32
      and octet_length(${t.reservationKey}) = 32
      and octet_length(${t.inputSha256}) = 32`),
    check("offer_pdf_draft_versions_ck", sql`${t.inputVersion} = 'offer-pdf-draft-input.v1'
      and ${t.canonicalizationVersion} = 'offer-jcs.v1'
      and ${t.templateVersion} = 'offer-pdf-draft-template.v1'
      and ${t.rendererRecipeVersion} = 'offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac'`),
    check("offer_pdf_draft_input_ck", sql`jsonb_typeof(${t.inputSnapshot}) = 'object'
      and ${t.inputSnapshot}->>'schemaVersion' = ${t.inputVersion}
      and ${t.inputSnapshot}->>'canonicalizationVersion' = ${t.canonicalizationVersion}
      and ${t.inputSnapshot}->>'templateVersion' = ${t.templateVersion}
      and ${t.inputSnapshot}->>'rendererRecipeVersion' = ${t.rendererRecipeVersion}`),
    check("offer_pdf_draft_input_hash_ck", sql`${t.inputSha256} = sha256(convert_to(
      public.canonicalize_offer_json_v1(${t.inputSnapshot}), 'UTF8'
    ))`),
    check("offer_pdf_draft_state_ck", sql`${t.state} in (
      'queued', 'running', 'retry_wait', 'succeeded', 'failed_final'
    )`),
    check("offer_pdf_draft_attempt_ck", sql`${t.attemptCount} between 0 and 3`),
    check("offer_pdf_draft_error_ck", sql`(
      ${t.errorCode} is null and ${t.errorRetryable} is null
    ) or (
      ${t.errorCode} ~ '^[a-z][a-z0-9_]{0,79}$' and ${t.errorRetryable} is not null
    )`),
    check("offer_pdf_draft_artifact_ck", sql`(
      ${t.artifactMimeType} is null
      and ${t.artifactSha256} is null
      and ${t.artifactSizeBytes} is null
      and ${t.artifactBytes} is null
    ) or (
      ${t.artifactMimeType} = 'application/pdf'
      and octet_length(${t.artifactSha256}) = 32
      and ${t.artifactSizeBytes} between 100 and 8388608
      and octet_length(${t.artifactBytes}) = ${t.artifactSizeBytes}
      and ${t.artifactSha256} = pg_catalog.sha256(${t.artifactBytes})
    )`),
    check("offer_pdf_draft_shape_ck", sql`case ${t.state}
      when 'queued' then
        ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
        and ${t.finishedAt} is null and ${t.errorCode} is null
        and ${t.errorRetryable} is null and ${t.artifactBytes} is null
      when 'running' then
        ${t.leaseToken} is not null and ${t.leaseExpiresAt} is not null
        and ${t.startedAt} is not null and ${t.finishedAt} is null
        and ${t.errorCode} is null and ${t.errorRetryable} is null
        and ${t.artifactBytes} is null
      when 'retry_wait' then
        ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
        and ${t.startedAt} is not null and ${t.finishedAt} is null
        and ${t.errorCode} is not null and ${t.errorRetryable} = true
        and ${t.artifactBytes} is null
      when 'succeeded' then
        ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
        and ${t.startedAt} is not null and ${t.finishedAt} is not null
        and ${t.errorCode} is null and ${t.errorRetryable} is null
        and ${t.artifactBytes} is not null
      when 'failed_final' then
        ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
        and ${t.startedAt} is not null and ${t.finishedAt} is not null
        and ${t.errorCode} is not null and ${t.errorRetryable} = false
        and ${t.artifactBytes} is null
      else false end`),
  ],
);

export const offerVariantSection = pgTable(
  "offer_variant_section",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    revision: integer("revision").notNull(),
    sectionDomainId: uuid("section_domain_id").notNull(),
    position: integer("position").notNull(),
    category: text("category").notNull(),
    title: text("title").notNull(),
    discountBps: integer("discount_bps").notNull(),
    sectionSnapshot: jsonb("section_snapshot").$type<OfferSectionSnapshotV1>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_variant_section_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_variant_section_ws_revision_id_uq").on(t.workspaceId, t.revisionId, t.id),
    unique("offer_variant_section_ws_revision_domain_uq").on(
      t.workspaceId,
      t.revisionId,
      t.sectionDomainId,
    ),
    unique("offer_variant_section_ws_revision_position_uq").on(
      t.workspaceId,
      t.revisionId,
      t.position,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_variant_section_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.revisionId, t.offerId, t.variantId, t.projectId, t.revision],
      foreignColumns: [
        offerVariantRevision.workspaceId,
        offerVariantRevision.id,
        offerVariantRevision.offerId,
        offerVariantRevision.variantId,
        offerVariantRevision.projectId,
        offerVariantRevision.revision,
      ],
      name: "offer_variant_section_revision_fk",
    }),
    check("offer_variant_section_position_ck", sql`${t.position} between 1 and 25`),
    check("offer_variant_section_category_ck", sql`${t.category} in (
      'module', 'inverter', 'battery', 'wallbox', 'heat_pump', 'mounting', 'other'
    )`),
    check("offer_variant_section_title_ck", sql`length(btrim(${t.title})) between 1 and 120`),
    check("offer_variant_section_discount_ck", sql`${t.discountBps} between 0 and 10000`),
    check("offer_variant_section_json_ck", sql`jsonb_typeof(${t.sectionSnapshot}) = 'object'`),
  ],
);

export const offerBomLine = pgTable(
  "offer_bom_line",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    variantId: uuid("variant_id").notNull(),
    projectId: uuid("project_id").notNull(),
    revisionId: uuid("revision_id").notNull(),
    revision: integer("revision").notNull(),
    sectionId: uuid("section_id").notNull(),
    sectionDomainId: uuid("section_domain_id").notNull(),
    lineDomainId: uuid("line_domain_id").notNull(),
    position: integer("position").notNull(),
    componentCategory: text("component_category").notNull(),
    positionType: text("position_type").notNull(),
    isHidden: boolean("is_hidden").notNull(),
    quantityMilli: integer("quantity_milli").notNull(),
    unit: text("unit").notNull(),
    sourceKind: text("source_kind").notNull(),
    catalogComponentId: uuid("catalog_component_id"),
    catalogComponentRevision: integer("catalog_component_revision"),
    componentSnapshotSha256: bytea("component_snapshot_sha256"),
    originalSalesUnitNetCents: bigint("original_sales_unit_net_cents", { mode: "number" }).notNull(),
    effectiveSalesUnitNetCents: bigint("effective_sales_unit_net_cents", { mode: "number" }).notNull(),
    originalPurchaseUnitNetCents: bigint("original_purchase_unit_net_cents", { mode: "number" }).notNull(),
    effectivePurchaseUnitNetCents: bigint("effective_purchase_unit_net_cents", { mode: "number" }).notNull(),
    lineDiscountBps: integer("line_discount_bps").notNull(),
    taxTreatment: text("tax_treatment").notNull(),
    taxRateBps: integer("tax_rate_bps").notNull(),
    lineBaseNetCents: bigint("line_base_net_cents", { mode: "number" }).notNull(),
    lineDiscountedNetCents: bigint("line_discounted_net_cents", { mode: "number" }).notNull(),
    sectionDiscountedNetCents: bigint("section_discounted_net_cents", { mode: "number" }).notNull(),
    finalSalesNetCents: bigint("final_sales_net_cents", { mode: "number" }).notNull(),
    salesTaxCents: bigint("sales_tax_cents", { mode: "number" }).notNull(),
    salesGrossCents: bigint("sales_gross_cents", { mode: "number" }).notNull(),
    purchaseNetCents: bigint("purchase_net_cents", { mode: "number" }).notNull(),
    lineSnapshot: jsonb("line_snapshot").$type<OfferLineSnapshotV1>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_bom_line_ws_id_uq").on(t.workspaceId, t.id),
    unique("offer_bom_line_ws_revision_domain_uq").on(t.workspaceId, t.revisionId, t.lineDomainId),
    unique("offer_bom_line_ws_section_position_uq").on(t.workspaceId, t.revisionId, t.sectionId, t.position),
    index("offer_bom_line_ws_catalog_idx").on(
      t.workspaceId,
      t.catalogComponentId,
      t.catalogComponentRevision,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_bom_line_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.revisionId, t.offerId, t.variantId, t.projectId, t.revision],
      foreignColumns: [
        offerVariantRevision.workspaceId,
        offerVariantRevision.id,
        offerVariantRevision.offerId,
        offerVariantRevision.variantId,
        offerVariantRevision.projectId,
        offerVariantRevision.revision,
      ],
      name: "offer_bom_line_revision_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.revisionId, t.sectionId],
      foreignColumns: [
        offerVariantSection.workspaceId,
        offerVariantSection.revisionId,
        offerVariantSection.id,
      ],
      name: "offer_bom_line_section_fk",
    }),
    foreignKey({
      columns: [
        t.workspaceId,
        t.catalogComponentId,
        t.catalogComponentRevision,
        t.componentSnapshotSha256,
      ],
      foreignColumns: [
        catalogComponentRevision.workspaceId,
        catalogComponentRevision.componentId,
        catalogComponentRevision.revision,
        catalogComponentRevision.snapshotSha256,
      ],
      name: "offer_bom_line_catalog_revision_fk",
    }),
    check("offer_bom_line_position_ck", sql`${t.position} between 1 and 500`),
    check("offer_bom_line_category_ck", sql`${t.componentCategory} in (
      'module', 'inverter', 'battery', 'wallbox', 'heat_pump', 'mounting', 'other'
    )`),
    check("offer_bom_line_position_type_ck", sql`${t.positionType} in ('required', 'additional', 'optional')`),
    check("offer_bom_line_quantity_ck", sql`${t.quantityMilli} between 1 and 100000000
      and (${t.unit} = 'meter' or ${t.quantityMilli} % 1000 = 0)`),
    check("offer_bom_line_unit_ck", sql`${t.unit} in ('piece', 'set', 'meter')`),
    check("offer_bom_line_source_ck", sql`(
      ${t.sourceKind} = 'catalog'
      and ${t.catalogComponentId} is not null
      and ${t.catalogComponentRevision} is not null
      and octet_length(${t.componentSnapshotSha256}) = 32
    ) or (
      ${t.sourceKind} = 'custom'
      and ${t.catalogComponentId} is null
      and ${t.catalogComponentRevision} is null
      and ${t.componentSnapshotSha256} is null
    )`),
    check("offer_bom_line_discount_tax_ck", sql`${t.lineDiscountBps} between 0 and 10000
      and ((${t.taxTreatment} = 'standard_19' and ${t.taxRateBps} = 1900)
        or (${t.taxTreatment} = 'zero_operator_confirmed' and ${t.taxRateBps} = 0))`),
    check("offer_bom_line_money_ck", sql`${moneyCheck(t.originalSalesUnitNetCents)}
      and ${moneyCheck(t.effectiveSalesUnitNetCents)}
      and ${moneyCheck(t.originalPurchaseUnitNetCents)}
      and ${moneyCheck(t.effectivePurchaseUnitNetCents)}
      and ${moneyCheck(t.lineBaseNetCents)} and ${moneyCheck(t.lineDiscountedNetCents)}
      and ${moneyCheck(t.sectionDiscountedNetCents)} and ${moneyCheck(t.finalSalesNetCents)}
      and ${moneyCheck(t.salesTaxCents)} and ${moneyCheck(t.salesGrossCents)}
      and ${moneyCheck(t.purchaseNetCents)}
      and ${t.salesGrossCents} = ${t.finalSalesNetCents} + ${t.salesTaxCents}`),
    check("offer_bom_line_json_ck", sql`jsonb_typeof(${t.lineSnapshot}) = 'object'`),
  ],
);

export const offerMutationRateWindow = pgTable(
  "offer_mutation_rate_window",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    scope: text("scope").$type<"actor" | "workspace">().notNull(),
    actorId: uuid("actor_id"),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("offer_mutation_rate_window_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("offer_mutation_rate_window_actor_uq")
      .on(t.workspaceId, t.actorId, t.windowStart)
      .where(sql`${t.scope} = 'actor'`),
    uniqueIndex("offer_mutation_rate_window_workspace_uq")
      .on(t.workspaceId, t.windowStart)
      .where(sql`${t.scope} = 'workspace'`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "offer_mutation_rate_window_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "offer_mutation_rate_window_actor_fk",
    }).onDelete("cascade"),
    check("offer_mutation_rate_window_scope_ck", sql`(
      ${t.scope} = 'actor' and ${t.actorId} is not null and ${t.attempts} between 1 and 120
    ) or (
      ${t.scope} = 'workspace' and ${t.actorId} is null and ${t.attempts} between 1 and 1200
    )`),
    check("offer_mutation_rate_window_alignment_ck", sql`${t.windowStart} = date_bin(
      interval '15 minutes', ${t.windowStart}, timestamptz '1970-01-01 00:00:00+00'
    )`),
  ],
);
