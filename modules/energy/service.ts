import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { emitEvent } from "@/lib/events";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import {
  CALCULATION_CANONICALIZATION_VERSION,
  canonicalizeCalculationJson,
  hashPlanningCalculationInput,
  PLANNING_CALCULATION_CONTRACT_VERSION,
  PLANNING_CALCULATION_SCHEMA_SHA256,
  ProjectRequirementsRechnerV1Schema,
  SITE_ENERGY_PROFILE_SCHEMA_VERSION,
  siteEnergyProfileV1Schema,
  validatePlanningCalculationRequest,
  type PlanningCalculationRequestV1,
  type PlanningCalculationResultV1,
  type ProjectRequirementsRechnerV1,
  type SiteEnergyProfileV1,
} from "@/lib/integrations/calculation/contract";
import { validatePlanningCalculationResultExactlyForRequest } from
  "@/lib/integrations/calculation/validate-result";
import { projectRechnerSnapshotToEnergyProfile } from "@/lib/integrations/calculation/rechner-profile";
import {
  buildProjectCalculationPreparation,
  hashProjectCalculationPreparation,
} from "@/lib/integrations/calculation/preparation";
import {
  PLANNING_DEFAULTS_VERSION,
  PLANNING_MODEL_ID,
  PLANNING_MODEL_SOURCE_REVISION,
  PLANNING_MODEL_VERSION,
  PLANNING_PROVIDER_RECIPE_VERSION,
  PLANNING_RESERVATION_VERSION,
} from "@/lib/integrations/calculation/versions";
import type { RechnerCalculationSnapshotV1 } from "@/lib/integrations/rechner/types";
import {
  can,
  PermissionDeniedError,
  type ServiceCtx,
} from "@/lib/permissions";
import { enqueueProjectCalculationDispatch } from "./calculation-service";

type ProjectSiteRow = {
  project_id: string;
  site_id: string;
  address_mode: string;
  geocode_precision: string | null;
  address_follow_up_required: boolean;
  address_revision: number;
  pin_confirmed: boolean;
  pin_confirmed_address_revision: number | null;
  latitude: number | null;
  longitude: number | null;
  snapshot_id: string | null;
  snapshot: RechnerCalculationSnapshotV1 | null;
  [key: string]: unknown;
};

type StoredProfileRow = {
  id: string;
  revision: number;
  address_revision: number;
  profile: unknown;
  profile_sha256: Uint8Array;
  source_kind: string;
  source_snapshot_id: string | null;
  source_project_id: string | null;
  confirmed_profile_revision: number | null;
  confirmed_address_revision: number | null;
  confirmed_by: string | null;
  confirmed_at: Date | string | null;
  [key: string]: unknown;
};

type RequirementRow = {
  id: string;
  revision: number;
  source_snapshot_id: string;
  requirements: unknown;
  source_branch: string;
  [key: string]: unknown;
};

type JobRow = {
  id: string;
  reservation_key: Uint8Array;
  state: string;
  [key: string]: unknown;
};

type ContextJobRow = JobRow & {
  project_id: string;
  site_id: string;
  address_revision: number;
  pin_confirmed_address_revision: number;
  profile_id: string;
  profile_revision: number;
  confirmed_profile_revision: number;
  confirmed_address_revision: number;
  requirement_id: string;
  requirement_revision: number;
  source_snapshot_id: string | null;
  provider_recipe_version: string;
  contract_version: string;
  model_id: string;
  model_version: string;
  source_revision: string;
  defaults_version: string;
  attempt_count: number;
  input_sha256: Uint8Array | null;
  input_snapshot: unknown;
  error_code: string | null;
  error_retryable: boolean | null;
  calculation_revision_id: string | null;
  calculation_revision: number | null;
  result: unknown;
};

export type ProjectEnergyProfileCandidate = {
  projectId: string;
  siteId: string;
  sourceSnapshotId: string;
  addressRevision: number;
  expectedLatestRevision: number;
  profile: SiteEnergyProfileV1;
};

export type SaveProjectEnergyProfileInput = {
  projectId: string;
  expectedAddressRevision: number;
  expectedLatestRevision: number;
  profile: unknown;
  roofAcknowledgements: string[];
};

export type SaveProjectEnergyProfileResult = {
  profileId: string;
  revision: number;
  addressRevision: number;
  changed: boolean;
  confirmed: boolean;
};

export type ConfirmProjectEnergyProfileInput = {
  projectId: string;
  expectedAddressRevision: number;
  expectedProfileRevision: number;
};

export type ConfirmProjectEnergyProfileResult = {
  profileId: string;
  profileRevision: number;
  addressRevision: number;
  jobId: string;
  reservationKey: string;
  replayed: boolean;
};

export const CALCULATION_RESERVATION_RATE_LIMIT_POLICY_V1 = Object.freeze({
  id: "project-calculation-reservation-rate-limit.v1",
  actorCooldownSeconds: 10,
  actorMaxPerRollingHour: 30,
  workspaceMaxPerRollingHour: 300,
});

export type ProjectEnergyCalculationResult = {
  id: string;
  revision: number;
  value: PlanningCalculationResultV1;
  binding: {
    addressRevision: number;
    profile: { id: string; revision: number };
    requirement: { id: string; revision: number };
  };
  assumptions: PlanningCalculationRequestV1["resolvedAssumptions"];
  sources: {
    providerRecipeVersion: string;
    contractVersion: string;
    canonicalizationVersion: string;
    schemaSha256: string;
    defaultsVersion: string;
    modelId: string;
    modelVersion: string;
    sourceRevision: string;
  };
};

export type ProjectEnergyCalculationState =
  | {
      status: "blocked";
      blocker: "address_pin" | "energy_profile" | "profile_confirmation"
        | "project_requirement" | "calculation";
      jobId: null;
      result: null;
    }
  | {
      status: "queued" | "running" | "retry_wait";
      jobId: string;
      attemptCount: number;
      result: null;
    }
  | {
      status: "failed";
      jobId: string;
      attemptCount: number;
      errorCode: string;
      retryable: false;
      result: null;
    }
  | {
      status: "current";
      jobId: string;
      result: ProjectEnergyCalculationResult;
    }
  | {
      status: "stale";
      jobId: string;
      result: ProjectEnergyCalculationResult | null;
    };

export type ProjectEnergyContext = {
  projectId: string;
  siteId: string;
  addressRevision: number;
  profile: {
    id: string;
    revision: number;
    addressRevision: number;
    confirmed: boolean;
    value: SiteEnergyProfileV1;
  } | null;
  calculation: ProjectEnergyCalculationState;
  capabilities: {
    canEdit: boolean;
    canConfirm: boolean;
    canRetry: boolean;
  };
};

const candidateProjectIdSchema = z.uuid();
const saveProjectEnergyProfileInputSchema = z.strictObject({
  projectId: z.uuid(),
  expectedAddressRevision: z.int().safe().min(1),
  expectedLatestRevision: z.int().safe().min(0),
  profile: siteEnergyProfileV1Schema,
  roofAcknowledgements: z.array(
    z.string().min(1).max(64).refine((value) => value === value.trim()),
  ).max(4),
});
const confirmProjectEnergyProfileInputSchema = z.strictObject({
  projectId: z.uuid(),
  expectedAddressRevision: z.int().safe().min(1),
  expectedProfileRevision: z.int().safe().min(1),
});

abstract class EnergyProfileServiceError extends Error {
  protected constructor(
    public readonly code:
      | "prerequisites_missing"
      | "invalid_profile"
      | "stale"
      | "unsupported_source"
      | "retry_conflict"
      | "rate_limited",
    message: string,
  ) {
    super(message);
    this.name = "EnergyProfileServiceError";
  }
}

export class EnergyProfileNotFoundError extends EnergyProfileServiceError {
  constructor() {
    super("prerequisites_missing", "project energy profile was not found");
    this.name = "EnergyProfileNotFoundError";
  }
}

export class EnergyProfileConflictError extends EnergyProfileServiceError {
  constructor() {
    super("stale", "project energy profile revision is stale");
    this.name = "EnergyProfileConflictError";
  }
}

export class EnergyProfilePrerequisitesError extends EnergyProfileServiceError {
  constructor(public readonly reason: "address_pin" | "profile_confirmation") {
    super("prerequisites_missing", `project energy prerequisites missing: ${reason}`);
    this.name = "EnergyProfilePrerequisitesError";
  }
}

export class EnergyProfileInvalidError extends EnergyProfileServiceError {
  constructor() {
    super("invalid_profile", "project energy profile is invalid");
    this.name = "EnergyProfileInvalidError";
  }
}

export class EnergyProfileUnsupportedSourceError extends EnergyProfileServiceError {
  constructor() {
    super("unsupported_source", "project energy source is unsupported");
    this.name = "EnergyProfileUnsupportedSourceError";
  }
}

export class EnergyProfileRoofAcknowledgementError extends EnergyProfileServiceError {
  constructor() {
    super(
      "prerequisites_missing",
      "project energy roofs are not confirmed for the current site",
    );
    this.name = "EnergyProfileRoofAcknowledgementError";
  }
}

export class EnergyProfileRetryConflictError extends EnergyProfileServiceError {
  constructor() {
    super("retry_conflict", "another project calculation is already active");
    this.name = "EnergyProfileRetryConflictError";
  }
}

export class EnergyProfileRateLimitError extends EnergyProfileServiceError {
  public readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super("rate_limited", "project calculation reservation is rate limited");
    this.name = "EnergyProfileRateLimitError";
    this.retryAfterSeconds = Number.isFinite(retryAfterSeconds)
      ? Math.max(1, Math.ceil(retryAfterSeconds))
      : 1;
  }
}

function requireProjectAccess(
  ctx: ServiceCtx,
  action: "project.read" | "project.write",
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

function sha256Bytes(value: unknown): Buffer {
  return createHash("sha256")
    .update(canonicalizeCalculationJson(value), "utf8")
    .digest();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function requirePositiveRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new EnergyProfileInvalidError();
}

function hasCurrentHouse(row: ProjectSiteRow): boolean {
  return row.address_mode === "selected"
    && row.geocode_precision === "house"
    && !row.address_follow_up_required
    && row.pin_confirmed
    && row.pin_confirmed_address_revision === row.address_revision
    && row.latitude !== null
    && row.longitude !== null;
}

function assertCurrentHouse(row: ProjectSiteRow, expectedAddressRevision: number): void {
  requirePositiveRevision(expectedAddressRevision);
  if (row.address_revision !== expectedAddressRevision) {
    throw new EnergyProfileConflictError();
  }
  if (!hasCurrentHouse(row)) {
    throw new EnergyProfilePrerequisitesError("address_pin");
  }
}

async function lockProjectSite(
  tx: TenantTx,
  workspaceId: string,
  projectId: string,
): Promise<ProjectSiteRow | null> {
  const result = await tx.execute<ProjectSiteRow>(sql`
    select p.id as project_id, p.site_id,
           s.address_mode, s.geocode_precision, s.address_follow_up_required,
           s.address_revision, s.pin_confirmed,
           s.pin_confirmed_address_revision, s.lat as latitude,
           s.lng as longitude, cs.id as snapshot_id, cs.snapshot
      from project p
      join site s
        on s.workspace_id = p.workspace_id and s.id = p.site_id
      left join calculator_snapshot cs
        on cs.workspace_id = p.workspace_id and cs.project_id = p.id
     where p.workspace_id = ${workspaceId}::uuid
       and p.id = ${projectId}::uuid
     for update of p, s
  `);
  return result.rows[0] ?? null;
}

async function readProjectSite(
  tx: TenantTx,
  workspaceId: string,
  projectId: string,
): Promise<ProjectSiteRow | null> {
  const result = await tx.execute<ProjectSiteRow>(sql`
    select p.id as project_id, p.site_id,
           s.address_mode, s.geocode_precision, s.address_follow_up_required,
           s.address_revision, s.pin_confirmed,
           s.pin_confirmed_address_revision, s.lat as latitude,
           s.lng as longitude, cs.id as snapshot_id, cs.snapshot
      from project p
      join site s
        on s.workspace_id = p.workspace_id and s.id = p.site_id
      left join calculator_snapshot cs
        on cs.workspace_id = p.workspace_id and cs.project_id = p.id
     where p.workspace_id = ${workspaceId}::uuid
       and p.id = ${projectId}::uuid
  `);
  return result.rows[0] ?? null;
}

async function lockStoredProfile(
  tx: TenantTx,
  workspaceId: string,
  siteId: string,
): Promise<StoredProfileRow | null> {
  const result = await tx.execute<StoredProfileRow>(sql`
    select id, revision, address_revision, profile, profile_sha256,
           source_kind, source_snapshot_id, source_project_id,
           confirmed_profile_revision, confirmed_address_revision,
           confirmed_by, confirmed_at
      from site_energy_profile
     where workspace_id = ${workspaceId}::uuid
       and site_id = ${siteId}::uuid
     for update
  `);
  return result.rows[0] ?? null;
}

async function readStoredProfile(
  tx: TenantTx,
  workspaceId: string,
  siteId: string,
): Promise<StoredProfileRow | null> {
  const result = await tx.execute<StoredProfileRow>(sql`
    select id, revision, address_revision, profile, profile_sha256,
           source_kind, source_snapshot_id, source_project_id,
           confirmed_profile_revision, confirmed_address_revision,
           confirmed_by, confirmed_at
      from site_energy_profile
     where workspace_id = ${workspaceId}::uuid
       and site_id = ${siteId}::uuid
  `);
  return result.rows[0] ?? null;
}

type ProjectEnergySnapshotRow = ProjectSiteRow & {
  stored_id: string | null;
  stored_revision: number | null;
  stored_address_revision: number | null;
  stored_profile: unknown;
  stored_profile_sha256: Uint8Array | null;
  stored_source_kind: string | null;
  stored_source_snapshot_id: string | null;
  stored_source_project_id: string | null;
  stored_confirmed_profile_revision: number | null;
  stored_confirmed_address_revision: number | null;
  stored_confirmed_by: string | null;
  stored_confirmed_at: Date | string | null;
  requirement_id_ctx: string | null;
  requirement_revision_ctx: number | null;
  requirement_source_snapshot_id_ctx: string | null;
  requirement_requirements_ctx: unknown;
  requirement_source_branch_ctx: string | null;
  job_id_ctx: string | null;
  job_project_id_ctx: string | null;
  job_site_id_ctx: string | null;
  job_reservation_key_ctx: Uint8Array | null;
  job_state_ctx: string | null;
  job_address_revision_ctx: number | null;
  job_pin_confirmed_address_revision_ctx: number | null;
  job_profile_id_ctx: string | null;
  job_profile_revision_ctx: number | null;
  job_confirmed_profile_revision_ctx: number | null;
  job_confirmed_address_revision_ctx: number | null;
  job_requirement_id_ctx: string | null;
  job_requirement_revision_ctx: number | null;
  job_source_snapshot_id_ctx: string | null;
  job_provider_recipe_version_ctx: string | null;
  job_contract_version_ctx: string | null;
  job_model_id_ctx: string | null;
  job_model_version_ctx: string | null;
  job_source_revision_ctx: string | null;
  job_defaults_version_ctx: string | null;
  job_attempt_count_ctx: number | null;
  job_input_sha256_ctx: Uint8Array | null;
  job_input_snapshot_ctx: unknown;
  job_error_code_ctx: string | null;
  job_error_retryable_ctx: boolean | null;
  calculation_revision_id_ctx: string | null;
  calculation_revision_ctx: number | null;
  calculation_result_ctx: unknown;
};

type ProjectEnergySnapshot = {
  projectSite: ProjectSiteRow;
  stored: StoredProfileRow | null;
  requirement: RequirementRow | null;
  jobs: ContextJobRow[];
};

async function readProjectEnergySnapshot(
  tx: TenantTx,
  workspaceId: string,
  projectId: string,
): Promise<ProjectEnergySnapshot | null> {
  // READ COMMITTED garantiert Konsistenz pro Statement, nicht über mehrere
  // Statements. Deshalb wird der gesamte sichtbare Graph in genau EINER
  // Abfrage aufgenommen; ein gleichzeitiger Save kann so nie Adresse N mit
  // Profil N+1 oder Requirement N+1 vermischen.
  const result = await tx.execute<ProjectEnergySnapshotRow>(sql`
    with project_site as (
      select p.id as project_id, p.site_id,
             s.address_mode, s.geocode_precision, s.address_follow_up_required,
             s.address_revision, s.pin_confirmed,
             s.pin_confirmed_address_revision, s.lat as latitude,
             s.lng as longitude, snapshot.id as snapshot_id, snapshot.snapshot
        from project p
        join site s
          on s.workspace_id = p.workspace_id and s.id = p.site_id
        left join calculator_snapshot snapshot
          on snapshot.workspace_id = p.workspace_id
         and snapshot.project_id = p.id
       where p.workspace_id = ${workspaceId}::uuid
         and p.id = ${projectId}::uuid
    ), latest_requirement as (
      select requirement.id, requirement.revision,
             requirement.source_snapshot_id, requirement.requirements,
             snapshot.snapshot->>'branch' as source_branch
        from project_requirement requirement
        join calculator_snapshot snapshot
          on snapshot.workspace_id = requirement.workspace_id
         and snapshot.id = requirement.source_snapshot_id
         and snapshot.project_id = requirement.project_id
        join project_site selected on selected.project_id = requirement.project_id
       where requirement.workspace_id = ${workspaceId}::uuid
       order by requirement.revision desc
       limit 1
    )
    select selected.*,
           profile.id as stored_id,
           profile.revision as stored_revision,
           profile.address_revision as stored_address_revision,
           profile.profile as stored_profile,
           profile.profile_sha256 as stored_profile_sha256,
           profile.source_kind as stored_source_kind,
           profile.source_snapshot_id as stored_source_snapshot_id,
           profile.source_project_id as stored_source_project_id,
           profile.confirmed_profile_revision as stored_confirmed_profile_revision,
           profile.confirmed_address_revision as stored_confirmed_address_revision,
           profile.confirmed_by as stored_confirmed_by,
           profile.confirmed_at as stored_confirmed_at,
           requirement.id as requirement_id_ctx,
           requirement.revision as requirement_revision_ctx,
           requirement.source_snapshot_id as requirement_source_snapshot_id_ctx,
           requirement.requirements as requirement_requirements_ctx,
           requirement.source_branch as requirement_source_branch_ctx,
           job.id as job_id_ctx,
           job.project_id as job_project_id_ctx,
           job.site_id as job_site_id_ctx,
           job.reservation_key as job_reservation_key_ctx,
           job.state as job_state_ctx,
           job.address_revision as job_address_revision_ctx,
           job.pin_confirmed_address_revision as job_pin_confirmed_address_revision_ctx,
           job.profile_id as job_profile_id_ctx,
           job.profile_revision as job_profile_revision_ctx,
           job.confirmed_profile_revision as job_confirmed_profile_revision_ctx,
           job.confirmed_address_revision as job_confirmed_address_revision_ctx,
           job.requirement_id as job_requirement_id_ctx,
           job.requirement_revision as job_requirement_revision_ctx,
           job.source_snapshot_id as job_source_snapshot_id_ctx,
           job.provider_recipe_version as job_provider_recipe_version_ctx,
           job.contract_version as job_contract_version_ctx,
           job.model_id as job_model_id_ctx,
           job.model_version as job_model_version_ctx,
           job.source_revision as job_source_revision_ctx,
           job.defaults_version as job_defaults_version_ctx,
           job.attempt_count as job_attempt_count_ctx,
           job.input_sha256 as job_input_sha256_ctx,
           job.input_snapshot as job_input_snapshot_ctx,
           job.error_code as job_error_code_ctx,
           job.error_retryable as job_error_retryable_ctx,
           revision.id as calculation_revision_id_ctx,
           revision.revision as calculation_revision_ctx,
           revision.result as calculation_result_ctx
      from project_site selected
      left join site_energy_profile profile
        on profile.workspace_id = ${workspaceId}::uuid
       and profile.site_id = selected.site_id
      left join latest_requirement requirement on true
      left join project_calculation_job job
        on job.workspace_id = ${workspaceId}::uuid
       and job.project_id = selected.project_id
      left join project_calculation_revision revision
        on revision.workspace_id = job.workspace_id
       and revision.id = job.result_revision_id
       and revision.job_id = job.id
       and revision.project_id = job.project_id
       and revision.site_id = job.site_id
     order by job.created_at desc, job.id desc
  `);
  const first = result.rows[0];
  if (!first) return null;

  const projectSite: ProjectSiteRow = {
    project_id: first.project_id,
    site_id: first.site_id,
    address_mode: first.address_mode,
    geocode_precision: first.geocode_precision,
    address_follow_up_required: first.address_follow_up_required,
    address_revision: first.address_revision,
    pin_confirmed: first.pin_confirmed,
    pin_confirmed_address_revision: first.pin_confirmed_address_revision,
    latitude: first.latitude,
    longitude: first.longitude,
    snapshot_id: first.snapshot_id,
    snapshot: first.snapshot,
  };
  const stored: StoredProfileRow | null = first.stored_id === null
    ? null
    : {
        id: first.stored_id,
        revision: first.stored_revision as number,
        address_revision: first.stored_address_revision as number,
        profile: first.stored_profile,
        profile_sha256: first.stored_profile_sha256 as Uint8Array,
        source_kind: first.stored_source_kind as string,
        source_snapshot_id: first.stored_source_snapshot_id,
        source_project_id: first.stored_source_project_id,
        confirmed_profile_revision: first.stored_confirmed_profile_revision,
        confirmed_address_revision: first.stored_confirmed_address_revision,
        confirmed_by: first.stored_confirmed_by,
        confirmed_at: first.stored_confirmed_at,
      };
  const requirement: RequirementRow | null = first.requirement_id_ctx === null
    ? null
    : {
        id: first.requirement_id_ctx,
        revision: first.requirement_revision_ctx as number,
        source_snapshot_id: first.requirement_source_snapshot_id_ctx as string,
        requirements: first.requirement_requirements_ctx,
        source_branch: first.requirement_source_branch_ctx as string,
      };
  const jobs = result.rows.flatMap<ContextJobRow>((row) => {
    if (row.job_id_ctx === null) return [];
    return [{
      id: row.job_id_ctx,
      project_id: row.job_project_id_ctx as string,
      site_id: row.job_site_id_ctx as string,
      reservation_key: row.job_reservation_key_ctx as Uint8Array,
      state: row.job_state_ctx as string,
      address_revision: row.job_address_revision_ctx as number,
      pin_confirmed_address_revision:
        row.job_pin_confirmed_address_revision_ctx as number,
      profile_id: row.job_profile_id_ctx as string,
      profile_revision: row.job_profile_revision_ctx as number,
      confirmed_profile_revision: row.job_confirmed_profile_revision_ctx as number,
      confirmed_address_revision: row.job_confirmed_address_revision_ctx as number,
      requirement_id: row.job_requirement_id_ctx as string,
      requirement_revision: row.job_requirement_revision_ctx as number,
      source_snapshot_id: row.job_source_snapshot_id_ctx,
      provider_recipe_version: row.job_provider_recipe_version_ctx as string,
      contract_version: row.job_contract_version_ctx as string,
      model_id: row.job_model_id_ctx as string,
      model_version: row.job_model_version_ctx as string,
      source_revision: row.job_source_revision_ctx as string,
      defaults_version: row.job_defaults_version_ctx as string,
      attempt_count: row.job_attempt_count_ctx as number,
      input_sha256: row.job_input_sha256_ctx,
      input_snapshot: row.job_input_snapshot_ctx,
      error_code: row.job_error_code_ctx,
      error_retryable: row.job_error_retryable_ctx,
      calculation_revision_id: row.calculation_revision_id_ctx,
      calculation_revision: row.calculation_revision_ctx,
      result: row.calculation_result_ctx,
    }];
  });
  return { projectSite, stored, requirement, jobs };
}

function projectCandidate(
  row: ProjectSiteRow,
  expectedLatestRevision: number,
): ProjectEnergyProfileCandidate {
  if (row.snapshot_id === null || row.snapshot === null) {
    throw new EnergyProfileUnsupportedSourceError();
  }
  const projected = projectRechnerSnapshotToEnergyProfile(row.snapshot);
  if (!projected.ok) {
    if (projected.code === "unsupported_source") {
      throw new EnergyProfileUnsupportedSourceError();
    }
    throw new EnergyProfileInvalidError();
  }
  return {
    projectId: row.project_id,
    siteId: row.site_id,
    sourceSnapshotId: row.snapshot_id,
    addressRevision: row.address_revision,
    expectedLatestRevision,
    profile: projected.value,
  };
}

type KnownOrUnknown =
  | { status: "known"; value: unknown; source: string }
  | { status: "unknown"; value: null; source: "not_collected" };

function normalizeKnownField(
  submitted: KnownOrUnknown,
  candidate: KnownOrUnknown,
): KnownOrUnknown {
  if (
    submitted.status === candidate.status
    && submitted.value === candidate.value
  ) {
    return structuredClone(candidate);
  }
  if (submitted.status === "unknown") {
    return { status: "unknown", value: null, source: "not_collected" };
  }
  return { status: "known", value: submitted.value, source: "operator_reviewed" };
}

type Asset = SiteEnergyProfileV1["existingAssets"][keyof SiteEnergyProfileV1["existingAssets"]];

function withoutSource(value: Asset): Record<string, unknown> {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.source;
  return copy;
}

function normalizeAsset(submitted: Asset, candidate: Asset): Asset {
  if (
    canonicalizeCalculationJson(withoutSource(submitted))
    === canonicalizeCalculationJson(withoutSource(candidate))
  ) {
    return structuredClone(candidate);
  }
  if (submitted.status === "unknown") {
    return { status: "unknown", source: "not_collected" };
  }
  return { ...submitted, source: "operator_reviewed" } as Asset;
}

function normalizeProfile(
  submitted: SiteEnergyProfileV1,
  candidate: SiteEnergyProfileV1,
  rawAcknowledgements: string[],
): SiteEnergyProfileV1 {
  if (!Array.isArray(rawAcknowledgements) || rawAcknowledgements.length > 4) {
    throw new EnergyProfileInvalidError();
  }
  const acknowledgements = new Set<string>();
  for (const roofId of rawAcknowledgements) {
    if (
      typeof roofId !== "string"
      || roofId.length < 1
      || roofId.length > 64
      || acknowledgements.has(roofId)
    ) {
      throw new EnergyProfileInvalidError();
    }
    acknowledgements.add(roofId);
  }

  const candidateRoofs = new Map(candidate.roofs.map((roof) => [roof.id, roof]));
  const submittedRoofIds = new Set(submitted.roofs.map((roof) => roof.id));
  if (submittedRoofIds.size !== submitted.roofs.length) throw new EnergyProfileInvalidError();
  for (const roofId of acknowledgements) {
    if (!submittedRoofIds.has(roofId)) throw new EnergyProfileInvalidError();
  }

  const roofs = submitted.roofs.map((roof) => {
    const sourceRoof = candidateRoofs.get(roof.id);
    const submittedShape = {
      id: roof.id,
      areaM2: roof.areaM2,
      azimuthDeg: roof.azimuthDeg,
      tiltDeg: roof.tiltDeg,
      type: roof.type,
      shading: { status: roof.shading.status, value: roof.shading.value },
    };
    const candidateShape = sourceRoof && {
      id: sourceRoof.id,
      areaM2: sourceRoof.areaM2,
      azimuthDeg: sourceRoof.azimuthDeg,
      tiltDeg: sourceRoof.tiltDeg,
      type: sourceRoof.type,
      shading: { status: sourceRoof.shading.status, value: sourceRoof.shading.value },
    };
    const unchanged = sourceRoof !== undefined
      && canonicalizeCalculationJson(submittedShape)
        === canonicalizeCalculationJson(candidateShape);

    // Eine Default-Geometrie ist keine hausbezogene Dachwahrheit. Ein Klick
    // darf ihre Herkunft deshalb nicht hochstufen. Der Bearbeiter muss sie
    // durch ein klar neues, manuell erfasstes Dach (neue stabile Roof-ID)
    // ersetzen; erst dieser Replacement-Pfad kann operator_reviewed werden.
    if (sourceRoof?.source === "default" && acknowledgements.has(roof.id)) {
      throw new EnergyProfileRoofAcknowledgementError();
    }

    if (unchanged && !acknowledgements.has(roof.id)) return structuredClone(sourceRoof);
    if (!acknowledgements.has(roof.id)) throw new EnergyProfileRoofAcknowledgementError();

    return {
      ...roof,
      source: "operator_reviewed" as const,
      shading: roof.shading.status === "unknown"
        ? { status: "unknown" as const, value: null, source: "not_collected" as const }
        : { ...roof.shading, source: "operator_reviewed" as const },
    };
  });

  const profile: SiteEnergyProfileV1 = {
    schemaVersion: SITE_ENERGY_PROFILE_SCHEMA_VERSION,
    inputMode: "consumption",
    building: {
      type: normalizeKnownField(submitted.building.type, candidate.building.type) as SiteEnergyProfileV1["building"]["type"],
      year: normalizeKnownField(submitted.building.year, candidate.building.year) as SiteEnergyProfileV1["building"]["year"],
      heatedAreaM2: normalizeKnownField(
        submitted.building.heatedAreaM2,
        candidate.building.heatedAreaM2,
      ) as SiteEnergyProfileV1["building"]["heatedAreaM2"],
    },
    roofs,
    consumption: {
      householdKwhPerYear: normalizeKnownField(
        submitted.consumption.householdKwhPerYear,
        candidate.consumption.householdKwhPerYear,
      ) as SiteEnergyProfileV1["consumption"]["householdKwhPerYear"],
      electricityPriceCentsPerKwh: normalizeKnownField(
        submitted.consumption.electricityPriceCentsPerKwh,
        candidate.consumption.electricityPriceCentsPerKwh,
      ) as SiteEnergyProfileV1["consumption"]["electricityPriceCentsPerKwh"],
      annualPriceIncreasePercent: normalizeKnownField(
        submitted.consumption.annualPriceIncreasePercent,
        candidate.consumption.annualPriceIncreasePercent,
      ) as SiteEnergyProfileV1["consumption"]["annualPriceIncreasePercent"],
      loadProfile: normalizeKnownField(
        submitted.consumption.loadProfile,
        candidate.consumption.loadProfile,
      ) as SiteEnergyProfileV1["consumption"]["loadProfile"],
      evKmPerYear: normalizeKnownField(
        submitted.consumption.evKmPerYear,
        candidate.consumption.evKmPerYear,
      ) as SiteEnergyProfileV1["consumption"]["evKmPerYear"],
      evChargingPattern: normalizeKnownField(
        submitted.consumption.evChargingPattern,
        candidate.consumption.evChargingPattern,
      ) as SiteEnergyProfileV1["consumption"]["evChargingPattern"],
      heatPumpKwhPerYear: normalizeKnownField(
        submitted.consumption.heatPumpKwhPerYear,
        candidate.consumption.heatPumpKwhPerYear,
      ) as SiteEnergyProfileV1["consumption"]["heatPumpKwhPerYear"],
      coolingKwhPerYear: normalizeKnownField(
        submitted.consumption.coolingKwhPerYear,
        candidate.consumption.coolingKwhPerYear,
      ) as SiteEnergyProfileV1["consumption"]["coolingKwhPerYear"],
      heatingAcKwhPerYear: normalizeKnownField(
        submitted.consumption.heatingAcKwhPerYear,
        candidate.consumption.heatingAcKwhPerYear,
      ) as SiteEnergyProfileV1["consumption"]["heatingAcKwhPerYear"],
      hotWaterKwhPerYear: normalizeKnownField(
        submitted.consumption.hotWaterKwhPerYear,
        candidate.consumption.hotWaterKwhPerYear,
      ) as SiteEnergyProfileV1["consumption"]["hotWaterKwhPerYear"],
    },
    existingAssets: {
      pv: normalizeAsset(submitted.existingAssets.pv, candidate.existingAssets.pv) as SiteEnergyProfileV1["existingAssets"]["pv"],
      storage: normalizeAsset(
        submitted.existingAssets.storage,
        candidate.existingAssets.storage,
      ) as SiteEnergyProfileV1["existingAssets"]["storage"],
      wallbox: normalizeAsset(
        submitted.existingAssets.wallbox,
        candidate.existingAssets.wallbox,
      ) as SiteEnergyProfileV1["existingAssets"]["wallbox"],
      ev: normalizeAsset(submitted.existingAssets.ev, candidate.existingAssets.ev) as SiteEnergyProfileV1["existingAssets"]["ev"],
    },
    provenance: structuredClone(candidate.provenance),
  };

  const validated = siteEnergyProfileV1Schema.safeParse(profile);
  if (!validated.success) throw new EnergyProfileInvalidError();
  return validated.data;
}

export async function getProjectEnergyProfileCandidate(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectEnergyProfileCandidate | null> {
  requireProjectAccess(ctx, "project.write", "energy_profile");
  const parsedProjectId = candidateProjectIdSchema.safeParse(projectId);
  if (!parsedProjectId.success) throw new EnergyProfileInvalidError();
  const row = await readProjectSite(tx, ctx.workspaceId, parsedProjectId.data);
  if (!row) return null;
  const stored = await readStoredProfile(tx, ctx.workspaceId, row.site_id);
  return projectCandidate(row, stored?.revision ?? 0);
}

export async function saveProjectEnergyProfile(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: SaveProjectEnergyProfileInput,
): Promise<SaveProjectEnergyProfileResult> {
  requireProjectAccess(ctx, "project.write", "energy_profile");
  const parsedInput = saveProjectEnergyProfileInputSchema.safeParse(input);
  if (!parsedInput.success) throw new EnergyProfileInvalidError();
  const validatedInput = parsedInput.data;

  const projectSite = await lockProjectSite(tx, ctx.workspaceId, validatedInput.projectId);
  if (!projectSite) throw new EnergyProfileNotFoundError();
  assertCurrentHouse(projectSite, validatedInput.expectedAddressRevision);
  const stored = await lockStoredProfile(tx, ctx.workspaceId, projectSite.site_id);
  if (stored === null && validatedInput.expectedLatestRevision !== 0) {
    throw new EnergyProfileConflictError();
  }
  if (stored !== null && stored.revision !== validatedInput.expectedLatestRevision) {
    throw new EnergyProfileConflictError();
  }
  if (stored !== null) {
    const parsedStored = siteEnergyProfileV1Schema.safeParse(stored.profile);
    if (
      !parsedStored.success
      || !sameBytes(stored.profile_sha256, sha256Bytes(parsedStored.data))
    ) throw new EnergyProfileInvalidError();
  }

  const candidate = projectCandidate(projectSite, validatedInput.expectedLatestRevision);
  const profile = normalizeProfile(
    validatedInput.profile,
    candidate.profile,
    validatedInput.roofAcknowledgements,
  );
  const profileSha256 = sha256Bytes(profile);

  if (
    stored !== null
    && stored.address_revision === projectSite.address_revision
    && sameBytes(stored.profile_sha256, profileSha256)
    && canonicalizeCalculationJson(stored.profile) === canonicalizeCalculationJson(profile)
  ) {
    const confirmed = stored.confirmed_profile_revision === stored.revision
      && stored.confirmed_address_revision === stored.address_revision
      && stored.confirmed_by !== null
      && stored.confirmed_at !== null;
    return {
      profileId: stored.id,
      revision: stored.revision,
      addressRevision: stored.address_revision,
      changed: false,
      confirmed,
    };
  }

  const profileId = stored?.id ?? randomUUID();
  const revision = stored === null ? 1 : stored.revision + 1;
  if (stored === null) {
    await tx.execute(sql`
      insert into site_energy_profile (
        id, workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256
      ) values (
        ${profileId}::uuid, ${ctx.workspaceId}::uuid, ${projectSite.site_id}::uuid,
        1, ${SITE_ENERGY_PROFILE_SCHEMA_VERSION}, 'consumption',
        'rechner_snapshot', ${candidate.sourceSnapshotId}::uuid,
        ${validatedInput.projectId}::uuid, ${projectSite.address_revision},
        ${JSON.stringify(profile)}::jsonb, ${profileSha256}
      )
    `);
  } else {
    const updated = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      update site_energy_profile
         set revision = ${revision},
             source_kind = 'rechner_snapshot',
             source_snapshot_id = ${candidate.sourceSnapshotId}::uuid,
             source_project_id = ${validatedInput.projectId}::uuid,
             address_revision = ${projectSite.address_revision},
             profile = ${JSON.stringify(profile)}::jsonb,
             profile_sha256 = ${profileSha256},
             confirmed_profile_revision = null,
             confirmed_address_revision = null,
             confirmed_by = null,
             confirmed_at = null,
             updated_at = now()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${stored.id}::uuid
         and revision = ${stored.revision}
       returning id
    `);
    if (updated.rows.length !== 1) throw new EnergyProfileConflictError();
  }

  const eventPayload = {
    projectId: validatedInput.projectId,
    siteId: projectSite.site_id,
    profileId,
    profileRevision: revision,
    addressRevision: projectSite.address_revision,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "site",
    aggregateId: projectSite.site_id,
    eventType: "site.energy_profile_saved",
    actor: ctx.actor,
    payload: eventPayload,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.write",
    resource: "energy_profile",
    allowed: true,
    details: eventPayload,
  });

  return {
    profileId,
    revision,
    addressRevision: projectSite.address_revision,
    changed: true,
    confirmed: false,
  };
}

function reservationHash(input: {
  workspaceId: string;
  projectId: string;
  siteId: string;
  addressRevision: number;
  profileId: string;
  profileRevision: number;
  requirementId: string;
  requirementRevision: number;
  sourceSnapshotId: string;
}): Buffer {
  return sha256Bytes({
    reservationVersion: PLANNING_RESERVATION_VERSION,
    canonicalizationVersion: CALCULATION_CANONICALIZATION_VERSION,
    schemaSha256: PLANNING_CALCULATION_SCHEMA_SHA256,
    bindings: {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      siteId: input.siteId,
      addressRevision: input.addressRevision,
      pinConfirmedAddressRevision: input.addressRevision,
      profileId: input.profileId,
      profileRevision: input.profileRevision,
      confirmedProfileRevision: input.profileRevision,
      confirmedAddressRevision: input.addressRevision,
      requirementId: input.requirementId,
      requirementRevision: input.requirementRevision,
      sourceSnapshotId: input.sourceSnapshotId,
    },
    providerRecipeVersion: PLANNING_PROVIDER_RECIPE_VERSION,
    contractVersion: PLANNING_CALCULATION_CONTRACT_VERSION,
    modelId: PLANNING_MODEL_ID,
    modelVersion: PLANNING_MODEL_VERSION,
    sourceRevision: PLANNING_MODEL_SOURCE_REVISION,
    defaultsVersion: PLANNING_DEFAULTS_VERSION,
  });
}

type ReservationRateLimitRow = {
  database_now: Date | string;
  retry_after_seconds: number;
  actor_hour_count: number;
  workspace_hour_count: number;
  [key: string]: unknown;
};

async function enforceNewReservationRateLimit(
  tx: TenantTx,
  workspaceId: string,
  actorId: string,
): Promise<Date | string> {
  const policy = CALCULATION_RESERVATION_RATE_LIMIT_POLICY_V1;

  // Neue Reservations werden immer zuerst workspaceweit und danach fuer den
  // Actor innerhalb dieses Workspace serialisiert. Die domänenspezifischen
  // Hash-Praefixe trennen beide Lockraeume; eine theoretische Hashkollision
  // kann nur zusaetzlich serialisieren, niemals ein Limit oeffnen.
  await tx.execute(sql`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        ${`${policy.id}:workspace:${workspaceId}`},
        0::bigint
      )
    )
  `);
  await tx.execute(sql`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(
        ${`${policy.id}:workspace:${workspaceId}:actor:${actorId}`},
        0::bigint
      )
    )
  `);

  // clock_timestamp() wird bewusst erst NACH beiden Locks aufgenommen. now()
  // waere der Transaktionsbeginn und koennte nach Lock-Wartezeit ein bereits
  // veraltetes rollendes Fenster pruefen. Es gibt keinen Zustandfilter: Auch
  // succeeded/failed_final zaehlen, weil schon die Reservation externen
  // Aufwand ausloesen kann.
  const result = await tx.execute<ReservationRateLimitRow>(sql`
    with rate_clock as materialized (
      select pg_catalog.clock_timestamp() as database_now
    ), rate_stats as (
      select rate_clock.database_now,
             count(job.id) filter (
               where job.created_by = ${actorId}::uuid
             )::int as actor_hour_count,
             max(job.created_at) filter (
               where job.created_by = ${actorId}::uuid
             ) as actor_latest_created_at,
             min(job.created_at) filter (
               where job.created_by = ${actorId}::uuid
             ) as actor_oldest_created_at,
             count(job.id)::int as workspace_hour_count,
             min(job.created_at) as workspace_oldest_created_at
        from rate_clock
        left join project_calculation_job job
          on job.workspace_id = ${workspaceId}::uuid
         and job.created_at > rate_clock.database_now - interval '1 hour'
       group by rate_clock.database_now
    )
    select database_now::text as database_now,
           actor_hour_count, workspace_hour_count,
           greatest(
             case
               when actor_latest_created_at
                    > database_now - pg_catalog.make_interval(
                        secs => ${policy.actorCooldownSeconds}
                      )
               then pg_catalog.ceil(extract(epoch from (
                 actor_latest_created_at
                   + pg_catalog.make_interval(secs => ${policy.actorCooldownSeconds})
                   - database_now
               )))
               else 0
             end,
             case
               when actor_hour_count >= ${policy.actorMaxPerRollingHour}
               then pg_catalog.ceil(extract(epoch from (
                 actor_oldest_created_at + interval '1 hour' - database_now
               )))
               else 0
             end,
             case
               when workspace_hour_count >= ${policy.workspaceMaxPerRollingHour}
               then pg_catalog.ceil(extract(epoch from (
                 workspace_oldest_created_at + interval '1 hour' - database_now
               )))
               else 0
             end
           )::int as retry_after_seconds
      from rate_stats
  `);
  const row = result.rows[0];
  const retryAfterSeconds = Number(row?.retry_after_seconds);
  if (
    row === undefined
    || !(row.database_now instanceof Date || typeof row.database_now === "string")
    || !Number.isSafeInteger(retryAfterSeconds)
  ) {
    throw new EnergyProfileInvalidError();
  }
  if (retryAfterSeconds > 0) {
    throw new EnergyProfileRateLimitError(retryAfterSeconds);
  }
  return row.database_now;
}

async function lockLatestRequirement(
  tx: TenantTx,
  workspaceId: string,
  projectId: string,
): Promise<RequirementRow | null> {
  const result = await tx.execute<RequirementRow>(sql`
    select requirement.id, requirement.revision,
           requirement.source_snapshot_id, requirement.requirements,
           snapshot.snapshot->>'branch' as source_branch
      from project_requirement requirement
      join calculator_snapshot snapshot
        on snapshot.workspace_id = requirement.workspace_id
       and snapshot.id = requirement.source_snapshot_id
       and snapshot.project_id = requirement.project_id
     where requirement.workspace_id = ${workspaceId}::uuid
       and requirement.project_id = ${projectId}::uuid
     order by requirement.revision desc
     limit 1
     for update of requirement
  `);
  return result.rows[0] ?? null;
}

function parseRequirementForProfile(
  requirement: RequirementRow,
  profile: SiteEnergyProfileV1,
  expectedSourceSnapshotId: string | null,
): ProjectRequirementsRechnerV1 | null {
  const parsed = ProjectRequirementsRechnerV1Schema.safeParse(requirement.requirements);
  if (!parsed.success) return null;
  if (
    expectedSourceSnapshotId === null
    || requirement.source_snapshot_id !== expectedSourceSnapshotId
    || requirement.source_branch !== parsed.data.branch
  ) return null;

  const pvStatus = profile.existingAssets.pv.status;
  if (
    (parsed.data.branch === "new_installation" && pvStatus !== "known_absent")
    || (parsed.data.branch === "existing_installation" && pvStatus !== "known_present")
  ) return null;
  return parsed.data;
}

function assertRequirementMatchesProfile(
  requirement: RequirementRow,
  profile: SiteEnergyProfileV1,
  expectedSourceSnapshotId: string | null,
): ProjectRequirementsRechnerV1 {
  const parsed = parseRequirementForProfile(
    requirement,
    profile,
    expectedSourceSnapshotId,
  );
  if (parsed === null) throw new EnergyProfileInvalidError();
  return parsed;
}

function hasConfirmationCalculationInputs(
  profile: SiteEnergyProfileV1,
  requirement: ProjectRequirementsRechnerV1,
): boolean {
  return profile.roofs.every(
    (roof) => roof.source === "operator_reviewed" && roof.shading.status === "known",
  ) && (
    requirement.branch !== "existing_installation"
    || profile.existingAssets.storage.status !== "unknown"
  );
}

function jobMatchesCurrentBindings(
  job: ContextJobRow,
  workspaceId: string,
  projectSite: ProjectSiteRow,
  profile: StoredProfileRow,
  requirement: RequirementRow,
): boolean {
  return job.project_id === projectSite.project_id
    && job.site_id === projectSite.site_id
    && job.address_revision === projectSite.address_revision
    && job.pin_confirmed_address_revision === projectSite.address_revision
    && job.profile_id === profile.id
    && job.profile_revision === profile.revision
    && job.confirmed_profile_revision === profile.revision
    && job.confirmed_address_revision === profile.address_revision
    && job.requirement_id === requirement.id
    && job.requirement_revision === requirement.revision
    && job.source_snapshot_id === requirement.source_snapshot_id
    && job.provider_recipe_version === PLANNING_PROVIDER_RECIPE_VERSION
    && job.contract_version === PLANNING_CALCULATION_CONTRACT_VERSION
    && job.model_id === PLANNING_MODEL_ID
    && job.model_version === PLANNING_MODEL_VERSION
    && job.source_revision === PLANNING_MODEL_SOURCE_REVISION
    && job.defaults_version === PLANNING_DEFAULTS_VERSION
    && sameBytes(job.reservation_key, reservationHash({
      workspaceId,
      projectId: projectSite.project_id,
      siteId: projectSite.site_id,
      addressRevision: projectSite.address_revision,
      profileId: profile.id,
      profileRevision: profile.revision,
      requirementId: requirement.id,
      requirementRevision: requirement.revision,
      sourceSnapshotId: requirement.source_snapshot_id,
    }));
}

function calculationResultFromJob(
  job: ContextJobRow,
  required: boolean,
): ProjectEnergyCalculationResult | null {
  if (
    job.calculation_revision_id === null
    || job.calculation_revision === null
    || job.result === null
  ) {
    if (required) throw new EnergyProfileInvalidError();
    return null;
  }
  const input = validatePlanningCalculationRequest(job.input_snapshot);
  if (!input.ok || job.input_sha256 === null) {
    if (required) throw new EnergyProfileInvalidError();
    return null;
  }
  const validated = validatePlanningCalculationResultExactlyForRequest(
    input.value,
    job.result,
  );
  if (!validated.ok) {
    if (required) throw new EnergyProfileInvalidError();
    return null;
  }
  const inputSha256 = hashPlanningCalculationInput(input.value);
  if (
    !sameBytes(job.input_sha256, Buffer.from(inputSha256, "hex"))
    || validated.value.inputSha256 !== inputSha256
    || input.value.bindings.projectId !== job.project_id
    || input.value.bindings.siteId !== job.site_id
    || input.value.bindings.addressRevision !== job.address_revision
    || input.value.bindings.pinConfirmedAddressRevision
      !== job.pin_confirmed_address_revision
    || input.value.bindings.energyProfileId !== job.profile_id
    || input.value.bindings.energyProfileRevision !== job.profile_revision
    || input.value.bindings.confirmedEnergyProfileRevision
      !== job.confirmed_profile_revision
    || input.value.bindings.confirmedEnergyProfileAddressRevision
      !== job.confirmed_address_revision
    || input.value.bindings.projectRequirementId !== job.requirement_id
    || input.value.bindings.projectRequirementRevision !== job.requirement_revision
    || input.value.bindings.sourceCalculatorSnapshotId !== job.source_snapshot_id
    || input.value.contractVersion !== job.contract_version
    || validated.value.model.id !== job.model_id
    || validated.value.model.version !== job.model_version
    || validated.value.model.sourceRevision !== job.source_revision
  ) {
    if (required) throw new EnergyProfileInvalidError();
    return null;
  }
  return {
    id: job.calculation_revision_id,
    revision: job.calculation_revision,
    value: validated.value,
    binding: {
      addressRevision: job.address_revision,
      profile: { id: job.profile_id, revision: job.profile_revision },
      requirement: { id: job.requirement_id, revision: job.requirement_revision },
    },
    assumptions: structuredClone(input.value.resolvedAssumptions),
    sources: {
      providerRecipeVersion: job.provider_recipe_version,
      contractVersion: job.contract_version,
      canonicalizationVersion: input.value.canonicalizationVersion,
      schemaSha256: PLANNING_CALCULATION_SCHEMA_SHA256,
      defaultsVersion: job.defaults_version,
      modelId: job.model_id,
      modelVersion: job.model_version,
      sourceRevision: job.source_revision,
    },
  };
}

export async function getProjectEnergyContext(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectEnergyContext | null> {
  requireProjectAccess(ctx, "project.read", "energy_profile");
  const parsedProjectId = candidateProjectIdSchema.safeParse(projectId);
  if (!parsedProjectId.success) throw new EnergyProfileInvalidError();

  const snapshot = await readProjectEnergySnapshot(
    tx,
    ctx.workspaceId,
    parsedProjectId.data,
  );
  if (!snapshot) return null;
  const { projectSite, stored, requirement, jobs } = snapshot;

  let profileValue: SiteEnergyProfileV1 | null = null;
  if (stored !== null) {
    const parsedProfile = siteEnergyProfileV1Schema.safeParse(stored.profile);
    if (
      !parsedProfile.success
      || !sameBytes(stored.profile_sha256, sha256Bytes(parsedProfile.data))
    ) throw new EnergyProfileInvalidError();
    profileValue = parsedProfile.data;
  }

  const addressReady = hasCurrentHouse(projectSite);
  const profileConfirmed = stored !== null
    && profileValue !== null
    && stored.confirmed_profile_revision === stored.revision
    && stored.confirmed_address_revision === stored.address_revision
    && stored.confirmed_address_revision === projectSite.address_revision
    && stored.confirmed_by !== null
    && stored.confirmed_at !== null;
  const currentRequirement = requirement !== null && profileValue !== null
    ? parseRequirementForProfile(requirement, profileValue, projectSite.snapshot_id)
    : null;
  const prerequisitesReady = addressReady
    && stored !== null
    && profileValue !== null
    && profileConfirmed
    && requirement !== null
    && currentRequirement !== null;
  const currentJob = prerequisitesReady
    ? jobs.find((job) => jobMatchesCurrentBindings(
        job,
        ctx.workspaceId,
        projectSite,
        stored,
        requirement,
      ))
    : undefined;

  let calculation: ProjectEnergyCalculationState;
  if (currentJob !== undefined) {
    if (
      currentJob.state === "queued"
      || currentJob.state === "running"
      || currentJob.state === "retry_wait"
    ) {
      calculation = {
        status: currentJob.state,
        jobId: currentJob.id,
        attemptCount: currentJob.attempt_count,
        result: null,
      };
    } else if (currentJob.state === "succeeded") {
      calculation = {
        status: "current",
        jobId: currentJob.id,
        result: calculationResultFromJob(currentJob, true) as ProjectEnergyCalculationResult,
      };
    } else if (
      currentJob.state === "failed_final"
      && currentJob.error_code !== null
      && currentJob.error_retryable === false
    ) {
      calculation = {
        status: "failed",
        jobId: currentJob.id,
        attemptCount: currentJob.attempt_count,
        errorCode: currentJob.error_code,
        retryable: false,
        result: null,
      };
    } else {
      throw new EnergyProfileInvalidError();
    }
  } else if (jobs.length > 0) {
    const historical = jobs.find((job) => job.state === "succeeded") ?? jobs[0];
    calculation = {
      status: "stale",
      jobId: historical.id,
      result: historical.state === "succeeded"
        ? calculationResultFromJob(historical, false)
        : null,
    };
  } else {
    const blocker = !addressReady
      ? "address_pin"
      : stored === null || profileValue === null
        ? "energy_profile"
        : requirement === null || currentRequirement === null
          ? "project_requirement"
          : !profileConfirmed
            ? "profile_confirmation"
            : "calculation";
    calculation = { status: "blocked", blocker, jobId: null, result: null };
  }

  const canWrite = can(ctx, "project.write") && ctx.capabilities.external_only !== true;
  const canConfirm = addressReady
    && stored !== null
    && profileValue !== null
    && stored.address_revision === projectSite.address_revision
    && currentRequirement !== null
    && hasConfirmationCalculationInputs(profileValue, currentRequirement);
  return {
    projectId: projectSite.project_id,
    siteId: projectSite.site_id,
    addressRevision: projectSite.address_revision,
    profile: stored !== null && profileValue !== null
      ? {
          id: stored.id,
          revision: stored.revision,
          addressRevision: stored.address_revision,
          confirmed: profileConfirmed,
          value: profileValue,
        }
      : null,
    calculation,
    capabilities: {
      canEdit: canWrite,
      canConfirm: canWrite && canConfirm,
      // Ein Control darf erst angeboten werden, wenn eine echte öffentliche
      // Retry-Mutation existiert. Ein finaler nicht-retrybarer Fehler ist
      // ausdrücklich keine ausführbare Fähigkeit.
      canRetry: false,
    },
  };
}

export async function confirmProjectEnergyProfile(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ConfirmProjectEnergyProfileInput,
): Promise<ConfirmProjectEnergyProfileResult> {
  requireProjectAccess(ctx, "project.write", "energy_profile");
  const parsedInput = confirmProjectEnergyProfileInputSchema.safeParse(input);
  if (!parsedInput.success) throw new EnergyProfileInvalidError();
  const validatedInput = parsedInput.data;

  const projectSite = await lockProjectSite(tx, ctx.workspaceId, validatedInput.projectId);
  if (!projectSite) throw new EnergyProfileNotFoundError();
  assertCurrentHouse(projectSite, validatedInput.expectedAddressRevision);
  const stored = await lockStoredProfile(tx, ctx.workspaceId, projectSite.site_id);
  if (!stored) throw new EnergyProfileNotFoundError();
  if (
    stored.revision !== validatedInput.expectedProfileRevision
    || stored.address_revision !== projectSite.address_revision
  ) {
    throw new EnergyProfileConflictError();
  }

  const parsedProfile = siteEnergyProfileV1Schema.safeParse(stored.profile);
  if (!parsedProfile.success || !sameBytes(stored.profile_sha256, sha256Bytes(parsedProfile.data))) {
    throw new EnergyProfileInvalidError();
  }
  if (parsedProfile.data.roofs.some((roof) => roof.source !== "operator_reviewed")) {
    throw new EnergyProfileRoofAcknowledgementError();
  }

  const requirement = await lockLatestRequirement(
    tx,
    ctx.workspaceId,
    validatedInput.projectId,
  );
  if (!requirement) throw new EnergyProfilePrerequisitesError("profile_confirmation");
  const parsedRequirement = assertRequirementMatchesProfile(
    requirement,
    parsedProfile.data,
    projectSite.snapshot_id,
  );
  if (!hasConfirmationCalculationInputs(parsedProfile.data, parsedRequirement)) {
    throw new EnergyProfilePrerequisitesError("profile_confirmation");
  }

  let preparationSnapshot;
  try {
    preparationSnapshot = buildProjectCalculationPreparation({
      latitude: projectSite.latitude,
      longitude: projectSite.longitude,
      profile: parsedProfile.data,
      requirements: parsedRequirement,
      sourceSnapshot: projectSite.snapshot,
    });
  } catch {
    throw new EnergyProfileInvalidError();
  }
  const preparationSha256 = Buffer.from(
    hashProjectCalculationPreparation(preparationSnapshot),
    "hex",
  );

  const reservationKeyBytes = reservationHash({
    workspaceId: ctx.workspaceId,
    projectId: validatedInput.projectId,
    siteId: projectSite.site_id,
    addressRevision: projectSite.address_revision,
    profileId: stored.id,
    profileRevision: stored.revision,
    requirementId: requirement.id,
    requirementRevision: requirement.revision,
    sourceSnapshotId: requirement.source_snapshot_id,
  });
  const reservationKey = reservationKeyBytes.toString("hex");

  const existingResult = await tx.execute<JobRow>(sql`
    select id, reservation_key, state
      from project_calculation_job
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${validatedInput.projectId}::uuid
       and reservation_key = ${reservationKeyBytes}
     for update
  `);
  let job = existingResult.rows[0] ?? null;
  const activeResult = await tx.execute<JobRow>(sql`
    select id, reservation_key, state
      from project_calculation_job
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${validatedInput.projectId}::uuid
       and state in ('queued', 'running', 'retry_wait')
     for update
  `);
  const conflicting = activeResult.rows.find(
    (active) => !sameBytes(active.reservation_key, reservationKeyBytes),
  );
  if (conflicting) throw new EnergyProfileRetryConflictError();

  // Ein exakter Replay ist keine neue Reservation und muss auch bei
  // ausgeschoepfter Quota die idempotente queued-Dispatch-Reparatur erreichen.
  // Nur der Null-Fall nimmt Locks, prueft Limits und reserviert DB-Zeit.
  const reservationCreatedAt = job === null
    ? await enforceNewReservationRateLimit(tx, ctx.workspaceId, ctx.actor)
    : null;

  const profileAlreadyConfirmed =
    stored.confirmed_profile_revision === stored.revision
    && stored.confirmed_address_revision === stored.address_revision
    && stored.confirmed_by !== null
    && stored.confirmed_at !== null;
  if (!profileAlreadyConfirmed) {
    const confirmed = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
      update site_energy_profile
         set confirmed_profile_revision = revision,
             confirmed_address_revision = address_revision,
             confirmed_by = ${ctx.actor}::uuid,
             confirmed_at = now(),
             updated_at = now()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${stored.id}::uuid
         and revision = ${stored.revision}
         and confirmed_profile_revision is null
         and confirmed_address_revision is null
         and confirmed_by is null
         and confirmed_at is null
       returning id
    `);
    if (confirmed.rows.length !== 1) throw new EnergyProfileConflictError();
  }

  let jobCreated = false;
  if (!job) {
    if (reservationCreatedAt === null) throw new EnergyProfileInvalidError();
    const jobId = randomUUID();
    await tx.execute(sql`
      insert into project_calculation_job (
        id, workspace_id, project_id, site_id,
        address_revision, pin_confirmed_address_revision,
        profile_id, profile_revision, confirmed_profile_revision,
        confirmed_address_revision, requirement_id, requirement_revision,
        source_snapshot_id, reservation_key, provider_recipe_version,
        contract_version, model_id, model_version, source_revision,
        defaults_version, preparation_snapshot, preparation_sha256,
        state, attempt_count, next_attempt_at, created_by, created_at
      ) values (
        ${jobId}::uuid, ${ctx.workspaceId}::uuid, ${validatedInput.projectId}::uuid,
        ${projectSite.site_id}::uuid, ${projectSite.address_revision},
        ${projectSite.address_revision}, ${stored.id}::uuid, ${stored.revision},
        ${stored.revision}, ${stored.address_revision}, ${requirement.id}::uuid,
        ${requirement.revision}, ${requirement.source_snapshot_id}::uuid,
        ${reservationKeyBytes}, ${PLANNING_PROVIDER_RECIPE_VERSION},
        ${PLANNING_CALCULATION_CONTRACT_VERSION}, ${PLANNING_MODEL_ID},
        ${PLANNING_MODEL_VERSION}, ${PLANNING_MODEL_SOURCE_REVISION},
        ${PLANNING_DEFAULTS_VERSION}, ${JSON.stringify(preparationSnapshot)}::jsonb,
        ${preparationSha256}, 'queued', 0, ${reservationCreatedAt}::timestamptz,
        ${ctx.actor}::uuid, ${reservationCreatedAt}::timestamptz
      )
    `);
    job = { id: jobId, reservation_key: reservationKeyBytes, state: "queued" };
    jobCreated = true;
  }

  // Die fachliche Reservation und ihre minimale pg-boss-Zustellung teilen
  // dieselbe Transaktion. Auch ein Replay eines noch queued Jobs repariert
  // damit eine historisch verlorene Zustellung idempotent.
  if (job.state === "queued") {
    await enqueueProjectCalculationDispatch(tx, ctx.workspaceId, job.id);
  }

  const eventPayload = {
    projectId: validatedInput.projectId,
    siteId: projectSite.site_id,
    profileId: stored.id,
    profileRevision: stored.revision,
    addressRevision: stored.address_revision,
    jobId: job.id,
  };
  if (!profileAlreadyConfirmed) {
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "site",
      aggregateId: projectSite.site_id,
      eventType: "site.energy_profile_confirmed",
      actor: ctx.actor,
      payload: eventPayload,
    });
  }
  if (jobCreated) {
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "project",
      aggregateId: validatedInput.projectId,
      eventType: "project.calculation_reserved",
      actor: ctx.actor,
      payload: eventPayload,
    });
  }
  if (!profileAlreadyConfirmed || jobCreated) {
    await writeAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      action: "project.write",
      resource: profileAlreadyConfirmed ? "calculation_job" : "energy_profile",
      allowed: true,
      details: eventPayload,
    });
  }

  return {
    profileId: stored.id,
    profileRevision: stored.revision,
    addressRevision: stored.address_revision,
    jobId: job.id,
    reservationKey,
    replayed: profileAlreadyConfirmed && !jobCreated,
  };
}
