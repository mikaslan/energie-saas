import { sql } from "drizzle-orm";
import {
  ADDRESS_FINGERPRINT_VERSION,
  addressFingerprint,
} from "@/lib/address-fingerprint";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { writeAudit } from "@/lib/audit";
import {
  AddressCandidateSchema,
  type AddressCandidate,
} from "@/lib/integrations/geocoding/contract";
import {
  can,
  isExternalOnly,
  PermissionDeniedError,
  type ServiceCtx,
} from "@/lib/permissions";

export type ProjectTriageDetail = {
  project: {
    id: string;
    name: string;
    phase: string;
    outcome: string;
    createdAt: string;
    columnId: string;
    columnName: string;
  };
  contact: {
    displayName: string;
    email: string | null;
    phone: string | null;
  };
  site: {
    id: string;
    formattedAddress: string | null;
    addressMode: string;
    precision: string | null;
    addressFollowUpRequired: boolean;
    pinConfirmed: boolean;
    pinAdjusted: boolean;
    addressRevision: number;
    geocodeSource: string | null;
    latitude: number | null;
    longitude: number | null;
  };
  source: {
    label: string;
    submittedAt: string | null;
    calculatorEngine: string | null;
    producerRevision: string | null;
  };
  requirements: {
    branch: string | null;
    targetStorageKwh: number | null;
    wallbox: boolean;
    bidirectionalCharging: boolean;
    backupPower: boolean;
  };
  calculatorEstimate: {
    label: "Unverifizierter Richtwert – kein Angebotspreis";
    integrity: string | null;
    priceSource: string | null;
    systemPeakPowerKwp: number | null;
    storageCapacityKwh: number | null;
    autonomyRate: number | null;
    investmentLowCents: number | null;
    investmentHighCents: number | null;
    amortizationYears: number | null;
  };
  blockers: {
    dedupeReviewRequired: boolean;
    addressFollowUpRequired: boolean;
    pinConfirmationRequired: boolean;
    catalogResolutionPending: boolean;
  };
  permissions: {
    canMoveCard: boolean;
    canConfirmPin: boolean;
    canCorrectAddress: boolean;
  };
};

type DetailRow = {
  project_id: string;
  project_name: string;
  phase: string;
  outcome: string;
  created_at: Date | string;
  column_id: string;
  column_name: string;
  contact_name: string;
  email: string | null;
  phone: string | null;
  site_id: string;
  formatted_address: string | null;
  address_mode: string;
  geocode_precision: string | null;
  address_follow_up_required: boolean;
  pin_confirmed: boolean;
  pin_adjusted: boolean;
  address_revision: number;
  geocode_source: string | null;
  lat: number | null;
  lng: number | null;
  source_key: string;
  submitted_at: Date | string | null;
  calculator_engine: string | null;
  producer_revision: string | null;
  requirements_branch: string | null;
  target_storage_kwh: number | string | null;
  wallbox: boolean | null;
  bidirectional_charging: boolean | null;
  backup_power: boolean | null;
  result_integrity: string | null;
  price_source: string | null;
  system_peak_power_kwp: number | string | null;
  storage_capacity_kwh: number | string | null;
  autonomy_rate: number | string | null;
  investment_low_cents: number | string | null;
  investment_high_cents: number | string | null;
  amortization_years: number | string | null;
  dedupe_review_required: boolean;
  catalog_resolution_status: string;
  referencing_projects: number;
  [key: string]: unknown;
};

type PinRow = {
  project_id: string;
  site_id: string;
  address_mode: string;
  geocode_precision: string | null;
  address_follow_up_required: boolean;
  pin_confirmed: boolean;
  pin_confirmed_address_revision: number | null;
  address_revision: number;
  street: string | null;
  house_number: string | null;
  postal_code: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  [key: string]: unknown;
};

type AddressCorrectionRow = {
  project_id: string;
  site_id: string;
  contact_id: string;
  address_mode: string;
  address_follow_up_required: boolean;
  pin_confirmed: boolean;
  address_revision: number;
  [key: string]: unknown;
};

export type ProjectAddressCorrectionContext = {
  projectId: string;
  siteId: string;
  addressRevision: number;
  editable: boolean;
};

export type CorrectProjectSiteAddressInput = {
  projectId: string;
  expectedAddressRevision: number;
  resolvedAddress: AddressCandidate;
  pin: {
    latitude: number;
    longitude: number;
  };
};

export class SiteAddressNotEditableError extends Error {
  constructor() {
    super("site address cannot be corrected from the current state");
    this.name = "SiteAddressNotEditableError";
  }
}

export class SiteAddressConflictError extends Error {
  constructor() {
    super("site address revision is stale");
    this.name = "SiteAddressConflictError";
  }
}

export class SiteAddressCollisionError extends Error {
  constructor() {
    super("another site already uses this contact address");
    this.name = "SiteAddressCollisionError";
  }
}

export class SiteAddressSharedError extends Error {
  constructor() {
    super("site is referenced by more than one project");
    this.name = "SiteAddressSharedError";
  }
}

export class SitePinOutOfRangeError extends Error {
  constructor() {
    super("site pin is outside the permitted address radius");
    this.name = "SitePinOutOfRangeError";
  }
}

export class SiteAddressInvalidError extends Error {
  constructor() {
    super("resolved site address is invalid");
    this.name = "SiteAddressInvalidError";
  }
}

export class SitePinNotConfirmableError extends Error {
  constructor() {
    super("site pin cannot be confirmed from the current address quality");
    this.name = "SitePinNotConfirmableError";
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
  if (isExternalOnly(ctx)) {
    throw new PermissionDeniedError(
      action,
      resource,
      "external_only_without_assignment",
      ctx.actor,
    );
  }
}

function numberOrNull(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export async function getProjectTriageDetail(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectTriageDetail | null> {
  requireProjectAccess(ctx, "project.read", "project");

  const result = await tx.execute<DetailRow>(sql`
    select p.id as project_id, p.name as project_name, p.phase, p.outcome,
           p.created_at, p.kanban_column_id as column_id,
           kc.name as column_name, p.source_key,
           c.display_name as contact_name, c.email_primary as email,
           c.phone_raw as phone,
           s.id as site_id, s.formatted_address, s.address_mode,
           s.geocode_source, s.geocode_precision,
           s.address_follow_up_required, s.pin_confirmed,
           s.pin_adjusted, s.address_revision, s.lat, s.lng,
           r.submitted_at, r.calculator_engine,
           r.producer_git_revision as producer_revision,
           pr.requirements->>'branch' as requirements_branch,
           nullif(pr.requirements #>> '{requestedProducts,targetStorageKwh}', '')::numeric
             as target_storage_kwh,
           (pr.requirements #>> '{requestedProducts,wallbox}')::boolean as wallbox,
           (pr.requirements #>> '{requestedProducts,bidirectionalCharging}')::boolean
             as bidirectional_charging,
           (pr.requirements #>> '{requestedProducts,backupPower}')::boolean as backup_power,
           cs.result_integrity,
           cs.investment_source as price_source,
           nullif(cs.snapshot #>> '{result,systemPeakPowerKwp}', '')::numeric
             as system_peak_power_kwp,
           nullif(cs.snapshot #>> '{result,storageCapacityKwh}', '')::numeric
             as storage_capacity_kwh,
           nullif(cs.snapshot #>> '{result,energy,autonomyRate}', '')::numeric
             as autonomy_rate,
           nullif(cs.snapshot #>> '{result,economics,investmentLowCents}', '')::numeric
             as investment_low_cents,
           nullif(cs.snapshot #>> '{result,economics,investmentHighCents}', '')::numeric
             as investment_high_cents,
           nullif(cs.snapshot #>> '{result,economics,amortizationYears}', '')::numeric
             as amortization_years,
           coalesce(p.dedupe_review_required, false)
             or coalesce(c.dedupe_review_required, false) as dedupe_review_required,
           p.catalog_resolution_status,
           (select count(*)::int
              from project reference
             where reference.workspace_id = p.workspace_id
               and reference.site_id = p.site_id) as referencing_projects
    from project p
    join contact c
      on c.workspace_id = p.workspace_id and c.id = p.contact_id
    join site s
      on s.workspace_id = p.workspace_id and s.id = p.site_id
    join kanban_column kc
      on kc.workspace_id = p.workspace_id
      and kc.board_id = p.kanban_board_id
      and kc.id = p.kanban_column_id
    left join inbound_receipt r
      on r.workspace_id = p.workspace_id and r.project_id = p.id
    left join calculator_snapshot cs
      on cs.workspace_id = p.workspace_id and cs.project_id = p.id
    left join lateral (
      select requirement.requirements
      from project_requirement requirement
      where requirement.workspace_id = p.workspace_id
        and requirement.project_id = p.id
      order by requirement.revision desc
      limit 1
    ) pr on true
    where p.workspace_id = ${ctx.workspaceId}::uuid
      and p.id = ${projectId}::uuid
    limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;

  const canWrite = can(ctx, "project.write");
  return {
    project: {
      id: row.project_id,
      name: row.project_name,
      phase: row.phase,
      outcome: row.outcome,
      createdAt: isoOrNull(row.created_at)!,
      columnId: row.column_id,
      columnName: row.column_name,
    },
    contact: {
      displayName: row.contact_name,
      email: row.email,
      phone: row.phone,
    },
    site: {
      id: row.site_id,
      formattedAddress: row.formatted_address,
      addressMode: row.address_mode,
      precision: row.geocode_precision,
      addressFollowUpRequired: row.address_follow_up_required,
      pinConfirmed: row.pin_confirmed,
      pinAdjusted: row.pin_adjusted,
      addressRevision: row.address_revision,
      geocodeSource: row.geocode_source,
      latitude: row.lat,
      longitude: row.lng,
    },
    source: {
      label: row.source_key === "wmee-rechner-v3" ? "Solarrechner" : "Manuell",
      submittedAt: isoOrNull(row.submitted_at),
      calculatorEngine: row.calculator_engine,
      producerRevision: row.producer_revision,
    },
    requirements: {
      branch: row.requirements_branch,
      targetStorageKwh: numberOrNull(row.target_storage_kwh),
      wallbox: row.wallbox === true,
      bidirectionalCharging: row.bidirectional_charging === true,
      backupPower: row.backup_power === true,
    },
    calculatorEstimate: {
      label: "Unverifizierter Richtwert – kein Angebotspreis",
      integrity: row.result_integrity,
      priceSource: row.price_source,
      systemPeakPowerKwp: numberOrNull(row.system_peak_power_kwp),
      storageCapacityKwh: numberOrNull(row.storage_capacity_kwh),
      autonomyRate: numberOrNull(row.autonomy_rate),
      investmentLowCents: numberOrNull(row.investment_low_cents),
      investmentHighCents: numberOrNull(row.investment_high_cents),
      amortizationYears: numberOrNull(row.amortization_years),
    },
    blockers: {
      dedupeReviewRequired: row.dedupe_review_required,
      addressFollowUpRequired: row.address_follow_up_required,
      pinConfirmationRequired: !row.pin_confirmed,
      catalogResolutionPending: row.catalog_resolution_status !== "resolved",
    },
    permissions: {
      canMoveCard: canWrite,
      canConfirmPin: canWrite
        && row.address_mode === "selected"
        && row.geocode_precision === "house"
        && !row.address_follow_up_required
        && !row.pin_confirmed,
      canCorrectAddress: canWrite
        && row.address_mode === "regional_estimate"
        && row.address_follow_up_required
        && !row.pin_confirmed
        && row.referencing_projects === 1,
    },
  };
}

function validRevision(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function validCoordinate(value: number, minimum: number, maximum: number): boolean {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

const EARTH_RADIUS_METERS = 6_371_008.8;
const MAXIMUM_PIN_DISTANCE_METERS = 150;
const PIN_ADJUSTED_THRESHOLD_METERS = 0.5;

function radians(value: number): number {
  return value * (Math.PI / 180);
}

function distanceMeters(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): number {
  const fromLatitude = radians(from.latitude);
  const toLatitude = radians(to.latitude);
  const latitudeDelta = toLatitude - fromLatitude;
  const longitudeDelta = radians(to.longitude - from.longitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude)
    * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

function isAddressFingerprintViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505"
    && candidate.constraint === "site_ws_contact_address_fingerprint_uq";
}

function editableAddressState(row: AddressCorrectionRow): boolean {
  return row.address_mode === "regional_estimate"
    && row.address_follow_up_required
    && !row.pin_confirmed;
}

export async function getProjectAddressCorrectionContext(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<ProjectAddressCorrectionContext | null> {
  requireProjectAccess(ctx, "project.write", "site_address");

  const result = await tx.execute<AddressCorrectionRow & {
    referencing_projects: number;
  }>(sql`
    select p.id as project_id, p.site_id, p.contact_id,
           s.address_mode, s.address_follow_up_required,
           s.pin_confirmed, s.address_revision,
           (select count(*)::int
              from project reference
             where reference.workspace_id = p.workspace_id
               and reference.site_id = p.site_id) as referencing_projects
    from project p
    join site s
      on s.workspace_id = p.workspace_id and s.id = p.site_id
    where p.workspace_id = ${ctx.workspaceId}::uuid
      and p.id = ${projectId}::uuid
    limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;

  return {
    projectId: row.project_id,
    siteId: row.site_id,
    addressRevision: row.address_revision,
    editable: editableAddressState(row) && row.referencing_projects === 1,
  };
}

export async function correctProjectSiteAddress(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CorrectProjectSiteAddressInput,
): Promise<{ siteId: string; addressRevision: number }> {
  requireProjectAccess(ctx, "project.write", "site_address");
  if (!validRevision(input.expectedAddressRevision)) {
    throw new SiteAddressConflictError();
  }

  const parsedAddress = AddressCandidateSchema.safeParse(input.resolvedAddress);
  if (!parsedAddress.success) throw new SiteAddressInvalidError();
  if (
    !validCoordinate(input.pin.latitude, -90, 90)
    || !validCoordinate(input.pin.longitude, -180, 180)
  ) {
    throw new SitePinOutOfRangeError();
  }
  const resolvedAddress = parsedAddress.data;
  const pinDistance = distanceMeters(resolvedAddress, input.pin);
  // One micrometre of tolerance keeps the mathematically inclusive boundary
  // stable across floating-point implementations without widening the rule.
  if (pinDistance > MAXIMUM_PIN_DISTANCE_METERS + 0.000_001) {
    throw new SitePinOutOfRangeError();
  }

  // Locking the contact serializes fingerprint decisions across different
  // regional Sites of the same customer. FOR UPDATE on the Site also blocks
  // a concurrent FK reference until the shared-site check has completed.
  const locked = await tx.execute<AddressCorrectionRow>(sql`
    select p.id as project_id, p.site_id, p.contact_id,
           s.address_mode, s.address_follow_up_required,
           s.pin_confirmed, s.address_revision
    from project p
    join site s
      on s.workspace_id = p.workspace_id and s.id = p.site_id
    join contact c
      on c.workspace_id = p.workspace_id and c.id = p.contact_id
    where p.workspace_id = ${ctx.workspaceId}::uuid
      and p.id = ${input.projectId}::uuid
    for update of p, s, c
  `);
  const row = locked.rows[0];
  if (!row) throw new SiteAddressNotEditableError();
  if (row.address_revision !== input.expectedAddressRevision) {
    throw new SiteAddressConflictError();
  }
  if (!editableAddressState(row)) throw new SiteAddressNotEditableError();

  const references = await tx.execute<{ total: number; [key: string]: unknown }>(sql`
    select count(*)::int as total
    from project
    where workspace_id = ${ctx.workspaceId}::uuid
      and site_id = ${row.site_id}::uuid
  `);
  if (references.rows[0]?.total !== 1) throw new SiteAddressSharedError();

  const fingerprint = addressFingerprint({
    countryCode: resolvedAddress.countryCode,
    postalCode: resolvedAddress.postalCode,
    city: resolvedAddress.city,
    street: resolvedAddress.street,
    houseNumber: resolvedAddress.houseNumber,
  });
  const collision = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id
    from site
    where workspace_id = ${ctx.workspaceId}::uuid
      and contact_id = ${row.contact_id}::uuid
      and id <> ${row.site_id}::uuid
      and address_mode = 'selected'
      and address_fingerprint_version = ${ADDRESS_FINGERPRINT_VERSION}
      and address_fingerprint = ${fingerprint}
    limit 1
  `);
  if (collision.rows.length > 0) throw new SiteAddressCollisionError();

  const nextRevision = row.address_revision + 1;
  try {
    await tx.execute(sql`
      update site
      set formatted_address = ${resolvedAddress.formattedAddress},
          address_fingerprint = ${fingerprint},
          address_fingerprint_version = ${ADDRESS_FINGERPRINT_VERSION},
          address_mode = 'selected',
          street = ${resolvedAddress.street},
          house_number = ${resolvedAddress.houseNumber},
          postal_code = ${resolvedAddress.postalCode},
          city = ${resolvedAddress.city},
          country = ${resolvedAddress.countryCode},
          lat = ${input.pin.latitude},
          lng = ${input.pin.longitude},
          geocode_source = ${resolvedAddress.provider},
          geocode_place_id = ${resolvedAddress.placeId},
          geocode_precision = ${resolvedAddress.precision},
          address_follow_up_required = false,
          pin_confirmed = false,
          pin_confirmed_address_revision = null,
          pin_adjusted = ${pinDistance > PIN_ADJUSTED_THRESHOLD_METERS},
          address_revision = ${nextRevision},
          updated_at = now()
      where workspace_id = ${ctx.workspaceId}::uuid
        and id = ${row.site_id}::uuid
    `);
  } catch (error) {
    if (isAddressFingerprintViolation(error)) throw new SiteAddressCollisionError();
    throw error;
  }

  const technicalDetails = {
    siteId: row.site_id,
    projectId: row.project_id,
    addressRevision: nextRevision,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "site",
    aggregateId: row.site_id,
    eventType: "site.address_corrected",
    actor: ctx.actor,
    payload: technicalDetails,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.write",
    resource: "site_address",
    allowed: true,
    details: technicalDetails,
  });

  return { siteId: row.site_id, addressRevision: nextRevision };
}

export async function confirmProjectSitePin(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; expectedAddressRevision: number },
): Promise<{ siteId: string; confirmed: true; changed: boolean }> {
  requireProjectAccess(ctx, "project.write", "site_pin");

  const result = await tx.execute<PinRow>(sql`
    select p.id as project_id, s.id as site_id, s.address_mode,
           s.geocode_precision, s.address_follow_up_required,
           s.pin_confirmed, s.pin_confirmed_address_revision,
           s.address_revision, s.street, s.house_number, s.postal_code,
           s.city, s.lat, s.lng
    from project p
    join site s
      on s.workspace_id = p.workspace_id and s.id = p.site_id
    where p.workspace_id = ${ctx.workspaceId}::uuid
      and p.id = ${input.projectId}::uuid
    for update of p, s
  `);
  const row = result.rows[0];
  if (!row) throw new SitePinNotConfirmableError();
  if (!validRevision(input.expectedAddressRevision)
    || row.address_revision !== input.expectedAddressRevision) {
    throw new SiteAddressConflictError();
  }
  if (
    row.pin_confirmed
    && row.pin_confirmed_address_revision === row.address_revision
  ) {
    return { siteId: row.site_id, confirmed: true, changed: false };
  }
  if (
    row.address_mode !== "selected"
    || row.geocode_precision !== "house"
    || row.address_follow_up_required
    || !row.street
    || !row.house_number
    || !row.postal_code
    || !row.city
    || row.lat === null
    || row.lng === null
  ) {
    throw new SitePinNotConfirmableError();
  }

  await tx.execute(sql`
    update site
    set pin_confirmed = true,
        pin_confirmed_address_revision = ${row.address_revision},
        updated_at = now()
    where workspace_id = ${ctx.workspaceId}::uuid
      and id = ${row.site_id}::uuid
  `);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "site",
    aggregateId: row.site_id,
    eventType: "site.pin_confirmed",
    actor: ctx.actor,
    payload: {
      siteId: row.site_id,
      projectId: row.project_id,
      addressRevision: row.address_revision,
    },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.write",
    resource: "site_pin",
    allowed: true,
    details: {
      siteId: row.site_id,
      projectId: row.project_id,
      addressRevision: row.address_revision,
    },
  });

  return { siteId: row.site_id, confirmed: true, changed: true };
}
