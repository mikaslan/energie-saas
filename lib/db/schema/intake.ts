import { sql } from "drizzle-orm";
import {
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
} from "drizzle-orm/pg-core";
import type { RechnerCalculationSnapshotV1 } from "@/lib/integrations/rechner/types";
import { contact } from "./crm";
import { workspace } from "./core";
import { project } from "./project";
import { bytea } from "./types";

export type RechnerAcquisitionSnapshot = {
  channel: "website_calculator";
  source: "solarrechner";
  pagePath: string | null;
  referrerOrigin: string | null;
  utm: Record<"source" | "medium" | "campaign" | "term" | "content", string | null>;
};

export type RechnerProjectRequirementsV1 = {
  schemaVersion: "project-requirements.rechner.v1";
  source: "wmee-rechner-v3";
  branch: "new_installation" | "existing_installation";
  requestedProducts: {
    targetStorageKwh: number;
    wallbox: boolean;
    bidirectionalCharging: boolean;
    backupPower: boolean;
  };
};

export const inboundReceipt = pgTable(
  "inbound_receipt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceKey: text("source_key").notNull(),
    submissionId: uuid("submission_id").notNull(),
    contractVersion: text("contract_version").notNull(),
    bodySha256: bytea("body_sha256").notNull(),
    authKeyId: text("auth_key_id").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    producerApplication: text("producer_application").notNull(),
    producerGitRevision: text("producer_git_revision").notNull(),
    producerEnvironment: text("producer_environment").notNull(),
    producerDeploymentId: text("producer_deployment_id"),
    calculatorEngine: text("calculator_engine").notNull(),
    acquisition: jsonb("acquisition").$type<RechnerAcquisitionSnapshot>().notNull(),
    privacyPurpose: text("privacy_purpose").notNull(),
    privacyLegalBasis: text("privacy_legal_basis").notNull(),
    privacyNoticeVersion: text("privacy_notice_version").notNull(),
    privacyNoticeUrl: text("privacy_notice_url").notNull(),
    contactResolution: text("contact_resolution").notNull(),
    contactId: uuid("contact_id").notNull(),
    emailMatchContactId: uuid("email_match_contact_id"),
    phoneMatchContactId: uuid("phone_match_contact_id"),
    siteId: uuid("site_id").notNull(),
    projectId: uuid("project_id").notNull(),
  },
  (t) => [
    index("inbound_receipt_ws_received_idx").on(t.workspaceId, t.authKeyId, t.receivedAt),
    unique("inbound_receipt_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("inbound_receipt_ws_source_submission_uq").on(
      t.workspaceId,
      t.sourceKey,
      t.submissionId,
    ),
    uniqueIndex("inbound_receipt_ws_project_uq").on(t.workspaceId, t.projectId),
    unique("inbound_receipt_ws_id_project_uq").on(t.workspaceId, t.id, t.projectId),
    unique("inbound_receipt_ws_exact_source_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
      t.bodySha256,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "inbound_receipt_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId, t.contactId, t.siteId],
      foreignColumns: [project.workspaceId, project.id, project.contactId, project.siteId],
      name: "inbound_receipt_project_graph_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.emailMatchContactId],
      foreignColumns: [contact.workspaceId, contact.id],
      name: "inbound_receipt_email_match_contact_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.phoneMatchContactId],
      foreignColumns: [contact.workspaceId, contact.id],
      name: "inbound_receipt_phone_match_contact_fk",
    }),
    check("inbound_receipt_source_ck", sql`${t.sourceKey} = 'wmee-rechner-v3'`),
    check("inbound_receipt_contract_ck", sql`${t.contractVersion} = 'rechner-intake.v1'`),
    check("inbound_receipt_hash_ck", sql`octet_length(${t.bodySha256}) = 32`),
    check(
      "inbound_receipt_auth_key_ck",
      sql`${t.authKeyId} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`,
    ),
    check(
      "inbound_receipt_producer_ck",
      sql`${t.producerApplication} = 'wmee-rechner-v3'
        and ${t.producerGitRevision} ~ '^[0-9a-f]{40}$'
        and ${t.producerEnvironment} in ('production', 'preview', 'development')
        and ${t.calculatorEngine} = 'wmee-solar.v1'`,
    ),
    check(
      "inbound_receipt_privacy_ck",
      sql`${t.privacyPurpose} = 'offer_request'
        and ${t.privacyLegalBasis} = 'art_6_1_b_precontractual'
        and length(btrim(${t.privacyNoticeVersion})) between 1 and 100
        and ${t.privacyNoticeUrl} like 'https://%'`,
    ),
    check(
      "inbound_receipt_contact_resolution_ck",
      sql`${t.contactResolution} in ('created', 'email_match', 'phone_match', 'review_created')`,
    ),
    check("inbound_receipt_acquisition_ck", sql`jsonb_typeof(${t.acquisition}) = 'object'`),
  ],
);

export const calculatorSnapshot = pgTable(
  "calculator_snapshot",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    receiptId: uuid("receipt_id").notNull(),
    projectId: uuid("project_id").notNull(),
    schemaVersion: text("schema_version").notNull(),
    calculatorEngine: text("calculator_engine").notNull(),
    resultIntegrity: text("result_integrity").notNull(),
    investmentSource: text("investment_source").notNull(),
    calculatedAt: timestamp("calculated_at", { withTimezone: true }).notNull(),
    snapshot: jsonb("snapshot").$type<RechnerCalculationSnapshotV1>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("calculator_snapshot_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("calculator_snapshot_ws_receipt_uq").on(t.workspaceId, t.receiptId),
    uniqueIndex("calculator_snapshot_ws_project_uq").on(t.workspaceId, t.projectId),
    unique("calculator_snapshot_ws_id_project_uq").on(t.workspaceId, t.id, t.projectId),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "calculator_snapshot_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.receiptId, t.projectId],
      foreignColumns: [inboundReceipt.workspaceId, inboundReceipt.id, inboundReceipt.projectId],
      name: "calculator_snapshot_receipt_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "calculator_snapshot_project_fk",
    }),
    check(
      "calculator_snapshot_schema_ck",
      sql`${t.schemaVersion} = 'wmee-solar-snapshot.v1'
        and ${t.calculatorEngine} = 'wmee-solar.v1'
        and ${t.resultIntegrity} = 'client_reported_unverified'`,
    ),
    check(
      "calculator_snapshot_investment_ck",
      sql`${t.investmentSource} = 'market_estimate'`,
    ),
    check(
      "calculator_snapshot_json_ck",
      sql`(
        jsonb_typeof(${t.snapshot}) = 'object'
        and (${t.snapshot} - array[
          'schemaVersion', 'calculatedAt', 'branch', 'questionnaireVariant',
          'resultIntegrity', 'inputs', 'provenance', 'result'
        ]::text[]) = '{}'::jsonb
        and ${t.snapshot}->>'schemaVersion' = ${t.schemaVersion}
        and ${t.snapshot}->>'resultIntegrity' = ${t.resultIntegrity}
        and ${t.snapshot}->>'branch' in ('new_installation', 'existing_installation')
        and jsonb_typeof(${t.snapshot}->'inputs') = 'object'
        and jsonb_typeof(${t.snapshot}->'provenance') = 'object'
        and ${t.snapshot}#>>'{provenance,investment}' = ${t.investmentSource}
        and jsonb_typeof(${t.snapshot}->'result') = 'object'
        and (
          (${t.snapshot}->>'branch' = 'new_installation'
            and ${t.snapshot}#>>'{result,mode}' = 'new_installation')
          or
          (${t.snapshot}->>'branch' = 'existing_installation'
            and ${t.snapshot}#>>'{result,mode}' = 'existing_installation')
        )
      ) is true`,
    ),
  ],
);

export const projectRequirement = pgTable(
  "project_requirement",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    revision: integer("revision").notNull(),
    schemaVersion: text("schema_version").notNull(),
    sourceSnapshotId: uuid("source_snapshot_id").notNull(),
    requirements: jsonb("requirements").$type<RechnerProjectRequirementsV1>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_requirement_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_requirement_ws_id_project_revision_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
      t.revision,
    ),
    uniqueIndex("project_requirement_ws_project_revision_uq").on(
      t.workspaceId,
      t.projectId,
      t.revision,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_requirement_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "project_requirement_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.sourceSnapshotId, t.projectId],
      foreignColumns: [calculatorSnapshot.workspaceId, calculatorSnapshot.id, calculatorSnapshot.projectId],
      name: "project_requirement_snapshot_project_fk",
    }),
    check("project_requirement_revision_ck", sql`${t.revision} > 0`),
    check(
      "project_requirement_schema_ck",
      sql`${t.schemaVersion} = 'project-requirements.rechner.v1'`,
    ),
    check(
      "project_requirement_json_ck",
      sql`(
        jsonb_typeof(${t.requirements}) = 'object'
        and (${t.requirements} - array[
          'schemaVersion', 'source', 'branch', 'requestedProducts'
        ]::text[]) = '{}'::jsonb
        and ${t.requirements}->>'schemaVersion' = ${t.schemaVersion}
        and ${t.requirements}->>'source' = 'wmee-rechner-v3'
        and ${t.requirements}->>'branch' in ('new_installation', 'existing_installation')
        and jsonb_typeof(${t.requirements}->'requestedProducts') = 'object'
        and ((${t.requirements}->'requestedProducts') - array[
          'targetStorageKwh', 'wallbox', 'bidirectionalCharging', 'backupPower'
        ]::text[]) = '{}'::jsonb
        and jsonb_typeof(${t.requirements}#>'{requestedProducts,targetStorageKwh}') = 'number'
        and jsonb_typeof(${t.requirements}#>'{requestedProducts,wallbox}') = 'boolean'
        and jsonb_typeof(${t.requirements}#>'{requestedProducts,bidirectionalCharging}') = 'boolean'
        and jsonb_typeof(${t.requirements}#>'{requestedProducts,backupPower}') = 'boolean'
      ) is true`,
    ),
  ],
);
