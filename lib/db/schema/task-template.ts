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

// F16-04 · Aufgaben-Vorlagen (Titel-Preset + Fälligkeits-Offset).
// Archiv statt Delete (active-Flag, F7.3/F16.3-Muster). Offset-Semantik:
// null = ohne Fälligkeit, 0 = heute (Europe/Berlin), sonst Tage dazu.
export const taskTemplate = pgTable(
  "task_template",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    title: text("title").notNull(),
    dueOffsetDays: integer("due_offset_days"),
    active: boolean("active").notNull().default(true),
    position: integer("position").notNull().default(0),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("task_template_ws_idx").on(t.workspaceId, t.active, t.position),
    uniqueIndex("task_template_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("task_template_ws_active_name_uq")
      .on(t.workspaceId, t.nameNormalized)
      .where(sql`${t.active}`),
    check("task_template_name_ck", sql`${t.name} ~ '^[^[:space:]].*$' and pg_catalog.length(${t.name}) <= 200 and ${t.name} !~ '[[:cntrl:]]'`),
    check("task_template_name_normalized_ck", sql`${t.nameNormalized} = pg_catalog.lower(pg_catalog.btrim(${t.nameNormalized}))`),
    check("task_template_title_ck", sql`pg_catalog.length(pg_catalog.btrim(${t.title})) between 1 and 200`),
    check("task_template_due_offset_ck", sql`${t.dueOffsetDays} is null or (${t.dueOffsetDays} between 0 and 3650)`),
    check("task_template_position_ck", sql`${t.position} >= 0`),
    check("task_template_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "task_template_workspace_id_fk",
    }),
  ],
);
