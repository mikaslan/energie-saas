import {
  foreignKey,
  index,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { membership, workspace } from "./core";
import { leadSource } from "./lead-source";

// F1-10 Lead-Routing: genau eine Regel je Lead-Quelle
// (Quelle -> Standard-Betreuer als Workspace-Mitgliedschaft).
// Der Vorschlag nutzt den bestehenden set_key_account-Pfad;
// die Regel selbst schreibt/liest nie Zuweisungen.
export const projectLeadRoutingRule = pgTable(
  "project_lead_routing_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    leadSourceId: uuid("lead_source_id").notNull(),
    assigneeMembershipId: uuid("assignee_membership_id").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_lead_routing_rule_ws_id_uq").on(t.workspaceId, t.id),
    // Genau eine Regel je Quelle im Workspace.
    uniqueIndex("project_lead_routing_rule_ws_source_uq")
      .on(t.workspaceId, t.leadSourceId),
    index("project_lead_routing_rule_ws_membership_idx").on(
      t.workspaceId,
      t.assigneeMembershipId,
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
    // RESTRICT wie project_assignment_membership_fk: kein stilles
    // Verlieren der Regel beim Offboarding — erst Regel löschen.
    foreignKey({
      columns: [t.workspaceId, t.assigneeMembershipId],
      foreignColumns: [membership.workspaceId, membership.id],
      name: "project_lead_routing_rule_membership_fk",
    }).onDelete("restrict"),
  ],
);
