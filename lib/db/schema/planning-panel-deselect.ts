import {
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
import { planningPanelGroup } from "./planning-panel-group";

// F3-04b Einzelmodul-Abwahl Stufe-0 (Katalog F3.4): Deselect-Zeilen
// je Panel-Gruppe (row/col 1-basiert, optionale Begründung).
// Eindeutig je Zelle (UNIQUE); Raster-Tiefe (row/col im Gruppen-
// Raster) prüft der Service; Doppel-Abwahl ist dort idempotent.
export const planningPanelDeselect = pgTable(
  "planning_panel_deselect",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    groupId: uuid("group_id").notNull(),
    row: integer("row").notNull(),
    col: integer("col").notNull(),
    reason: text("reason"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("planning_panel_deselect_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("planning_panel_deselect_cell_uq").on(t.groupId, t.row, t.col),
    index("planning_panel_deselect_ws_group_idx").on(t.workspaceId, t.groupId),
    check(
      "planning_panel_deselect_row_ck",
      sql`${t.row} >= 1`,
    ),
    check(
      "planning_panel_deselect_col_ck",
      sql`${t.col} >= 1`,
    ),
    check(
      "planning_panel_deselect_reason_ck",
      sql`${t.reason} IS NULL OR (char_length(${t.reason}) >= 1 AND char_length(${t.reason}) <= 280)`,
    ),
    check("planning_panel_deselect_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "planning_panel_deselect_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.groupId],
      foreignColumns: [planningPanelGroup.workspaceId, planningPanelGroup.id],
      name: "planning_panel_deselect_group_fk",
    }).onDelete("restrict"),
  ],
);
