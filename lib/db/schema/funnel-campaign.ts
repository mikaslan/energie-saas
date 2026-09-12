import { sql } from "drizzle-orm";
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
import { workspace } from "./core";
import { leadSource } from "./lead-source";

// F12-01 Funnel-Kampagne: benannte Variante mit eigener Lead-Quelle und
// stabilem Slug (Deeplink-Token, Bedienung in F12-02). Tenant-Tabelle:
// FORCE RLS + tenant_isolation kommen aus der Migration (0086-Muster).
export const funnelCampaign = pgTable(
  "funnel_campaign",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    slug: text("slug").notNull(),
    slugNormalized: text("slug_normalized").notNull(),
    leadSourceId: uuid("lead_source_id").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("funnel_campaign_ws_idx").on(t.workspaceId, t.archivedAt),
    // Composite-Unique als zusammengesetztes FK-Ziel für
    // project(workspace_id, funnel_campaign_id) — echter Constraint
    // (Lehre aus F7-12: Unique-Index trägt keinen FK).
    unique("funnel_campaign_ws_id_uq").on(t.workspaceId, t.id),
    // F1.8-Muster: Name und Slug sind NUR unter aktiven Kampagnen
    // eindeutig — nach Archivierung werden beide wieder frei.
    uniqueIndex("funnel_campaign_ws_active_name_uq")
      .on(t.workspaceId, t.nameNormalized)
      .where(sql`${t.archivedAt} is null`),
    uniqueIndex("funnel_campaign_ws_active_slug_uq")
      .on(t.workspaceId, t.slugNormalized)
      .where(sql`${t.archivedAt} is null`),
    check("funnel_campaign_name_ck", sql`${t.name} ~ '^[^[:space:]].*$' and pg_catalog.length(${t.name}) <= 120`),
    check("funnel_campaign_name_normalized_ck", sql`${t.nameNormalized} = pg_catalog.lower(pg_catalog.btrim(${t.nameNormalized}))`),
    check("funnel_campaign_slug_ck", sql`${t.slug} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`),
    check("funnel_campaign_slug_normalized_ck", sql`${t.slugNormalized} = pg_catalog.lower(pg_catalog.btrim(${t.slugNormalized}))`),
    check("funnel_campaign_archive_ck", sql`${t.archivedAt} is null or ${t.archivedAt} >= ${t.createdAt}`),
    check("funnel_campaign_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "funnel_campaign_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.leadSourceId],
      foreignColumns: [leadSource.workspaceId, leadSource.id],
      name: "funnel_campaign_lead_source_fk",
    }),
  ],
);
