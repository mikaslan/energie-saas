import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { membership, workspace } from "./core";
import { project } from "./project";

// F7.1 Slice A: Ausführungsphase je Projekt (genau eine Zeile).
// Quelle direkt (Modal) oder Signatur (Slice B); offer/variant sind reine
// Referenzen ohne FK in die Offer-Kette.
export const installation = pgTable(
  "installation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull(),
    offerId: uuid("offer_id"),
    variantId: uuid("variant_id"),
    // F7-05 Slice 3: Lead Installer (Installations-Ebene), NULL = nicht
    // zugewiesen; FK SET NULL (Mitglied weg ≠ Installation weg).
    leadInstallerMembershipId: uuid("lead_installer_membership_id"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // F7-05 Abnahme: NULL = nicht abgenommen; nur bei completed belegbar
    // (Service-Guard), korrigierbar via erneuter Abnahme.
    handoverAt: timestamp("handover_at", { withTimezone: true }),
    handoverByName: text("handover_by_name"),
    handoverNote: text("handover_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("installation_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("installation_ws_project_uq").on(t.workspaceId, t.projectId),
    index("installation_ws_status_idx").on(t.workspaceId, t.status),
    index("installation_ws_lead_installer_idx").on(t.workspaceId, t.leadInstallerMembershipId),
    check("installation_source_ck", sql`${t.source} in ('direct', 'signature')`),
    check("installation_status_ck", sql`${t.status} in ('active', 'completed')`),
    check(
      "installation_completed_ck",
      sql`(${t.status} = 'completed' and ${t.completedAt} is not null) or (${t.status} = 'active' and ${t.completedAt} is null)`,
    ),
    check(
      "installation_handover_ck",
      sql`(${t.handoverAt} is null and ${t.handoverByName} is null and ${t.handoverNote} is null) or (${t.status} = 'completed' and ${t.handoverAt} is not null and pg_catalog.length(pg_catalog.btrim(${t.handoverByName})) between 1 and 160 and (${t.handoverNote} is null or (pg_catalog.length(${t.handoverNote}) between 1 and 500 and ${t.handoverNote} = pg_catalog.btrim(${t.handoverNote}))))`,
    ),
    check(
      "installation_variant_needs_offer_ck",
      sql`${t.variantId} is null or ${t.offerId} is not null`,
    ),
    check("installation_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "installation_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "installation_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.leadInstallerMembershipId],
      foreignColumns: [membership.workspaceId, membership.id],
      name: "installation_lead_installer_membership_fk",
    }).onDelete("set null"),
  ],
);
