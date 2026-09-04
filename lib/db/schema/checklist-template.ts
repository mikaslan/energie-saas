import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";

export const checklistTemplate = pgTable(
  "checklist_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    description: text("description"),
    position: integer("position").notNull().default(0),
    active: boolean("active").notNull().default(true),
    targets: jsonb("targets").notNull().default(sql`'[]'::jsonb`),
    items: jsonb("items").notNull().default(sql`'[]'::jsonb`),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("checklist_template_ws_idx").on(t.workspaceId, t.active, t.position),
    uniqueIndex("checklist_template_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("checklist_template_ws_active_name_uq")
      .on(t.workspaceId, t.nameNormalized)
      .where(sql`${t.active}`),
    check("checklist_template_name_ck", sql`${t.name} ~ '^[^[:space:]].*$' and pg_catalog.length(${t.name}) <= 200 and ${t.name} !~ '[[:cntrl:]]'`),
    check("checklist_template_name_normalized_ck", sql`${t.nameNormalized} = pg_catalog.lower(pg_catalog.btrim(${t.nameNormalized}))`),
    check("checklist_template_description_ck", sql`${t.description} is null or (
      pg_catalog.length(${t.description}) between 1 and 2000
      and ${t.description} = pg_catalog.btrim(${t.description})
      and ${t.description} !~ '[[:cntrl:]]'
    )`),
    check("checklist_template_position_ck", sql`${t.position} >= 0`),
    check("checklist_template_targets_ck", sql`pg_catalog.jsonb_typeof(${t.targets}) = 'array'`),
    check("checklist_template_items_ck", sql`pg_catalog.jsonb_typeof(${t.items}) = 'array'`),
    check("checklist_template_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "checklist_template_workspace_id_fk",
    }),
  ],
);
