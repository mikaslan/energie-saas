import { sql } from "drizzle-orm";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { writeAudit } from "@/lib/audit";
import {
  can,
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
  [key: string]: unknown;
};

type PinRow = {
  project_id: string;
  site_id: string;
  address_mode: string;
  geocode_precision: string | null;
  address_follow_up_required: boolean;
  pin_confirmed: boolean;
  street: string | null;
  house_number: string | null;
  postal_code: string | null;
  city: string | null;
  lat: number | null;
  lng: number | null;
  [key: string]: unknown;
};

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
  if (ctx.capabilities.external_only === true) {
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
           s.geocode_precision, s.address_follow_up_required,
           s.pin_confirmed, s.lat, s.lng,
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
           p.catalog_resolution_status
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
    },
  };
}

export async function confirmProjectSitePin(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string },
): Promise<{ siteId: string; confirmed: true; changed: boolean }> {
  requireProjectAccess(ctx, "project.write", "site_pin");

  const result = await tx.execute<PinRow>(sql`
    select p.id as project_id, s.id as site_id, s.address_mode,
           s.geocode_precision, s.address_follow_up_required,
           s.pin_confirmed, s.street, s.house_number, s.postal_code,
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
  if (row.pin_confirmed) {
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
    set pin_confirmed = true
    where workspace_id = ${ctx.workspaceId}::uuid
      and id = ${row.site_id}::uuid
  `);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "site",
    aggregateId: row.site_id,
    eventType: "site.pin_confirmed",
    actor: ctx.actor,
    payload: { siteId: row.site_id, projectId: row.project_id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.write",
    resource: "site_pin",
    allowed: true,
    details: { siteId: row.site_id, projectId: row.project_id },
  });

  return { siteId: row.site_id, confirmed: true, changed: true };
}
