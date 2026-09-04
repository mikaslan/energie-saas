import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";

export const leadSourceProjectDomains = ["residential", "commercial"] as const;

export const leadSource = pgTable(
  "lead_source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    projectDomain: text("project_domain").$type<(typeof leadSourceProjectDomains)[number] | null>(),
    color: text("color"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("lead_source_ws_idx").on(t.workspaceId, t.archivedAt),
    // Composite-Unique für den mehrspaltigen FK project(workspace_id, lead_source_id).
    unique("lead_source_ws_id_uq").on(t.workspaceId, t.id),
    // Spec F1.8: Name ist NUR unter aktiven Quellen eindeutig — nach
    // Archivierung wird der Name wieder frei (Reonic-Muster).
    uniqueIndex("lead_source_ws_active_name_uq")
      .on(t.workspaceId, t.nameNormalized)
      .where(sql`${t.archivedAt} is null`),
    check("lead_source_name_ck", sql`${t.name} ~ '^[^[:space:]].*$' and pg_catalog.length(${t.name}) <= 120`),
    check("lead_source_name_normalized_ck", sql`${t.nameNormalized} = pg_catalog.lower(pg_catalog.btrim(${t.nameNormalized}))`),
    check("lead_source_domain_ck", sql`${t.projectDomain} is null or ${t.projectDomain} in ('residential', 'commercial')`),
    check("lead_source_color_ck", sql`${t.color} is null or ${t.color} ~ '^#[0-9A-Fa-f]{6}$'`),
    check("lead_source_archive_ck", sql`${t.archivedAt} is null or ${t.archivedAt} >= ${t.createdAt}`),
    check("lead_source_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "lead_source_workspace_id_fk",
    }),
  ],
);
