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
import { workspace } from "./core";
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
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("installation_ws_project_uq").on(t.workspaceId, t.projectId),
    index("installation_ws_status_idx").on(t.workspaceId, t.status),
    check("installation_source_ck", sql`${t.source} in ('direct', 'signature')`),
    check("installation_status_ck", sql`${t.status} in ('active', 'completed')`),
    check(
      "installation_completed_ck",
      sql`(${t.status} = 'completed' and ${t.completedAt} is not null) or (${t.status} = 'active' and ${t.completedAt} is null)`,
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
  ],
);
