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
import type {
  CatalogComponentRevisionV1,
  CatalogComponentType,
  ProjectCatalogResolutionV1,
} from "@/lib/integrations/catalog/contract";
import { membership, workspace } from "./core";
import { projectCalculationRevision } from "./energy";
import { projectRequirement } from "./intake";
import { project } from "./project";
import { bytea } from "./types";

export const catalogComponentStatuses = ["draft", "active", "archived"] as const;
export type CatalogComponentStatus = (typeof catalogComponentStatuses)[number];

export const catalogComponent = pgTable(
  "catalog_component",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    internalSku: text("internal_sku").notNull(),
    componentType: text("component_type").$type<CatalogComponentType>().notNull(),
    status: text("status").$type<CatalogComponentStatus>().notNull().default("draft"),
    currentRevision: integer("current_revision").notNull().default(0),
    nominalPowerWatts: integer("nominal_power_watts"),
    usableCapacityWh: integer("usable_capacity_wh"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("catalog_component_ws_id_uq").on(t.workspaceId, t.id),
    unique("catalog_component_ws_id_type_uq").on(
      t.workspaceId,
      t.id,
      t.componentType,
    ),
    uniqueIndex("catalog_component_ws_sku_ci_uq").on(
      t.workspaceId,
      sql`lower(${t.internalSku})`,
    ),
    index("catalog_component_ws_list_idx").on(
      t.workspaceId,
      t.status,
      t.componentType,
      t.internalSku,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "catalog_component_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "catalog_component_created_by_fk",
    }),
    check(
      "catalog_component_sku_ck",
      sql`${t.internalSku} ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'`,
    ),
    check(
      "catalog_component_type_ck",
      sql`${t.componentType} in (
        'module', 'inverter', 'battery', 'wallbox',
        'heat_pump', 'mounting', 'other'
      )`,
    ),
    check(
      "catalog_component_status_ck",
      sql`${t.status} in ('draft', 'active', 'archived')`,
    ),
    check("catalog_component_revision_ck", sql`${t.currentRevision} >= 0`),
    check(
      "catalog_component_projection_ck",
      sql`(${t.nominalPowerWatts} is null or ${t.nominalPowerWatts} > 0)
        and (${t.usableCapacityWh} is null or ${t.usableCapacityWh} > 0)`,
    ),
    check(
      "catalog_component_archive_ck",
      sql`(${t.status} = 'archived') = (${t.archivedAt} is not null)`,
    ),
  ],
);

export const catalogComponentRevision = pgTable(
  "catalog_component_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    componentId: uuid("component_id").notNull(),
    revision: integer("revision").notNull(),
    componentType: text("component_type").$type<CatalogComponentType>().notNull(),
    schemaVersion: text("schema_version").notNull(),
    canonicalizationVersion: text("canonicalization_version").notNull(),
    revisionSnapshot: jsonb("revision_snapshot").$type<CatalogComponentRevisionV1>().notNull(),
    snapshotSha256: bytea("snapshot_sha256").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("catalog_component_revision_ws_id_uq").on(t.workspaceId, t.id),
    unique("catalog_component_revision_ws_component_revision_uq").on(
      t.workspaceId,
      t.componentId,
      t.revision,
    ),
    unique("catalog_component_revision_ws_component_revision_hash_uq").on(
      t.workspaceId,
      t.componentId,
      t.revision,
      t.snapshotSha256,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "catalog_component_revision_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.componentId, t.componentType],
      foreignColumns: [
        catalogComponent.workspaceId,
        catalogComponent.id,
        catalogComponent.componentType,
      ],
      name: "catalog_component_revision_component_type_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "catalog_component_revision_created_by_fk",
    }),
    check("catalog_component_revision_revision_ck", sql`${t.revision} > 0`),
    check(
      "catalog_component_revision_version_ck",
      sql`${t.schemaVersion} = 'catalog-component-revision.v1'
        and ${t.canonicalizationVersion} = 'catalog-jcs.v1'`,
    ),
    check(
      "catalog_component_revision_hash_ck",
      sql`octet_length(${t.snapshotSha256}) = 32`,
    ),
    check(
      "catalog_component_revision_json_ck",
      sql`jsonb_typeof(${t.revisionSnapshot}) = 'object'
        and (${t.revisionSnapshot} - array[
          'schemaVersion', 'canonicalizationVersion', 'identity',
          'presentation', 'technicalData', 'commercial',
          'technicalProvenance', 'snapshotSha256'
        ]::text[]) = '{}'::jsonb
        and ${t.revisionSnapshot}->>'schemaVersion' = ${t.schemaVersion}
        and ${t.revisionSnapshot}->>'canonicalizationVersion' = ${t.canonicalizationVersion}
        and ${t.revisionSnapshot}#>>'{identity,workspaceId}' = ${t.workspaceId}::text
        and ${t.revisionSnapshot}#>>'{identity,componentId}' = ${t.componentId}::text
        and (${t.revisionSnapshot}#>>'{identity,revision}')::integer = ${t.revision}
        and ${t.revisionSnapshot}#>>'{identity,componentType}' = ${t.componentType}
        and ${t.revisionSnapshot}->>'snapshotSha256' = encode(${t.snapshotSha256}, 'hex')`,
    ),
  ],
);

export const projectCatalogResolution = pgTable(
  "project_catalog_resolution",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    siteId: uuid("site_id").notNull(),
    revision: integer("revision").notNull(),
    requirementId: uuid("requirement_id").notNull(),
    requirementRevision: integer("requirement_revision").notNull(),
    calculationRevisionId: uuid("calculation_revision_id").notNull(),
    calculationRevision: integer("calculation_revision").notNull(),
    calculationInputSha256: bytea("calculation_input_sha256").notNull(),
    calculationResultSha256: bytea("calculation_result_sha256").notNull(),
    calculationQuality: text("calculation_quality").notNull(),
    calculationValidationStatus: text("calculation_validation_status").notNull(),
    schemaVersion: text("schema_version").notNull(),
    canonicalizationVersion: text("canonicalization_version").notNull(),
    resolutionSnapshot: jsonb("resolution_snapshot").$type<ProjectCatalogResolutionV1>().notNull(),
    resolutionSha256: bytea("resolution_sha256").notNull(),
    confirmedBy: uuid("confirmed_by").notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_catalog_resolution_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_catalog_resolution_ws_exact_source_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
      t.revision,
      t.resolutionSha256,
    ),
    unique("project_catalog_resolution_ws_id_project_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
    ),
    uniqueIndex("project_catalog_resolution_ws_project_revision_uq").on(
      t.workspaceId,
      t.projectId,
      t.revision,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_catalog_resolution_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId, t.siteId],
      foreignColumns: [project.workspaceId, project.id, project.siteId],
      name: "project_catalog_resolution_project_site_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.requirementId, t.projectId, t.requirementRevision],
      foreignColumns: [
        projectRequirement.workspaceId,
        projectRequirement.id,
        projectRequirement.projectId,
        projectRequirement.revision,
      ],
      name: "project_catalog_resolution_requirement_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [
        t.workspaceId,
        t.calculationRevisionId,
        t.projectId,
        t.siteId,
        t.calculationRevision,
      ],
      foreignColumns: [
        projectCalculationRevision.workspaceId,
        projectCalculationRevision.id,
        projectCalculationRevision.projectId,
        projectCalculationRevision.siteId,
        projectCalculationRevision.revision,
      ],
      name: "project_catalog_resolution_calculation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.confirmedBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "project_catalog_resolution_confirmed_by_fk",
    }),
    check("project_catalog_resolution_revision_ck", sql`${t.revision} > 0`),
    check(
      "project_catalog_resolution_binding_revision_ck",
      sql`${t.requirementRevision} > 0 and ${t.calculationRevision} > 0`,
    ),
    check(
      "project_catalog_resolution_version_ck",
      sql`${t.schemaVersion} = 'project-catalog-resolution.v1'
        and ${t.canonicalizationVersion} = 'catalog-jcs.v1'
        and ${t.calculationQuality} = 'server_reproduced_estimate'
        and ${t.calculationValidationStatus} = 'not_f4_reference_validated'`,
    ),
    check(
      "project_catalog_resolution_hash_ck",
      sql`octet_length(${t.calculationInputSha256}) = 32
        and octet_length(${t.calculationResultSha256}) = 32
        and octet_length(${t.resolutionSha256}) = 32`,
    ),
    check(
      "project_catalog_resolution_json_ck",
      sql`jsonb_typeof(${t.resolutionSnapshot}) = 'object'
        and (${t.resolutionSnapshot} - array[
          'schemaVersion', 'canonicalizationVersion', 'revision', 'bindings',
          'lines', 'requested', 'acknowledgements', 'coverage', 'totals',
          'warnings', 'confirmedBy', 'confirmedAt', 'resolutionSha256'
        ]::text[]) = '{}'::jsonb
        and ${t.resolutionSnapshot}->>'schemaVersion' = ${t.schemaVersion}
        and ${t.resolutionSnapshot}->>'canonicalizationVersion' = ${t.canonicalizationVersion}
        and (${t.resolutionSnapshot}->>'revision')::integer = ${t.revision}
        and ${t.resolutionSnapshot}#>>'{bindings,workspaceId}' = ${t.workspaceId}::text
        and ${t.resolutionSnapshot}#>>'{bindings,projectId}' = ${t.projectId}::text
        and ${t.resolutionSnapshot}#>>'{bindings,siteId}' = ${t.siteId}::text
        and ${t.resolutionSnapshot}#>>'{bindings,requirementId}' = ${t.requirementId}::text
        and (${t.resolutionSnapshot}#>>'{bindings,requirementRevision}')::integer
          = ${t.requirementRevision}
        and ${t.resolutionSnapshot}#>>'{bindings,calculationRevisionId}'
          = ${t.calculationRevisionId}::text
        and (${t.resolutionSnapshot}#>>'{bindings,calculationRevision}')::integer
          = ${t.calculationRevision}
        and ${t.resolutionSnapshot}#>>'{bindings,calculationInputSha256}'
          = encode(${t.calculationInputSha256}, 'hex')
        and ${t.resolutionSnapshot}#>>'{bindings,calculationResultSha256}'
          = encode(${t.calculationResultSha256}, 'hex')
        and ${t.resolutionSnapshot}#>>'{bindings,calculationQuality}'
          = ${t.calculationQuality}
        and ${t.resolutionSnapshot}#>>'{bindings,calculationValidationStatus}'
          = ${t.calculationValidationStatus}
        and ${t.resolutionSnapshot}->>'confirmedBy' = ${t.confirmedBy}::text
        and (${t.resolutionSnapshot}->>'confirmedAt')::timestamptz = ${t.confirmedAt}
        and ${t.resolutionSnapshot}->>'resolutionSha256'
          = encode(${t.resolutionSha256}, 'hex')
        and jsonb_typeof(${t.resolutionSnapshot}->'lines') = 'array'
        and jsonb_array_length(${t.resolutionSnapshot}->'lines') between 1 and 500`,
    ),
  ],
);

export const projectCatalogResolutionLine = pgTable(
  "project_catalog_resolution_line",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    resolutionId: uuid("resolution_id").notNull(),
    projectId: uuid("project_id").notNull(),
    position: integer("position").notNull(),
    quantity: integer("quantity").notNull(),
    catalogComponentId: uuid("catalog_component_id").notNull(),
    catalogComponentRevision: integer("catalog_component_revision").notNull(),
    componentSnapshotSha256: bytea("component_snapshot_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_catalog_resolution_line_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_catalog_resolution_line_ws_resolution_position_uq").on(
      t.workspaceId,
      t.resolutionId,
      t.position,
    ),
    unique("project_catalog_resolution_line_ws_resolution_component_uq").on(
      t.workspaceId,
      t.resolutionId,
      t.catalogComponentId,
    ),
    index("project_catalog_resolution_line_ws_component_project_idx").on(
      t.workspaceId,
      t.catalogComponentId,
      t.catalogComponentRevision,
      t.projectId,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_catalog_resolution_line_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.resolutionId, t.projectId],
      foreignColumns: [
        projectCatalogResolution.workspaceId,
        projectCatalogResolution.id,
        projectCatalogResolution.projectId,
      ],
      name: "project_catalog_resolution_line_resolution_project_fk",
    }).onDelete("cascade"),
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
      name: "project_catalog_resolution_line_catalog_revision_fk",
    }),
    check("project_catalog_resolution_line_position_ck", sql`${t.position} > 0`),
    check(
      "project_catalog_resolution_line_quantity_ck",
      sql`${t.quantity} between 1 and 100000`,
    ),
    check(
      "project_catalog_resolution_line_hash_ck",
      sql`octet_length(${t.componentSnapshotSha256}) = 32`,
    ),
  ],
);
