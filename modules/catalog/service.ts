import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  canonicalizeCalculationJson,
  validatePlanningCalculationRequest,
  type PlanningCalculationRequestV1,
  type PlanningCalculationResultV1,
} from "@/lib/integrations/calculation/contract";
import { validatePlanningCalculationResultExactlyForRequest } from
  "@/lib/integrations/calculation/validate-result";
import {
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
  catalogComponentCreateCommandV1Schema,
  catalogComponentDetailsCommandV1Schema,
  catalogComponentPricingCommandV1Schema,
  normalizeCatalogSku,
  resolveProjectCatalogCommandV1Schema,
  sealCatalogComponentRevision,
  sealProjectCatalogResolution,
  toCatalogComponentView,
  toProjectCatalogResolutionView,
  validateCatalogComponentRevision,
  validateProjectCatalogResolution,
  type CatalogComponentCreateCommandV1,
  type CatalogComponentDetailsCommandV1,
  type CatalogComponentPricingCommandV1,
  type CatalogComponentRevisionV1,
  type CatalogComponentStatus,
  type CatalogComponentType,
  type CatalogComponentViewV1,
  type ProjectCatalogResolutionLineV1,
  type ProjectCatalogResolutionV1,
  type ProjectCatalogResolutionViewV1,
  type RequestedCatalogCoverageV1,
  type ResolveProjectCatalogCommandV1,
} from "@/lib/integrations/catalog/contract";
import {
  can,
  PermissionDeniedError,
  type Action,
  type ServiceCtx,
} from "@/lib/permissions";
import { getProjectEnergyContext } from "@/modules/energy";

export type CatalogComponentReadModel = {
  id: string;
  status: CatalogComponentStatus;
  currentRevision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  current: CatalogComponentViewV1;
  permissions: {
    canManage: boolean;
    canEditPrices: boolean;
    canReadPurchasePrice: boolean;
  };
};

export type CatalogListFilters = {
  status?: CatalogComponentStatus;
  componentType?: CatalogComponentType;
  query?: string;
};

export type CatalogLifecycleCommand = {
  componentId: string;
  expectedRevision: number;
  expectedStatus: CatalogComponentStatus;
};

export type CatalogMutationResult = {
  componentId: string;
  revision: number;
  status: CatalogComponentStatus;
  changed: boolean;
};

export type ProjectCatalogResolutionStaleReason =
  | "project_status_pending"
  | "requirement_changed"
  | "calculation_changed"
  | "catalog_component_changed";

export type ProjectCatalogResolutionContext = {
  projectId: string;
  siteId: string;
  state: "blocked" | "pending" | "current" | "stale";
  blocker:
    | "missing_requirement"
    | "missing_calculation"
    | "calculation_not_current"
    | "calculation_invalid"
    | null;
  staleReasons: ProjectCatalogResolutionStaleReason[];
  requested: RequestedCatalogCoverageV1 | null;
  currentRequirementRevision: number | null;
  currentCalculationRevision: number | null;
  activeComponents: CatalogComponentReadModel[];
  latestResolution: ProjectCatalogResolutionViewV1 | null;
  permissions: {
    canResolve: boolean;
    canReadPurchasePrice: boolean;
  };
};

export type ProjectCatalogResolutionMutationResult = {
  projectId: string;
  resolutionId: string;
  revision: number;
  resolutionSha256: string;
};

type CatalogRow = {
  id: string;
  workspace_id: string;
  internal_sku: string;
  component_type: CatalogComponentType;
  status: CatalogComponentStatus;
  current_revision: number;
  archived_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  revision_snapshot: unknown;
  snapshot_sha256_hex: string;
  [key: string]: unknown;
};

type LockedCatalogRow = CatalogRow & {
  component_type: CatalogComponentType;
  internal_sku: string;
};

type ProjectRow = {
  id: string;
  site_id: string;
  catalog_resolution_status: string;
  [key: string]: unknown;
};

type RequirementRow = {
  id: string;
  revision: number;
  requirements: unknown;
  [key: string]: unknown;
};

type CalculationRow = {
  id: string;
  project_id: string;
  site_id: string;
  revision: number;
  requirement_id: string;
  requirement_revision: number;
  input_sha256_hex: string;
  result_sha256_hex: string;
  quality: string;
  validation_status: string;
  input_snapshot: unknown;
  result: unknown;
  [key: string]: unknown;
};

type ResolutionRow = {
  id: string;
  revision: number;
  resolution_snapshot: unknown;
  resolution_sha256_hex: string;
  [key: string]: unknown;
};

type ResolutionLineStateRow = {
  catalog_component_id: string;
  catalog_component_revision: number;
  component_snapshot_sha256_hex: string;
  current_revision: number;
  status: CatalogComponentStatus;
  [key: string]: unknown;
};

const lifecycleCommandSchema = z.strictObject({
  componentId: z.uuid(),
  expectedRevision: z.int().safe().min(1),
  expectedStatus: z.enum(["draft", "active", "archived"]),
});

const listFiltersSchema = z.strictObject({
  status: z.enum(["draft", "active", "archived"]).optional(),
  componentType: z.enum([
    "module", "inverter", "battery", "wallbox",
    "heat_pump", "mounting", "other",
  ]).optional(),
  query: z.string().max(120).optional(),
});

export class CatalogInputError extends Error {
  constructor(public readonly paths: string[]) {
    super("catalog input is invalid");
    this.name = "CatalogInputError";
  }
}

export class CatalogConflictError extends Error {
  constructor() {
    super("catalog component changed since it was loaded");
    this.name = "CatalogConflictError";
  }
}

export class CatalogNotFoundError extends Error {
  constructor() {
    super("catalog component was not found");
    this.name = "CatalogNotFoundError";
  }
}

export class CatalogStateError extends Error {
  constructor(public readonly code: "archived" | "not_archived" | "active_requires_pricing") {
    super("catalog component state does not permit this operation");
    this.name = "CatalogStateError";
  }
}

export class CatalogIntegrityError extends Error {
  constructor() {
    super("stored catalog data failed integrity validation");
    this.name = "CatalogIntegrityError";
  }
}

export class CatalogPersistenceError extends Error {
  constructor() {
    super("catalog write failed");
    this.name = "CatalogPersistenceError";
  }
}

export class ProjectCatalogConflictError extends Error {
  constructor() {
    super("project catalog resolution changed since it was loaded");
    this.name = "ProjectCatalogConflictError";
  }
}

export class ProjectCatalogBlockedError extends Error {
  constructor(public readonly code:
    | "project_not_found"
    | "missing_requirement"
    | "missing_calculation"
    | "calculation_not_current"
    | "calculation_invalid"
    | "component_not_active") {
    super("project catalog resolution is blocked");
    this.name = "ProjectCatalogBlockedError";
  }
}

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => (
    issue.path.length === 0 ? "/" : `/${issue.path.map(String).join("/")}`
  )))].slice(0, 20);
}

function requireCatalogAccess(
  ctx: ServiceCtx,
  action: Action,
  resource: string,
): void {
  if (!can(ctx, action)) {
    throw new PermissionDeniedError(action, resource, undefined, ctx.actor);
  }
  if (ctx.capabilities.external_only === true) {
    throw new PermissionDeniedError(
      action,
      resource,
      "external_only_without_assignment",
      ctx.actor,
    );
  }
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new CatalogIntegrityError();
  return parsed.toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function validatedSnapshot(row: CatalogRow): CatalogComponentRevisionV1 {
  const validated = validateCatalogComponentRevision(row.revision_snapshot);
  if (
    !validated.ok
    || validated.value.snapshotSha256 !== row.snapshot_sha256_hex
    || validated.value.identity.workspaceId !== row.workspace_id
    || validated.value.identity.componentId !== row.id
    || validated.value.identity.revision !== row.current_revision
    || validated.value.identity.internalSku !== row.internal_sku
    || validated.value.identity.componentType !== row.component_type
  ) {
    throw new CatalogIntegrityError();
  }
  return validated.value;
}

function readPermissions(ctx: ServiceCtx): CatalogComponentReadModel["permissions"] {
  const canManage = can(ctx, "catalog.manage");
  return {
    canManage,
    canEditPrices: canManage && can(ctx, "price.edit"),
    canReadPurchasePrice: can(ctx, "price.read_purchase"),
  };
}

function toReadModel(row: CatalogRow, ctx: ServiceCtx): CatalogComponentReadModel {
  const permissions = readPermissions(ctx);
  return {
    id: row.id,
    status: row.status,
    currentRevision: row.current_revision,
    archivedAt: isoOrNull(row.archived_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    current: toCatalogComponentView(validatedSnapshot(row), {
      canReadPurchasePrice: permissions.canReadPurchasePrice,
    }),
    permissions,
  };
}

export async function listCatalogComponents(
  tx: TenantTx,
  ctx: ServiceCtx,
  filters: CatalogListFilters = {},
): Promise<CatalogComponentReadModel[]> {
  requireCatalogAccess(ctx, "catalog.read", "catalog_component");
  const parsedFilters = listFiltersSchema.safeParse(filters);
  if (!parsedFilters.success) throw new CatalogInputError(issuePaths(parsedFilters.error));
  const safeFilters = parsedFilters.data;
  const canManage = can(ctx, "catalog.manage");
  const query = safeFilters.query?.normalize("NFKC").trim() ?? "";
  const result = await tx.execute<CatalogRow>(sql`
    select component.id, component.workspace_id, component.internal_sku,
           component.component_type, component.status, component.current_revision,
           component.archived_at, component.created_at, component.updated_at,
           revision.revision_snapshot,
           encode(revision.snapshot_sha256, 'hex') as snapshot_sha256_hex
      from catalog_component component
      join catalog_component_revision revision
        on revision.workspace_id = component.workspace_id
       and revision.component_id = component.id
       and revision.revision = component.current_revision
     where component.workspace_id = ${ctx.workspaceId}::uuid
       and (${canManage}::boolean or component.status <> 'draft')
       and (${safeFilters.status ?? null}::text is null
         or component.status = ${safeFilters.status ?? null}::text)
       and (${safeFilters.componentType ?? null}::text is null
         or component.component_type = ${safeFilters.componentType ?? null}::text)
       and (${query} = '' or component.internal_sku ilike ${`%${query}%`}
         or revision.revision_snapshot#>>'{presentation,displayName}' ilike ${`%${query}%`})
     order by component.status, component.component_type,
              component.internal_sku, component.id
     limit 200
  `);
  return result.rows.map((row) => toReadModel(row, ctx));
}

export async function getCatalogComponent(
  tx: TenantTx,
  ctx: ServiceCtx,
  componentId: string,
): Promise<CatalogComponentReadModel | null> {
  requireCatalogAccess(ctx, "catalog.read", "catalog_component");
  const id = z.uuid().safeParse(componentId);
  if (!id.success) throw new CatalogInputError(["/componentId"]);
  const canManage = can(ctx, "catalog.manage");
  const result = await tx.execute<CatalogRow>(sql`
    select component.id, component.workspace_id, component.internal_sku,
           component.component_type, component.status, component.current_revision,
           component.archived_at, component.created_at, component.updated_at,
           revision.revision_snapshot,
           encode(revision.snapshot_sha256, 'hex') as snapshot_sha256_hex
      from catalog_component component
      join catalog_component_revision revision
        on revision.workspace_id = component.workspace_id
       and revision.component_id = component.id
       and revision.revision = component.current_revision
     where component.workspace_id = ${ctx.workspaceId}::uuid
       and component.id = ${id.data}::uuid
       and (${canManage}::boolean or component.status <> 'draft')
     limit 1
  `);
  const row = result.rows[0];
  return row ? toReadModel(row, ctx) : null;
}

function parseCreateCommand(value: unknown): CatalogComponentCreateCommandV1 {
  let normalized = value;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    try {
      normalized = {
        ...record,
        internalSku: normalizeCatalogSku(record.internalSku as string),
      };
    } catch {
      throw new CatalogInputError(["/internalSku"]);
    }
  }
  const parsed = catalogComponentCreateCommandV1Schema.safeParse(normalized);
  if (!parsed.success) throw new CatalogInputError(issuePaths(parsed.error));
  return parsed.data;
}

function constraintName(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { constraint?: unknown; cause?: unknown };
  if (typeof candidate.constraint === "string") return candidate.constraint;
  if (typeof candidate.cause === "object" && candidate.cause !== null) {
    const cause = candidate.cause as { constraint?: unknown };
    if (typeof cause.constraint === "string") return cause.constraint;
  }
  return undefined;
}

async function insertRevision(
  tx: TenantTx,
  ctx: ServiceCtx,
  snapshot: CatalogComponentRevisionV1,
): Promise<void> {
  try {
    await tx.execute(sql`
      insert into catalog_component_revision (
        id, workspace_id, component_id, revision, component_type,
        schema_version, canonicalization_version, revision_snapshot,
        snapshot_sha256, created_by
      ) values (
        ${randomUUID()}::uuid, ${ctx.workspaceId}::uuid,
        ${snapshot.identity.componentId}::uuid, ${snapshot.identity.revision},
        ${snapshot.identity.componentType}, ${snapshot.schemaVersion},
        ${snapshot.canonicalizationVersion}, ${JSON.stringify(snapshot)}::jsonb,
        decode(${snapshot.snapshotSha256}, 'hex'), ${ctx.actor}::uuid
      )
    `);
  } catch (error) {
    if (
      constraintName(error) === "catalog_component_revision_ws_component_revision_uq"
      || constraintName(error) === "catalog_component_revision_ws_component_revision_hash_uq"
    ) {
      throw new CatalogConflictError();
    }
    throw new CatalogPersistenceError();
  }
}

async function recordRevisionMutation(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    componentId: string;
    revision: number;
    status: CatalogComponentStatus;
    snapshotSha256: string;
    eventType:
      | "catalog.component_created"
      | "catalog.component_revised"
      | "catalog.component_status_changed";
    action: "catalog.manage" | "price.edit";
    fieldClasses: Array<"identity" | "details" | "pricing" | "status">;
  },
): Promise<void> {
  const details = {
    componentId: input.componentId,
    revision: input.revision,
    status: input.status,
    snapshotSha256: input.snapshotSha256,
    fieldClasses: input.fieldClasses,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "catalog_component",
    aggregateId: input.componentId,
    eventType: input.eventType,
    actor: ctx.actor,
    payload: details,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: input.action,
    resource: input.action === "price.edit"
      ? "catalog_component_pricing"
      : "catalog_component",
    allowed: true,
    details,
  });
}

export async function createCatalogComponent(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<CatalogMutationResult> {
  requireCatalogAccess(ctx, "catalog.manage", "catalog_component");
  const command = parseCreateCommand(value);
  if (command.commercial !== null) {
    requireCatalogAccess(ctx, "price.edit", "catalog_component_pricing");
  }
  const componentId = randomUUID();
  let snapshot: CatalogComponentRevisionV1;
  try {
    snapshot = sealCatalogComponentRevision({
      schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
      canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
      identity: {
        workspaceId: ctx.workspaceId,
        componentId,
        revision: 1,
        internalSku: command.internalSku,
        componentType: command.componentType,
      },
      presentation: command.presentation,
      technicalData: command.technicalData,
      commercial: command.commercial,
      technicalProvenance: command.technicalProvenance,
    });
  } catch {
    throw new CatalogInputError(["/presentation", "/technicalData", "/commercial"]);
  }

  try {
    await tx.execute(sql`
      insert into catalog_component (
        id, workspace_id, internal_sku, component_type, created_by
      ) values (
        ${componentId}::uuid, ${ctx.workspaceId}::uuid,
        ${command.internalSku}, ${command.componentType}, ${ctx.actor}::uuid
      )
    `);
  } catch (error) {
    if (constraintName(error) === "catalog_component_ws_sku_ci_uq") {
      throw new CatalogConflictError();
    }
    throw new CatalogPersistenceError();
  }
  await insertRevision(tx, ctx, snapshot);

  await recordRevisionMutation(tx, ctx, {
    componentId,
    revision: 1,
    status: "draft",
    snapshotSha256: snapshot.snapshotSha256,
    eventType: "catalog.component_created",
    action: "catalog.manage",
    fieldClasses: command.commercial === null
      ? ["identity", "details"]
      : ["identity", "details", "pricing"],
  });
  return { componentId, revision: 1, status: "draft", changed: true };
}

async function lockCatalogComponent(
  tx: TenantTx,
  ctx: ServiceCtx,
  componentId: string,
): Promise<LockedCatalogRow> {
  const locked = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select component.id
      from catalog_component component
     where component.workspace_id = ${ctx.workspaceId}::uuid
       and component.id = ${componentId}::uuid
     for update of component
  `);
  if (!locked.rows[0]) throw new CatalogNotFoundError();

  // READ COMMITTED gives each statement a fresh snapshot. Keep the possibly
  // waiting row lock separate from the revision join so a concurrent revision
  // can never leave us with the old snapshot beside the newly locked row.
  const result = await tx.execute<LockedCatalogRow>(sql`
    select component.id, component.workspace_id, component.internal_sku,
           component.component_type,
           component.status, component.current_revision,
           component.archived_at, component.created_at, component.updated_at,
           revision.revision_snapshot,
           encode(revision.snapshot_sha256, 'hex') as snapshot_sha256_hex
      from catalog_component component
      join catalog_component_revision revision
        on revision.workspace_id = component.workspace_id
       and revision.component_id = component.id
       and revision.revision = component.current_revision
     where component.workspace_id = ${ctx.workspaceId}::uuid
       and component.id = ${componentId}::uuid
  `);
  const row = result.rows[0];
  if (!row) throw new CatalogIntegrityError();
  return row;
}

function requireExpectedRevision(row: LockedCatalogRow, expectedRevision: number): void {
  if (row.current_revision !== expectedRevision) throw new CatalogConflictError();
}

async function lockAffectedProjectsForComponent(
  tx: TenantTx,
  ctx: ServiceCtx,
  componentId: string,
): Promise<void> {
  await tx.execute(sql`
    select project_record.id
      from project project_record
     where project_record.workspace_id = ${ctx.workspaceId}::uuid
       and exists (
         select 1
           from project_catalog_resolution resolution
           join project_catalog_resolution_line line
             on line.workspace_id = resolution.workspace_id
            and line.resolution_id = resolution.id
          where resolution.workspace_id = project_record.workspace_id
            and resolution.project_id = project_record.id
            and resolution.revision = (
              select max(latest.revision)
                from project_catalog_resolution latest
               where latest.workspace_id = resolution.workspace_id
                 and latest.project_id = resolution.project_id
            )
            and line.catalog_component_id = ${componentId}::uuid
       )
     order by project_record.id
     for update of project_record
  `);
}

export async function reviseCatalogComponentDetails(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<CatalogMutationResult> {
  requireCatalogAccess(ctx, "catalog.manage", "catalog_component");
  const parsed = catalogComponentDetailsCommandV1Schema.safeParse(value);
  if (!parsed.success) throw new CatalogInputError(issuePaths(parsed.error));
  const command: CatalogComponentDetailsCommandV1 = parsed.data;
  const row = await lockCatalogComponent(tx, ctx, command.componentId);
  requireExpectedRevision(row, command.expectedRevision);
  if (row.status === "archived") throw new CatalogStateError("archived");
  const previous = validatedSnapshot(row);
  let snapshot: CatalogComponentRevisionV1;
  try {
    snapshot = sealCatalogComponentRevision({
      schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
      canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
      identity: {
        ...previous.identity,
        revision: previous.identity.revision + 1,
      },
      presentation: command.presentation,
      technicalData: command.technicalData,
      commercial: previous.commercial,
      technicalProvenance: command.technicalProvenance,
    });
  } catch {
    throw new CatalogInputError(["/presentation", "/technicalData"]);
  }
  await lockAffectedProjectsForComponent(tx, ctx, row.id);
  await insertRevision(tx, ctx, snapshot);
  await recordRevisionMutation(tx, ctx, {
    componentId: row.id,
    revision: snapshot.identity.revision,
    status: "draft",
    snapshotSha256: snapshot.snapshotSha256,
    eventType: "catalog.component_revised",
    action: "catalog.manage",
    fieldClasses: ["details"],
  });
  return {
    componentId: row.id,
    revision: snapshot.identity.revision,
    status: "draft",
    changed: true,
  };
}

export async function reviseCatalogComponentPricing(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<CatalogMutationResult> {
  requireCatalogAccess(ctx, "catalog.manage", "catalog_component");
  requireCatalogAccess(ctx, "price.edit", "catalog_component_pricing");
  const parsed = catalogComponentPricingCommandV1Schema.safeParse(value);
  if (!parsed.success) throw new CatalogInputError(issuePaths(parsed.error));
  const command: CatalogComponentPricingCommandV1 = parsed.data;
  const row = await lockCatalogComponent(tx, ctx, command.componentId);
  requireExpectedRevision(row, command.expectedRevision);
  if (row.status === "archived") throw new CatalogStateError("archived");
  const previous = validatedSnapshot(row);
  const snapshot = sealCatalogComponentRevision({
    schemaVersion: previous.schemaVersion,
    canonicalizationVersion: previous.canonicalizationVersion,
    identity: { ...previous.identity, revision: previous.identity.revision + 1 },
    presentation: previous.presentation,
    technicalData: previous.technicalData,
    commercial: command.commercial,
    technicalProvenance: previous.technicalProvenance,
  });
  await lockAffectedProjectsForComponent(tx, ctx, row.id);
  await insertRevision(tx, ctx, snapshot);
  await recordRevisionMutation(tx, ctx, {
    componentId: row.id,
    revision: snapshot.identity.revision,
    status: "draft",
    snapshotSha256: snapshot.snapshotSha256,
    eventType: "catalog.component_revised",
    action: "price.edit",
    fieldClasses: ["pricing"],
  });
  return {
    componentId: row.id,
    revision: snapshot.identity.revision,
    status: "draft",
    changed: true,
  };
}

async function changeCatalogStatus(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
  target: CatalogComponentStatus,
): Promise<CatalogMutationResult> {
  requireCatalogAccess(ctx, "catalog.manage", "catalog_component");
  const parsed = lifecycleCommandSchema.safeParse(value);
  if (!parsed.success) throw new CatalogInputError(issuePaths(parsed.error));
  const row = await lockCatalogComponent(tx, ctx, parsed.data.componentId);
  requireExpectedRevision(row, parsed.data.expectedRevision);
  if (row.status !== parsed.data.expectedStatus) throw new CatalogConflictError();
  const snapshot = validatedSnapshot(row);
  if (row.status === target) {
    return {
      componentId: row.id,
      revision: row.current_revision,
      status: row.status,
      changed: false,
    };
  }
  if (target === "active" && snapshot.commercial === null) {
    throw new CatalogStateError("active_requires_pricing");
  }
  if (target === "active" && row.status === "archived") {
    throw new CatalogStateError("archived");
  }
  if (target === "draft" && row.status !== "archived") {
    throw new CatalogStateError("not_archived");
  }
  if (target === "archived") {
    await lockAffectedProjectsForComponent(tx, ctx, row.id);
  }
  await tx.execute(sql`
    update catalog_component
       set status = ${target},
           archived_at = case when ${target} = 'archived' then now() else null end,
           updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${row.id}::uuid
       and current_revision = ${row.current_revision}
  `);
  await recordRevisionMutation(tx, ctx, {
    componentId: row.id,
    revision: row.current_revision,
    status: target,
    snapshotSha256: snapshot.snapshotSha256,
    eventType: "catalog.component_status_changed",
    action: "catalog.manage",
    fieldClasses: ["status"],
  });
  return {
    componentId: row.id,
    revision: row.current_revision,
    status: target,
    changed: true,
  };
}

export async function activateCatalogComponent(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<CatalogMutationResult> {
  return changeCatalogStatus(tx, ctx, value, "active");
}

export async function archiveCatalogComponent(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<CatalogMutationResult> {
  return changeCatalogStatus(tx, ctx, value, "archived");
}

export async function returnCatalogComponentToDraft(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<CatalogMutationResult> {
  return changeCatalogStatus(tx, ctx, value, "draft");
}

function sameCalculationJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeCalculationJson(left) === canonicalizeCalculationJson(right);
  } catch {
    return false;
  }
}

function kiloToBaseUnits(value: number): number {
  const scaled = value * 1_000;
  const rounded = Math.round(scaled);
  if (
    !Number.isFinite(value)
    || !Number.isSafeInteger(rounded)
    || rounded < 0
  ) {
    throw new CatalogIntegrityError();
  }
  // Planning values are canonicalized to six decimal places. The catalog
  // contract stores base units as integers, so the only stable bridge is the
  // nearest whole watt / watt-hour.
  return rounded;
}

type CurrentPlanning = {
  request: PlanningCalculationRequestV1;
  result: PlanningCalculationResultV1;
  requested: RequestedCatalogCoverageV1;
};

type PlanningEvaluation =
  | { ok: true; value: CurrentPlanning }
  | { ok: false; code: "calculation_not_current" | "calculation_invalid" };

function evaluateCurrentPlanning(
  ctx: ServiceCtx,
  project: ProjectRow,
  requirement: RequirementRow,
  calculation: CalculationRow,
): PlanningEvaluation {
  if (
    calculation.project_id !== project.id
    || calculation.site_id !== project.site_id
    || calculation.requirement_id !== requirement.id
    || calculation.requirement_revision !== requirement.revision
  ) {
    return { ok: false, code: "calculation_not_current" };
  }
  const request = validatePlanningCalculationRequest(calculation.input_snapshot);
  const result = validatePlanningCalculationResultExactlyForRequest(
    calculation.input_snapshot,
    calculation.result,
  );
  if (!request.ok || !result.ok) return { ok: false, code: "calculation_invalid" };
  if (
    request.value.bindings.workspaceId !== ctx.workspaceId
    || request.value.bindings.projectId !== project.id
    || request.value.bindings.siteId !== project.site_id
    || request.value.bindings.projectRequirementId !== requirement.id
    || request.value.bindings.projectRequirementRevision !== requirement.revision
    || !sameCalculationJson(request.value.projectRequirements, requirement.requirements)
    || calculation.input_sha256_hex !== result.value.inputSha256
    || calculation.result_sha256_hex !== result.value.resultSha256
    || calculation.quality !== result.value.quality
    || calculation.validation_status !== result.value.validationStatus
  ) {
    return { ok: false, code: "calculation_invalid" };
  }

  const requestedProducts = request.value.projectRequirements.requestedProducts;
  const requested: RequestedCatalogCoverageV1 = result.value.branch === "new_installation"
    ? {
        branch: result.value.branch,
        pvPeakPowerWatts: kiloToBaseUnits(result.value.calculation.systemPeakPowerKwp),
        storageCapacityWh: kiloToBaseUnits(
          result.value.calculation.plannedStorageCapacityKwh,
        ),
        wallbox: requestedProducts.wallbox,
        backupPower: requestedProducts.backupPower,
        bidirectionalCharging: requestedProducts.bidirectionalCharging,
      }
    : {
        branch: result.value.branch,
        pvPeakPowerWatts: 0,
        storageCapacityWh: kiloToBaseUnits(
          result.value.calculation.addedStorageCapacityKwh,
        ),
        wallbox: requestedProducts.wallbox,
        backupPower: requestedProducts.backupPower,
        bidirectionalCharging: requestedProducts.bidirectionalCharging,
      };
  return { ok: true, value: { request: request.value, result: result.value, requested } };
}

async function readProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectRow | null> {
  const result = await tx.execute<ProjectRow>(sql`
    select id, site_id, catalog_resolution_status
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     limit 1
  `);
  return result.rows[0] ?? null;
}

async function lockProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectRow | null> {
  const result = await tx.execute<ProjectRow>(sql`
    select id, site_id, catalog_resolution_status
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     for update
  `);
  return result.rows[0] ?? null;
}

async function readLatestRequirement(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  lock: boolean,
): Promise<RequirementRow | null> {
  const result = lock
    ? await tx.execute<RequirementRow>(sql`
        select id, revision, requirements
          from project_requirement
         where workspace_id = ${ctx.workspaceId}::uuid
           and project_id = ${projectId}::uuid
         order by revision desc
         limit 1
         for share
      `)
    : await tx.execute<RequirementRow>(sql`
        select id, revision, requirements
          from project_requirement
         where workspace_id = ${ctx.workspaceId}::uuid
           and project_id = ${projectId}::uuid
         order by revision desc
         limit 1
      `);
  return result.rows[0] ?? null;
}

async function readLatestCalculation(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  lock: boolean,
): Promise<CalculationRow | null> {
  const result = lock
    ? await tx.execute<CalculationRow>(sql`
        select id, project_id, site_id, revision,
               requirement_id, requirement_revision,
               encode(input_sha256, 'hex') as input_sha256_hex,
               encode(result_sha256, 'hex') as result_sha256_hex,
               quality, validation_status, input_snapshot, result
          from project_calculation_revision
         where workspace_id = ${ctx.workspaceId}::uuid
           and project_id = ${projectId}::uuid
         order by revision desc
         limit 1
         for share
      `)
    : await tx.execute<CalculationRow>(sql`
        select id, project_id, site_id, revision,
               requirement_id, requirement_revision,
               encode(input_sha256, 'hex') as input_sha256_hex,
               encode(result_sha256, 'hex') as result_sha256_hex,
               quality, validation_status, input_snapshot, result
          from project_calculation_revision
         where workspace_id = ${ctx.workspaceId}::uuid
           and project_id = ${projectId}::uuid
         order by revision desc
         limit 1
      `);
  return result.rows[0] ?? null;
}

async function readRequirementByIdentity(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  requirementId: string,
  revision: number,
): Promise<RequirementRow | null> {
  const result = await tx.execute<RequirementRow>(sql`
    select id, revision, requirements
      from project_requirement
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
       and id = ${requirementId}::uuid
       and revision = ${revision}
     for share
  `);
  return result.rows[0] ?? null;
}

async function readCalculationByIdentity(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  calculationId: string,
  revision: number,
): Promise<CalculationRow | null> {
  const result = await tx.execute<CalculationRow>(sql`
    select id, project_id, site_id, revision,
           requirement_id, requirement_revision,
           encode(input_sha256, 'hex') as input_sha256_hex,
           encode(result_sha256, 'hex') as result_sha256_hex,
           quality, validation_status, input_snapshot, result
      from project_calculation_revision
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
       and id = ${calculationId}::uuid
       and revision = ${revision}
     for share
  `);
  return result.rows[0] ?? null;
}

async function readLatestResolution(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ResolutionRow | null> {
  const result = await tx.execute<ResolutionRow>(sql`
    select id, revision, resolution_snapshot,
           encode(resolution_sha256, 'hex') as resolution_sha256_hex
      from project_catalog_resolution
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
     order by revision desc
     limit 1
  `);
  return result.rows[0] ?? null;
}

function validatedResolution(row: ResolutionRow): ProjectCatalogResolutionV1 {
  const validated = validateProjectCatalogResolution(row.resolution_snapshot);
  if (
    !validated.ok
    || validated.value.revision !== row.revision
    || validated.value.resolutionSha256 !== row.resolution_sha256_hex
  ) throw new CatalogIntegrityError();
  return validated.value;
}

async function resolutionStaleReasons(
  tx: TenantTx,
  ctx: ServiceCtx,
  project: ProjectRow,
  requirement: RequirementRow | null,
  calculation: CalculationRow | null,
  row: ResolutionRow,
  resolution: ProjectCatalogResolutionV1,
): Promise<ProjectCatalogResolutionStaleReason[]> {
  const reasons: ProjectCatalogResolutionStaleReason[] = [];
  if (project.catalog_resolution_status !== "resolved") {
    reasons.push("project_status_pending");
  }
  if (
    requirement === null
    || resolution.bindings.requirementId !== requirement.id
    || resolution.bindings.requirementRevision !== requirement.revision
  ) reasons.push("requirement_changed");
  if (
    calculation === null
    || resolution.bindings.calculationRevisionId !== calculation.id
    || resolution.bindings.calculationRevision !== calculation.revision
    || resolution.bindings.calculationInputSha256 !== calculation.input_sha256_hex
    || resolution.bindings.calculationResultSha256 !== calculation.result_sha256_hex
    || resolution.bindings.calculationQuality !== calculation.quality
    || resolution.bindings.calculationValidationStatus !== calculation.validation_status
  ) reasons.push("calculation_changed");

  const states = await tx.execute<ResolutionLineStateRow>(sql`
    select line.catalog_component_id, line.catalog_component_revision,
           encode(line.component_snapshot_sha256, 'hex')
             as component_snapshot_sha256_hex,
           component.current_revision, component.status
      from project_catalog_resolution_line line
      join catalog_component component
        on component.workspace_id = line.workspace_id
       and component.id = line.catalog_component_id
     where line.workspace_id = ${ctx.workspaceId}::uuid
       and line.resolution_id = ${row.id}::uuid
     order by line.position
  `);
  if (states.rows.length !== resolution.lines.length) throw new CatalogIntegrityError();
  const snapshotLines = new Map(resolution.lines.map((line) => [line.catalogComponentId, line]));
  let changed = false;
  for (const state of states.rows) {
    const line = snapshotLines.get(state.catalog_component_id);
    if (
      !line
      || line.catalogComponentRevision !== state.catalog_component_revision
      || line.componentSnapshotSha256 !== state.component_snapshot_sha256_hex
    ) throw new CatalogIntegrityError();
    if (
      state.status !== "active"
      || state.current_revision !== state.catalog_component_revision
    ) changed = true;
  }
  if (changed) reasons.push("catalog_component_changed");
  return [...new Set(reasons)];
}

export async function getProjectCatalogResolutionContext(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectCatalogResolutionContext | null> {
  requireCatalogAccess(ctx, "project.read", "project_catalog_resolution");
  const parsedId = z.uuid().safeParse(projectId);
  if (!parsedId.success) throw new CatalogInputError(["/projectId"]);
  const project = await readProject(tx, ctx, parsedId.data);
  if (!project) return null;
  const energy = await getProjectEnergyContext(tx, ctx, project.id);
  if (!energy) return null;
  let requirement: RequirementRow | null;
  let calculation: CalculationRow | null;
  if (energy.calculation.status === "current") {
    const current = energy.calculation.result;
    requirement = await readRequirementByIdentity(
      tx,
      ctx,
      project.id,
      current.binding.requirement.id,
      current.binding.requirement.revision,
    );
    calculation = await readCalculationByIdentity(
      tx,
      ctx,
      project.id,
      current.id,
      current.revision,
    );
  } else {
    requirement = await readLatestRequirement(tx, ctx, project.id, false);
    calculation = await readLatestCalculation(tx, ctx, project.id, false);
  }
  const activeComponents = await listCatalogComponents(tx, ctx, { status: "active" });
  const resolutionRow = await readLatestResolution(tx, ctx, project.id);
  const resolution = resolutionRow ? validatedResolution(resolutionRow) : null;

  let blocker: ProjectCatalogResolutionContext["blocker"] = null;
  let requested: RequestedCatalogCoverageV1 | null = null;
  if (!requirement) {
    blocker = "missing_requirement";
  } else if (energy.calculation.status !== "current") {
    blocker = calculation === null ? "missing_calculation" : "calculation_not_current";
  } else if (!calculation) {
    blocker = "missing_calculation";
  } else {
    const current = energy.calculation.result;
    if (
      current.id !== calculation.id
      || current.revision !== calculation.revision
      || current.binding.requirement.id !== requirement.id
      || current.binding.requirement.revision !== requirement.revision
    ) {
      blocker = "calculation_not_current";
    } else {
      const planning = evaluateCurrentPlanning(ctx, project, requirement, calculation);
      if (!planning.ok) blocker = planning.code;
      else requested = planning.value.requested;
    }
  }

  const staleReasons = resolutionRow && resolution
    ? await resolutionStaleReasons(
        tx,
        ctx,
        project,
        requirement,
        calculation,
        resolutionRow,
        resolution,
      )
    : [];
  const state = blocker !== null
    ? "blocked" as const
    : resolution === null
      ? "pending" as const
      : staleReasons.length > 0
        ? "stale" as const
        : "current" as const;
  const canReadPurchasePrice = can(ctx, "price.read_purchase");
  return {
    projectId: project.id,
    siteId: project.site_id,
    state,
    blocker,
    staleReasons,
    requested,
    currentRequirementRevision: requirement?.revision ?? null,
    currentCalculationRevision: calculation?.revision ?? null,
    activeComponents,
    latestResolution: resolution
      ? toProjectCatalogResolutionView(resolution, { canReadPurchasePrice })
      : null,
    permissions: {
      canResolve: can(ctx, "project.write"),
      canReadPurchasePrice,
    },
  };
}

function requirementKeysForSelection(
  type: CatalogComponentType,
  requested: RequestedCatalogCoverageV1,
): ProjectCatalogResolutionLineV1["coversRequirementKeys"] {
  if (type === "module" || type === "inverter" || type === "mounting") {
    return requested.pvPeakPowerWatts > 0 ? ["pv_generation"] : [];
  }
  if (type === "battery") {
    return [
      ...(requested.storageCapacityWh > 0 ? ["storage_capacity" as const] : []),
      ...(requested.backupPower ? ["backup_power" as const] : []),
    ];
  }
  if (type === "wallbox") {
    return [
      ...(requested.wallbox ? ["wallbox" as const] : []),
      ...(requested.bidirectionalCharging ? ["bidirectional_charging" as const] : []),
    ];
  }
  return [];
}

async function lockSelectedComponents(
  tx: TenantTx,
  ctx: ServiceCtx,
  command: ResolveProjectCatalogCommandV1,
): Promise<Map<string, LockedCatalogRow>> {
  const ids = [...new Set(command.selections.map((selection) => selection.componentId))].sort();
  if (ids.length !== command.selections.length) {
    throw new CatalogInputError(["/selections"]);
  }
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const locked = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select component.id
      from catalog_component component
     where component.workspace_id = ${ctx.workspaceId}::uuid
       and component.id in (${idList})
     order by component.id
     for update of component
  `);
  if (locked.rows.length !== ids.length) {
    throw new ProjectCatalogBlockedError("component_not_active");
  }

  // Re-read after every component lock has been acquired. A single statement
  // that both waits and joins the revision can observe a mixed old/new view.
  const result = await tx.execute<LockedCatalogRow>(sql`
    select component.id, component.workspace_id, component.internal_sku,
           component.component_type, component.status, component.current_revision,
           component.archived_at, component.created_at, component.updated_at,
           revision.revision_snapshot,
           encode(revision.snapshot_sha256, 'hex') as snapshot_sha256_hex
      from catalog_component component
      join catalog_component_revision revision
        on revision.workspace_id = component.workspace_id
       and revision.component_id = component.id
       and revision.revision = component.current_revision
     where component.workspace_id = ${ctx.workspaceId}::uuid
       and component.id in (${idList})
     order by component.id
  `);
  if (result.rows.length !== ids.length) throw new CatalogIntegrityError();
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  for (const selection of command.selections) {
    const row = byId.get(selection.componentId);
    if (
      !row
      || row.status !== "active"
      || row.current_revision !== selection.expectedComponentRevision
    ) throw new ProjectCatalogBlockedError("component_not_active");
    validatedSnapshot(row);
  }
  return byId;
}

async function insertResolutionSnapshot(
  tx: TenantTx,
  ctx: ServiceCtx,
  resolutionId: string,
  snapshot: ProjectCatalogResolutionV1,
): Promise<void> {
  try {
    await tx.execute(sql`
      set constraints project_catalog_resolution_complete,
                      project_catalog_resolution_line_complete deferred
    `);
    await tx.execute(sql`
      insert into project_catalog_resolution (
        id, workspace_id, project_id, site_id, revision,
        requirement_id, requirement_revision, calculation_revision_id,
        calculation_revision, calculation_input_sha256,
        calculation_result_sha256, calculation_quality,
        calculation_validation_status, schema_version,
        canonicalization_version, resolution_snapshot, resolution_sha256,
        confirmed_by, confirmed_at
      ) values (
        ${resolutionId}::uuid, ${ctx.workspaceId}::uuid,
        ${snapshot.bindings.projectId}::uuid, ${snapshot.bindings.siteId}::uuid,
        ${snapshot.revision}, ${snapshot.bindings.requirementId}::uuid,
        ${snapshot.bindings.requirementRevision},
        ${snapshot.bindings.calculationRevisionId}::uuid,
        ${snapshot.bindings.calculationRevision},
        decode(${snapshot.bindings.calculationInputSha256}, 'hex'),
        decode(${snapshot.bindings.calculationResultSha256}, 'hex'),
        ${snapshot.bindings.calculationQuality},
        ${snapshot.bindings.calculationValidationStatus},
        ${snapshot.schemaVersion}, ${snapshot.canonicalizationVersion},
        ${JSON.stringify(snapshot)}::jsonb,
        decode(${snapshot.resolutionSha256}, 'hex'),
        ${snapshot.confirmedBy}::uuid, ${snapshot.confirmedAt}::timestamptz
      )
    `);
    for (const line of snapshot.lines) {
      await tx.execute(sql`
        insert into project_catalog_resolution_line (
          id, workspace_id, resolution_id, project_id, position, quantity,
          catalog_component_id, catalog_component_revision,
          component_snapshot_sha256
        ) values (
          ${line.lineId}::uuid, ${ctx.workspaceId}::uuid,
          ${resolutionId}::uuid, ${snapshot.bindings.projectId}::uuid,
          ${line.position}, ${line.quantity}, ${line.catalogComponentId}::uuid,
          ${line.catalogComponentRevision},
          decode(${line.componentSnapshotSha256}, 'hex')
        )
      `);
    }
    await tx.execute(sql`
      set constraints project_catalog_resolution_complete,
                      project_catalog_resolution_line_complete immediate
    `);
  } catch {
    throw new CatalogPersistenceError();
  }
}

export async function resolveProjectCatalog(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<ProjectCatalogResolutionMutationResult> {
  requireCatalogAccess(ctx, "project.write", "project_catalog_resolution");
  const parsed = resolveProjectCatalogCommandV1Schema.safeParse(value);
  if (!parsed.success) throw new CatalogInputError(issuePaths(parsed.error));
  const command = parsed.data;
  const components = await lockSelectedComponents(tx, ctx, command);
  const project = await lockProject(tx, ctx, command.projectId);
  if (!project) throw new ProjectCatalogBlockedError("project_not_found");
  const energy = await getProjectEnergyContext(tx, ctx, project.id);
  if (!energy) throw new ProjectCatalogBlockedError("project_not_found");
  if (energy.calculation.status !== "current") {
    throw new ProjectCatalogBlockedError("calculation_not_current");
  }
  const currentCalculation = energy.calculation.result;
  const requirement = await readRequirementByIdentity(
    tx,
    ctx,
    project.id,
    currentCalculation.binding.requirement.id,
    currentCalculation.binding.requirement.revision,
  );
  if (!requirement) throw new ProjectCatalogBlockedError("missing_requirement");
  const calculation = await readCalculationByIdentity(
    tx,
    ctx,
    project.id,
    currentCalculation.id,
    currentCalculation.revision,
  );
  if (!calculation) throw new ProjectCatalogBlockedError("missing_calculation");

  const previous = await readLatestResolution(tx, ctx, project.id);
  const currentResolutionRevision = previous?.revision ?? 0;
  if (
    currentResolutionRevision !== command.expectedResolutionRevision
    || requirement.revision !== command.expectedRequirementRevision
    || calculation.revision !== command.expectedCalculationRevision
  ) throw new ProjectCatalogConflictError();

  const planning = evaluateCurrentPlanning(ctx, project, requirement, calculation);
  if (!planning.ok) throw new ProjectCatalogBlockedError(planning.code);
  if (!sameCalculationJson(planning.value.result, currentCalculation.value)) {
    throw new ProjectCatalogBlockedError("calculation_invalid");
  }
  const timestamp = await tx.execute<{ confirmed_at: Date | string; [key: string]: unknown }>(
    sql`select clock_timestamp() as confirmed_at`,
  );
  const confirmedAt = iso(timestamp.rows[0]!.confirmed_at);
  const lines: ProjectCatalogResolutionLineV1[] = command.selections.map(
    (selection, index) => {
      const row = components.get(selection.componentId);
      if (!row) throw new ProjectCatalogBlockedError("component_not_active");
      const snapshot = validatedSnapshot(row);
      return {
        lineId: randomUUID(),
        position: index + 1,
        quantity: selection.quantity,
        coversRequirementKeys: requirementKeysForSelection(
          snapshot.identity.componentType,
          planning.value.requested,
        ),
        catalogComponentId: row.id,
        catalogComponentRevision: row.current_revision,
        componentSnapshotSha256: snapshot.snapshotSha256,
        componentSnapshot: snapshot,
      };
    },
  );
  let snapshot: ProjectCatalogResolutionV1;
  try {
    snapshot = sealProjectCatalogResolution({
      schemaVersion: PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
      canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
      revision: currentResolutionRevision + 1,
      bindings: {
        workspaceId: ctx.workspaceId,
        projectId: project.id,
        siteId: project.site_id,
        requirementId: requirement.id,
        requirementRevision: requirement.revision,
        calculationRevisionId: calculation.id,
        calculationRevision: calculation.revision,
        calculationInputSha256: calculation.input_sha256_hex,
        calculationResultSha256: calculation.result_sha256_hex,
        calculationQuality: "server_reproduced_estimate",
        calculationValidationStatus: "not_f4_reference_validated",
      },
      lines,
      requested: planning.value.requested,
      acknowledgements: command.acknowledgements,
      confirmedBy: ctx.actor,
      confirmedAt,
    });
  } catch {
    throw new CatalogInputError(["/selections", "/acknowledgements"]);
  }

  const resolutionId = randomUUID();
  await insertResolutionSnapshot(tx, ctx, resolutionId, snapshot);
  const safeDetails = {
    projectId: project.id,
    resolutionId,
    revision: snapshot.revision,
    requirementRevision: requirement.revision,
    calculationRevision: calculation.revision,
    resolutionSha256: snapshot.resolutionSha256,
    componentRevisions: snapshot.lines.map((line) => ({
      componentId: line.catalogComponentId,
      revision: line.catalogComponentRevision,
      snapshotSha256: line.componentSnapshotSha256,
    })),
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: project.id,
    eventType: "project.catalog_resolved",
    actor: ctx.actor,
    payload: safeDetails,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.write",
    resource: "project_catalog_resolution",
    allowed: true,
    details: safeDetails,
  });
  return {
    projectId: project.id,
    resolutionId,
    revision: snapshot.revision,
    resolutionSha256: snapshot.resolutionSha256,
  };
}
