// F1-23 Routing-Vertiefung: Evaluator für Lead-Routing-Regeln.
//
// Regelmodell (Slice-Spec docs/spec/F1-23-routing-deepening.md, Migration
// 0235): Dimension Quelle XOR Kampagne; mode suggest(default)/auto;
// priority 0..9999 (first-match AUFSTEIGEND, 0 zuerst); Trigger
// auto_on_manual (default true) / auto_on_intake (default FALSE);
// Kampagnen-Regeln NUR suggest; archivierte Regeln feuern nicht.
//
// Konflikt (Auto-Entscheid, nur Erfassungszeitpunkt): F12-02-Beauftragter >
// Kampagnen-suggest > Quellen-Auto. Die höhere Stufe UNTERDRÜCKT das
// Feueren der tieferen: Eine lebende Kampagnen-Regel zur Kampagne des
// Leads unterdrückt das Quellen-Auto (Lead bleibt unzugewiesen, Union
// trägt den Vorschlag). Suggest-Union: max 5, Kampagne-vor-Quelle, je
// priority aufsteigend — Modus und Trigger filtern die Union NICHT
// (auto impliziert vorschlagbar).
//
// Fail-closed: Baumelnde Regelziele (Mitgliedschaft weg — nur per direktem
// DB-Eingriff erreichbar, sonst RESTRICT) werden erkannt, nicht still
// weggefiltert: Auto-Gewinner ohne Ziel meldet Drift (manuell → Erfassung
// verweigert, Intake → unzugewiesen + lead_routing.failed).
//
// Hinweis: KEIN "server-only"-Import — der Intake-Service (modules/intake)
// hängt in diesem Modul-Graphen (Muster modules/lead-sources/service.ts).
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import type { ServiceCtx } from "@/lib/permissions";

/** Max. Glieder der Suggest-Union (F1-23). */
export const ROUTING_SUGGESTION_LIMIT = 5;

/** Erfassungszeitpunkt der Auto-Entscheidung: manuell oder Intake. */
export type RoutingTrigger = "manual" | "intake";

export const ROUTING_RULE_MODES = ["suggest", "auto"] as const;
export type RoutingRuleMode = (typeof ROUTING_RULE_MODES)[number];

/** Regel im Evaluator-Format (0235-Shape; pre-0235 mit Defaults belegt). */
export type RoutingEvaluationRule = {
  id: string;
  /** Genau eines von leadSourceId/funnelCampaignId ist gesetzt (XOR). */
  leadSourceId: string | null;
  funnelCampaignId: string | null;
  assigneeMembershipId: string;
  /** false nur bei baumelndem Ziel (FK-Umgehung) — Drift, kein Skip. */
  assigneeAlive: boolean;
  mode: RoutingRuleMode;
  priority: number;
  autoOnManual: boolean;
  autoOnIntake: boolean;
  archivedAt: string | null;
};

/** Loader-Zeile: Evaluator-Regel plus Anzeige-Felder. */
export type RoutingRuleRecord = RoutingEvaluationRule & {
  assigneeLabel: string | null;
  sourceName: string;
};

export type RoutingEvaluationInput = {
  trigger: RoutingTrigger;
  leadSourceId: string | null;
  funnelCampaignId: string | null;
  campaignAssigneeMembershipId: string | null;
  keyAccountMembershipIds: readonly string[];
  rules: readonly RoutingEvaluationRule[];
};

export type RoutingAutoDecision = {
  ruleId: string | null;
  membershipId: string;
  via: "campaign_assignee" | "source_rule";
};

export type RoutingAutoDrift = {
  ruleId: string;
  membershipId: string;
};

export type RoutingEvaluation = {
  auto: RoutingAutoDecision | null;
  /** Auto-Gewinner ohne lebendes Ziel (fail-closed, kein Fall-through). */
  autoDrift: RoutingAutoDrift | null;
  /** true wenn Kampagnen-Regeln das Quellen-Auto unterdrückt haben. */
  suppressedByCampaign: boolean;
  suggestions: { ruleId: string; membershipId: string }[];
};

function isSourceRule(rule: RoutingEvaluationRule, sourceId: string | null): boolean {
  return (
    rule.funnelCampaignId === null
    && rule.leadSourceId !== null
    && sourceId !== null
    && rule.leadSourceId === sourceId
  );
}

function isCampaignRule(rule: RoutingEvaluationRule, campaignId: string | null): boolean {
  return (
    rule.funnelCampaignId !== null
    && campaignId !== null
    && rule.funnelCampaignId === campaignId
  );
}

function byPriorityAsc(a: RoutingEvaluationRule, b: RoutingEvaluationRule): number {
  return a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Reine Routing-Entscheidung (kein DB-Zugriff): Auto-Gewinner nach
 * Konfliktordnung plus Suggest-Union. Ids werden exakt verglichen —
 * Aufrufer normalisieren (der Loader liefert lowercase).
 */
export function evaluateRoutingRules(input: RoutingEvaluationInput): RoutingEvaluation {
  const live = input.rules.filter((rule) => rule.archivedAt === null);

  let auto: RoutingAutoDecision | null = null;
  let autoDrift: RoutingAutoDrift | null = null;
  let suppressedByCampaign = false;
  if (input.trigger === "manual" && input.campaignAssigneeMembershipId !== null) {
    auto = {
      ruleId: null,
      membershipId: input.campaignAssigneeMembershipId,
      via: "campaign_assignee",
    };
  } else {
    const campaignTier = live.filter((rule) => isCampaignRule(rule, input.funnelCampaignId));
    if (campaignTier.length > 0) {
      // Kampagnen-Stufe beansprucht den Lead: kein Quellen-Auto, nur
      // Vorschlag (Mitglieds-Liveness ist dafür egal — die Konfiguration
      // beansprucht die Stufe, nicht das Einzelziel).
      suppressedByCampaign = true;
    } else {
      const triggerOk = (rule: RoutingEvaluationRule): boolean =>
        input.trigger === "manual" ? rule.autoOnManual : rule.autoOnIntake;
      const winner = live
        .filter((rule) =>
          isSourceRule(rule, input.leadSourceId) && rule.mode === "auto" && triggerOk(rule))
        .sort(byPriorityAsc)[0];
      if (winner) {
        if (winner.assigneeAlive) {
          auto = { ruleId: winner.id, membershipId: winner.assigneeMembershipId, via: "source_rule" };
        } else {
          autoDrift = { ruleId: winner.id, membershipId: winner.assigneeMembershipId };
        }
      }
    }
  }

  const keyHolders = new Set(input.keyAccountMembershipIds);
  const seen = new Set<string>();
  const suggestions: { ruleId: string; membershipId: string }[] = [];
  const ordered = [
    ...live.filter((rule) => isCampaignRule(rule, input.funnelCampaignId)).sort(byPriorityAsc),
    ...live.filter((rule) => isSourceRule(rule, input.leadSourceId)).sort(byPriorityAsc),
  ];
  for (const rule of ordered) {
    if (
      !rule.assigneeAlive
      || keyHolders.has(rule.assigneeMembershipId)
      || seen.has(rule.assigneeMembershipId)
    ) {
      continue;
    }
    seen.add(rule.assigneeMembershipId);
    suggestions.push({ ruleId: rule.id, membershipId: rule.assigneeMembershipId });
    if (suggestions.length >= ROUTING_SUGGESTION_LIMIT) break;
  }

  return { auto, autoDrift, suppressedByCampaign, suggestions };
}

// 0235-Spalten (Slice-Vertrag): Fehlen sie, läuft der Evaluator im
// F1-10/F12-02-Kompatibilitätsmodus (suggest-Default, nie Auto).
const DEEPENING_COLUMNS = [
  "mode",
  "priority",
  "auto_on_manual",
  "auto_on_intake",
  "funnel_campaign_id",
  "archived_at",
] as const;

/** true sobald Migration 0235 alle Vertiefungs-Spalten angelegt hat. */
export async function hasRoutingDeepening(tx: TenantTx): Promise<boolean> {
  const result = await tx.execute<{ column_name: string }>(sql`
    select column_name
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'project_lead_routing_rule'
  `);
  const present = new Set(result.rows.map((row) => row.column_name));
  return DEEPENING_COLUMNS.every((column) => present.has(column));
}

function normalizedInstant(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

/**
 * Regeln zur Dimension laden — bewusst OHNE Archiv-Filter (reine
 * Auswertung in evaluateRoutingRules) und mit LEFT-Joins: Baumelnde Ziele
 * werden als assigneeAlive=false gemeldet, nicht weggefiltert. Kein
 * Permission-Gate (Muster resolveLeadSourceForProducer): Aufrufer sind
 * autorisierte Erfassungs-/Lese-Pfade.
 */
export async function loadRoutingRules(
  tx: TenantTx,
  ctx: Pick<ServiceCtx, "workspaceId">,
  input: { leadSourceId: string | null; funnelCampaignId: string | null },
): Promise<RoutingRuleRecord[]> {
  if (input.leadSourceId === null && input.funnelCampaignId === null) return [];
  if (!(await hasRoutingDeepening(tx))) {
    if (input.leadSourceId === null) return [];
    const legacy = await tx.execute<{
      id: string;
      lead_source_id: string;
      assignee_membership_id: string;
      assignee_alive: boolean;
      assignee_label: string | null;
      source_name: string;
    }>(sql`
      select rule.id,
             rule.lead_source_id,
             rule.assignee_membership_id,
             (member_record.id is not null) as assignee_alive,
             identity_record.email as assignee_label,
             coalesce(source_record.name, '') as source_name
        from project_lead_routing_rule rule
        left join membership member_record
          on member_record.workspace_id = rule.workspace_id
         and member_record.id = rule.assignee_membership_id
        left join user_identity identity_record
          on identity_record.id = member_record.user_id
        left join lead_source source_record
          on source_record.workspace_id = rule.workspace_id
         and source_record.id = rule.lead_source_id
       where rule.workspace_id = ${ctx.workspaceId}::uuid
         and rule.lead_source_id = ${input.leadSourceId}::uuid
       order by rule.created_at asc, rule.id asc
    `);
    // F1-10-Regel als suggest-Default: feuert nie Auto.
    return legacy.rows.map((row) => ({
      id: row.id.toLowerCase(),
      leadSourceId: row.lead_source_id.toLowerCase(),
      funnelCampaignId: null,
      assigneeMembershipId: row.assignee_membership_id.toLowerCase(),
      assigneeAlive: row.assignee_alive,
      mode: "suggest" as const,
      priority: 0,
      autoOnManual: true,
      autoOnIntake: false,
      archivedAt: null,
      assigneeLabel: row.assignee_label,
      sourceName: row.source_name,
    }));
  }

  const dimension = input.leadSourceId !== null && input.funnelCampaignId !== null
    ? sql`(rule.lead_source_id = ${input.leadSourceId}::uuid or rule.funnel_campaign_id = ${input.funnelCampaignId}::uuid)`
    : input.leadSourceId !== null
      ? sql`rule.lead_source_id = ${input.leadSourceId}::uuid`
      : sql`rule.funnel_campaign_id = ${input.funnelCampaignId}::uuid`;
  const result = await tx.execute<{
    id: string;
    lead_source_id: string | null;
    funnel_campaign_id: string | null;
    assignee_membership_id: string;
    assignee_alive: boolean;
    mode: string;
    priority: number;
    auto_on_manual: boolean;
    auto_on_intake: boolean;
    archived_at: Date | string | null;
    assignee_label: string | null;
    source_name: string;
  }>(sql`
    select rule.id,
           rule.lead_source_id,
           rule.funnel_campaign_id,
           rule.assignee_membership_id,
           (member_record.id is not null) as assignee_alive,
           rule.mode,
           rule.priority,
           rule.auto_on_manual,
           rule.auto_on_intake,
           rule.archived_at,
           identity_record.email as assignee_label,
           coalesce(source_record.name, campaign_source_record.name, '') as source_name
      from project_lead_routing_rule rule
      left join membership member_record
        on member_record.workspace_id = rule.workspace_id
       and member_record.id = rule.assignee_membership_id
      left join user_identity identity_record
        on identity_record.id = member_record.user_id
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
       and ${dimension}
     order by rule.priority asc, rule.created_at asc, rule.id asc
  `);
  return result.rows.map((row) => ({
    id: row.id.toLowerCase(),
    leadSourceId: row.lead_source_id === null ? null : row.lead_source_id.toLowerCase(),
    funnelCampaignId: row.funnel_campaign_id === null ? null : row.funnel_campaign_id.toLowerCase(),
    assigneeMembershipId: row.assignee_membership_id.toLowerCase(),
    assigneeAlive: row.assignee_alive,
    // Fail-closed: unbekannter Modus feuert nie Auto.
    mode: row.mode === "auto" ? "auto" : "suggest",
    priority: row.priority,
    autoOnManual: row.auto_on_manual,
    autoOnIntake: row.auto_on_intake,
    archivedAt: normalizedInstant(row.archived_at),
    assigneeLabel: row.assignee_label,
    sourceName: row.source_name,
  }));
}

export type AutoRoutingOutcome =
  | { status: "assigned"; ruleId: string | null; membershipId: string; via: "campaign_assignee" | "source_rule" }
  | { status: "unassigned"; reason: "no_match" | "suppressed"; ruleId: null }
  | {
    status: "unassigned";
    reason: "assignee_gone";
    ruleId: string | null;
    membershipId: string;
    via: "campaign_assignee" | "source_rule";
  }
  | {
    status: "unassigned";
    reason: "revision_conflict";
    ruleId: string | null;
    membershipId: string;
    via: "campaign_assignee" | "source_rule";
  }
  | { status: "unassigned"; reason: "error"; ruleId: null };

export type RoutingFailedReason = "assignee_gone" | "revision_conflict" | "error";

/**
 * Intake-Degradation: Projekt bleibt unzugewiesen, genau ein
 * lead_routing.failed am Projekt belegt den Grund.
 */
export async function emitRoutingFailedEvent(
  tx: TenantTx,
  ctx: Pick<ServiceCtx, "workspaceId" | "actor">,
  input: {
    projectId: string;
    leadSourceId: string | null;
    ruleId: string | null;
    trigger: RoutingTrigger;
    reason: RoutingFailedReason;
  },
): Promise<void> {
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: input.projectId,
    eventType: "lead_routing.failed",
    actor: ctx.actor,
    payload: {
      projectId: input.projectId,
      leadSourceId: input.leadSourceId,
      ruleId: input.ruleId,
      trigger: input.trigger,
      reason: input.reason,
    },
  });
}

/**
 * Regelvollzug: Gewinner als Key Account zuweisen — atomar gegen die
 * Race (Mitgliedschaft zwischen Laden und Schreiben weg): Das INSERT
 * feuert nur bei lebendem Ziel, sonst meldet es inserted=false statt
 * die Transaktion mit einer FK-Verletzung zu vergiften. Schreibt bei
 * Erfolg Revision + Feuerungs-Event + Audit (F12-02-Belegform). Trifft
 * der Revisions-Bump keine Zeile (fremder Vollzug zuerst), wird die
 * eigene Zeile zurueckgenommen und revisionConflict gemeldet statt ein
 * luegendes Event zu schreiben.
 */
export async function assignRoutedKeyAccount(
  tx: TenantTx,
  ctx: Pick<ServiceCtx, "workspaceId" | "actor">,
  input: {
    projectId: string;
    ruleId: string | null;
    membershipId: string;
    trigger: RoutingTrigger;
    funnelCampaignId: string | null;
  },
): Promise<{ inserted: boolean; revisionConflict: boolean }> {
  const inserted = await tx.execute<{ id: string }>(sql`
    insert into project_assignment (
      workspace_id, project_id, membership_id, assignment_role
    )
    select ${ctx.workspaceId}::uuid, ${input.projectId}::uuid,
           ${input.membershipId}::uuid, 'key_account'
     where exists (
       select 1 from membership member_record
        where member_record.workspace_id = ${ctx.workspaceId}::uuid
          and member_record.id = ${input.membershipId}::uuid
     )
    returning id
  `);
  if (inserted.rows.length === 0) return { inserted: false, revisionConflict: false };

  const bumped = await tx.execute(sql`
    update project
       set assignment_revision = 1, updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${input.projectId}::uuid
       and assignment_revision = 0
  `);
  if ((bumped.rowCount ?? 0) === 0) {
    await tx.execute(sql`
      delete from project_assignment
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${inserted.rows[0]!.id}::uuid
    `);
    return { inserted: false, revisionConflict: true };
  }
  const evidence = {
    projectId: input.projectId,
    assignmentRevision: 1,
    commandKind: "set_key_account",
    membershipId: input.membershipId,
    autoRouted: true,
    funnelCampaignId: input.funnelCampaignId,
    ruleId: input.ruleId,
    trigger: input.trigger,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: input.projectId,
    eventType: "project.assignment_key_account_changed",
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.assign",
    resource: "project_assignment",
    allowed: true,
    details: evidence,
  });
  return { inserted: true, revisionConflict: false };
}

/**
 * Auto-Entscheid am Erfassungszeitpunkt: laden, auswerten, ggf. vollziehen.
 * Drift (Ziel weg — erkannt oder Race) meldet assignee_gone: Intake
 * emittiert dazu lead_routing.failed, manuell verweigert der Aufrufer.
 */
export async function applyAutoRouting(
  tx: TenantTx,
  ctx: Pick<ServiceCtx, "workspaceId" | "actor">,
  input: {
    projectId: string;
    leadSourceId: string | null;
    funnelCampaignId: string | null;
    campaignAssigneeMembershipId: string | null;
    trigger: RoutingTrigger;
  },
): Promise<AutoRoutingOutcome> {
  const rules = await loadRoutingRules(tx, ctx, {
    leadSourceId: input.leadSourceId,
    funnelCampaignId: input.funnelCampaignId,
  });
  const decision = evaluateRoutingRules({
    trigger: input.trigger,
    leadSourceId: input.leadSourceId,
    funnelCampaignId: input.funnelCampaignId,
    campaignAssigneeMembershipId: input.campaignAssigneeMembershipId,
    keyAccountMembershipIds: [],
    rules,
  });

  if (decision.autoDrift) {
    if (input.trigger === "intake") {
      await emitRoutingFailedEvent(tx, ctx, {
        projectId: input.projectId,
        leadSourceId: input.leadSourceId,
        ruleId: decision.autoDrift.ruleId,
        trigger: input.trigger,
        reason: "assignee_gone",
      });
    }
    return {
      status: "unassigned",
      reason: "assignee_gone",
      ruleId: decision.autoDrift.ruleId,
      membershipId: decision.autoDrift.membershipId,
      via: "source_rule",
    };
  }
  if (!decision.auto) {
    return {
      status: "unassigned",
      reason: decision.suppressedByCampaign ? "suppressed" : "no_match",
      ruleId: null,
    };
  }

  const assigned = await assignRoutedKeyAccount(tx, ctx, {
    projectId: input.projectId,
    ruleId: decision.auto.ruleId,
    membershipId: decision.auto.membershipId,
    trigger: input.trigger,
    funnelCampaignId: input.funnelCampaignId,
  });
  if (!assigned.inserted) {
    const reason = assigned.revisionConflict ? "revision_conflict" : "assignee_gone";
    if (input.trigger === "intake") {
      await emitRoutingFailedEvent(tx, ctx, {
        projectId: input.projectId,
        leadSourceId: input.leadSourceId,
        ruleId: decision.auto.ruleId,
        trigger: input.trigger,
        reason,
      });
    }
    return {
      status: "unassigned",
      reason,
      ruleId: decision.auto.ruleId,
      membershipId: decision.auto.membershipId,
      via: decision.auto.via,
    };
  }
  return {
    status: "assigned",
    ruleId: decision.auto.ruleId,
    membershipId: decision.auto.membershipId,
    via: decision.auto.via,
  };
}

/**
 * Intake-Hook: Auto-Vollzug, der nie wirft (kein 500 an den Sender).
 * Unerwartete Fehler werden best-effort als lead_routing.failed belegt —
 * das Projekt bleibt in jedem Fall unzugewiesen bestehen.
 */
export async function applyIntakeAutoRouting(
  tx: TenantTx,
  ctx: Pick<ServiceCtx, "workspaceId" | "actor">,
  input: { projectId: string; leadSourceId: string | null },
): Promise<AutoRoutingOutcome> {
  try {
    return await applyAutoRouting(tx, ctx, {
      projectId: input.projectId,
      leadSourceId: input.leadSourceId,
      funnelCampaignId: null,
      campaignAssigneeMembershipId: null,
      trigger: "intake",
    });
  } catch {
    try {
      await emitRoutingFailedEvent(tx, ctx, {
        projectId: input.projectId,
        leadSourceId: input.leadSourceId,
        ruleId: null,
        trigger: "intake",
        reason: "error",
      });
    } catch {
      // Letzte Zuflucht: unzugewiesen ohne Event-Beleg.
    }
    return { status: "unassigned", reason: "error", ruleId: null };
  }
}
