import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantTx } from "@/lib/db/types";
import {
  validateProjectCatalogResolution,
  type CatalogComponentStatus,
  type ProjectCatalogResolutionV1,
} from "@/lib/integrations/catalog/contract";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type Action,
  type ServiceCtx,
} from "@/lib/permissions";

export type OfferCatalogResolutionSnapshot = ProjectCatalogResolutionV1;

export type OfferCatalogCopy = {
  resolutionId: string;
  resolutionRevision: number;
  resolutionSha256: string;
  snapshot: OfferCatalogResolutionSnapshot;
};

export type OfferCatalogCopyResult =
  | { state: "current"; copy: OfferCatalogCopy }
  | { state: "conflict" }
  | {
      state: "blocked";
      code: "project_not_found" | "resolution_not_current";
    };

export type OfferCatalogBasisReference = {
  expectedRequirementRevision: number;
  expectedCalculationRevision: number;
  expectedResolutionRevision: number;
};

export class CatalogOfferBridgeIntegrityError extends Error {
  constructor() {
    super("catalog data for the offer boundary failed integrity validation");
    this.name = "CatalogOfferBridgeIntegrityError";
  }
}

type OfferCopyResolutionRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  site_id: string;
  revision: number;
  requirement_id: string;
  requirement_revision: number;
  calculation_revision_id: string;
  calculation_revision: number;
  calculation_input_sha256_hex: string;
  calculation_result_sha256_hex: string;
  calculation_quality: string;
  calculation_validation_status: string;
  resolution_snapshot: unknown;
  resolution_sha256_hex: string;
  [key: string]: unknown;
};

type OfferCopyLineStateRow = {
  line_id: string;
  position: number;
  quantity: number;
  catalog_component_id: string;
  catalog_component_revision: number;
  component_snapshot_sha256_hex: string;
  current_revision: number | null;
  status: CatalogComponentStatus | null;
  component_exists: boolean;
  [key: string]: unknown;
};

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);

const offerCatalogCopyRequestSchema = z.strictObject({
  projectId: z.uuid().transform((value) => value.toLowerCase()),
  siteId: z.uuid().transform((value) => value.toLowerCase()),
  expectedResolutionRevision: z.int().safe().min(1),
  requirement: z.strictObject({
    id: z.uuid().transform((value) => value.toLowerCase()),
    revision: z.int().safe().min(1),
  }),
  calculation: z.strictObject({
    id: z.uuid().transform((value) => value.toLowerCase()),
    revision: z.int().safe().min(1),
    inputSha256: sha256Schema,
    resultSha256: sha256Schema,
  }),
});

const offerCatalogBindingSchema = z.strictObject({
  resolutionId: z.uuid().transform((value) => value.toLowerCase()),
  resolutionRevision: z.int().safe().min(1),
  resolutionSha256: sha256Schema,
});

const offerCatalogBasisProjectSchema = z.uuid()
  .transform((value) => value.toLowerCase());
const offerCatalogBasisReferenceSchema = z.strictObject({
  expectedRequirementRevision: z.int().safe().min(1),
  expectedCalculationRevision: z.int().safe().min(1),
  expectedResolutionRevision: z.int().safe().min(1),
});

const offerCatalogFreshnessRequestSchema = z.array(z.strictObject({
  requestKey: z.uuid().transform((value) => value.toLowerCase()),
  projectId: z.uuid().transform((value) => value.toLowerCase()),
  bindings: z.array(offerCatalogBindingSchema).min(1).max(12),
})).max(200).superRefine((requests, context) => {
  const keys = new Set<string>();
  for (const [index, request] of requests.entries()) {
    if (keys.has(request.requestKey)) {
      context.addIssue({
        code: "custom",
        path: [index, "requestKey"],
        message: "requestKey must be unique",
      });
    }
    keys.add(request.requestKey);
  }
});

function requireOfferCatalogAccess(
  ctx: ServiceCtx,
  actions: readonly Action[],
  resource: string,
): void {
  for (const action of actions) {
    if (!can(ctx, action)) {
      throw new PermissionDeniedError(action, resource, undefined, ctx.actor);
    }
  }
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      actions[0] ?? "project.read",
      resource,
      "external_only_without_assignment",
      ctx.actor,
    );
  }
}

function validateResolutionRow(
  ctx: ServiceCtx,
  row: OfferCopyResolutionRow,
): OfferCatalogResolutionSnapshot {
  const validated = validateProjectCatalogResolution(row.resolution_snapshot);
  if (
    !validated.ok
    || validated.value.resolutionSha256 !== row.resolution_sha256_hex
    || validated.value.revision !== row.revision
    || validated.value.bindings.workspaceId !== row.workspace_id
    || validated.value.bindings.workspaceId !== ctx.workspaceId
    || validated.value.bindings.projectId !== row.project_id
    || validated.value.bindings.siteId !== row.site_id
    || validated.value.bindings.requirementId !== row.requirement_id
    || validated.value.bindings.requirementRevision !== row.requirement_revision
    || validated.value.bindings.calculationRevisionId
      !== row.calculation_revision_id
    || validated.value.bindings.calculationRevision
      !== row.calculation_revision
    || validated.value.bindings.calculationInputSha256
      !== row.calculation_input_sha256_hex
    || validated.value.bindings.calculationResultSha256
      !== row.calculation_result_sha256_hex
    || validated.value.bindings.calculationQuality !== row.calculation_quality
    || validated.value.bindings.calculationValidationStatus
      !== row.calculation_validation_status
    || validated.value.lines.length < 1
    || validated.value.lines.length > 500
  ) {
    throw new CatalogOfferBridgeIntegrityError();
  }
  return validated.value;
}

/**
 * Purpose-limited, server-only catalog export used while seeding an Offer.
 *
 * The project row is locked before catalog state is read. Catalog component
 * rows are deliberately not locked: catalog writes take Component -> Project,
 * while Offer writes already take Project first. The project lock therefore
 * gives a stable committed catalog view without introducing the inverse
 * Project -> Component lock edge.
 */
export async function readCurrentProjectCatalogForOfferCopy(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferCatalogCopyResult> {
  requireOfferCatalogAccess(
    ctx,
    ["project.write", "price.edit"],
    "offer_catalog_copy",
  );
  const parsed = offerCatalogCopyRequestSchema.safeParse(value);
  if (!parsed.success) throw new CatalogOfferBridgeIntegrityError();
  const request = parsed.data;

  const projectResult = await tx.execute<{
    id: string;
    site_id: string;
    catalog_resolution_status: string;
    [key: string]: unknown;
  }>(sql`
    select id, site_id, catalog_resolution_status
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${request.projectId}::uuid
     for share
  `);
  const project = projectResult.rows[0];
  if (!project) return { state: "blocked", code: "project_not_found" };

  const resolutionResult = await tx.execute<OfferCopyResolutionRow>(sql`
    select id, workspace_id, project_id, site_id, revision,
           requirement_id, requirement_revision, calculation_revision_id,
           calculation_revision,
           encode(calculation_input_sha256, 'hex') as calculation_input_sha256_hex,
           encode(calculation_result_sha256, 'hex') as calculation_result_sha256_hex,
           calculation_quality, calculation_validation_status,
           resolution_snapshot,
           encode(resolution_sha256, 'hex') as resolution_sha256_hex
      from project_catalog_resolution
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${request.projectId}::uuid
     order by revision desc
     limit 1
     for share
  `);
  const row = resolutionResult.rows[0];
  if (!row || row.revision !== request.expectedResolutionRevision) {
    return { state: "conflict" };
  }
  if (
    project.site_id !== request.siteId
    || project.catalog_resolution_status !== "resolved"
    || row.project_id !== request.projectId
    || row.site_id !== request.siteId
    || row.requirement_id !== request.requirement.id
    || row.requirement_revision !== request.requirement.revision
    || row.calculation_revision_id !== request.calculation.id
    || row.calculation_revision !== request.calculation.revision
    || row.calculation_input_sha256_hex !== request.calculation.inputSha256
    || row.calculation_result_sha256_hex !== request.calculation.resultSha256
    || row.calculation_quality !== "server_reproduced_estimate"
    || row.calculation_validation_status !== "not_f4_reference_validated"
  ) {
    return { state: "blocked", code: "resolution_not_current" };
  }

  const snapshot = validateResolutionRow(ctx, row);
  const states = await tx.execute<OfferCopyLineStateRow>(sql`
    select line.id as line_id, line.position, line.quantity::integer as quantity,
           line.catalog_component_id, line.catalog_component_revision,
           encode(line.component_snapshot_sha256, 'hex')
             as component_snapshot_sha256_hex,
           component.current_revision, component.status,
           component.id is not null as component_exists
      from project_catalog_resolution_line line
      left join catalog_component component
        on component.workspace_id = line.workspace_id
       and component.id = line.catalog_component_id
     where line.workspace_id = ${ctx.workspaceId}::uuid
       and line.resolution_id = ${row.id}::uuid
     order by line.position
  `);
  if (states.rows.length !== snapshot.lines.length) {
    throw new CatalogOfferBridgeIntegrityError();
  }
  for (const [index, state] of states.rows.entries()) {
    const line = snapshot.lines[index];
    if (
      !line
      || !state.component_exists
      || state.line_id !== line.lineId
      || state.position !== line.position
      || state.quantity !== line.quantity
      || state.catalog_component_id !== line.catalogComponentId
      || state.catalog_component_revision !== line.catalogComponentRevision
      || state.component_snapshot_sha256_hex !== line.componentSnapshotSha256
    ) {
      throw new CatalogOfferBridgeIntegrityError();
    }
    if (
      state.current_revision !== state.catalog_component_revision
      || state.status !== "active"
      || line.componentSnapshot.commercial === null
    ) {
      return { state: "blocked", code: "resolution_not_current" };
    }
  }

  return {
    state: "current",
    copy: {
      resolutionId: row.id,
      resolutionRevision: row.revision,
      resolutionSha256: row.resolution_sha256_hex,
      snapshot,
    },
  };
}

/**
 * Returns only the optimistic-concurrency revisions needed to request a new
 * Offer basis. This is an untrusted UI hint, never commercial input: the
 * mutation reloads and validates the complete current basis under lock.
 */
export async function readCurrentProjectCatalogBasisReference(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferCatalogBasisReference | null> {
  requireOfferCatalogAccess(
    ctx,
    ["project.write", "price.edit"],
    "offer_catalog_basis_reference",
  );
  const parsedProjectId = offerCatalogBasisProjectSchema.safeParse(value);
  if (!parsedProjectId.success) throw new CatalogOfferBridgeIntegrityError();

  const result = await tx.execute<{
    catalog_resolution_status: string;
    expected_requirement_revision: number;
    expected_calculation_revision: number;
    expected_resolution_revision: number;
    [key: string]: unknown;
  }>(sql`
    select project_record.catalog_resolution_status,
           resolution.requirement_revision as expected_requirement_revision,
           resolution.calculation_revision as expected_calculation_revision,
           resolution.revision as expected_resolution_revision
      from project project_record
      join project_catalog_resolution resolution
        on resolution.workspace_id = project_record.workspace_id
       and resolution.project_id = project_record.id
     where project_record.workspace_id = ${ctx.workspaceId}::uuid
       and project_record.id = ${parsedProjectId.data}::uuid
     order by resolution.revision desc
     limit 1
  `);
  const row = result.rows[0];
  if (!row || row.catalog_resolution_status !== "resolved") return null;
  const parsed = offerCatalogBasisReferenceSchema.safeParse({
    expectedRequirementRevision: row.expected_requirement_revision,
    expectedCalculationRevision: row.expected_calculation_revision,
    expectedResolutionRevision: row.expected_resolution_revision,
  });
  if (!parsed.success) throw new CatalogOfferBridgeIntegrityError();
  return parsed.data;
}

/**
 * Returns only freshness booleans for Offer read models. No snapshot, price,
 * component identity, or provenance crosses this read boundary.
 */
export async function readOfferCatalogFreshness(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<ReadonlyMap<string, boolean>> {
  requireOfferCatalogAccess(ctx, ["project.read"], "offer_catalog_freshness");
  const parsed = offerCatalogFreshnessRequestSchema.safeParse(value);
  if (!parsed.success) throw new CatalogOfferBridgeIntegrityError();
  if (parsed.data.length === 0) return new Map();

  const payload = parsed.data.map((request) => ({
    request_key: request.requestKey,
    project_id: request.projectId,
    bindings: request.bindings.map((binding) => ({
      resolution_id: binding.resolutionId,
      resolution_revision: binding.resolutionRevision,
      resolution_sha256: binding.resolutionSha256,
    })),
  }));
  const result = await tx.execute<{
    request_key: string;
    outdated: boolean;
    [key: string]: unknown;
  }>(sql`
    with request_row as materialized (
      select input.request_key::uuid as request_key,
             input.project_id::uuid as project_id,
             input.bindings
        from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb)
          as input(request_key text, project_id text, bindings jsonb)
    ),
    binding_row as materialized (
      select request.request_key, request.project_id,
             binding.resolution_id::uuid as resolution_id,
             binding.resolution_revision,
             binding.resolution_sha256
        from request_row request
        cross join lateral jsonb_to_recordset(request.bindings)
          as binding(
            resolution_id text,
            resolution_revision integer,
            resolution_sha256 text
          )
    ),
    latest_resolution as materialized (
      select distinct on (resolution.project_id)
             resolution.project_id, resolution.id, resolution.revision,
             encode(resolution.resolution_sha256, 'hex') as resolution_sha256_hex
        from project_catalog_resolution resolution
        join (select distinct project_id from request_row) requested
          on requested.project_id = resolution.project_id
       where resolution.workspace_id = ${ctx.workspaceId}::uuid
       order by resolution.project_id, resolution.revision desc
    ),
    binding_state as (
      select binding.request_key,
             bool_or(
               latest.id = binding.resolution_id
               and latest.revision = binding.resolution_revision
               and latest.resolution_sha256_hex = binding.resolution_sha256
               and exists (
                 select 1
                   from project_catalog_resolution_line source_line
                  where source_line.workspace_id = ${ctx.workspaceId}::uuid
                    and source_line.resolution_id = latest.id
               )
               and not exists (
                 select 1
                   from project_catalog_resolution_line source_line
                   left join catalog_component component
                     on component.workspace_id = source_line.workspace_id
                    and component.id = source_line.catalog_component_id
                  where source_line.workspace_id = ${ctx.workspaceId}::uuid
                    and source_line.resolution_id = latest.id
                    and (
                      component.id is null
                      or component.status <> 'active'
                      or component.current_revision
                        <> source_line.catalog_component_revision
                    )
               )
             ) as any_current
        from binding_row binding
        left join latest_resolution latest
          on latest.project_id = binding.project_id
       group by binding.request_key
    )
    select request.request_key::text as request_key,
           project_record.id is null
           or project_record.site_id is null
           or project_record.catalog_resolution_status <> 'resolved'
           or coalesce(binding_state.any_current, false) is not true as outdated
      from request_row request
      left join project project_record
        on project_record.workspace_id = ${ctx.workspaceId}::uuid
       and project_record.id = request.project_id
      left join binding_state
        on binding_state.request_key = request.request_key
     order by request.request_key
  `);

  const freshness = new Map(parsed.data.map((request) => [request.requestKey, true]));
  for (const row of result.rows) {
    if (freshness.has(row.request_key) && typeof row.outdated === "boolean") {
      freshness.set(row.request_key, row.outdated);
    }
  }
  return freshness;
}
