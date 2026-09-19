// F1-10 Lead-Routing + F1-23 Routing-Vertiefung (0235): Regeln je
// Dimension (Quelle XOR Kampagne) mit Modus, Priorität und Triggern.
// Berechtigung: bestehende lead_source.read/write (KEINE neuen Keys).
// Die Regel schreibt/liest nie Zuweisungen — Vorschlag und Auto-Vollzug
// nutzen den bestehenden set_key_account-Pfad (Evaluator).
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { FunnelCampaignNotFoundError } from "@/modules/funnel-campaigns/errors";
import {
  evaluateRoutingRules,
  hasRoutingDeepening,
  loadRoutingRules,
  type RoutingRuleMode,
} from "./routing-evaluator";
import {
  LeadSourceNotFoundError,
  LeadSourceValidationError,
} from "./errors";

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "lead_source.read")) {
    throw new PermissionDeniedError("lead_source.read", "project_lead_routing_rule", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "lead_source.write")) {
    throw new PermissionDeniedError("lead_source.write", "project_lead_routing_rule", undefined, ctx.actor);
  }
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const setRoutingRuleCommandSchema = z.strictObject({
  ruleId: uuidSchema.optional(),
  leadSourceId: uuidSchema.optional(),
  funnelCampaignId: uuidSchema.optional(),
  assigneeMembershipId: uuidSchema,
  mode: z.enum(["suggest", "auto"]).optional(),
  priority: z.number().int().min(0).max(9999).optional(),
  autoOnManual: z.boolean().optional(),
  autoOnIntake: z.boolean().optional(),
});

export type SetRoutingRuleInput = {
  ruleId?: string;
  leadSourceId?: string;
  funnelCampaignId?: string;
  assigneeMembershipId: string;
  mode?: RoutingRuleMode;
  priority?: number;
  autoOnManual?: boolean;
  autoOnIntake?: boolean;
};

export type LeadRoutingRuleDto = {
  id: string;
  /** Quellen-Dimension; "" bei Kampagnen-Regeln (XOR). */
  leadSourceId: string;
  /** Kampagnen-Dimension; null bei Quellen-Regeln (XOR). */
  funnelCampaignId: string | null;
  /** Quellenname bzw. Quellenname der Kampagne. */
  sourceName: string;
  assigneeMembershipId: string;
  assigneeLabel: string;
  mode: RoutingRuleMode;
  priority: number;
  autoOnManual: boolean;
  autoOnIntake: boolean;
  archivedAt: string | null;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

export type LeadRoutingSuggestion = {
  projectId: string;
  /** Feuernde Regel (stabile Key für die Union). */
  ruleId: string;
  leadSourceId: string;
  sourceName: string;
  membershipId: string;
  label: string;
};

export type RoutableMember = {
  membershipId: string;
  label: string;
};

type RuleRow = {
  lead_source_id: string;
  source_name: string;
  assignee_membership_id: string;
  assignee_label: string;
  updated_at: string;
};

function toDto(row: RuleRow & { id: string }, canWrite: boolean): LeadRoutingRuleDto {
  return {
    id: row.id,
    leadSourceId: row.lead_source_id,
    funnelCampaignId: null,
    sourceName: row.source_name,
    assigneeMembershipId: row.assignee_membership_id,
    assigneeLabel: row.assignee_label,
    mode: "suggest",
    priority: 0,
    autoOnManual: true,
    autoOnIntake: false,
    archivedAt: null,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  };
}

function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

function hasValue(value: unknown): boolean {
  return value !== undefined;
}

type ResolvedRuleCommand = {
  ruleId: string | undefined;
  leadSourceId: string | undefined;
  funnelCampaignId: string | undefined;
  assigneeMembershipId: string;
  mode: RoutingRuleMode;
  priority: number;
  autoOnManual: boolean;
  autoOnIntake: boolean;
  /** true sobald ein Vertiefungs-Schlüssel übergeben wurde (UI sendet immer voll). */
  deepeningKeysPresent: boolean;
};

function resolveRuleCommand(input: SetRoutingRuleInput): ResolvedRuleCommand {
  const parsed = setRoutingRuleCommandSchema.safeParse(input);
  if (!parsed.success) throw new LeadSourceValidationError();
  const command = parsed.data;
  const hasSource = hasValue(command.leadSourceId);
  const hasCampaign = hasValue(command.funnelCampaignId);
  if (hasSource === hasCampaign) {
    throw new LeadSourceValidationError("routing dimension must be source XOR campaign");
  }
  const mode = command.mode ?? "suggest";
  if (hasCampaign && mode === "auto") {
    throw new LeadSourceValidationError("campaign routing rules are suggest-only");
  }
  return {
    ruleId: command.ruleId,
    leadSourceId: command.leadSourceId,
    funnelCampaignId: command.funnelCampaignId,
    assigneeMembershipId: command.assigneeMembershipId,
    mode,
    priority: command.priority ?? 0,
    autoOnManual: command.autoOnManual ?? true,
    autoOnIntake: command.autoOnIntake ?? false,
    deepeningKeysPresent:
      hasValue(command.ruleId)
      || hasValue(command.funnelCampaignId)
      || hasValue(command.mode)
      || hasValue(command.priority)
      || hasValue(command.autoOnManual)
      || hasValue(command.autoOnIntake),
  };
}

type DisplayRuleRow = {
  id: string;
  lead_source_id: string | null;
  funnel_campaign_id: string | null;
  source_name: string;
  assignee_membership_id: string;
  assignee_label: string;
  mode: string;
  priority: number;
  auto_on_manual: boolean;
  auto_on_intake: boolean;
  archived_at: string | null;
  updated_at: string;
};

function toDeepeningDto(row: DisplayRuleRow, canWrite: boolean): LeadRoutingRuleDto {
  return {
    id: row.id,
    leadSourceId: row.lead_source_id ?? "",
    funnelCampaignId: row.funnel_campaign_id,
    sourceName: row.source_name,
    assigneeMembershipId: row.assignee_membership_id,
    assigneeLabel: row.assignee_label,
    mode: row.mode === "auto" ? "auto" : "suggest",
    priority: row.priority,
    autoOnManual: row.auto_on_manual,
    autoOnIntake: row.auto_on_intake,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  };
}

/** Anzeige-Zeile einer 0235-Regel (Labels per Join, nie null-tolerant nötig). */
async function selectDisplayRule(
  tx: TenantTx,
  ctx: ServiceCtx,
  ruleId: string,
): Promise<DisplayRuleRow> {
  const result = await tx.execute<DisplayRuleRow>(sql`
    select rule.id,
           rule.lead_source_id,
           rule.funnel_campaign_id,
           coalesce(source_record.name, campaign_source_record.name, '') as source_name,
           rule.assignee_membership_id,
           identity_record.email as assignee_label,
           rule.mode,
           rule.priority,
           rule.auto_on_manual,
           rule.auto_on_intake,
           rule.archived_at,
           rule.updated_at
      from project_lead_routing_rule rule
      join membership membership_record
        on membership_record.workspace_id = rule.workspace_id
       and membership_record.id = rule.assignee_membership_id
      join user_identity identity_record
        on identity_record.id = membership_record.user_id
      left join lead_source source_record
        on source_record.workspace_id = rule.workspace_id
       and source_record.id = rule.lead_source_id
      left join funnel_campaign campaign_record
        on campaign_record.workspace_id = rule.workspace_id
       and campaign_record.id = rule.funnel_campaign_id
      left join lead_source campaign_source_record
        on campaign_source_record.workspace_id = rule.workspace_id
       and campaign_source_record.id = campaign_record.lead_source_id
     where rule.workspace_id = ${ctx.workspaceId}::uuid
       and rule.id = ${ruleId}::uuid
     limit 1
  `);
  const row = result.rows[0];
  if (!row || row.assignee_label === null) {
    throw new LeadSourceValidationError("routing rule target vanished");
  }
  return row;
}

/**
 * Regel setzen: ohne Vertiefungs-Schlüssel (reiner leadSourceId-Aufruf,
 * F1-10-Form) ersetzt der Aufruf ALLE Quellen-Regeln (genau eine Regel je
 * Quelle, Upsert-Verhalten); mit Vertiefungs-Schlüsseln (UI sendet immer
 * voll) gilt Upsert je (Dimension, Ziel), mit ruleId Update in-place.
 * Quelle und Mitgliedschaft müssen im Workspace existieren — sonst
 * NotFound/Validation, kein stilles Anlegen.
 */
export async function setRoutingRule(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: SetRoutingRuleInput,
): Promise<LeadRoutingRuleDto> {
  requireWrite(ctx);
  const command = resolveRuleCommand(input);
  const deepening = await hasRoutingDeepening(tx);
  if (command.deepeningKeysPresent && !deepening) {
    throw new LeadSourceValidationError(
      "routing deepening unavailable (migration 0235 missing)",
    );
  }

  if (command.leadSourceId !== undefined) {
    const source = await tx.execute<{ id: string }>(sql`
      select id from lead_source
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.leadSourceId}::uuid
       limit 1
    `);
    if (!source.rows[0]) throw new LeadSourceNotFoundError(command.leadSourceId);
  } else if (command.funnelCampaignId !== undefined) {
    // Direkter SQL-Check statt Modul-Import (funnel-campaigns hängt an
    // lead-sources — kein Rück-Import; nur errors.ts ist freigegeben).
    const campaign = await tx.execute<{ id: string }>(sql`
      select id from funnel_campaign
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.funnelCampaignId}::uuid
         and archived_at is null
       limit 1
    `);
    if (!campaign.rows[0]) throw new FunnelCampaignNotFoundError(command.funnelCampaignId);
  }

  const member = await tx.execute<{ id: string }>(sql`
    select id from membership
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.assigneeMembershipId}::uuid
     limit 1
  `);
  if (!member.rows[0]) {
    throw new LeadSourceValidationError("routing target membership not found");
  }

  // F1-10-Pfad (Byte-verhalten): Upsert je Quelle.
  if (!command.deepeningKeysPresent && command.leadSourceId !== undefined) {
    if (!deepening) {
      const saved = await tx.execute<RuleRow & { id: string }>(sql`
        insert into project_lead_routing_rule (
          workspace_id, lead_source_id, assignee_membership_id, created_by
        ) values (
          ${ctx.workspaceId}::uuid, ${command.leadSourceId}::uuid,
          ${command.assigneeMembershipId}::uuid, ${ctx.actor}::uuid
        )
        on conflict (workspace_id, lead_source_id)
        do update set assignee_membership_id = excluded.assignee_membership_id,
                      updated_at = statement_timestamp()
        returning id,
                  lead_source_id,
                  (select name from lead_source
                    where workspace_id = ${ctx.workspaceId}::uuid
                      and id = ${command.leadSourceId}::uuid) as source_name,
                  assignee_membership_id,
                  (select identity_record.email
                     from membership membership_record
                     join user_identity identity_record
                       on identity_record.id = membership_record.user_id
                    where membership_record.workspace_id = ${ctx.workspaceId}::uuid
                      and membership_record.id = ${command.assigneeMembershipId}::uuid) as assignee_label,
                  updated_at
      `);
      const row = saved.rows[0];
      if (!row || row.source_name === null || row.assignee_label === null) {
        throw new LeadSourceValidationError("routing rule target vanished");
      }
      await emitRuleSetEvent(tx, ctx, {
        ruleId: row.id,
        leadSourceId: command.leadSourceId,
        funnelCampaignId: null,
        membershipId: command.assigneeMembershipId,
        mode: "suggest",
        priority: 0,
      });
      return toDto(row, true);
    }

    // 0235: F1-10-Versprechen ("genau eine Regel je Quelle") per
    // Replace-all — der alte Unique existiert nicht mehr. Archivzeilen
    // bleiben bestehen (Historie; Archiv gibt Unique frei, loescht nicht).
    await tx.execute(sql`
      delete from project_lead_routing_rule
       where workspace_id = ${ctx.workspaceId}::uuid
         and lead_source_id = ${command.leadSourceId}::uuid
         and archived_at is null
    `);
    const created = await tx.execute<{ id: string }>(sql`
      insert into project_lead_routing_rule (
        workspace_id, lead_source_id, funnel_campaign_id,
        assignee_membership_id, mode, priority,
        auto_on_manual, auto_on_intake, created_by
      ) values (
        ${ctx.workspaceId}::uuid, ${command.leadSourceId}::uuid, null,
        ${command.assigneeMembershipId}::uuid, 'suggest', 0,
        true, false, ${ctx.actor}::uuid
      )
      returning id
    `);
    const ruleId = created.rows[0]?.id;
    if (!ruleId) throw new LeadSourceValidationError("routing rule target vanished");
    const display = await selectDisplayRule(tx, ctx, ruleId);
    await emitRuleSetEvent(tx, ctx, {
      ruleId,
      leadSourceId: command.leadSourceId,
      funnelCampaignId: null,
      membershipId: command.assigneeMembershipId,
      mode: "suggest",
      priority: 0,
    });
    return toDeepeningDto(display, true);
  }

  // Update in-place per ruleId (UI-Editieren).
  if (command.ruleId !== undefined) {
    let updated: { id: string }[];
    try {
      const result = await tx.execute<{ id: string }>(sql`
        update project_lead_routing_rule
           set lead_source_id = ${command.leadSourceId ?? null}::uuid,
               funnel_campaign_id = ${command.funnelCampaignId ?? null}::uuid,
               assignee_membership_id = ${command.assigneeMembershipId}::uuid,
               mode = ${command.mode},
               priority = ${command.priority},
               auto_on_manual = ${command.autoOnManual},
               auto_on_intake = ${command.autoOnIntake},
               updated_at = statement_timestamp()
         where workspace_id = ${ctx.workspaceId}::uuid
           and id = ${command.ruleId}::uuid
        returning id
      `);
      updated = result.rows;
    } catch (error) {
      const code = postgresErrorCode(error);
      if (code === "23505" || code === "23514" || code === "23503") {
        throw new LeadSourceValidationError("routing rule conflicts with existing rule");
      }
      throw error;
    }
    const ruleId = updated[0]?.id;
    if (!ruleId) throw new LeadSourceValidationError("routing rule not found");
    const display = await selectDisplayRule(tx, ctx, ruleId);
    await emitRuleSetEvent(tx, ctx, {
      ruleId,
      leadSourceId: command.leadSourceId ?? null,
      funnelCampaignId: command.funnelCampaignId ?? null,
      membershipId: command.assigneeMembershipId,
      mode: command.mode,
      priority: command.priority,
    });
    return toDeepeningDto(display, true);
  }

  // Upsert je (Dimension, Ziel) unter aktiven Regeln.
  const dimensionFilter = command.leadSourceId !== undefined
    ? sql`lead_source_id = ${command.leadSourceId}::uuid`
    : sql`funnel_campaign_id = ${command.funnelCampaignId}::uuid`;
  const touched = await tx.execute<{ id: string }>(sql`
    update project_lead_routing_rule
       set mode = ${command.mode},
           priority = ${command.priority},
           auto_on_manual = ${command.autoOnManual},
           auto_on_intake = ${command.autoOnIntake},
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and ${dimensionFilter}
       and assignee_membership_id = ${command.assigneeMembershipId}::uuid
       and archived_at is null
    returning id
  `);
  let ruleId = touched.rows[0]?.id ?? null;
  if (ruleId === null) {
    try {
      const created = await tx.execute<{ id: string }>(sql`
        insert into project_lead_routing_rule (
          workspace_id, lead_source_id, funnel_campaign_id,
          assignee_membership_id, mode, priority,
          auto_on_manual, auto_on_intake, created_by
        ) values (
          ${ctx.workspaceId}::uuid, ${command.leadSourceId ?? null}::uuid,
          ${command.funnelCampaignId ?? null}::uuid,
          ${command.assigneeMembershipId}::uuid, ${command.mode},
          ${command.priority}, ${command.autoOnManual}, ${command.autoOnIntake},
          ${ctx.actor}::uuid
        )
        returning id
      `);
      ruleId = created.rows[0]?.id ?? null;
    } catch (error) {
      if (postgresErrorCode(error) !== "23505") throw error;
      // Race: Konkurrent legte dieselbe (Dimension, Ziel)-Regel an —
      // einmal als Update wiederholen statt roh zu scheitern.
      const retried = await tx.execute<{ id: string }>(sql`
        update project_lead_routing_rule
           set mode = ${command.mode},
               priority = ${command.priority},
               auto_on_manual = ${command.autoOnManual},
               auto_on_intake = ${command.autoOnIntake},
               updated_at = statement_timestamp()
         where workspace_id = ${ctx.workspaceId}::uuid
           and ${dimensionFilter}
           and assignee_membership_id = ${command.assigneeMembershipId}::uuid
           and archived_at is null
        returning id
      `);
      ruleId = retried.rows[0]?.id ?? null;
    }
  }
  if (ruleId === null) {
    throw new LeadSourceValidationError("routing rule conflicts with existing rule");
  }
  const display = await selectDisplayRule(tx, ctx, ruleId);
  await emitRuleSetEvent(tx, ctx, {
    ruleId,
    leadSourceId: command.leadSourceId ?? null,
    funnelCampaignId: command.funnelCampaignId ?? null,
    membershipId: command.assigneeMembershipId,
    mode: command.mode,
    priority: command.priority,
  });
  return toDeepeningDto(display, true);
}

async function emitRuleSetEvent(
  tx: TenantTx,
  ctx: ServiceCtx,
  detail: {
    ruleId: string | null;
    leadSourceId: string | null;
    funnelCampaignId: string | null;
    membershipId: string;
    mode: RoutingRuleMode;
    priority: number;
  },
): Promise<void> {
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project_lead_routing_rule",
    aggregateId: (detail.leadSourceId ?? detail.funnelCampaignId ?? detail.ruleId ?? "") as string,
    eventType: "lead_routing_rule.set",
    actor: ctx.actor,
    payload: {
      leadSourceId: detail.leadSourceId,
      funnelCampaignId: detail.funnelCampaignId,
      membershipId: detail.membershipId,
      ruleId: detail.ruleId,
      mode: detail.mode,
      priority: detail.priority,
    },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "lead_routing_rule.set",
    resource: "project_lead_routing_rule",
    allowed: true,
    details: {
      leadSourceId: detail.leadSourceId,
      funnelCampaignId: detail.funnelCampaignId,
      membershipId: detail.membershipId,
      ruleId: detail.ruleId,
    },
  });
}

/** Regel löschen — per ruleId oder je Quelle; true wenn eine Regel bestand. */
export async function clearRoutingRule(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { leadSourceId?: string; ruleId?: string },
): Promise<{ leadSourceId: string | null; ruleId: string | null; deleted: boolean }> {
  requireWrite(ctx);
  const parsed = z
    .strictObject({ leadSourceId: uuidSchema.optional(), ruleId: uuidSchema.optional() })
    .safeParse(input);
  if (!parsed.success) throw new LeadSourceValidationError();
  const hasSource = hasValue(parsed.data.leadSourceId);
  const hasRule = hasValue(parsed.data.ruleId);
  if (hasSource === hasRule) {
    throw new LeadSourceValidationError("clear routing rule by source XOR rule id");
  }

  if (parsed.data.ruleId !== undefined) {
    const deleted = await tx.execute<{ id: string }>(sql`
      delete from project_lead_routing_rule
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${parsed.data.ruleId}::uuid
      returning id
    `);
    const wasDeleted = deleted.rows.length > 0;
    if (wasDeleted) {
      await emitRuleClearedEvent(tx, ctx, { leadSourceId: null, ruleId: parsed.data.ruleId, deletedCount: 1 });
    }
    return { leadSourceId: null, ruleId: parsed.data.ruleId, deleted: wasDeleted };
  }

  const leadSourceId = parsed.data.leadSourceId as string;
  // Nur aktive Regeln: Archivzeilen sind Historie und bleiben bestehen
  // (F1.8-Muster; ruleId-Pfad weiter explizit-total).
  const deleted = await tx.execute<{ id: string }>(sql`
    delete from project_lead_routing_rule
     where workspace_id = ${ctx.workspaceId}::uuid
       and lead_source_id = ${leadSourceId}::uuid
       and archived_at is null
    returning id
  `);
  const wasDeleted = deleted.rows.length > 0;
  if (wasDeleted) {
    await emitRuleClearedEvent(tx, ctx, {
      leadSourceId,
      ruleId: null,
      deletedCount: deleted.rows.length,
    });
  }
  return { leadSourceId, ruleId: null, deleted: wasDeleted };
}

async function emitRuleClearedEvent(
  tx: TenantTx,
  ctx: ServiceCtx,
  detail: { leadSourceId: string | null; ruleId: string | null; deletedCount: number },
): Promise<void> {
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project_lead_routing_rule",
    aggregateId: (detail.leadSourceId ?? detail.ruleId ?? "") as string,
    eventType: "lead_routing_rule.cleared",
    actor: ctx.actor,
    payload: {
      leadSourceId: detail.leadSourceId,
      ruleId: detail.ruleId,
      deletedCount: detail.deletedCount,
    },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "lead_routing_rule.clear",
    resource: "project_lead_routing_rule",
    allowed: true,
    details: { leadSourceId: detail.leadSourceId, ruleId: detail.ruleId },
  });
}

const archiveRoutingRuleCommandSchema = z.strictObject({
  ruleId: uuidSchema,
});

/**
 * Regel archivieren: feuert nicht mehr, gibt den Partial-Unique frei,
 * bleibt als Historie bestehen. Idempotent (erneutes Archivieren ist
 * No-Op ohne neues Event). Belegt als rule.set (Zustandsschreibung,
 * keine neue Event-/Audit-Sorte).
 */
export async function archiveRoutingRule(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { ruleId: string },
): Promise<LeadRoutingRuleDto> {
  requireWrite(ctx);
  const parsed = archiveRoutingRuleCommandSchema.safeParse(input);
  if (!parsed.success) throw new LeadSourceValidationError("routing rule id invalid");
  const current = await tx.execute<{ archived_at: string | null }>(sql`
    select archived_at from project_lead_routing_rule
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.ruleId}::uuid
  `);
  const row = current.rows[0];
  if (!row) throw new LeadSourceValidationError("routing rule not found");
  const canWrite = can(ctx, "lead_source.write");
  if (row.archived_at !== null) {
    return toDeepeningDto(await selectDisplayRule(tx, ctx, parsed.data.ruleId), canWrite);
  }
  await tx.execute(sql`
    update project_lead_routing_rule
       set archived_at = now(), updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.ruleId}::uuid
       and archived_at is null
  `);
  const display = await selectDisplayRule(tx, ctx, parsed.data.ruleId);
  await emitRuleSetEvent(tx, ctx, {
    ruleId: display.id,
    leadSourceId: display.lead_source_id,
    funnelCampaignId: display.funnel_campaign_id,
    membershipId: display.assignee_membership_id,
    mode: display.mode === "auto" ? "auto" : "suggest",
    priority: display.priority,
  });
  return toDeepeningDto(display, canWrite);
}

/**
 * Regel reaktivieren: feuert wieder. Scheitert ehrlich (Validation),
 * wenn inzwischen ein aktiver Zwilling dieselbe (Dimension, Ziel)
 * belegt — erst Zwilling loeschen/archivieren.
 */
export async function reactivateRoutingRule(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { ruleId: string },
): Promise<LeadRoutingRuleDto> {
  requireWrite(ctx);
  const parsed = archiveRoutingRuleCommandSchema.safeParse(input);
  if (!parsed.success) throw new LeadSourceValidationError("routing rule id invalid");
  let changed = false;
  try {
    const updated = await tx.execute<{ id: string }>(sql`
      update project_lead_routing_rule
         set archived_at = null, updated_at = now()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${parsed.data.ruleId}::uuid
         and archived_at is not null
      returning id
    `);
    changed = updated.rows.length > 0;
    if (!changed) {
      const exists = await tx.execute<{ id: string }>(sql`
        select id from project_lead_routing_rule
         where workspace_id = ${ctx.workspaceId}::uuid
           and id = ${parsed.data.ruleId}::uuid
      `);
      if (exists.rows.length === 0) throw new LeadSourceValidationError("routing rule not found");
    }
  } catch (error) {
    if (postgresErrorCode(error) === "23505") {
      throw new LeadSourceValidationError("routing rule conflicts with existing rule");
    }
    throw error;
  }
  const display = await selectDisplayRule(tx, ctx, parsed.data.ruleId);
  const canWrite = can(ctx, "lead_source.write");
  if (changed) {
    await emitRuleSetEvent(tx, ctx, {
      ruleId: display.id,
      leadSourceId: display.lead_source_id,
      funnelCampaignId: display.funnel_campaign_id,
      membershipId: display.assignee_membership_id,
      mode: display.mode === "auto" ? "auto" : "suggest",
      priority: display.priority,
    });
  }
  return toDeepeningDto(display, canWrite);
}

/** Alle Regeln (inkl. archivierter) mit Anzeige-Labels. */
export async function listRoutingRules(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<LeadRoutingRuleDto[]> {
  requireRead(ctx);
  const canWrite = can(ctx, "lead_source.write");
  if (!(await hasRoutingDeepening(tx))) {
    const result = await tx.execute<RuleRow & { id: string }>(sql`
      select rule.id,
             rule.lead_source_id,
             source_record.name as source_name,
             rule.assignee_membership_id,
             identity_record.email as assignee_label,
             rule.updated_at
        from project_lead_routing_rule rule
        join lead_source source_record
          on source_record.workspace_id = rule.workspace_id
         and source_record.id = rule.lead_source_id
        join membership membership_record
          on membership_record.workspace_id = rule.workspace_id
         and membership_record.id = rule.assignee_membership_id
        join user_identity identity_record
          on identity_record.id = membership_record.user_id
       where rule.workspace_id = ${ctx.workspaceId}::uuid
       order by lower(source_record.name), rule.lead_source_id
    `);
    return result.rows.map((row) => toDto(row, canWrite));
  }

  const result = await tx.execute<DisplayRuleRow>(sql`
    select rule.id,
           rule.lead_source_id,
           rule.funnel_campaign_id,
           coalesce(source_record.name, campaign_source_record.name, '') as source_name,
           rule.assignee_membership_id,
           identity_record.email as assignee_label,
           rule.mode,
           rule.priority,
           rule.auto_on_manual,
           rule.auto_on_intake,
           rule.archived_at,
           rule.updated_at
      from project_lead_routing_rule rule
      join membership membership_record
        on membership_record.workspace_id = rule.workspace_id
       and membership_record.id = rule.assignee_membership_id
      join user_identity identity_record
        on identity_record.id = membership_record.user_id
      left join lead_source source_record
        on source_record.workspace_id = rule.workspace_id
       and source_record.id = rule.lead_source_id
      left join funnel_campaign campaign_record
        on campaign_record.workspace_id = rule.workspace_id
       and campaign_record.id = rule.funnel_campaign_id
      left join lead_source campaign_source_record
        on campaign_source_record.workspace_id = rule.workspace_id
       and campaign_source_record.id = campaign_record.lead_source_id
     where rule.workspace_id = ${ctx.workspaceId}::uuid
     order by lower(coalesce(source_record.name, campaign_source_record.name, '')),
              rule.priority asc, rule.updated_at asc, rule.id asc
  `);
  return result.rows.map((row) => toDeepeningDto(row, canWrite));
}

/**
 * Mitglieder mit Anzeige-Label fuer das Regel-Dropdown (reiner Lese-Pfad,
 * gleiche Schranke wie die Regelliste).
 */
export async function listRoutableMembers(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<RoutableMember[]> {
  requireRead(ctx);
  const result = await tx.execute<{ membership_id: string; label: string }>(sql`
    select membership_record.id as membership_id,
           identity_record.email as label
      from membership membership_record
      join user_identity identity_record
        on identity_record.id = membership_record.user_id
     where membership_record.workspace_id = ${ctx.workspaceId}::uuid
     order by lower(identity_record.email), membership_record.id
     limit 200
  `);
  return result.rows.map((row) => ({ membershipId: row.membership_id, label: row.label }));
}

/**
 * Suggest-Union (F1-23): volle Evaluator-Union, max 5, Kampagne-vor-Quelle
 * je priority aufsteigend. Schreibt nichts — der Klick nutzt den
 * bestehenden set_key_account-Pfad.
 */
export async function suggestAssigneesForProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string },
): Promise<LeadRoutingSuggestion[]> {
  requireRead(ctx);
  const parsed = z.strictObject({ projectId: uuidSchema }).safeParse(input);
  if (!parsed.success) throw new LeadSourceValidationError();

  const project = await tx.execute<{
    lead_source_id: string | null;
    funnel_campaign_id: string | null;
  }>(sql`
    select lead_source_id, funnel_campaign_id
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.projectId}::uuid
     limit 1
  `);
  const dimensions = project.rows[0];
  if (!dimensions) return [];
  const leadSourceId = dimensions.lead_source_id;
  const funnelCampaignId = dimensions.funnel_campaign_id;
  if (leadSourceId === null && funnelCampaignId === null) return [];

  const keyHolders = await tx.execute<{ membership_id: string }>(sql`
    select membership_id from project_assignment
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${parsed.data.projectId}::uuid
       and assignment_role = 'key_account'
  `);
  const rules = await loadRoutingRules(tx, ctx, { leadSourceId, funnelCampaignId });
  const decision = evaluateRoutingRules({
    trigger: "manual",
    leadSourceId,
    funnelCampaignId,
    campaignAssigneeMembershipId: null,
    keyAccountMembershipIds: keyHolders.rows.map((row) => row.membership_id.toLowerCase()),
    rules,
  });
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const suggestions: LeadRoutingSuggestion[] = [];
  for (const item of decision.suggestions) {
    const rule = byId.get(item.ruleId);
    if (!rule || rule.assigneeLabel === null) continue;
    suggestions.push({
      projectId: parsed.data.projectId,
      ruleId: rule.id,
      leadSourceId: leadSourceId ?? rule.leadSourceId ?? "",
      sourceName: rule.sourceName,
      membershipId: rule.assigneeMembershipId,
      label: rule.assigneeLabel,
    });
  }
  return suggestions;
}

/**
 * Vorschlag fuer das Zuweisungs-Panel: erstes Glied der Suggest-Union —
 * null ohne Quelle/Regel, bei verschwundenem Mitglied oder wenn das
 * Mitglied bereits Key Account ist.
 */
export async function suggestAssigneeForProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string },
): Promise<LeadRoutingSuggestion | null> {
  const [first] = await suggestAssigneesForProject(tx, ctx, input);
  return first ?? null;
}
