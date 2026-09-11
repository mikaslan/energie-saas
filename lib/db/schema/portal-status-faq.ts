import { check, foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";

// F10-09 · Portal-FAQ je Installationsstand (Muster portal-status-label):
// Admin-Autorenschaft, eine Zeile je (Scope, Schlüssel); fehlende Zeile
// = kein FAQ-Block (ehrlicher Fallback, kein Default-Text).
export const portalStatusFaq = pgTable(
  "portal_status_faq",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    scope: text("scope").notNull(),
    sourceKey: text("source_key").notNull(),
    faq: text("faq").notNull(),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("portal_status_faq_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("portal_status_faq_ws_scope_key_uq").on(t.workspaceId, t.scope, t.sourceKey),
    // Fail-closed Allowlist: nur der belegte Installation-Umfang.
    check("portal_status_faq_scope_ck", sql`${t.scope} = 'installation'`),
    check(
      "portal_status_faq_key_ck",
      sql`${t.sourceKey} in ('active', 'completed', 'handover')`,
    ),
    check(
      "portal_status_faq_faq_ck",
      sql`${t.faq} = pg_catalog.btrim(${t.faq}) and pg_catalog.length(${t.faq}) between 1 and 2000 and ${t.faq} !~ '[[:cntrl:]]'`,
    ),
    check("portal_status_faq_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "portal_status_faq_workspace_id_fk",
    }),
  ],
);
