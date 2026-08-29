import { sql } from "drizzle-orm";
import {
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
} from "drizzle-orm/pg-core";
import type {
  PlanningCalculationRequestV1,
  PlanningCalculationResultV1,
  SiteEnergyProfileV1,
} from "@/lib/integrations/calculation/contract";
import type { ProjectCalculationPreparationV1 } from
  "@/lib/integrations/calculation/preparation";
import { membership, workspace } from "./core";
import { calculatorSnapshot, projectRequirement } from "./intake";
import { project } from "./project";
import { site } from "./site";
import { bytea } from "./types";

export const energyProfileSourceKinds = ["rechner_snapshot", "manual"] as const;
export const projectCalculationJobStates = [
  "queued",
  "running",
  "retry_wait",
  "succeeded",
  "failed_final",
] as const;

export type EnergyProfileSourceKind = (typeof energyProfileSourceKinds)[number];
export type ProjectCalculationJobState = (typeof projectCalculationJobStates)[number];
export type PlanningProviderSnapshotV1 =
  | PlanningCalculationRequestV1["yieldSnapshots"]
  | Record<string, unknown>;

export const siteEnergyProfile = pgTable(
  "site_energy_profile",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    siteId: uuid("site_id").notNull(),
    revision: integer("revision").notNull().default(1),
    schemaVersion: text("schema_version").notNull(),
    inputMode: text("input_mode").notNull(),
    sourceKind: text("source_kind").$type<EnergyProfileSourceKind>().notNull(),
    sourceSnapshotId: uuid("source_snapshot_id"),
    sourceProjectId: uuid("source_project_id"),
    addressRevision: integer("address_revision").notNull(),
    profile: jsonb("profile").$type<SiteEnergyProfileV1>().notNull(),
    profileSha256: bytea("profile_sha256").notNull(),
    confirmedProfileRevision: integer("confirmed_profile_revision"),
    confirmedAddressRevision: integer("confirmed_address_revision"),
    confirmedBy: uuid("confirmed_by"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("site_energy_profile_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("site_energy_profile_ws_site_uq").on(t.workspaceId, t.siteId),
    unique("site_energy_profile_ws_id_site_uq").on(t.workspaceId, t.id, t.siteId),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "site_energy_profile_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.siteId],
      foreignColumns: [site.workspaceId, site.id],
      name: "site_energy_profile_site_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.sourceProjectId, t.siteId],
      foreignColumns: [project.workspaceId, project.id, project.siteId],
      name: "site_energy_profile_source_project_site_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.sourceSnapshotId, t.sourceProjectId],
      foreignColumns: [
        calculatorSnapshot.workspaceId,
        calculatorSnapshot.id,
        calculatorSnapshot.projectId,
      ],
      name: "site_energy_profile_source_snapshot_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.confirmedBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "site_energy_profile_confirmed_by_fk",
    }),
    check("site_energy_profile_revision_ck", sql`${t.revision} > 0`),
    check("site_energy_profile_address_revision_ck", sql`${t.addressRevision} > 0`),
    check(
      "site_energy_profile_contract_ck",
      sql`${t.schemaVersion} = 'site-energy-profile.v1' and ${t.inputMode} = 'consumption'`,
    ),
    check(
      "site_energy_profile_source_ck",
      sql`(
        (${t.sourceKind} = 'manual'
          and ${t.sourceSnapshotId} is null
          and ${t.sourceProjectId} is null)
        or
        (${t.sourceKind} = 'rechner_snapshot'
          and ${t.sourceSnapshotId} is not null
          and ${t.sourceProjectId} is not null)
      ) is true`,
    ),
    check("site_energy_profile_hash_ck", sql`octet_length(${t.profileSha256}) = 32`),
    check(
      "site_energy_profile_json_ck",
      sql`(
        jsonb_typeof(${t.profile}) = 'object'
        and (${t.profile} - array[
          'schemaVersion', 'inputMode', 'building', 'roofs', 'consumption',
          'existingAssets', 'provenance'
        ]::text[]) = '{}'::jsonb
        and ${t.profile}->>'schemaVersion' = ${t.schemaVersion}
        and ${t.profile}->>'inputMode' = ${t.inputMode}
        and jsonb_typeof(${t.profile}->'building') = 'object'
        and jsonb_typeof(${t.profile}->'roofs') = 'array'
        and jsonb_array_length(${t.profile}->'roofs') between 1 and 4
        and jsonb_typeof(${t.profile}->'consumption') = 'object'
        and jsonb_typeof(${t.profile}->'existingAssets') = 'object'
        and jsonb_typeof(${t.profile}->'provenance') = 'object'
      ) is true`,
    ),
    check(
      "site_energy_profile_confirmation_ck",
      sql`(
        (${t.confirmedProfileRevision} is null
          and ${t.confirmedAddressRevision} is null
          and ${t.confirmedBy} is null
          and ${t.confirmedAt} is null)
        or
        (${t.confirmedProfileRevision} = ${t.revision}
          and ${t.confirmedAddressRevision} = ${t.addressRevision}
          and ${t.confirmedBy} is not null
          and ${t.confirmedAt} is not null)
      ) is true`,
    ),
  ],
);

export const projectCalculationJob = pgTable(
  "project_calculation_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    siteId: uuid("site_id").notNull(),
    addressRevision: integer("address_revision").notNull(),
    pinConfirmedAddressRevision: integer("pin_confirmed_address_revision").notNull(),
    profileId: uuid("profile_id").notNull(),
    profileRevision: integer("profile_revision").notNull(),
    confirmedProfileRevision: integer("confirmed_profile_revision").notNull(),
    confirmedAddressRevision: integer("confirmed_address_revision").notNull(),
    requirementId: uuid("requirement_id").notNull(),
    requirementRevision: integer("requirement_revision").notNull(),
    sourceSnapshotId: uuid("source_snapshot_id"),
    reservationKey: bytea("reservation_key").notNull(),
    providerRecipeVersion: text("provider_recipe_version").notNull(),
    contractVersion: text("contract_version").notNull(),
    modelId: text("model_id").notNull(),
    modelVersion: text("model_version").notNull(),
    sourceRevision: text("source_revision").notNull(),
    defaultsVersion: text("defaults_version").notNull(),
    preparationSnapshot: jsonb("preparation_snapshot")
      .$type<ProjectCalculationPreparationV1>(),
    preparationSha256: bytea("preparation_sha256"),
    state: text("state").$type<ProjectCalculationJobState>().notNull().default("queued"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    inputSha256: bytea("input_sha256"),
    inputSnapshot: jsonb("input_snapshot").$type<PlanningCalculationRequestV1>(),
    providerSnapshot: jsonb("provider_snapshot").$type<PlanningProviderSnapshotV1>(),
    errorCode: text("error_code"),
    errorRetryable: boolean("error_retryable"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    resultRevisionId: uuid("result_revision_id"),
  },
  (t) => [
    uniqueIndex("project_calculation_job_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_calculation_job_ws_id_project_site_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
      t.siteId,
    ),
    uniqueIndex("project_calculation_job_ws_project_reservation_uq").on(
      t.workspaceId,
      t.projectId,
      t.reservationKey,
    ),
    uniqueIndex("project_calculation_job_ws_project_active_uq")
      .on(t.workspaceId, t.projectId)
      .where(sql`${t.state} in ('queued', 'running', 'retry_wait')`),
    index("project_calculation_job_due_idx").on(
      t.workspaceId,
      t.state,
      t.nextAttemptAt,
      t.createdAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_calculation_job_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId, t.siteId],
      foreignColumns: [project.workspaceId, project.id, project.siteId],
      name: "project_calculation_job_project_site_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.profileId, t.siteId],
      foreignColumns: [siteEnergyProfile.workspaceId, siteEnergyProfile.id, siteEnergyProfile.siteId],
      name: "project_calculation_job_profile_site_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.requirementId, t.projectId, t.requirementRevision],
      foreignColumns: [
        projectRequirement.workspaceId,
        projectRequirement.id,
        projectRequirement.projectId,
        projectRequirement.revision,
      ],
      name: "project_calculation_job_requirement_project_revision_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.sourceSnapshotId, t.projectId],
      foreignColumns: [
        calculatorSnapshot.workspaceId,
        calculatorSnapshot.id,
        calculatorSnapshot.projectId,
      ],
      name: "project_calculation_job_source_snapshot_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "project_calculation_job_created_by_fk",
    }),
    check(
      "project_calculation_job_binding_revision_ck",
      sql`${t.addressRevision} > 0
        and ${t.addressRevision} = ${t.pinConfirmedAddressRevision}
        and ${t.addressRevision} = ${t.confirmedAddressRevision}
        and ${t.profileRevision} > 0
        and ${t.profileRevision} = ${t.confirmedProfileRevision}
        and ${t.requirementRevision} > 0`,
    ),
    check("project_calculation_job_reservation_hash_ck", sql`octet_length(${t.reservationKey}) = 32`),
    check(
      "project_calculation_job_preparation_ck",
      sql`(
        (${t.preparationSnapshot} is null and ${t.preparationSha256} is null)
        or (
          jsonb_typeof(${t.preparationSnapshot}) = 'object'
          and ${t.preparationSnapshot}->>'schemaVersion'
            = 'project-calculation-preparation.v1'
          and octet_length(${t.preparationSha256}) = 32
        )
      ) is true`,
    ),
    check(
      "project_calculation_job_versions_ck",
      sql`${t.contractVersion} = 'planning-calculation.v1'
        and length(btrim(${t.providerRecipeVersion})) between 1 and 100
        and ${t.modelId} = 'wmee-solar'
        and ${t.modelVersion} ~ '^[0-9]+\\.[0-9]+\\.[0-9]+([+-][a-z0-9.-]+)?$'
        and ${t.sourceRevision} ~ '^[0-9a-f]{40}$'
        and ${t.defaultsVersion} = 'wmee-planning-defaults.v1'`,
    ),
    check(
      "project_calculation_job_state_ck",
      sql`${t.state} in ('queued', 'running', 'retry_wait', 'succeeded', 'failed_final')`,
    ),
    check(
      "project_calculation_job_attempt_ck",
      sql`${t.attemptCount} between 0 and 10`,
    ),
    check(
      "project_calculation_job_input_ck",
      sql`(
        (${t.inputSha256} is null
          and ${t.inputSnapshot} is null
          and ${t.providerSnapshot} is null)
        or
        (octet_length(${t.inputSha256}) = 32
          and jsonb_typeof(${t.inputSnapshot}) = 'object'
          and jsonb_typeof(${t.providerSnapshot}) in ('object', 'array'))
      ) is true`,
    ),
    check(
      "project_calculation_job_error_ck",
      sql`(${t.errorCode} is null and ${t.errorRetryable} is null)
        or (${t.errorCode} ~ '^[a-z][a-z0-9_]{0,79}$' and ${t.errorRetryable} is not null)`,
    ),
    check(
      "project_calculation_job_shape_ck",
      sql`case ${t.state}
        when 'queued' then
          ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
          and ${t.finishedAt} is null and ${t.resultRevisionId} is null
          and ${t.errorCode} is null and ${t.errorRetryable} is null
        when 'running' then
          ${t.leaseToken} is not null and ${t.leaseExpiresAt} is not null
          and ${t.startedAt} is not null and ${t.finishedAt} is null
          and ${t.resultRevisionId} is null
          and ${t.errorCode} is null and ${t.errorRetryable} is null
        when 'retry_wait' then
          ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
          and ${t.startedAt} is not null and ${t.finishedAt} is null
          and ${t.resultRevisionId} is null
          and ${t.errorCode} is not null and ${t.errorRetryable} = true
        when 'succeeded' then
          ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
          and ${t.startedAt} is not null and ${t.finishedAt} is not null
          and ${t.resultRevisionId} is not null
          and ${t.inputSha256} is not null
          and ${t.errorCode} is null and ${t.errorRetryable} is null
        when 'failed_final' then
          ${t.leaseToken} is null and ${t.leaseExpiresAt} is null
          and ${t.startedAt} is not null and ${t.finishedAt} is not null
          and ${t.resultRevisionId} is null
          and ${t.errorCode} is not null and ${t.errorRetryable} = false
        else false
      end`,
    ),
  ],
);

export const projectCalculationRevision = pgTable(
  "project_calculation_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    siteId: uuid("site_id").notNull(),
    revision: integer("revision").notNull(),
    jobId: uuid("job_id").notNull(),
    addressRevision: integer("address_revision").notNull(),
    pinConfirmedAddressRevision: integer("pin_confirmed_address_revision").notNull(),
    profileId: uuid("profile_id").notNull(),
    profileRevision: integer("profile_revision").notNull(),
    confirmedProfileRevision: integer("confirmed_profile_revision").notNull(),
    confirmedAddressRevision: integer("confirmed_address_revision").notNull(),
    requirementId: uuid("requirement_id").notNull(),
    requirementRevision: integer("requirement_revision").notNull(),
    sourceSnapshotId: uuid("source_snapshot_id"),
    contractVersion: text("contract_version").notNull(),
    modelId: text("model_id").notNull(),
    modelVersion: text("model_version").notNull(),
    sourceRevision: text("source_revision").notNull(),
    defaultsVersion: text("defaults_version").notNull(),
    quality: text("quality").notNull(),
    validationStatus: text("validation_status").notNull(),
    inputSha256: bytea("input_sha256").notNull(),
    resultSha256: bytea("result_sha256").notNull(),
    inputSnapshot: jsonb("input_snapshot").$type<PlanningCalculationRequestV1>().notNull(),
    providerSnapshot: jsonb("provider_snapshot").$type<PlanningProviderSnapshotV1>().notNull(),
    result: jsonb("result").$type<PlanningCalculationResultV1>().notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_calculation_revision_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_calculation_revision_ws_id_project_site_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
      t.siteId,
    ),
    unique("project_calculation_revision_ws_id_project_site_revision_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
      t.siteId,
      t.revision,
    ),
    uniqueIndex("project_calculation_revision_ws_project_revision_uq").on(
      t.workspaceId,
      t.projectId,
      t.revision,
    ),
    uniqueIndex("project_calculation_revision_ws_job_uq").on(t.workspaceId, t.jobId),
    uniqueIndex("project_calculation_revision_ws_project_input_engine_uq").on(
      t.workspaceId,
      t.projectId,
      t.inputSha256,
      t.modelId,
      t.modelVersion,
      t.sourceRevision,
      t.defaultsVersion,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_calculation_revision_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId, t.siteId],
      foreignColumns: [project.workspaceId, project.id, project.siteId],
      name: "project_calculation_revision_project_site_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.profileId, t.siteId],
      foreignColumns: [siteEnergyProfile.workspaceId, siteEnergyProfile.id, siteEnergyProfile.siteId],
      name: "project_calculation_revision_profile_site_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.requirementId, t.projectId, t.requirementRevision],
      foreignColumns: [
        projectRequirement.workspaceId,
        projectRequirement.id,
        projectRequirement.projectId,
        projectRequirement.revision,
      ],
      name: "project_calculation_revision_requirement_project_revision_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.sourceSnapshotId, t.projectId],
      foreignColumns: [
        calculatorSnapshot.workspaceId,
        calculatorSnapshot.id,
        calculatorSnapshot.projectId,
      ],
      name: "project_calculation_revision_source_snapshot_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "project_calculation_revision_created_by_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.jobId, t.projectId, t.siteId],
      foreignColumns: [
        projectCalculationJob.workspaceId,
        projectCalculationJob.id,
        projectCalculationJob.projectId,
        projectCalculationJob.siteId,
      ],
      name: "project_calculation_revision_job_project_site_fk",
    }),
    check("project_calculation_revision_revision_ck", sql`${t.revision} > 0`),
    check(
      "project_calculation_revision_binding_revision_ck",
      sql`${t.addressRevision} > 0
        and ${t.addressRevision} = ${t.pinConfirmedAddressRevision}
        and ${t.addressRevision} = ${t.confirmedAddressRevision}
        and ${t.profileRevision} > 0
        and ${t.profileRevision} = ${t.confirmedProfileRevision}
        and ${t.requirementRevision} > 0`,
    ),
    check(
      "project_calculation_revision_versions_ck",
      sql`${t.contractVersion} = 'planning-calculation.v1'
        and ${t.modelId} = 'wmee-solar'
        and ${t.modelVersion} ~ '^[0-9]+\\.[0-9]+\\.[0-9]+([+-][a-z0-9.-]+)?$'
        and ${t.sourceRevision} ~ '^[0-9a-f]{40}$'
        and ${t.defaultsVersion} = 'wmee-planning-defaults.v1'
        and ${t.quality} = 'server_reproduced_estimate'
        and ${t.validationStatus} = 'not_f4_reference_validated'`,
    ),
    check(
      "project_calculation_revision_hash_ck",
      sql`octet_length(${t.inputSha256}) = 32 and octet_length(${t.resultSha256}) = 32`,
    ),
    check(
      "project_calculation_revision_json_ck",
      sql`jsonb_typeof(${t.inputSnapshot}) = 'object'
        and jsonb_typeof(${t.providerSnapshot}) in ('object', 'array')
        and jsonb_typeof(${t.result}) = 'object'
        and ${t.result}->>'contractVersion' = ${t.contractVersion}
        and ${t.result}->>'inputSha256' = encode(${t.inputSha256}, 'hex')
        and ${t.result}->>'resultSha256' = encode(${t.resultSha256}, 'hex')
        and ${t.result}->>'quality' = ${t.quality}
        and ${t.result}->>'validationStatus' = ${t.validationStatus}
        and ${t.result}#>>'{model,id}' = ${t.modelId}
        and ${t.result}#>>'{model,version}' = ${t.modelVersion}
        and ${t.result}#>>'{model,sourceRevision}' = ${t.sourceRevision}`,
    ),
  ],
);
