// F12-01 Funnel-Kampagnen: benannte Variante mit eigener Lead-Quelle und
// stabilem Slug (Deeplink-Token, Bedienung in F12-02).
// Berechtigung: bestehende lead_source.read/write (KEINE neuen Keys) —
// Kampagnen sind Quellen-Konfiguration.
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  createFunnelCampaignCommandSchema,
  funnelCampaignDtoSchema,
  FUNNEL_CAMPAIGN_SCHEMA_VERSION,
  type CreateFunnelCampaignCommand,
  type FunnelCampaignDto,
} from "@/lib/integrations/funnel-campaigns/contract";
import { LeadSourceNotFoundError } from "@/modules/lead-sources";
import {
  FunnelCampaignConflictError,
  FunnelCampaignNotFoundError,
  FunnelCampaignValidationError,
} from "./errors";

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "lead_source.read")) {
    throw new PermissionDeniedError("lead_source.read", "funnel_campaign", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "lead_source.write")) {
    throw new PermissionDeniedError("lead_source.write", "funnel_campaign", undefined, ctx.actor);
  }
}

export function normalizeFunnelCampaignName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

export function normalizeFunnelCampaignSlug(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

type FunnelCampaignRow = {
  id: string;
  name: string;
  slug: string;
  lead_source_id: string;
  lead_source_name: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

const ROW_SELECT = sql`
  select campaign.id, campaign.name, campaign.slug,
         campaign.lead_source_id, source.name as lead_source_name,
         campaign.archived_at, campaign.created_at, campaign.updated_at
    from funnel_campaign campaign
    join lead_source source
      on source.workspace_id = campaign.workspace_id
     and source.id = campaign.lead_source_id
`;

function toDto(row: FunnelCampaignRow, canWrite: boolean): FunnelCampaignDto {
  return funnelCampaignDtoSchema.parse({
    schemaVersion: FUNNEL_CAMPAIGN_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    slug: row.slug,
    leadSourceId: row.lead_source_id,
    leadSourceName: row.lead_source_name,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

export async function listFunnelCampaigns(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { includeArchived?: boolean } = {},
): Promise<FunnelCampaignDto[]> {
  requireRead(ctx);
  const includeArchived = query.includeArchived === true;
  const result = await tx.execute<FunnelCampaignRow>(sql`
    ${ROW_SELECT}
   where campaign.workspace_id = ${ctx.workspaceId}::uuid
     ${includeArchived ? sql`` : sql`and campaign.archived_at is null`}
   order by campaign.name asc, campaign.id asc
  `);
  const canWrite = can(ctx, "lead_source.write");
  return result.rows.map((row) => toDto(row, canWrite));
}

/**
 * Aktive Kampagne mit eigener Quelle für die manuelle Erfassung auflösen.
 * Gibt null zurück, wenn es sie nicht (mehr) gibt — der Aufrufer
 * entscheidet fail-closed (createManualLead verweigert, kein stiller
 * Quellen-Fallback).
 */
export async function resolveActiveFunnelCampaign(
  tx: TenantTx,
  ctx: Pick<ServiceCtx, "workspaceId">,
  id: string,
): Promise<{ id: string; leadSourceId: string } | null> {
  const result = await tx.execute<{ id: string; lead_source_id: string }>(sql`
    select id, lead_source_id
      from funnel_campaign
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id}::uuid
       and archived_at is null
     limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, leadSourceId: row.lead_source_id };
}

export async function createFunnelCampaign(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateFunnelCampaignCommand,
): Promise<FunnelCampaignDto> {
  requireWrite(ctx);
  const parsed = createFunnelCampaignCommandSchema.safeParse(input);
  if (!parsed.success) throw new FunnelCampaignValidationError();
  const command = parsed.data;

  // Quelle muss existieren UND aktiv sein (fail-closed — anders als die
  // historische F1-11-Quellenprüfung bleibt Bestand unberührt).
  const source = await tx.execute<{ id: string }>(sql`
    select id from lead_source
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.leadSourceId}::uuid
       and archived_at is null
     limit 1
  `);
  if (!source.rows[0]) throw new LeadSourceNotFoundError(command.leadSourceId);

  let row: FunnelCampaignRow;
  try {
    const inserted = await tx.execute<FunnelCampaignRow>(sql`
      insert into funnel_campaign (
        workspace_id, name, name_normalized, slug, slug_normalized, lead_source_id
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.name},
        ${normalizeFunnelCampaignName(command.name)},
        ${command.slug},
        ${normalizeFunnelCampaignSlug(command.slug)},
        ${command.leadSourceId}::uuid
      )
      returning id, name, slug, lead_source_id,
        (select name from lead_source
          where workspace_id = ${ctx.workspaceId}::uuid
            and id = ${command.leadSourceId}::uuid) as lead_source_name,
        archived_at, created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new FunnelCampaignConflictError(command.name);
    if (code === "23514") throw new FunnelCampaignValidationError();
    throw error;
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "funnel_campaign",
    aggregateId: row.id,
    eventType: "funnel_campaign.created",
    actor: ctx.actor,
    payload: { name: command.name, slug: command.slug, leadSourceId: command.leadSourceId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "funnel_campaign.create",
    resource: "funnel_campaign",
    allowed: true,
    details: { name: command.name, slug: command.slug },
  });

  return toDto(row, true);
}

export async function archiveFunnelCampaign(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<FunnelCampaignDto> {
  requireWrite(ctx);
  const updated = await tx.execute<FunnelCampaignRow>(sql`
    update funnel_campaign
       set archived_at = statement_timestamp(),
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id}::uuid
       and archived_at is null
    returning id, name, slug, lead_source_id,
      (select name from lead_source
        where workspace_id = funnel_campaign.workspace_id
          and id = funnel_campaign.lead_source_id) as lead_source_name,
      archived_at, created_at, updated_at
  `);
  const row = updated.rows[0];
  if (!row) {
    // Idempotenz: bereits archiviert → aktuellen Datensatz zurückgeben,
    // existiert sie nicht → NotFound.
    const current = await tx.execute<FunnelCampaignRow>(sql`
      ${ROW_SELECT}
     where campaign.workspace_id = ${ctx.workspaceId}::uuid
       and campaign.id = ${id}::uuid
     limit 1
    `);
    if (!current.rows[0]) throw new FunnelCampaignNotFoundError(id);
    return toDto(current.rows[0], true);
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "funnel_campaign",
    aggregateId: id,
    eventType: "funnel_campaign.archived",
    actor: ctx.actor,
    payload: {},
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "funnel_campaign.archive",
    resource: "funnel_campaign",
    allowed: true,
    details: { id },
  });

  return toDto(row, true);
}
