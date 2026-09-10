// F1-10 Lead-Routing: genau eine Regel je Lead-Quelle
// (Quelle -> Standard-Betreuer als Workspace-Mitgliedschaft).
// Berechtigung: bestehende lead_source.read/write (KEINE neuen Keys).
// Die Regel schreibt/liest nie Zuweisungen — der Vorschlag nutzt den
// bestehenden set_key_account-Pfad im Zuweisungs-Panel.
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
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
  leadSourceId: uuidSchema,
  assigneeMembershipId: uuidSchema,
});

export type LeadRoutingRuleDto = {
  leadSourceId: string;
  sourceName: string;
  assigneeMembershipId: string;
  assigneeLabel: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

export type LeadRoutingSuggestion = {
  projectId: string;
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

function toDto(row: RuleRow, canWrite: boolean): LeadRoutingRuleDto {
  return {
    leadSourceId: row.lead_source_id,
    sourceName: row.source_name,
    assigneeMembershipId: row.assignee_membership_id,
    assigneeLabel: row.assignee_label,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  };
}

/**
 * Regel setzen oder ersetzen (Upsert je Quelle). Quelle und Mitgliedschaft
 * muessen im Workspace existieren — sonst NotFound/Validation, kein
 * stilles Anlegen.
 */
export async function setRoutingRule(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { leadSourceId: string; assigneeMembershipId: string },
): Promise<LeadRoutingRuleDto> {
  requireWrite(ctx);
  const parsed = setRoutingRuleCommandSchema.safeParse(input);
  if (!parsed.success) throw new LeadSourceValidationError();
  const command = parsed.data;

  const source = await tx.execute<{ id: string }>(sql`
    select id from lead_source
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.leadSourceId}::uuid
     limit 1
  `);
  if (!source.rows[0]) throw new LeadSourceNotFoundError(command.leadSourceId);

  const member = await tx.execute<{ id: string }>(sql`
    select id from membership
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.assigneeMembershipId}::uuid
     limit 1
  `);
  if (!member.rows[0]) {
    throw new LeadSourceValidationError("routing target membership not found");
  }

  const saved = await tx.execute<RuleRow>(sql`
    insert into project_lead_routing_rule (
      workspace_id, lead_source_id, assignee_membership_id, created_by
    ) values (
      ${ctx.workspaceId}::uuid, ${command.leadSourceId}::uuid,
      ${command.assigneeMembershipId}::uuid, ${ctx.actor}::uuid
    )
    on conflict (workspace_id, lead_source_id)
    do update set assignee_membership_id = excluded.assignee_membership_id,
                  updated_at = statement_timestamp()
    returning lead_source_id,
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

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project_lead_routing_rule",
    aggregateId: command.leadSourceId,
    eventType: "lead_routing_rule.set",
    actor: ctx.actor,
    payload: { leadSourceId: command.leadSourceId, membershipId: command.assigneeMembershipId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "lead_routing_rule.set",
    resource: "project_lead_routing_rule",
    allowed: true,
    details: { leadSourceId: command.leadSourceId, membershipId: command.assigneeMembershipId },
  });

  return toDto(row as RuleRow, true);
}

/** Regel loeschen — true wenn eine Regel bestand. */
export async function clearRoutingRule(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { leadSourceId: string },
): Promise<{ leadSourceId: string; deleted: boolean }> {
  requireWrite(ctx);
  const parsed = z.strictObject({ leadSourceId: uuidSchema }).safeParse(input);
  if (!parsed.success) throw new LeadSourceValidationError();
  const deleted = await tx.execute<{ id: string }>(sql`
    delete from project_lead_routing_rule
     where workspace_id = ${ctx.workspaceId}::uuid
       and lead_source_id = ${parsed.data.leadSourceId}::uuid
    returning id
  `);
  const wasDeleted = deleted.rows.length > 0;
  if (wasDeleted) {
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "project_lead_routing_rule",
      aggregateId: parsed.data.leadSourceId,
      eventType: "lead_routing_rule.cleared",
      actor: ctx.actor,
      payload: { leadSourceId: parsed.data.leadSourceId },
    });
    await writeAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      action: "lead_routing_rule.clear",
      resource: "project_lead_routing_rule",
      allowed: true,
      details: { leadSourceId: parsed.data.leadSourceId },
    });
  }
  return { leadSourceId: parsed.data.leadSourceId, deleted: wasDeleted };
}

/** Alle Regeln mit Anzeige-Labels, sortiert nach Quellname. */
export async function listRoutingRules(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<LeadRoutingRuleDto[]> {
  requireRead(ctx);
  const result = await tx.execute<RuleRow>(sql`
    select rule.lead_source_id,
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
  const canWrite = can(ctx, "lead_source.write");
  return result.rows.map((row) => toDto(row, canWrite));
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
 * Vorschlag fuer das Zuweisungs-Panel: null ohne Quelle/Regel, bei
 * verschwundenem Mitglied oder wenn das Mitglied bereits Key Account ist.
 * Schreibt nichts — der Klick nutzt den bestehenden set_key_account-Pfad.
 */
export async function suggestAssigneeForProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string },
): Promise<LeadRoutingSuggestion | null> {
  requireRead(ctx);
  const parsed = z.strictObject({ projectId: uuidSchema }).safeParse(input);
  if (!parsed.success) throw new LeadSourceValidationError();

  const project = await tx.execute<{ lead_source_id: string | null }>(sql`
    select lead_source_id
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.projectId}::uuid
     limit 1
  `);
  const leadSourceId = project.rows[0]?.lead_source_id ?? null;
  if (!leadSourceId) return null;

  const suggestion = await tx.execute<{
    lead_source_id: string;
    source_name: string;
    membership_id: string;
    label: string;
    is_key_account: boolean;
  }>(sql`
    select rule.lead_source_id,
           source_record.name as source_name,
           rule.assignee_membership_id as membership_id,
           identity_record.email as label,
           exists (
             select 1 from project_assignment assignment_record
              where assignment_record.workspace_id = ${ctx.workspaceId}::uuid
                and assignment_record.project_id = ${parsed.data.projectId}::uuid
                and assignment_record.membership_id = rule.assignee_membership_id
                and assignment_record.assignment_role = 'key_account'
           ) as is_key_account
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
       and rule.lead_source_id = ${leadSourceId}::uuid
     limit 1
  `);
  const row = suggestion.rows[0];
  if (!row || row.is_key_account) return null;
  return {
    projectId: parsed.data.projectId,
    leadSourceId: row.lead_source_id,
    sourceName: row.source_name,
    membershipId: row.membership_id,
    label: row.label,
  };
}
