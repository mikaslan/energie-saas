import {
  check,
  doublePrecision,
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
import { planningRoofMin } from "./planning-roof-min";

// F3-04a manuelle Panel-Gruppe Stufe-0 (Katalog F3.4): Rechteck-Raster
// je Dach (Art H/V, Ursprung, Zeilen/Spalten, explizites Modulmaß,
// uniforme Lücke, optionale Gruppen-Neigung). Kein Auto-Fill, keine KI,
// kein Katalog-Join (Folge). Rechteck-in-Polygon auf App-Ebene
// (Contract); DB-CHECKs nur kind/Ranges/Rechteck-Positivität.
export const planningPanelGroup = pgTable(
  "planning_panel_group",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    roofId: uuid("roof_id").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    originJson: jsonb("origin_json").notNull(),
    rows: integer("rows").notNull(),
    cols: integer("cols").notNull(),
    moduleWM: doublePrecision("module_w_m").notNull(),
    moduleHM: doublePrecision("module_h_m").notNull(),
    gapM: doublePrecision("gap_m").notNull(),
    tiltDeg: doublePrecision("tilt_deg"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("planning_panel_group_ws_id_uq").on(t.workspaceId, t.id),
    index("planning_panel_group_ws_roof_idx").on(t.workspaceId, t.roofId),
    check(
      "planning_panel_group_kind_ck",
      sql`${t.kind} in ('h', 'v')`,
    ),
    check(
      "planning_panel_group_label_ck",
      sql`char_length(${t.label}) > 0`,
    ),
    check(
      "planning_panel_group_origin_ck",
      sql`jsonb_typeof(${t.originJson}) = 'object'
        AND (${t.originJson} ? 'x')
        AND (${t.originJson} ? 'y')`,
    ),
    check(
      "planning_panel_group_rows_ck",
      sql`${t.rows} >= 1 AND ${t.rows} <= 200`,
    ),
    check(
      "planning_panel_group_cols_ck",
      sql`${t.cols} >= 1 AND ${t.cols} <= 200`,
    ),
    check(
      "planning_panel_group_module_ck",
      sql`${t.moduleWM} >= 0.1 AND ${t.moduleWM} <= 5 AND ${t.moduleHM} >= 0.1 AND ${t.moduleHM} <= 5`,
    ),
    check(
      "planning_panel_group_gap_ck",
      sql`${t.gapM} >= 0 AND ${t.gapM} <= 2`,
    ),
    check(
      "planning_panel_group_tilt_ck",
      sql`${t.tiltDeg} IS NULL OR (${t.tiltDeg} >= 0 AND ${t.tiltDeg} <= 90)`,
    ),
    check(
      "planning_panel_group_rect_ck",
      sql`(${t.cols} * ${t.moduleWM} + (${t.cols} - 1) * ${t.gapM}) > 0
        AND (${t.rows} * ${t.moduleHM} + (${t.rows} - 1) * ${t.gapM}) > 0`,
    ),
    check("planning_panel_group_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "planning_panel_group_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.roofId],
      foreignColumns: [planningRoofMin.workspaceId, planningRoofMin.id],
      name: "planning_panel_group_roof_fk",
    }).onDelete("restrict"),
  ],
);
