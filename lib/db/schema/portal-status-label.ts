import { check, foreignKey, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";

// F10-05 · Portal-Statusmapping (Installation-Umfang): kundenlesbare
// Bezeichnung je Anzeigestand. Eine Zeile je (Scope, Schlüssel);
// fehlende Zeile = Standardtext (ehrlicher Fallback, kein NULL-Label).
export const portalStatusLabel = pgTable(
  "portal_status_label",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    scope: text("scope").notNull(),
    sourceKey: text("source_key").notNull(),
    label: text("label").notNull(),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("portal_status_label_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("portal_status_label_ws_scope_key_uq").on(t.workspaceId, t.scope, t.sourceKey),
    // Fail-closed Allowlist: nur der belegte Installation-Umfang.
    check("portal_status_label_scope_ck", sql`${t.scope} = 'installation'`),
    check(
      "portal_status_label_key_ck",
      sql`${t.sourceKey} in ('active', 'completed', 'handover')`,
    ),
    check(
      "portal_status_label_label_ck",
      sql`${t.label} = pg_catalog.btrim(${t.label}) and pg_catalog.length(${t.label}) between 1 and 80 and ${t.label} !~ '[[:cntrl:]]'`,
    ),
    check("portal_status_label_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "portal_status_label_workspace_id_fk",
    }),
  ],
);
