import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";

// F16.3 Slice A: Rabatt-Vorlagen (Fix/Prozent mit Cap). Archiv statt
// Delete (active-Flag, Checklisten-Muster). Steuerabzug ist Angebotslogik
// und steht bewusst NICHT hier (Spec-Nicht-Ziel).
export const discountTemplate = pgTable(
  "discount_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    kind: text("kind").notNull(),
    amountCents: integer("amount_cents"),
    percentBps: integer("percent_bps"),
    capCents: integer("cap_cents"),
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("discount_template_ws_idx").on(t.workspaceId, t.active, t.position),
    uniqueIndex("discount_template_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("discount_template_ws_active_name_uq")
      .on(t.workspaceId, t.nameNormalized)
      .where(sql`${t.active}`),
    check("discount_template_name_ck", sql`${t.name} ~ '^[^[:space:]].*$' and pg_catalog.length(${t.name}) <= 200 and ${t.name} !~ '[[:cntrl:]]'`),
    check("discount_template_name_normalized_ck", sql`${t.nameNormalized} = pg_catalog.lower(pg_catalog.btrim(${t.nameNormalized}))`),
    check("discount_template_kind_ck", sql`${t.kind} in ('fix_cents', 'percent_bps')`),
    check("discount_template_fix_ck", sql`(${t.kind} <> 'fix_cents') or (${t.amountCents} is not null and ${t.amountCents} >= 0 and ${t.percentBps} is null)`),
    check("discount_template_percent_ck", sql`(${t.kind} <> 'percent_bps') or (${t.percentBps} is not null and ${t.percentBps} between 1 and 10000 and ${t.amountCents} is null)`),
    check("discount_template_cap_ck", sql`${t.capCents} is null or (${t.kind} = 'percent_bps' and ${t.capCents} >= 0)`),
    check("discount_template_position_ck", sql`${t.position} >= 0`),
    check("discount_template_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "discount_template_workspace_id_fk",
    }),
  ],
);
