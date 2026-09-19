import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { membership, workspace } from "./core";
import { funnelCampaign } from "./funnel-campaign";
import { leadSource } from "./lead-source";

export const leadRoutingRuleModes = ["suggest", "auto"] as const;

// F1-10 Lead-Routing + F1-23 Routing-Vertiefung (0235): Regeln feuern je
// Dimension (Quelle XOR Kampagne) mit Modus, Priorität (first-match
// aufsteigend) und Triggern für manuelle Erfassung bzw. Intake. Kampagnen-
// Regeln sind immer suggest; archivierte Regeln feuern nicht. Der Vorschlag
// nutzt den bestehenden set_key_account-Pfad; die Regel selbst schreibt/liest
// nie Zuweisungen.
export const projectLeadRoutingRule = pgTable(
  "project_lead_routing_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    leadSourceId: uuid("lead_source_id"),
    funnelCampaignId: uuid("funnel_campaign_id"),
    assigneeMembershipId: uuid("assignee_membership_id").notNull(),
    mode: text("mode").$type<(typeof leadRoutingRuleModes)[number]>().notNull().default("suggest"),
    priority: integer("priority").notNull().default(0),
    autoOnManual: boolean("auto_on_manual").notNull().default(true),
    autoOnIntake: boolean("auto_on_intake").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_lead_routing_rule_ws_id_uq").on(t.workspaceId, t.id),
    // F1-23 löst "genau eine Regel je Quelle" ab: mehrere Regeln je
    // Dimension, Duplikate (Dimension + Ziel) sind nur unter aktiven
    // Regeln ausgeschlossen (F1.8-Muster: Archivierung gibt frei).
    uniqueIndex("project_lead_routing_rule_ws_source_assignee_uq")
      .on(t.workspaceId, t.leadSourceId, t.assigneeMembershipId)
      .where(sql`${t.leadSourceId} is not null and ${t.archivedAt} is null`),
    uniqueIndex("project_lead_routing_rule_ws_campaign_assignee_uq")
      .on(t.workspaceId, t.funnelCampaignId, t.assigneeMembershipId)
      .where(sql`${t.funnelCampaignId} is not null and ${t.archivedAt} is null`),
    index("project_lead_routing_rule_ws_source_idx").on(
      t.workspaceId,
      t.leadSourceId,
    ),
    index("project_lead_routing_rule_ws_campaign_idx").on(
      t.workspaceId,
      t.funnelCampaignId,
    ),
    index("project_lead_routing_rule_ws_membership_idx").on(
      t.workspaceId,
      t.assigneeMembershipId,
    ),
    // Genau eine Dimension: Quelle XOR Kampagne.
    check(
      "project_lead_routing_rule_dimension_ck",
      sql`(${t.leadSourceId} is null) != (${t.funnelCampaignId} is null)`,
    ),
    check(
      "project_lead_routing_rule_mode_ck",
      sql`${t.mode} in ('suggest', 'auto')`,
    ),
    check(
      "project_lead_routing_rule_priority_ck",
      sql`${t.priority} between 0 and 9999`,
    ),
    // Kampagnen-Regeln sind immer suggest (F12-02 bleibt einziger Auto-Pfad
    // für Kampagnen).
    check(
      "project_lead_routing_rule_campaign_mode_ck",
      sql`${t.funnelCampaignId} is null or ${t.mode} = 'suggest'`,
    ),
    check(
      "project_lead_routing_rule_archive_ck",
      sql`${t.archivedAt} is null or ${t.archivedAt} >= ${t.createdAt}`,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_lead_routing_rule_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.leadSourceId],
      foreignColumns: [leadSource.workspaceId, leadSource.id],
      name: "project_lead_routing_rule_lead_source_fk",
    }).onDelete("cascade"),
    // Wie die Quellen-Dimension: Kampagne weg → Regel gegenstandslos.
    foreignKey({
      columns: [t.workspaceId, t.funnelCampaignId],
      foreignColumns: [funnelCampaign.workspaceId, funnelCampaign.id],
      name: "project_lead_routing_rule_funnel_campaign_fk",
    }).onDelete("cascade"),
    // RESTRICT wie project_assignment_membership_fk: kein stilles
    // Verlieren der Regel beim Offboarding — erst Regel löschen.
    foreignKey({
      columns: [t.workspaceId, t.assigneeMembershipId],
      foreignColumns: [membership.workspaceId, membership.id],
      name: "project_lead_routing_rule_membership_fk",
    }).onDelete("restrict"),
  ],
);
