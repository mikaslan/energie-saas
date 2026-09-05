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

// F2.5 Slice A: Zahlarten-Stammdaten je Workspace (reine Anzeige, kein
// Provider-Verkehr). Schlüssel geschlossen (purchase/financing_classic/
// leasing), Archiv statt Delete (F1.8-Muster).
export const paymentOption = pgTable(
  "payment_option",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    kind: text("kind").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("payment_option_ws_idx").on(t.workspaceId, t.archivedAt),
    uniqueIndex("payment_option_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("payment_option_ws_active_key_uq")
      .on(t.workspaceId, t.key)
      .where(sql`${t.archivedAt} is null`),
    check("payment_option_key_ck", sql`${t.key} in ('purchase', 'financing_classic', 'leasing')`),
    check("payment_option_label_ck", sql`${t.label} ~ '^[^[:space:]].*$' and pg_catalog.length(${t.label}) <= 120 and ${t.label} !~ '[[:cntrl:]]'`),
    check("payment_option_kind_ck", sql`${t.kind} in ('purchase', 'financing', 'leasing')`),
    check("payment_option_key_kind_ck", sql`(${t.key} = 'purchase' and ${t.kind} = 'purchase') or (${t.key} = 'financing_classic' and ${t.kind} = 'financing') or (${t.key} = 'leasing' and ${t.kind} = 'leasing')`),
    check("payment_option_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "payment_option_workspace_id_fk",
    }),
  ],
);
