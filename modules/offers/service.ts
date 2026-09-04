import "server-only";

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  OFFER_CANONICALIZATION_VERSION,
  OFFER_VARIANT_SNAPSHOT_VERSION,
  canonicalizeOfferJson,
  createOfferCommandV1Schema,
  createVariantFromResolutionCommandV1Schema,
  duplicateOfferVariantCommandV1Schema,
  hashOfferCreateDigest,
  offerContactContextV1Schema,
  offerInstallationSiteContextV1Schema,
  offerPriceAudienceDecisionV1Schema,
  optionalBundlesSchema,
  reviseOfferVariantCommandV1Schema,
  sealOfferVariantSnapshot,
  setOptionalBundlesCommandV1Schema,
  setPrimaryVariantCommandV1Schema,
  setTotalPriceOverrideCommandV1Schema,
  toOfferVariantView,
  validateOfferVariantSnapshot,
  type CreateOfferCommandV1,
  type CreateVariantFromResolutionCommandV1,
  type DuplicateOfferVariantCommandV1,
  type OfferContactContextV1,
  type OfferInstallationSiteContextV1,
  type OfferSourceBindingsV1,
  type OfferVariantSnapshotV1,
  type OfferVariantViewV1,
  type ReviseOfferVariantCommandV1,
  type ReviseOfferVariantOperationV1,
  type SetOptionalBundlesCommandV1,
  type SetPrimaryVariantCommandV1,
  type SetTotalPriceOverrideCommandV1,
} from "@/lib/integrations/offers/contract";
import { calculateOfferPricing } from "@/lib/integrations/offers/money";
import { OfferRateLimitError } from "@/lib/integrations/offers/admission";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type Action,
  type ServiceCtx,
} from "@/lib/permissions";
import {
  CatalogOfferBridgeIntegrityError,
  readCurrentProjectCatalogBasisReference,
  readCurrentProjectCatalogForOfferCopy,
  readOfferCatalogFreshness,
  type OfferCatalogResolutionSnapshot,
} from "@/modules/catalog";

export type OfferMutationResult = {
  offerId: string;
  variantId: string;
  revision: number;
};

export type OfferListViewModel = {
  state: "loaded" | "empty" | "blocked" | "read_only";
  workspaceId: string;
  permissions: { canCreate: boolean };
  blockers: Array<{ code: string; label: string }>;
  columns: Array<{
    id: string;
    title: string;
    offers: Array<{
      id: string;
      href: string;
      offerNumber: string;
      customerDisplayName: string;
      installationSiteLabel: string;
      variantCount: number;
      updatedAtLabel: string;
      outdated: boolean;
    }>;
  }>;
};

export type OfferDetailViewModel = {
  state:
    | "loaded" | "blocked" | "outdated" | "dirty" | "pending"
    | "conflict" | "validation" | "unavailable" | "unauthenticated"
    | "success" | "read_only";
  workspaceId: string;
  offer: {
    id: string;
    projectId: string;
    projectOutcome: string;
    offerNumber: string;
    status: "draft";
    outdated: boolean;
    forecastValueNetCents: number | null;
    totalPriceOverrideNetCents: number | null;
  };
  primaryVariantId: string | null;
  overrideActive: boolean;
  displayTotalNetCents: number | null;
  displayTotalGrossCents: number | null;
  variants: Array<{
    id: string;
    name: string;
    revision: number;
    isPrimary: boolean;
    active: boolean;
    href: string;
  }>;
  activeVariant: OfferVariantViewV1;
  newBasisInput: {
    expectedRequirementRevision: number;
    expectedCalculationRevision: number;
    expectedResolutionRevision: number;
  } | null;
  permissions: {
    canEdit: boolean;
    canDuplicate: boolean;
    canCreateBasis: boolean;
    canReadPurchasePrice: boolean;
  };
  actionState: { status: "idle" };
};

export class OfferValidationError extends Error {
  constructor(public readonly paths: string[] = []) {
    super("offer command is invalid");
    this.name = "OfferValidationError";
  }
}

export class OfferConflictError extends Error {
  constructor(public readonly currentRevision?: number) {
    super("offer changed since it was loaded");
    this.name = "OfferConflictError";
  }
}

export { OfferRateLimitError };

export class OfferNotFoundError extends Error {
  constructor() {
    super("offer was not found");
    this.name = "OfferNotFoundError";
  }
}

export class OfferBlockedError extends OfferValidationError {
  constructor(public readonly code: string) {
    super([`/blocked/${code}`]);
    this.name = "OfferBlockedError";
  }
}

export class OfferIntegrityError extends Error {
  constructor() {
    super("stored offer data failed integrity validation");
    this.name = "OfferIntegrityError";
  }
}

export class OfferPersistenceError extends Error {
  constructor() {
    super("offer persistence failed");
    this.name = "OfferPersistenceError";
  }
}

type OfferRow = {
  id: string;
  workspace_id: string;
  project_id: string;
  contact_id: string;
  site_id: string;
  status: "draft";
  offer_number: string;
  forecast_value_net_cents: number | null;
  total_price_override_net_cents: number | null;
  contact_context: OfferContactContextV1;
  installation_site_context: OfferInstallationSiteContextV1;
  source_bindings: OfferSourceBindingsV1;
  price_audience_decision: PriceAudienceDecision;
  create_digest_hex: string;
  resolution_id: string;
  resolution_revision: number;
  resolution_sha256_hex: string;
  [key: string]: unknown;
};

type VariantRow = {
  id: string;
  offer_id: string;
  ordinal: number;
  current_revision: number;
  name: string;
  description: string | null;
  is_primary: boolean;
  optional_bundles: unknown;
  [key: string]: unknown;
};

type RevisionRow = {
  id: string;
  revision_snapshot: unknown;
  snapshot_sha256_hex: string;
  resolution_id: string;
  resolution_revision: number;
  resolution_sha256_hex: string;
  [key: string]: unknown;
};

type ProjectBasisRow = {
  id: string;
  contact_id: string;
  site_id: string;
  phase: string;
  outcome: string;
  source_key: string;
  dedupe_review_required: boolean;
  kanban_board_id: string;
  kanban_column_id: string;
  board_scope: string;
  board_is_default: boolean;
  board_archived_at: Date | string | null;
  column_type: string;
  column_archived_at: Date | string | null;
  display_name: string;
  email_primary: string | null;
  email_normalized: string | null;
  phone_e164: string | null;
  contact_deleted_at: Date | string | null;
  address_mode: string;
  formatted_address: string | null;
  street: string | null;
  house_number: string | null;
  postal_code: string | null;
  city: string | null;
  country: string;
  address_follow_up_required: boolean;
  address_revision: number;
  pin_confirmed: boolean;
  pin_confirmed_address_revision: number | null;
  [key: string]: unknown;
};

type ReceiptRow = {
  id: string;
  body_sha256_hex: string;
  source_key: string;
  privacy_purpose: string;
  project_id: string;
  contact_id: string;
  site_id: string;
  [key: string]: unknown;
};

type RequirementRow = {
  id: string;
  revision: number;
  [key: string]: unknown;
};

type CalculationRow = {
  id: string;
  project_id: string;
  site_id: string;
  revision: number;
  requirement_id: string;
  requirement_revision: number;
  address_revision: number;
  pin_confirmed_address_revision: number;
  confirmed_address_revision: number;
  quality: string;
  validation_status: string;
  input_sha256_hex: string;
  result_sha256_hex: string;
  [key: string]: unknown;
};

function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map((issue) => (
    issue.path.length === 0 ? "/" : `/${issue.path.map(String).join("/")}`
  )))].slice(0, 20);
}

function requireOfferAccess(ctx: ServiceCtx, action: Action, resource: string): void {
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

function canUseOfferActions(ctx: ServiceCtx, ...actions: Action[]): boolean {
  return !isExternalOnly(ctx)
    && actions.every((action) => can(ctx, action));
}

function iso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new OfferIntegrityError();
  return parsed.toISOString();
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

function formatUpdatedAt(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new OfferIntegrityError();
  return new Intl.DateTimeFormat("de-DE", {
    timeZone: "Europe/Berlin",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

export async function listOffers(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<OfferListViewModel> {
  requireOfferAccess(ctx, "project.read", "offer_list");
  const canCreate = canUseOfferActions(
    ctx,
    "project.write",
    "phase.convert",
    "price.edit",
  );
  // Existing drafts remain structurally editable with project.write alone.
  // Create rights are intentionally stronger and must not downgrade such an
  // editor to a misleading read-only list state.
  const canEdit = canUseOfferActions(ctx, "project.write");
  const boardResult = await tx.execute<{
    id: string;
    name: string;
    [key: string]: unknown;
  }>(sql`
    select id, name
      from kanban_board
     where workspace_id = ${ctx.workspaceId}::uuid
       and scope = 'residential'
       and is_default = true
       and archived_at is null
     order by id
     limit 2
  `);
  if (boardResult.rows.length !== 1) {
    return {
      state: "blocked",
      workspaceId: ctx.workspaceId,
      permissions: { canCreate },
      blockers: [{
        code: "default_board",
        label: boardResult.rows.length === 0
          ? "Standard-Board fehlt"
          : "Mehrere Standard-Boards gefunden",
      }],
      columns: [],
    };
  }
  const board = boardResult.rows[0]!;
  const columnResult = await tx.execute<{
    id: string;
    name: string;
    [key: string]: unknown;
  }>(sql`
    select id, name
      from kanban_column
     where workspace_id = ${ctx.workspaceId}::uuid
       and board_id = ${board.id}::uuid
       and column_type = 'offer'
       and archived_at is null
     order by position, id
     limit 2
  `);
  if (columnResult.rows.length !== 1) {
    return {
      state: "blocked",
      workspaceId: ctx.workspaceId,
      permissions: { canCreate },
      blockers: [{
        code: "offer_column",
        label: columnResult.rows.length === 0
          ? "Angebotsspalte fehlt"
          : "Mehrere Angebotsspalten gefunden",
      }],
      columns: [],
    };
  }
  const column = columnResult.rows[0]!;
  const result = await tx.execute<{
    id: string;
    project_id: string;
    offer_number: string;
    contact_context: OfferContactContextV1;
    installation_site_context: OfferInstallationSiteContextV1;
    updated_at: Date | string;
    variant_count: number;
    first_variant_id: string;
    catalog_bindings: unknown;
    [key: string]: unknown;
  }>(sql`
    select offer_record.id, offer_record.project_id, offer_record.offer_number,
           offer_record.contact_context, offer_record.installation_site_context,
           offer_record.updated_at,
           count(variant.id)::integer as variant_count,
           (array_agg(variant.id order by variant.ordinal))[1] as first_variant_id,
           jsonb_agg(jsonb_build_object(
             'resolutionId', current_revision.resolution_id::text,
             'resolutionRevision', current_revision.resolution_revision,
             'resolutionSha256', encode(current_revision.resolution_sha256, 'hex')
           ) order by variant.ordinal, variant.id) as catalog_bindings
      from offer offer_record
      join project project_record
        on project_record.workspace_id = offer_record.workspace_id
       and project_record.id = offer_record.project_id
      join offer_variant variant
        on variant.workspace_id = offer_record.workspace_id
       and variant.offer_id = offer_record.id
      join offer_variant_revision current_revision
        on current_revision.workspace_id = variant.workspace_id
       and current_revision.offer_id = variant.offer_id
       and current_revision.variant_id = variant.id
       and current_revision.revision = variant.current_revision
     where offer_record.workspace_id = ${ctx.workspaceId}::uuid
       and project_record.kanban_board_id = ${board.id}::uuid
       and project_record.kanban_column_id = ${column.id}::uuid
     group by offer_record.id
     order by offer_record.updated_at desc, offer_record.id
     limit 200
  `);
  let catalogFreshness: ReadonlyMap<string, boolean> = new Map();
  try {
    catalogFreshness = await readOfferCatalogFreshness(
      tx,
      ctx,
      result.rows.map((row) => ({
        requestKey: row.id,
        projectId: row.project_id,
        bindings: row.catalog_bindings,
      })),
    );
  } catch (error) {
    if (error instanceof CatalogOfferBridgeIntegrityError) {
      throw new OfferIntegrityError();
    }
    throw error;
  }
  const offers = result.rows.map((row) => ({
    id: row.id,
    href: `/w/${ctx.workspaceId}/angebote/${row.id}?variante=${row.first_variant_id}`,
    offerNumber: row.offer_number,
    customerDisplayName: row.contact_context.displayName,
    installationSiteLabel: row.installation_site_context.formattedAddress,
    variantCount: row.variant_count,
    updatedAtLabel: formatUpdatedAt(row.updated_at),
    outdated: catalogFreshness.get(row.id) ?? true,
  }));
  return {
    state: offers.length === 0 ? "empty" : canEdit ? "loaded" : "read_only",
    workspaceId: ctx.workspaceId,
    permissions: { canCreate },
    blockers: [],
    columns: offers.length === 0 ? [] : [{ id: column.id, title: column.name, offers }],
  };
}

export async function getOfferDetail(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { offerId: string; variantId: string | null },
): Promise<OfferDetailViewModel | null> {
  requireOfferAccess(ctx, "project.read", "offer_detail");
  const parsed = z.strictObject({
    offerId: z.uuid().transform((value) => value.toLowerCase()),
    variantId: z.uuid().transform((value) => value.toLowerCase()).nullable(),
  }).safeParse(input);
  if (!parsed.success) throw new OfferValidationError(issuePaths(parsed.error));

  const offerResult = await tx.execute<{
    id: string;
    project_id: string;
    project_outcome: string;
    offer_number: string;
    status: "draft";
    forecast_value_net_cents: string | null;
    total_price_override_net_cents: string | null;
    [key: string]: unknown;
  }>(sql`
    select offer_record.id, offer_record.project_id,
           project_record.outcome as project_outcome,
           offer_record.offer_number, offer_record.status,
           offer_record.forecast_value_net_cents,
           offer_record.total_price_override_net_cents
      from offer offer_record
      join project project_record
        on project_record.workspace_id = offer_record.workspace_id
       and project_record.id = offer_record.project_id
     where offer_record.workspace_id = ${ctx.workspaceId}::uuid
       and offer_record.id = ${parsed.data.offerId}::uuid
     limit 1
  `);
  const offerRecord = offerResult.rows[0];
  if (!offerRecord) return null;
  const forecastValueNetCents = offerRecord.forecast_value_net_cents === null
    ? null
    : Number(offerRecord.forecast_value_net_cents);
  if (
    forecastValueNetCents !== null
    && (!Number.isSafeInteger(forecastValueNetCents) || forecastValueNetCents < 0)
  ) {
    throw new OfferIntegrityError();
  }
  // Robuster Read: optionale Spalte fehlt in Unit-Fixtures/Alt-Zeilen
  // (undefined) — wie NULL behandeln, nur echte Werte validieren.
  const overrideRaw = offerRecord.total_price_override_net_cents;
  const totalPriceOverrideNetCents = overrideRaw === null || overrideRaw === undefined
    ? null
    : Number(overrideRaw);
  if (
    totalPriceOverrideNetCents !== null
    && (!Number.isSafeInteger(totalPriceOverrideNetCents) || totalPriceOverrideNetCents < 0)
  ) {
    throw new OfferIntegrityError();
  }

  const variantsResult = await tx.execute<VariantRow>(sql`
    select id, offer_id, ordinal, current_revision, name, description, is_primary
      from offer_variant
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${offerRecord.id}::uuid
     order by ordinal, id
  `);
  if (variantsResult.rows.length === 0) throw new OfferIntegrityError();
  const active = parsed.data.variantId === null
    ? variantsResult.rows[0]
    : variantsResult.rows.find((variant) => variant.id === parsed.data.variantId)
      ?? variantsResult.rows[0];

  const revisionResult = await tx.execute<RevisionRow>(sql`
    select id, revision_snapshot, encode(snapshot_sha256, 'hex') as snapshot_sha256_hex,
           resolution_id, resolution_revision,
           encode(resolution_sha256, 'hex') as resolution_sha256_hex
      from offer_variant_revision
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${offerRecord.id}::uuid
       and variant_id = ${active.id}::uuid
       and revision = ${active.current_revision}
     limit 1
  `);
  const revision = revisionResult.rows[0];
  if (!revision) throw new OfferIntegrityError();
  const validated = validateOfferVariantSnapshot(revision.revision_snapshot);
  if (!validated.ok || validated.value.snapshotSha256 !== revision.snapshot_sha256_hex) {
    throw new OfferIntegrityError();
  }

  let freshness: ReadonlyMap<string, boolean>;
  try {
    freshness = await readOfferCatalogFreshness(tx, ctx, [{
      requestKey: offerRecord.id,
      projectId: offerRecord.project_id,
      bindings: [{
        resolutionId: revision.resolution_id,
        resolutionRevision: revision.resolution_revision,
        resolutionSha256: revision.resolution_sha256_hex,
      }],
    }]);
  } catch (error) {
    if (error instanceof CatalogOfferBridgeIntegrityError) {
      throw new OfferIntegrityError();
    }
    throw error;
  }
  const outdated = freshness.get(offerRecord.id) ?? true;

  const canReadPurchasePrice = canUseOfferActions(ctx, "price.read_purchase");
  const canEdit = canUseOfferActions(ctx, "project.write");
  const canDuplicate = canEdit;
  const canCreateBasis = canUseOfferActions(ctx, "project.write", "price.edit");
  let newBasisInput: OfferDetailViewModel["newBasisInput"] = null;
  if (canCreateBasis && variantsResult.rows.length < 12) {
    try {
      newBasisInput = await readCurrentProjectCatalogBasisReference(
        tx,
        ctx,
        offerRecord.project_id,
      );
    } catch (error) {
      if (error instanceof CatalogOfferBridgeIntegrityError) {
        throw new OfferIntegrityError();
      }
      throw error;
    }
  }
  const activeVariant = toOfferVariantView(validated.value, {
    canReadPurchasePrice,
    canReadPrivateHashes: false,
  });
  const primaryRow = variantsResult.rows.find((variant) => variant.is_primary) ?? null;
  let primaryBasisNetCents: number | null = null;
  let primaryBasisGrossCents: number | null = null;
  if (primaryRow) {
    const primarySnapshot = await readValidatedRevision(
      tx,
      ctx,
      offerRecord.id,
      primaryRow.id,
      primaryRow.current_revision,
    );
    primaryBasisNetCents = primarySnapshot.totals.basisNetCents;
    primaryBasisGrossCents = primarySnapshot.totals.basisGrossCents;
  }
  const overrideActive = totalPriceOverrideNetCents !== null;
  return {
    state: outdated ? "outdated" : canEdit ? "loaded" : "read_only",
    workspaceId: ctx.workspaceId,
    offer: {
      id: offerRecord.id,
      projectId: offerRecord.project_id,
      projectOutcome: offerRecord.project_outcome,
      offerNumber: offerRecord.offer_number,
      status: offerRecord.status,
      outdated,
      forecastValueNetCents,
      totalPriceOverrideNetCents,
    },
    primaryVariantId: primaryRow?.id ?? null,
    overrideActive,
    displayTotalNetCents: overrideActive ? totalPriceOverrideNetCents : primaryBasisNetCents,
    displayTotalGrossCents: overrideActive ? null : primaryBasisGrossCents,
    variants: variantsResult.rows.map((variant) => ({
      id: variant.id,
      name: variant.name,
      revision: variant.current_revision,
      isPrimary: variant.is_primary,
      active: variant.id === active.id,
      href: `/w/${ctx.workspaceId}/angebote/${offerRecord.id}?variante=${variant.id}`,
    })),
    activeVariant,
    newBasisInput,
    permissions: {
      canEdit,
      canDuplicate: canDuplicate && variantsResult.rows.length < 12,
      canCreateBasis: canCreateBasis && variantsResult.rows.length < 12,
      canReadPurchasePrice,
    },
    actionState: { status: "idle" },
  };
}

type SnapshotSection = OfferVariantSnapshotV1["sections"][number];
type SnapshotLine = SnapshotSection["lines"][number];
type SnapshotLineBody = Omit<SnapshotLine, "computed">;
type SnapshotSectionBody = Omit<SnapshotSection, "lines"> & {
  lines: SnapshotLineBody[];
};
type TaxDecision = OfferVariantSnapshotV1["taxDecision"];
type PriceAudienceDecision = OfferVariantSnapshotV1["priceAudienceDecision"];
type OfferCatalogResolutionLine = OfferCatalogResolutionSnapshot["lines"][number];
type OfferCatalogComponentSnapshot = OfferCatalogResolutionLine["componentSnapshot"];
type OfferCatalogComponentType = OfferCatalogComponentSnapshot["identity"]["componentType"];

type CurrentBasis = {
  project: ProjectBasisRow;
  receipt: ReceiptRow;
  requirement: RequirementRow;
  calculation: CalculationRow;
  resolutionRow: {
    id: string;
    revision: number;
    resolution_sha256_hex: string;
  };
  resolution: OfferCatalogResolutionSnapshot;
  sourceBindings: OfferSourceBindingsV1;
  contactContext: OfferContactContextV1;
  installationSiteContext: OfferInstallationSiteContextV1;
  offerColumnId: string;
};

function taxDecision(
  treatment: "standard_19" | "zero_operator_confirmed",
  actor: string,
  at: string,
): TaxDecision {
  return treatment === "standard_19"
    ? { treatment, rateBps: 1_900, selectedBy: actor, selectedAt: at }
    : {
        treatment,
        rateBps: 0,
        selectedBy: actor,
        selectedAt: at,
        confirmationCode: "zero_tax_draft_operator_confirmed",
        confirmedBy: actor,
        confirmedAt: at,
      };
}

async function databaseNow(tx: TenantTx): Promise<string> {
  const result = await tx.execute<{ now: Date | string; [key: string]: unknown }>(sql`
    -- Callers acquire the relevant row lock before asking for a timestamp.
    -- clock_timestamp() therefore reflects the post-wait wall clock; a
    -- transaction that started earlier cannot move updated_at backwards after
    -- a younger transaction commits while it was waiting for that lock.
    select clock_timestamp() as now
  `);
  const value = result.rows[0]?.now;
  if (!value) throw new OfferPersistenceError();
  return iso(value);
}

async function lockProjectBasis(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectBasisRow> {
  // Lock the mutable project row in its own statement. A SELECT ... FOR UPDATE
  // that also joins the current board column can otherwise lose the row during
  // EvalPlanQual after waiting: the project may now point at the offer column,
  // while the waiting statement still evaluates the join against its older
  // snapshot. The second statement starts after the lock and therefore reads
  // one coherent, current basis for create/replay decisions.
  const locked = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     for update
  `);
  if (!locked.rows[0]) throw new OfferBlockedError("project_not_found");

  const result = await tx.execute<ProjectBasisRow>(sql`
    select project_record.id, project_record.contact_id, project_record.site_id,
           project_record.phase, project_record.outcome, project_record.source_key,
           project_record.dedupe_review_required,
           project_record.kanban_board_id, project_record.kanban_column_id,
           board.scope as board_scope, board.is_default as board_is_default,
           board.archived_at as board_archived_at,
           board_column.column_type, board_column.archived_at as column_archived_at,
           contact_record.display_name, contact_record.email_primary,
           contact_record.email_normalized,
           contact_record.phone_e164, contact_record.deleted_at as contact_deleted_at,
           site_record.address_mode, site_record.formatted_address,
           site_record.street, site_record.house_number, site_record.postal_code,
           site_record.city, site_record.country,
           site_record.address_follow_up_required, site_record.address_revision,
           site_record.pin_confirmed, site_record.pin_confirmed_address_revision
      from project project_record
      join contact contact_record
        on contact_record.workspace_id = project_record.workspace_id
       and contact_record.id = project_record.contact_id
      join site site_record
        on site_record.workspace_id = project_record.workspace_id
       and site_record.id = project_record.site_id
       and site_record.contact_id = project_record.contact_id
      join kanban_board board
        on board.workspace_id = project_record.workspace_id
       and board.id = project_record.kanban_board_id
      join kanban_column board_column
        on board_column.workspace_id = project_record.workspace_id
       and board_column.board_id = project_record.kanban_board_id
       and board_column.id = project_record.kanban_column_id
     where project_record.workspace_id = ${ctx.workspaceId}::uuid
       and project_record.id = ${projectId}::uuid
  `);
  const projectRecord = result.rows[0];
  if (!projectRecord) throw new OfferBlockedError("project_not_found");
  return projectRecord;
}

async function readExistingOfferForProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<(OfferRow & { basis_variant_id: string; basis_revision: number }) | null> {
  const result = await tx.execute<OfferRow & {
    basis_variant_id: string;
    basis_revision: number;
  }>(sql`
    select offer_record.id, offer_record.workspace_id, offer_record.project_id,
           offer_record.contact_id, offer_record.site_id, offer_record.status,
           offer_record.offer_number, offer_record.forecast_value_net_cents,
           offer_record.contact_context, offer_record.installation_site_context,
           offer_record.source_bindings, offer_record.price_audience_decision,
           encode(offer_record.create_digest, 'hex') as create_digest_hex,
           offer_record.resolution_id, offer_record.resolution_revision,
           encode(offer_record.resolution_sha256, 'hex') as resolution_sha256_hex,
           variant.id as basis_variant_id,
           variant.current_revision as basis_revision
      from offer offer_record
      join offer_variant variant
        on variant.workspace_id = offer_record.workspace_id
       and variant.offer_id = offer_record.id
       and variant.ordinal = 1
     where offer_record.workspace_id = ${ctx.workspaceId}::uuid
       and offer_record.project_id = ${projectId}::uuid
     limit 1
  `);
  return result.rows[0] ?? null;
}

async function loadCurrentBasis(
  tx: TenantTx,
  ctx: ServiceCtx,
  project: ProjectBasisRow,
  expected: {
    requirementRevision: number;
    calculationRevision: number;
    resolutionRevision: number;
  },
): Promise<CurrentBasis> {
  if (
    project.outcome !== "open"
    || project.source_key !== "wmee-rechner-v3"
    || project.dedupe_review_required
    || project.board_scope !== "residential"
    || !project.board_is_default
    || project.board_archived_at !== null
    || project.column_archived_at !== null
  ) throw new OfferBlockedError("project_not_eligible");
  if (
    project.contact_deleted_at !== null
    || project.address_mode !== "selected"
    || project.address_follow_up_required
    || !project.pin_confirmed
    || project.pin_confirmed_address_revision !== project.address_revision
    || !project.formatted_address || !project.street || !project.house_number
    || !project.postal_code || !project.city
  ) throw new OfferBlockedError("address_not_confirmed");

  // A TenantTx is backed by one pg client. Keep the lock/read sequence
  // explicit: concurrent client.query calls are deprecated in pg and make
  // lock acquisition order dependent on driver scheduling.
  const receiptResult = await tx.execute<ReceiptRow>(sql`
        select id, encode(body_sha256, 'hex') as body_sha256_hex,
               source_key, privacy_purpose, project_id, contact_id, site_id
          from inbound_receipt
         where workspace_id = ${ctx.workspaceId}::uuid
           and project_id = ${project.id}::uuid
         limit 1
         for share
      `);
  const requirementResult = await tx.execute<RequirementRow>(sql`
        select id, revision
          from project_requirement
         where workspace_id = ${ctx.workspaceId}::uuid
           and project_id = ${project.id}::uuid
         order by revision desc
         limit 1
         for share
      `);
  const calculationResult = await tx.execute<CalculationRow>(sql`
        select id, project_id, site_id, revision, requirement_id,
               requirement_revision, address_revision,
               pin_confirmed_address_revision, confirmed_address_revision,
               quality, validation_status,
               encode(input_sha256, 'hex') as input_sha256_hex,
               encode(result_sha256, 'hex') as result_sha256_hex
          from project_calculation_revision
         where workspace_id = ${ctx.workspaceId}::uuid
           and project_id = ${project.id}::uuid
         order by revision desc
         limit 1
         for share
      `);
  const offerColumns = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
        select id
          from kanban_column
         where workspace_id = ${ctx.workspaceId}::uuid
           and board_id = ${project.kanban_board_id}::uuid
           and column_type = 'offer'
           and archived_at is null
         order by position, id
         limit 2
      `);
  const receipt = receiptResult.rows[0];
  const requirement = requirementResult.rows[0];
  const calculation = calculationResult.rows[0];
  if (!receipt || receipt.source_key !== "wmee-rechner-v3"
    || receipt.privacy_purpose !== "offer_request"
    || receipt.project_id !== project.id || receipt.contact_id !== project.contact_id
    || receipt.site_id !== project.site_id) {
    throw new OfferBlockedError("inbound_binding_missing");
  }
  if (!requirement || requirement.revision !== expected.requirementRevision) {
    throw new OfferConflictError();
  }
  if (!calculation || calculation.revision !== expected.calculationRevision) {
    throw new OfferConflictError();
  }
  if (
    calculation.project_id !== project.id
    || calculation.site_id !== project.site_id
    || calculation.requirement_id !== requirement.id
    || calculation.requirement_revision !== requirement.revision
    || calculation.address_revision !== project.address_revision
    || calculation.pin_confirmed_address_revision !== project.address_revision
    || calculation.confirmed_address_revision !== project.address_revision
    || calculation.quality !== "server_reproduced_estimate"
    || calculation.validation_status !== "not_f4_reference_validated"
  ) throw new OfferBlockedError("calculation_not_current");
  if (offerColumns.rows.length !== 1) throw new OfferBlockedError("offer_column_configuration");
  let catalogCopyResult;
  try {
    catalogCopyResult = await readCurrentProjectCatalogForOfferCopy(tx, ctx, {
      projectId: project.id,
      siteId: project.site_id,
      expectedResolutionRevision: expected.resolutionRevision,
      requirement: {
        id: requirement.id,
        revision: requirement.revision,
      },
      calculation: {
        id: calculation.id,
        revision: calculation.revision,
        inputSha256: calculation.input_sha256_hex,
        resultSha256: calculation.result_sha256_hex,
      },
    });
  } catch (error) {
    if (error instanceof CatalogOfferBridgeIntegrityError) {
      throw new OfferIntegrityError();
    }
    throw error;
  }
  if (catalogCopyResult.state === "conflict") throw new OfferConflictError();
  if (catalogCopyResult.state === "blocked") {
    throw new OfferBlockedError(catalogCopyResult.code);
  }
  const catalogCopy = catalogCopyResult.copy;
  const resolutionRow = {
    id: catalogCopy.resolutionId,
    revision: catalogCopy.resolutionRevision,
    resolution_sha256_hex: catalogCopy.resolutionSha256,
  };

  const parsedContactContext = offerContactContextV1Schema.safeParse({
    displayName: project.display_name,
    emailPrimary: project.email_primary,
    phoneE164: project.phone_e164,
  });
  const parsedInstallationSiteContext = offerInstallationSiteContextV1Schema.safeParse({
    addressRevision: project.address_revision,
    formattedAddress: project.formatted_address,
    street: project.street,
    houseNumber: project.house_number,
    postalCode: project.postal_code,
    city: project.city,
    country: project.country,
  });
  if (
    !parsedContactContext.success
    || !parsedInstallationSiteContext.success
    || (parsedContactContext.data.emailPrimary?.toLowerCase() ?? null)
      !== project.email_normalized
  ) throw new OfferIntegrityError();
  const contactContext: OfferContactContextV1 = parsedContactContext.data;
  const installationSiteContext: OfferInstallationSiteContextV1 =
    parsedInstallationSiteContext.data;
  const sourceBindings: OfferSourceBindingsV1 = {
    projectId: project.id,
    contactId: project.contact_id,
    siteId: project.site_id,
    inboundReceiptId: receipt.id,
    inboundPayloadSha256: receipt.body_sha256_hex,
    requirementId: requirement.id,
    requirementRevision: requirement.revision,
    calculationRevisionId: calculation.id,
    calculationRevision: calculation.revision,
    calculationInputSha256: calculation.input_sha256_hex,
    calculationResultSha256: calculation.result_sha256_hex,
    resolutionId: resolutionRow.id,
    resolutionRevision: resolutionRow.revision,
    resolutionSha256: resolutionRow.resolution_sha256_hex,
  };
  return {
    project,
    receipt,
    requirement,
    calculation,
    resolutionRow,
    resolution: catalogCopy.snapshot,
    sourceBindings,
    contactContext,
    installationSiteContext,
    offerColumnId: offerColumns.rows[0]!.id,
  };
}

const CATEGORY_TITLES: Record<OfferCatalogComponentType, string> = {
  module: "PV-Module",
  inverter: "Wechselrichter",
  battery: "Speicher",
  wallbox: "Wallbox",
  heat_pump: "Wärmepumpe",
  mounting: "Montagesystem",
  other: "Weitere Komponenten",
};

function catalogSeedLine(
  line: OfferCatalogResolutionLine,
  resolution: OfferCatalogResolutionSnapshot,
  decision: TaxDecision,
  resolutionId: string,
): SnapshotLineBody {
  const component: OfferCatalogComponentSnapshot = line.componentSnapshot;
  const commercial = component.commercial;
  if (commercial === null) throw new OfferBlockedError("catalog_pricing_missing");
  return {
    lineDomainId: line.lineId,
    position: 1,
    componentCategory: component.identity.componentType,
    positionType: "required",
    isHidden: false,
    quantityMilli: line.quantity * 1_000,
    product: {
      kind: "catalog",
      internalSku: component.identity.internalSku,
      displayName: component.presentation.displayName,
      manufacturer: component.presentation.manufacturer,
      model: component.presentation.model,
      unit: component.presentation.unit,
      technicalData: component.technicalData,
      image: component.presentation.image,
      datasheet: component.presentation.datasheet,
      technicalProvenance: component.technicalProvenance,
    },
    source: {
      kind: "catalog",
      catalogComponentId: line.catalogComponentId,
      catalogComponentRevision: line.catalogComponentRevision,
      componentSnapshotSha256: line.componentSnapshotSha256,
      resolutionLineId: line.lineId,
      resolutionId,
      resolutionRevision: resolution.revision,
      resolutionSha256: resolution.resolutionSha256,
      catalogSalesUnitNetCents: commercial.salesPriceNetCents,
      catalogPurchaseUnitNetCents: commercial.purchasePriceNetCents,
    },
    salesPricing: {
      originalUnitNetCents: commercial.salesPriceNetCents,
      effectiveUnitNetCents: commercial.salesPriceNetCents,
      provenance: { kind: "catalog_seed", catalogProvenance: commercial.salesProvenance },
    },
    purchasePricing: {
      originalUnitNetCents: commercial.purchasePriceNetCents,
      effectiveUnitNetCents: commercial.purchasePriceNetCents,
      provenance: { kind: "catalog_seed", catalogProvenance: commercial.purchaseProvenance },
    },
    lineDiscountBps: 0,
    taxTreatment: decision.treatment,
    taxRateBps: decision.rateBps,
    taxDecision: decision,
  };
}

function buildResolutionSnapshot(input: {
  workspaceId: string;
  offerId: string;
  variantId: string;
  revision: number;
  variantName: string;
  description: string | null;
  contactContext: OfferContactContextV1;
  installationSiteContext: OfferInstallationSiteContextV1;
  sourceBindings: OfferSourceBindingsV1;
  resolution: OfferCatalogResolutionSnapshot;
  priceAudienceDecision: PriceAudienceDecision;
  actor: string;
  createdAt: string;
  taxTreatment: "standard_19" | "zero_operator_confirmed";
}): OfferVariantSnapshotV1 {
  const decision = taxDecision(input.taxTreatment, input.actor, input.createdAt);
  const byCategory = new Map<OfferCatalogComponentType, SnapshotLineBody[]>();
  for (const resolutionLine of [...input.resolution.lines].sort((left, right) =>
    left.position - right.position || left.lineId.localeCompare(right.lineId))) {
    const category = resolutionLine.componentSnapshot.identity.componentType;
    const lines = byCategory.get(category) ?? [];
    const seeded = catalogSeedLine(
      resolutionLine,
      input.resolution,
      decision,
      input.sourceBindings.resolutionId,
    );
    seeded.position = lines.length + 1;
    lines.push(seeded);
    byCategory.set(category, lines);
  }
  const categoryOrder: readonly OfferCatalogComponentType[] = [
    "module",
    "inverter",
    "battery",
    "wallbox",
    "heat_pump",
    "mounting",
    "other",
  ];
  const sections: SnapshotSectionBody[] = categoryOrder
    .filter((category) => byCategory.has(category))
    .map((category, index) => ({
      sectionDomainId: randomUUID(),
      position: index + 1,
      category,
      title: CATEGORY_TITLES[category],
      discountBps: 0,
      lines: byCategory.get(category)!,
    }),
  );
  let pricing;
  try {
    pricing = calculateOfferPricing({
      currency: "EUR",
      priceBasis: "net",
      globalDiscountBps: 0,
      customDealNetCents: null,
      sections: sections.map((section) => ({
        sectionDomainId: section.sectionDomainId,
        position: section.position,
        discountBps: section.discountBps,
        lines: section.lines.map((line) => ({
          lineDomainId: line.lineDomainId,
          position: line.position,
          unit: line.product.unit,
          positionType: line.positionType,
          isHidden: line.isHidden,
          quantityMilli: line.quantityMilli,
          salesUnitNetCents: line.salesPricing.effectiveUnitNetCents,
          purchaseUnitNetCents: line.purchasePricing.effectiveUnitNetCents,
          lineDiscountBps: line.lineDiscountBps,
          taxRateBps: line.taxRateBps,
        })),
      })),
    });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new OfferBlockedError("offer_pricing_out_of_range");
    }
    throw error;
  }
  const pricingById = new Map(pricing.lines.map((line) => [line.lineDomainId, line]));
  return sealOfferVariantSnapshot({
    schemaVersion: OFFER_VARIANT_SNAPSHOT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    workspaceId: input.workspaceId,
    offerId: input.offerId,
    variantId: input.variantId,
    revision: input.revision,
    variantName: input.variantName,
    description: input.description,
    contactContext: input.contactContext,
    installationSiteContext: input.installationSiteContext,
    sourceBindings: input.sourceBindings,
    priceAudienceDecision: input.priceAudienceDecision,
    taxDecision: decision,
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    customDealNetCents: null,
    sections: sections.map((section) => ({
      ...section,
      lines: section.lines.map((line) => {
        const calculated = pricingById.get(line.lineDomainId);
        if (!calculated) throw new OfferIntegrityError();
        return {
          ...line,
          computed: {
            lineBaseNetCents: calculated.lineBaseNetCents,
            lineDiscountedNetCents: calculated.lineDiscountedNetCents,
            sectionDiscountedNetCents: calculated.sectionDiscountedNetCents,
            finalSalesNetCents: calculated.finalSalesNetCents,
            salesTaxCents: calculated.salesTaxCents,
            salesGrossCents: calculated.salesGrossCents,
            purchaseNetCents: calculated.purchaseNetCents,
          },
        };
      }),
    })),
    totals: pricing.totals,
    createdBy: input.actor,
    createdAt: input.createdAt,
  });
}

async function persistRevision(
  tx: TenantTx,
  ctx: ServiceCtx,
  snapshot: OfferVariantSnapshotV1,
): Promise<void> {
  const revisionId = randomUUID();
  await tx.execute(sql`
    insert into offer_variant_revision (
      id, workspace_id, offer_id, variant_id, project_id, revision,
      schema_version, canonicalization_version, revision_snapshot,
      snapshot_sha256, resolution_id, resolution_revision, resolution_sha256,
      basis_net_cents, basis_tax_cents, basis_gross_cents,
      optional_net_cents, optional_tax_cents, optional_gross_cents,
      created_by, created_at
    ) values (
      ${revisionId}::uuid, ${ctx.workspaceId}::uuid,
      ${snapshot.offerId}::uuid, ${snapshot.variantId}::uuid,
      ${snapshot.sourceBindings.projectId}::uuid, ${snapshot.revision},
      ${snapshot.schemaVersion}, ${snapshot.canonicalizationVersion},
      ${JSON.stringify(snapshot)}::jsonb, decode(${snapshot.snapshotSha256}, 'hex'),
      ${snapshot.sourceBindings.resolutionId}::uuid,
      ${snapshot.sourceBindings.resolutionRevision},
      decode(${snapshot.sourceBindings.resolutionSha256}, 'hex'),
      ${snapshot.totals.basisNetCents}, ${snapshot.totals.basisTaxCents},
      ${snapshot.totals.basisGrossCents}, ${snapshot.totals.optionalNetCents},
      ${snapshot.totals.optionalTaxCents}, ${snapshot.totals.optionalGrossCents},
      ${ctx.actor}::uuid, ${snapshot.createdAt}::timestamptz
    )
  `);
  for (const section of snapshot.sections) {
    const sectionId = randomUUID();
    await tx.execute(sql`
      insert into offer_variant_section (
        id, workspace_id, offer_id, variant_id, project_id,
        revision_id, revision, section_domain_id, position,
        category, title, discount_bps, section_snapshot, created_at
      ) values (
        ${sectionId}::uuid, ${ctx.workspaceId}::uuid,
        ${snapshot.offerId}::uuid, ${snapshot.variantId}::uuid,
        ${snapshot.sourceBindings.projectId}::uuid, ${revisionId}::uuid,
        ${snapshot.revision}, ${section.sectionDomainId}::uuid,
        ${section.position}, ${section.category}, ${section.title},
        ${section.discountBps}, ${JSON.stringify(section)}::jsonb,
        ${snapshot.createdAt}::timestamptz
      )
    `);
    for (const line of section.lines) {
      const catalogSource = line.source.kind === "catalog" ? line.source : null;
      await tx.execute(sql`
        insert into offer_bom_line (
          id, workspace_id, offer_id, variant_id, project_id,
          revision_id, revision, section_id, section_domain_id,
          line_domain_id, position, component_category, position_type,
          is_hidden, quantity_milli, unit, source_kind,
          catalog_component_id, catalog_component_revision,
          component_snapshot_sha256, original_sales_unit_net_cents,
          effective_sales_unit_net_cents, original_purchase_unit_net_cents,
          effective_purchase_unit_net_cents, line_discount_bps,
          tax_treatment, tax_rate_bps, line_base_net_cents,
          line_discounted_net_cents, section_discounted_net_cents,
          final_sales_net_cents, sales_tax_cents, sales_gross_cents,
          purchase_net_cents, line_snapshot, created_at
        ) values (
          ${randomUUID()}::uuid, ${ctx.workspaceId}::uuid,
          ${snapshot.offerId}::uuid, ${snapshot.variantId}::uuid,
          ${snapshot.sourceBindings.projectId}::uuid, ${revisionId}::uuid,
          ${snapshot.revision}, ${sectionId}::uuid,
          ${section.sectionDomainId}::uuid, ${line.lineDomainId}::uuid,
          ${line.position}, ${line.componentCategory}, ${line.positionType},
          ${line.isHidden}, ${line.quantityMilli}, ${line.product.unit},
          ${line.source.kind}, ${catalogSource?.catalogComponentId ?? null}::uuid,
          ${catalogSource?.catalogComponentRevision ?? null},
          decode(${catalogSource?.componentSnapshotSha256 ?? null}, 'hex'),
          ${line.salesPricing.originalUnitNetCents},
          ${line.salesPricing.effectiveUnitNetCents},
          ${line.purchasePricing.originalUnitNetCents},
          ${line.purchasePricing.effectiveUnitNetCents},
          ${line.lineDiscountBps}, ${line.taxTreatment}, ${line.taxRateBps},
          ${line.computed.lineBaseNetCents},
          ${line.computed.lineDiscountedNetCents},
          ${line.computed.sectionDiscountedNetCents},
          ${line.computed.finalSalesNetCents}, ${line.computed.salesTaxCents},
          ${line.computed.salesGrossCents}, ${line.computed.purchaseNetCents},
          ${JSON.stringify(line)}::jsonb, ${snapshot.createdAt}::timestamptz
        )
      `);
    }
  }
}

type OfferMutationDetailsInput = {
  offerId: string;
  variantId: string;
  revision: number;
  previousRevision: number | null;
  changeClasses: readonly string[];
  previousState: "absent" | "request" | "draft";
  newState: "draft";
  sourceVariantId?: string;
};

function offerMutationDetails(input: OfferMutationDetailsInput) {
  return {
    offerId: input.offerId,
    variantId: input.variantId,
    ...(input.sourceVariantId ? { sourceVariantId: input.sourceVariantId } : {}),
    previousRevision: input.previousRevision,
    newRevision: input.revision,
    changeClasses: [...new Set(input.changeClasses)].sort(),
    previousState: input.previousState,
    newState: input.newState,
  };
}

async function recordOfferMutation(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: OfferMutationDetailsInput & { eventType: string; action: Action },
): Promise<void> {
  const details = offerMutationDetails(input);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "offer",
    aggregateId: input.offerId,
    eventType: input.eventType,
    actor: ctx.actor,
    payload: details,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: input.action,
    resource: "offer",
    allowed: true,
    details,
  });
}

export async function createOfferFromRequest(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferMutationResult> {
  requireOfferAccess(ctx, "project.write", "offer");
  requireOfferAccess(ctx, "phase.convert", "offer");
  requireOfferAccess(ctx, "price.edit", "offer_pricing");
  const parsed = createOfferCommandV1Schema.safeParse(value);
  if (!parsed.success) throw new OfferValidationError(issuePaths(parsed.error));
  const command: CreateOfferCommandV1 = parsed.data;
  const project = await lockProjectBasis(tx, ctx, command.projectId);
  const existing = await readExistingOfferForProject(tx, ctx, command.projectId);
  if (existing) {
    const replayDigest = hashOfferCreateDigest({
      schemaVersion: "offer-create-digest-material.v1",
      command,
      sourceBindings: existing.source_bindings,
      contactContext: existing.contact_context,
      installationSiteContext: existing.installation_site_context,
    });
    if (replayDigest !== existing.create_digest_hex) throw new OfferConflictError();
    return {
      offerId: existing.id,
      variantId: existing.basis_variant_id,
      revision: existing.basis_revision,
    };
  }
  if (project.phase !== "request" || project.column_type !== "lead") {
    throw new OfferBlockedError("project_not_request");
  }
  const basis = await loadCurrentBasis(tx, ctx, project, {
    requirementRevision: command.expectedRequirementRevision,
    calculationRevision: command.expectedCalculationRevision,
    resolutionRevision: command.expectedResolutionRevision,
  });
  const now = await databaseNow(tx);
  const digest = hashOfferCreateDigest({
    schemaVersion: "offer-create-digest-material.v1",
    command,
    sourceBindings: basis.sourceBindings,
    contactContext: basis.contactContext,
    installationSiteContext: basis.installationSiteContext,
  });
  const offerId = randomUUID();
  const variantId = randomUUID();
  const priceAudienceDecision: PriceAudienceDecision = {
    audience: "b2c",
    confirmationCode: "b2c_operator_confirmed",
    confirmedBy: ctx.actor,
    confirmedAt: now,
  };
  const snapshot = buildResolutionSnapshot({
    workspaceId: ctx.workspaceId,
    offerId,
    variantId,
    revision: 1,
    variantName: "Basis",
    description: null,
    contactContext: basis.contactContext,
    installationSiteContext: basis.installationSiteContext,
    sourceBindings: basis.sourceBindings,
    resolution: basis.resolution,
    priceAudienceDecision,
    actor: ctx.actor,
    createdAt: now,
    taxTreatment: command.taxTreatment,
  });
  const yearResult = await tx.execute<{ year: number; [key: string]: unknown }>(sql`
    select extract(year from ${now}::timestamptz at time zone 'Europe/Berlin')::integer as year
  `);
  const year = yearResult.rows[0]?.year;
  if (!year) throw new OfferPersistenceError();
  const numberResult = await tx.execute<{
    prefix: string;
    padding: number;
    last_sequence: number;
    [key: string]: unknown;
  }>(sql`
    insert into offer_number_series (
      workspace_id, series_year, prefix, padding, last_sequence,
      created_at, updated_at
    ) values (
      ${ctx.workspaceId}::uuid, ${year}, 'ANG', 6, 1,
      ${now}::timestamptz, ${now}::timestamptz
    )
    on conflict (workspace_id, series_year)
    do update set last_sequence = offer_number_series.last_sequence + 1,
                  -- The conflict update acquires the shared series row only
                  -- after any earlier allocator commits. Read the wall clock
                  -- at that point; reusing the pre-wait Offer timestamp could
                  -- otherwise move this monotone counter timestamp backwards.
                  updated_at = clock_timestamp()
      where offer_number_series.last_sequence < 999999
    returning prefix, padding, last_sequence
  `);
  const number = numberResult.rows[0];
  if (!number) throw new OfferBlockedError("offer_number_exhausted");
  const offerNumber = `${number.prefix}-${year}-${String(number.last_sequence).padStart(number.padding, "0")}`;

  try {
    await tx.execute(sql`
      insert into offer (
        id, workspace_id, project_id, contact_id, site_id, status, scope,
        price_audience, price_audience_decision,
        offer_number, number_year, number_sequence,
        forecast_value_net_cents, contact_context, installation_site_context,
        source_bindings, inbound_receipt_id, inbound_payload_sha256,
        requirement_id, requirement_revision, calculation_revision_id,
        calculation_revision, calculation_input_sha256,
        calculation_result_sha256, resolution_id, resolution_revision,
        resolution_sha256, create_digest, created_by, created_at, updated_at
      ) values (
        ${offerId}::uuid, ${ctx.workspaceId}::uuid, ${project.id}::uuid,
        ${project.contact_id}::uuid, ${project.site_id}::uuid, 'draft',
        'residential', 'b2c', ${JSON.stringify(priceAudienceDecision)}::jsonb,
        ${offerNumber}, ${year}, ${number.last_sequence},
        ${command.forecastValueNetCents}, ${JSON.stringify(basis.contactContext)}::jsonb,
        ${JSON.stringify(basis.installationSiteContext)}::jsonb,
        ${JSON.stringify(basis.sourceBindings)}::jsonb,
        ${basis.receipt.id}::uuid, decode(${basis.receipt.body_sha256_hex}, 'hex'),
        ${basis.requirement.id}::uuid, ${basis.requirement.revision},
        ${basis.calculation.id}::uuid, ${basis.calculation.revision},
        decode(${basis.calculation.input_sha256_hex}, 'hex'),
        decode(${basis.calculation.result_sha256_hex}, 'hex'),
        ${basis.resolutionRow.id}::uuid, ${basis.resolutionRow.revision},
        decode(${basis.resolutionRow.resolution_sha256_hex}, 'hex'),
        decode(${digest}, 'hex'), ${ctx.actor}::uuid,
        ${now}::timestamptz, ${now}::timestamptz
      )
    `);
    await tx.execute(sql`
      insert into offer_variant (
        id, workspace_id, offer_id, ordinal, current_revision,
        name, description, is_primary, created_by, created_at, updated_at
      ) values (
        ${variantId}::uuid, ${ctx.workspaceId}::uuid, ${offerId}::uuid,
        1, 1, ${snapshot.variantName}, ${snapshot.description},
        true, ${ctx.actor}::uuid, ${now}::timestamptz, ${now}::timestamptz
      )
    `);
    await persistRevision(tx, ctx, snapshot);
    const moved = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      update project
         set phase = 'offer', kanban_column_id = ${basis.offerColumnId}::uuid,
             updated_at = ${now}::timestamptz
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${project.id}::uuid
         and phase = 'request'
         and kanban_column_id = ${project.kanban_column_id}::uuid
      returning id
    `);
    if (!moved.rows[0]) throw new OfferConflictError();
  } catch (error) {
    if (error instanceof OfferConflictError || error instanceof OfferBlockedError) throw error;
    if (constraintName(error) === "offer_ws_project_uq") throw new OfferConflictError();
    throw new OfferPersistenceError();
  }
  await recordOfferMutation(tx, ctx, {
    offerId,
    variantId,
    revision: 1,
    previousRevision: null,
    changeClasses: ["offer_created"],
    previousState: "request",
    newState: "draft",
    eventType: "offer.created",
    action: "phase.convert",
  });
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "offer",
    aggregateId: offerId,
    eventType: "offer.variant_created",
    actor: ctx.actor,
    payload: offerMutationDetails({
      offerId,
      variantId,
      revision: 1,
      previousRevision: null,
      changeClasses: ["resolution_seed"],
      previousState: "absent",
      newState: "draft",
    }),
  });
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: project.id,
    eventType: "project.phase_changed",
    actor: ctx.actor,
    payload: { projectId: project.id, offerId, from: "request", to: "offer" },
  });
  return { offerId, variantId, revision: 1 };
}

async function readOfferProjectId(
  tx: TenantTx,
  ctx: ServiceCtx,
  offerId: string,
): Promise<string> {
  const result = await tx.execute<{ project_id: string; [key: string]: unknown }>(sql`
    select project_id
      from offer
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${offerId}::uuid
     limit 1
  `);
  const projectId = result.rows[0]?.project_id;
  if (!projectId) throw new OfferNotFoundError();
  return projectId;
}

async function lockOffer(
  tx: TenantTx,
  ctx: ServiceCtx,
  offerId: string,
): Promise<OfferRow> {
  const result = await tx.execute<OfferRow>(sql`
    select id, workspace_id, project_id, contact_id, site_id, status,
           offer_number, forecast_value_net_cents,
           total_price_override_net_cents, contact_context,
           installation_site_context, source_bindings, price_audience_decision,
           encode(create_digest, 'hex') as create_digest_hex,
           resolution_id, resolution_revision,
           encode(resolution_sha256, 'hex') as resolution_sha256_hex
      from offer
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${offerId}::uuid
     for update
  `);
  const offerRecord = result.rows[0];
  if (!offerRecord) throw new OfferNotFoundError();
  return offerRecord;
}

async function lockVariant(
  tx: TenantTx,
  ctx: ServiceCtx,
  offerId: string,
  variantId: string,
): Promise<VariantRow> {
  const result = await tx.execute<VariantRow>(sql`
    select id, offer_id, ordinal, current_revision, name, description, is_primary,
           optional_bundles
      from offer_variant
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${offerId}::uuid
       and id = ${variantId}::uuid
     for update
  `);
  const variant = result.rows[0];
  if (!variant) throw new OfferNotFoundError();
  return variant;
}

async function readValidatedRevision(
  tx: TenantTx,
  ctx: ServiceCtx,
  offerId: string,
  variantId: string,
  revision: number,
): Promise<OfferVariantSnapshotV1> {
  const result = await tx.execute<RevisionRow>(sql`
    select id, revision_snapshot, encode(snapshot_sha256, 'hex') as snapshot_sha256_hex,
           resolution_id, resolution_revision,
           encode(resolution_sha256, 'hex') as resolution_sha256_hex
      from offer_variant_revision
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${offerId}::uuid
       and variant_id = ${variantId}::uuid
       and revision = ${revision}
     limit 1
  `);
  const row = result.rows[0];
  if (!row) throw new OfferIntegrityError();
  const validated = validateOfferVariantSnapshot(row.revision_snapshot);
  if (!validated.ok || validated.value.snapshotSha256 !== row.snapshot_sha256_hex) {
    throw new OfferIntegrityError();
  }
  return validated.value;
}

function readStoredPriceAudienceDecision(
  offerRecord: OfferRow,
): PriceAudienceDecision {
  const parsed = offerPriceAudienceDecisionV1Schema.safeParse(
    offerRecord.price_audience_decision,
  );
  if (!parsed.success) throw new OfferIntegrityError();
  return structuredClone(parsed.data);
}

async function nextVariantOrdinal(
  tx: TenantTx,
  ctx: ServiceCtx,
  offerId: string,
): Promise<number> {
  const result = await tx.execute<{ next_ordinal: number; [key: string]: unknown }>(sql`
    select coalesce(max(ordinal), 0)::integer + 1 as next_ordinal
      from offer_variant
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${offerId}::uuid
  `);
  const ordinal = result.rows[0]?.next_ordinal;
  if (!ordinal || ordinal > 12) throw new OfferBlockedError("variant_limit");
  return ordinal;
}

async function insertVariant(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    id: string;
    offerId: string;
    ordinal: number;
    name: string;
    description: string | null;
    isPrimary: boolean;
    createdAt: string;
  },
): Promise<void> {
  try {
    await tx.execute(sql`
      insert into offer_variant (
        id, workspace_id, offer_id, ordinal, current_revision,
        name, description, is_primary, created_by, created_at, updated_at
      ) values (
        ${input.id}::uuid, ${ctx.workspaceId}::uuid, ${input.offerId}::uuid,
        ${input.ordinal}, 1, ${input.name}, ${input.description},
        ${input.isPrimary}, ${ctx.actor}::uuid,
        ${input.createdAt}::timestamptz, ${input.createdAt}::timestamptz
      )
    `);
  } catch (error) {
    if (constraintName(error) === "offer_variant_ws_offer_ordinal_uq") {
      throw new OfferConflictError();
    }
    if (constraintName(error) === "offer_variant_ws_offer_primary_uq") {
      throw new OfferIntegrityError();
    }
    throw new OfferPersistenceError();
  }
}

async function touchOfferAndProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  offerRecord: OfferRow,
  at: string,
): Promise<void> {
  await tx.execute(sql`
    update offer
       set updated_at = ${at}::timestamptz
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${offerRecord.id}::uuid
  `);
  await tx.execute(sql`
    update project
       set updated_at = ${at}::timestamptz
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${offerRecord.project_id}::uuid
  `);
}

export async function duplicateOfferVariant(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferMutationResult> {
  requireOfferAccess(ctx, "project.write", "offer_variant");
  const parsed = duplicateOfferVariantCommandV1Schema.safeParse(value);
  if (!parsed.success) throw new OfferValidationError(issuePaths(parsed.error));
  const command: DuplicateOfferVariantCommandV1 = parsed.data;
  const projectId = await readOfferProjectId(tx, ctx, command.offerId);
  await lockProjectBasis(tx, ctx, projectId);
  const offerRecord = await lockOffer(tx, ctx, command.offerId);
  const sourceVariant = await lockVariant(
    tx,
    ctx,
    offerRecord.id,
    command.sourceVariantId,
  );
  if (sourceVariant.current_revision !== command.expectedSourceRevision) {
    throw new OfferConflictError(sourceVariant.current_revision);
  }
  const source = await readValidatedRevision(
    tx,
    ctx,
    offerRecord.id,
    sourceVariant.id,
    sourceVariant.current_revision,
  );
  const ordinal = await nextVariantOrdinal(tx, ctx, offerRecord.id);
  const now = await databaseNow(tx);
  const variantId = randomUUID();
  const snapshot = sealOfferVariantSnapshot({
    ...structuredClone(source),
    variantId,
    revision: 1,
    variantName: command.name,
    createdBy: ctx.actor,
    createdAt: now,
  });
  await insertVariant(tx, ctx, {
    id: variantId,
    offerId: offerRecord.id,
    ordinal,
    name: snapshot.variantName,
    description: snapshot.description,
    isPrimary: false,
    createdAt: now,
  });
  await persistRevision(tx, ctx, snapshot);
  await touchOfferAndProject(tx, ctx, offerRecord, now);
  await recordOfferMutation(tx, ctx, {
    offerId: offerRecord.id,
    variantId,
    revision: 1,
    previousRevision: sourceVariant.current_revision,
    changeClasses: ["variant_duplicate"],
    previousState: "absent",
    newState: "draft",
    sourceVariantId: sourceVariant.id,
    eventType: "offer.variant_duplicated",
    action: "project.write",
  });
  return { offerId: offerRecord.id, variantId, revision: 1 };
}

export async function createVariantFromCurrentResolution(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferMutationResult> {
  requireOfferAccess(ctx, "project.write", "offer_variant");
  requireOfferAccess(ctx, "price.edit", "offer_pricing");
  const parsed = createVariantFromResolutionCommandV1Schema.safeParse(value);
  if (!parsed.success) throw new OfferValidationError(issuePaths(parsed.error));
  const command: CreateVariantFromResolutionCommandV1 = parsed.data;
  const projectId = await readOfferProjectId(tx, ctx, command.offerId);
  const project = await lockProjectBasis(tx, ctx, projectId);
  const offerRecord = await lockOffer(tx, ctx, command.offerId);
  const basis = await loadCurrentBasis(tx, ctx, project, {
    requirementRevision: command.expectedRequirementRevision,
    calculationRevision: command.expectedCalculationRevision,
    resolutionRevision: command.expectedResolutionRevision,
  });
  if (canonicalizeOfferJson(offerRecord.installation_site_context)
    !== canonicalizeOfferJson(basis.installationSiteContext)) {
    throw new OfferBlockedError("installation_site_changed");
  }
  const priceAudienceDecision = readStoredPriceAudienceDecision(offerRecord);
  const ordinal = await nextVariantOrdinal(tx, ctx, offerRecord.id);
  const now = await databaseNow(tx);
  const variantId = randomUUID();
  const snapshot = buildResolutionSnapshot({
    workspaceId: ctx.workspaceId,
    offerId: offerRecord.id,
    variantId,
    revision: 1,
    variantName: command.name,
    description: null,
    contactContext: offerRecord.contact_context,
    installationSiteContext: offerRecord.installation_site_context,
    sourceBindings: basis.sourceBindings,
    resolution: basis.resolution,
    priceAudienceDecision,
    actor: ctx.actor,
    createdAt: now,
    taxTreatment: command.taxTreatment,
  });
  await insertVariant(tx, ctx, {
    id: variantId,
    offerId: offerRecord.id,
    ordinal,
    name: snapshot.variantName,
    description: snapshot.description,
    isPrimary: false,
    createdAt: now,
  });
  await persistRevision(tx, ctx, snapshot);
  await touchOfferAndProject(tx, ctx, offerRecord, now);
  await recordOfferMutation(tx, ctx, {
    offerId: offerRecord.id,
    variantId,
    revision: 1,
    previousRevision: null,
    changeClasses: ["resolution_seed"],
    previousState: "absent",
    newState: "draft",
    eventType: "offer.variant_created",
    action: "price.edit",
  });
  return { offerId: offerRecord.id, variantId, revision: 1 };
}

function findLine(
  snapshot: OfferVariantSnapshotV1,
  lineDomainId: string,
): { section: SnapshotSection; line: SnapshotLine; lineIndex: number } {
  for (const section of snapshot.sections) {
    const lineIndex = section.lines.findIndex((line) => line.lineDomainId === lineDomainId);
    if (lineIndex >= 0) return { section, line: section.lines[lineIndex]!, lineIndex };
  }
  throw new OfferValidationError(["/operations/lineDomainId"]);
}

function findSection(
  snapshot: OfferVariantSnapshotV1,
  sectionDomainId: string,
): SnapshotSection {
  const section = snapshot.sections.find((entry) => entry.sectionDomainId === sectionDomainId);
  if (!section) throw new OfferValidationError(["/operations/sectionDomainId"]);
  return section;
}

function reindex<T extends { position: number }>(items: T[]): void {
  items.forEach((item, index) => {
    item.position = index + 1;
  });
}

function originalProvenance(
  provenance: SnapshotLine["salesPricing"]["provenance"],
): Extract<SnapshotLine["salesPricing"]["provenance"], { kind: "catalog_seed" | "custom" }> {
  return provenance.kind === "manual_override"
    ? provenance.originalProvenance
    : provenance;
}

function applyRevisionOperation(
  snapshot: OfferVariantSnapshotV1,
  operation: ReviseOfferVariantOperationV1,
  ctx: ServiceCtx,
  at: string,
): void {
  switch (operation.operation) {
    case "set_variant_name":
      snapshot.variantName = operation.name;
      return;
    case "set_variant_description":
      snapshot.description = operation.description;
      return;
    case "set_global_discount":
      requireOfferAccess(ctx, "discount.apply", "offer_discount");
      snapshot.globalDiscountBps = operation.discountBps;
      return;
    case "set_custom_deal":
      requireOfferAccess(ctx, "discount.apply", "offer_discount");
      snapshot.customDealNetCents = operation.customDealNetCents;
      return;
    case "set_section_discount":
      requireOfferAccess(ctx, "discount.apply", "offer_discount");
      findSection(snapshot, operation.sectionDomainId).discountBps = operation.discountBps;
      return;
    case "move_section": {
      const index = snapshot.sections.findIndex(
        (section) => section.sectionDomainId === operation.sectionDomainId,
      );
      if (index < 0 || operation.position > snapshot.sections.length) {
        throw new OfferValidationError(["/operations/position"]);
      }
      const [section] = snapshot.sections.splice(index, 1);
      snapshot.sections.splice(operation.position - 1, 0, section!);
      reindex(snapshot.sections);
      return;
    }
    case "move_line": {
      const found = findLine(snapshot, operation.lineDomainId);
      const target = findSection(snapshot, operation.sectionDomainId);
      if (operation.position > target.lines.length + (found.section === target ? 0 : 1)) {
        throw new OfferValidationError(["/operations/position"]);
      }
      found.section.lines.splice(found.lineIndex, 1);
      target.lines.splice(operation.position - 1, 0, found.line);
      found.line.componentCategory = target.category;
      reindex(found.section.lines);
      if (found.section !== target) reindex(target.lines);
      return;
    }
    case "set_line_quantity":
      findLine(snapshot, operation.lineDomainId).line.quantityMilli = operation.quantityMilli;
      return;
    case "set_custom_line_details": {
      const line = findLine(snapshot, operation.lineDomainId).line;
      if (line.source.kind !== "custom" || line.product.kind !== "custom") {
        throw new OfferValidationError(["/operations/lineDomainId"]);
      }
      line.product = {
        ...line.product,
        displayName: operation.displayName,
        description: operation.description,
        unit: operation.unit,
      };
      return;
    }
    case "set_line_position_type":
      findLine(snapshot, operation.lineDomainId).line.positionType = operation.positionType;
      return;
    case "set_line_visibility":
      findLine(snapshot, operation.lineDomainId).line.isHidden = operation.isHidden;
      return;
    case "set_line_sales_price": {
      const line = findLine(snapshot, operation.lineDomainId).line;
      line.salesPricing = {
        ...line.salesPricing,
        effectiveUnitNetCents: operation.salesUnitNetCents,
        provenance: {
          kind: "manual_override",
          reasonCode: operation.reasonCode,
          overriddenBy: ctx.actor,
          overriddenAt: at,
          originalProvenance: originalProvenance(line.salesPricing.provenance),
        },
      };
      return;
    }
    case "set_line_purchase_price": {
      requireOfferAccess(ctx, "price.read_purchase", "offer_purchase_pricing");
      const line = findLine(snapshot, operation.lineDomainId).line;
      if (line.source.kind !== "custom") {
        throw new OfferValidationError(["/operations/lineDomainId"]);
      }
      line.purchasePricing = {
        ...line.purchasePricing,
        effectiveUnitNetCents: operation.purchaseUnitNetCents,
        provenance: {
          kind: "manual_override",
          reasonCode: operation.reasonCode,
          overriddenBy: ctx.actor,
          overriddenAt: at,
          originalProvenance: originalProvenance(line.purchasePricing.provenance),
        },
      };
      return;
    }
    case "set_line_discount":
      requireOfferAccess(ctx, "discount.apply", "offer_discount");
      findLine(snapshot, operation.lineDomainId).line.lineDiscountBps = operation.discountBps;
      return;
    case "remove_custom_line": {
      const found = findLine(snapshot, operation.lineDomainId);
      if (found.line.source.kind !== "custom") {
        throw new OfferValidationError(["/operations/lineDomainId"]);
      }
      found.section.lines.splice(found.lineIndex, 1);
      reindex(found.section.lines);
      return;
    }
    case "add_custom_section": {
      if (operation.position > snapshot.sections.length + 1) {
        throw new OfferValidationError(["/operations/position"]);
      }
      snapshot.sections.splice(operation.position - 1, 0, {
        sectionDomainId: operation.sectionDomainId,
        position: operation.position,
        category: operation.category,
        title: operation.title,
        discountBps: 0,
        lines: [],
      });
      reindex(snapshot.sections);
      return;
    }
    case "remove_custom_section": {
      const index = snapshot.sections.findIndex(
        (section) => section.sectionDomainId === operation.sectionDomainId,
      );
      const section = index < 0 ? undefined : snapshot.sections[index];
      if (!section || section.lines.some((line) => line.source.kind !== "custom")) {
        throw new OfferValidationError(["/operations/sectionDomainId"]);
      }
      snapshot.sections.splice(index, 1);
      reindex(snapshot.sections);
      return;
    }
    case "add_custom_line": {
      const section = findSection(snapshot, operation.sectionDomainId);
      if (operation.position > section.lines.length + 1) {
        throw new OfferValidationError(["/operations/position"]);
      }
      const decision = taxDecision(operation.taxTreatment, ctx.actor, at);
      section.lines.splice(operation.position - 1, 0, {
        lineDomainId: operation.lineDomainId,
        position: operation.position,
        componentCategory: section.category,
        positionType: operation.positionType,
        isHidden: operation.isHidden,
        quantityMilli: operation.quantityMilli,
        product: {
          kind: "custom",
          displayName: operation.displayName,
          description: operation.description,
          unit: operation.unit,
        },
        source: { kind: "custom", enteredBy: ctx.actor, enteredAt: at },
        salesPricing: {
          originalUnitNetCents: operation.salesUnitNetCents,
          effectiveUnitNetCents: operation.salesUnitNetCents,
          provenance: { kind: "custom", enteredBy: ctx.actor, enteredAt: at },
        },
        purchasePricing: {
          originalUnitNetCents: operation.purchaseUnitNetCents,
          effectiveUnitNetCents: operation.purchaseUnitNetCents,
          provenance: { kind: "custom", enteredBy: ctx.actor, enteredAt: at },
        },
        lineDiscountBps: 0,
        taxTreatment: decision.treatment,
        taxRateBps: decision.rateBps,
        taxDecision: decision,
        computed: {
          lineBaseNetCents: 0,
          lineDiscountedNetCents: 0,
          sectionDiscountedNetCents: 0,
          finalSalesNetCents: 0,
          salesTaxCents: 0,
          salesGrossCents: 0,
          purchaseNetCents: 0,
        },
      });
      reindex(section.lines);
      return;
    }
    case "set_line_tax": {
      const line = findLine(snapshot, operation.lineDomainId).line;
      const decision = taxDecision(operation.taxTreatment, ctx.actor, at);
      line.taxTreatment = decision.treatment;
      line.taxRateBps = decision.rateBps;
      line.taxDecision = decision;
      snapshot.taxDecision = decision;
      return;
    }
  }
}

function repriceSnapshot(snapshot: OfferVariantSnapshotV1): void {
  const pricing = calculateOfferPricing({
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: snapshot.globalDiscountBps,
    customDealNetCents: snapshot.customDealNetCents,
    sections: snapshot.sections.map((section) => ({
      sectionDomainId: section.sectionDomainId,
      position: section.position,
      discountBps: section.discountBps,
      lines: section.lines.map((line) => ({
        lineDomainId: line.lineDomainId,
        position: line.position,
        unit: line.product.unit,
        positionType: line.positionType,
        isHidden: line.isHidden,
        quantityMilli: line.quantityMilli,
        salesUnitNetCents: line.salesPricing.effectiveUnitNetCents,
        purchaseUnitNetCents: line.purchasePricing.effectiveUnitNetCents,
        lineDiscountBps: line.lineDiscountBps,
        taxRateBps: line.taxRateBps,
      })),
    })),
  });
  const byId = new Map(pricing.lines.map((line) => [line.lineDomainId, line]));
  for (const section of snapshot.sections) {
    for (const line of section.lines) {
      const calculated = byId.get(line.lineDomainId);
      if (!calculated) throw new OfferIntegrityError();
      line.computed = {
        lineBaseNetCents: calculated.lineBaseNetCents,
        lineDiscountedNetCents: calculated.lineDiscountedNetCents,
        sectionDiscountedNetCents: calculated.sectionDiscountedNetCents,
        finalSalesNetCents: calculated.finalSalesNetCents,
        salesTaxCents: calculated.salesTaxCents,
        salesGrossCents: calculated.salesGrossCents,
        purchaseNetCents: calculated.purchaseNetCents,
      };
    }
  }
  snapshot.totals = pricing.totals;
}

export async function reviseOfferVariant(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<OfferMutationResult> {
  requireOfferAccess(ctx, "project.write", "offer_variant");
  const parsed = reviseOfferVariantCommandV1Schema.safeParse(value);
  if (!parsed.success) throw new OfferValidationError(issuePaths(parsed.error));
  const command: ReviseOfferVariantCommandV1 = parsed.data;
  for (const operation of command.operations) {
    switch (operation.operation) {
      case "set_line_sales_price":
      case "set_line_tax":
        requireOfferAccess(ctx, "price.edit", "offer_pricing");
        break;
      case "set_line_purchase_price":
      case "add_custom_line":
        requireOfferAccess(ctx, "price.edit", "offer_pricing");
        requireOfferAccess(ctx, "price.read_purchase", "offer_purchase_pricing");
        break;
      case "set_global_discount":
      case "set_custom_deal":
      case "set_section_discount":
      case "set_line_discount":
        requireOfferAccess(ctx, "discount.apply", "offer_discount");
        break;
      default:
        break;
    }
  }
  const projectId = await readOfferProjectId(tx, ctx, command.offerId);
  await lockProjectBasis(tx, ctx, projectId);
  const offerRecord = await lockOffer(tx, ctx, command.offerId);
  const variant = await lockVariant(tx, ctx, offerRecord.id, command.variantId);
  if (variant.current_revision !== command.expectedRevision) {
    throw new OfferConflictError(variant.current_revision);
  }
  const previous = await readValidatedRevision(
    tx,
    ctx,
    offerRecord.id,
    variant.id,
    variant.current_revision,
  );
  const now = await databaseNow(tx);
  const next = structuredClone(previous);
  next.revision = previous.revision + 1;
  next.createdBy = ctx.actor;
  next.createdAt = now;
  for (const operation of command.operations) {
    applyRevisionOperation(next, operation, ctx, now);
  }
  let snapshot: OfferVariantSnapshotV1;
  try {
    repriceSnapshot(next);
    snapshot = sealOfferVariantSnapshot(next);
  } catch {
    throw new OfferValidationError(["/operations"]);
  }
  await persistRevision(tx, ctx, snapshot);
  const updated = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    update offer_variant
       set current_revision = ${snapshot.revision}, name = ${snapshot.variantName},
           description = ${snapshot.description}, updated_at = ${now}::timestamptz
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${offerRecord.id}::uuid
       and id = ${variant.id}::uuid
       and current_revision = ${command.expectedRevision}
    returning id
  `);
  if (!updated.rows[0]) throw new OfferConflictError();
  await touchOfferAndProject(tx, ctx, offerRecord, now);
  await recordOfferMutation(tx, ctx, {
    offerId: offerRecord.id,
    variantId: variant.id,
    revision: snapshot.revision,
    previousRevision: command.expectedRevision,
    changeClasses: command.operations.map((operation) => operation.operation),
    previousState: "draft",
    newState: "draft",
    eventType: "offer.variant_revised",
    action: "project.write",
  });
  return { offerId: offerRecord.id, variantId: variant.id, revision: snapshot.revision };
}

export type SetPrimaryVariantResult = {
  offerId: string;
  variantId: string;
  alreadyPrimary: boolean;
};

export async function setPrimaryVariant(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<SetPrimaryVariantResult> {
  requireOfferAccess(ctx, "project.write", "offer_variant");
  const parsed = setPrimaryVariantCommandV1Schema.safeParse(value);
  if (!parsed.success) throw new OfferValidationError(issuePaths(parsed.error));
  const command: SetPrimaryVariantCommandV1 = parsed.data;
  const projectId = await readOfferProjectId(tx, ctx, command.offerId);
  await lockProjectBasis(tx, ctx, projectId);
  const offerRecord = await lockOffer(tx, ctx, command.offerId);
  const variant = await lockVariant(tx, ctx, offerRecord.id, command.variantId);
  if (variant.is_primary) {
    return { offerId: offerRecord.id, variantId: variant.id, alreadyPrimary: true };
  }
  const now = await databaseNow(tx);
  const previous = await tx.execute<{ id: string }>(sql`
    select id from offer_variant
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${offerRecord.id}::uuid
       and is_primary = true
     limit 1
  `);
  const previousPrimaryVariantId = previous.rows[0]?.id ?? null;
  try {
    await tx.execute(sql`
      update offer_variant
         set is_primary = false, updated_at = ${now}::timestamptz
       where workspace_id = ${ctx.workspaceId}::uuid
         and offer_id = ${offerRecord.id}::uuid
         and is_primary = true
    `);
    await tx.execute(sql`
      update offer_variant
         set is_primary = true, updated_at = ${now}::timestamptz
       where workspace_id = ${ctx.workspaceId}::uuid
         and offer_id = ${offerRecord.id}::uuid
         and id = ${variant.id}::uuid
    `);
  } catch (error) {
    if (constraintName(error) === "offer_variant_ws_offer_primary_uq") {
      throw new OfferIntegrityError();
    }
    throw new OfferPersistenceError();
  }
  await touchOfferAndProject(tx, ctx, offerRecord, now);
  const payload = {
    offerId: offerRecord.id,
    variantId: variant.id,
    previousPrimaryVariantId,
    actor: ctx.actor,
    at: now,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "offer",
    aggregateId: offerRecord.id,
    eventType: "offer.primary_switched",
    actor: ctx.actor,
    payload,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.write",
    resource: "offer",
    allowed: true,
    details: payload,
  });
  return { offerId: offerRecord.id, variantId: variant.id, alreadyPrimary: false };
}

export type SetTotalPriceOverrideResult = {
  offerId: string;
  totalPriceOverrideNetCents: number | null;
  changed: boolean;
};

export async function setTotalPriceOverride(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<SetTotalPriceOverrideResult> {
  requireOfferAccess(ctx, "project.write", "offer");
  requireOfferAccess(ctx, "price.edit", "offer_pricing");
  const parsed = setTotalPriceOverrideCommandV1Schema.safeParse(value);
  if (!parsed.success) throw new OfferValidationError(issuePaths(parsed.error));
  const command: SetTotalPriceOverrideCommandV1 = parsed.data;
  const projectId = await readOfferProjectId(tx, ctx, command.offerId);
  await lockProjectBasis(tx, ctx, projectId);
  const offerRecord = await lockOffer(tx, ctx, command.offerId);
  const stored = offerRecord.total_price_override_net_cents === null
    ? null
    : Number(offerRecord.total_price_override_net_cents);
  if (stored === command.totalPriceOverrideNetCents) {
    return {
      offerId: offerRecord.id,
      totalPriceOverrideNetCents: command.totalPriceOverrideNetCents,
      changed: false,
    };
  }
  const now = await databaseNow(tx);
  await tx.execute(sql`
    update offer
       set total_price_override_net_cents = ${command.totalPriceOverrideNetCents},
           updated_at = ${now}::timestamptz
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${offerRecord.id}::uuid
  `);
  await touchOfferAndProject(tx, ctx, offerRecord, now);
  const cleared = command.totalPriceOverrideNetCents === null;
  const payload = cleared
    ? { offerId: offerRecord.id, previousValueNetCents: stored, actor: ctx.actor, at: now }
    : {
        offerId: offerRecord.id,
        valueNetCents: command.totalPriceOverrideNetCents,
        previousValueNetCents: stored,
        actor: ctx.actor,
        at: now,
      };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "offer",
    aggregateId: offerRecord.id,
    eventType: cleared ? "offer.total_override_cleared" : "offer.total_override_set",
    actor: ctx.actor,
    payload,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "price.edit",
    resource: "offer",
    allowed: true,
    details: payload,
  });
  return {
    offerId: offerRecord.id,
    totalPriceOverrideNetCents: command.totalPriceOverrideNetCents,
    changed: true,
  };
}

export type SetOptionalBundlesResult = {
  offerId: string;
  variantId: string;
  changed: boolean;
};

export async function setOptionalBundles(
  tx: TenantTx,
  ctx: ServiceCtx,
  value: unknown,
): Promise<SetOptionalBundlesResult> {
  requireOfferAccess(ctx, "project.write", "offer_variant");
  const parsed = setOptionalBundlesCommandV1Schema.safeParse(value);
  if (!parsed.success) throw new OfferValidationError(issuePaths(parsed.error));
  const command: SetOptionalBundlesCommandV1 = parsed.data;
  const projectId = await readOfferProjectId(tx, ctx, command.offerId);
  await lockProjectBasis(tx, ctx, projectId);
  const offerRecord = await lockOffer(tx, ctx, command.offerId);
  const variant = await lockVariant(tx, ctx, offerRecord.id, command.variantId);
  const stored = optionalBundlesSchema.safeParse(variant.optional_bundles);
  if (!stored.success) throw new OfferIntegrityError();
  if (canonicalizeOfferJson(stored.data) === canonicalizeOfferJson(command.bundles)) {
    return { offerId: offerRecord.id, variantId: variant.id, changed: false };
  }
  const now = await databaseNow(tx);
  await tx.execute(sql`
    update offer_variant
       set optional_bundles = ${JSON.stringify(command.bundles)}::jsonb,
           updated_at = ${now}::timestamptz
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${offerRecord.id}::uuid
       and id = ${variant.id}::uuid
  `);
  const payload = {
    offerId: offerRecord.id,
    variantId: variant.id,
    bundles: command.bundles,
    actor: ctx.actor,
    at: now,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "offer",
    aggregateId: offerRecord.id,
    eventType: "offer.variant_bundles_set",
    actor: ctx.actor,
    payload,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.write",
    resource: "offer",
    allowed: true,
    details: payload,
  });
  return { offerId: offerRecord.id, variantId: variant.id, changed: true };
}
