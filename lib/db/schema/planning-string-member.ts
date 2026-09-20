import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";
import { planningString } from "./planning-string";
import { planningPanelGroup } from "./planning-panel-group";

// F3-05c String-Zell-Ranges Stufe-0: Rechteck-Ranges (Zeilen-/
// Spalten-Fenster) je String-Member. Form-Regeln (≥1, from≤to)
// als Inline-CHECKs; Schnitt-Regeln (Raster, Deselect, Überlapp,
// Doppelbelegung) prüft der Service (App-Level, Spec ESTIMATE).
// member_json bleibt daneben lesbar (Bestandsschutz).
export const planningStringMember = pgTable(
  "planning_string_member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    stringId: uuid("string_id").notNull(),
    groupId: uuid("group_id").notNull(),
    rowFrom: integer("row_from").notNull(),
    rowTo: integer("row_to").notNull(),
    colFrom: integer("col_from").notNull(),
    colTo: integer("col_to").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("planning_string_member_ws_id_uq").on(t.workspaceId, t.id),
    index("planning_string_member_ws_string_idx").on(t.workspaceId, t.stringId),
    index("planning_string_member_ws_group_idx").on(t.workspaceId, t.groupId),
    check(
      "planning_string_member_row_ck",
      sql`${t.rowFrom} >= 1 AND ${t.rowTo} >= ${t.rowFrom}`,
    ),
    check(
      "planning_string_member_col_ck",
      sql`${t.colFrom} >= 1 AND ${t.colTo} >= ${t.colFrom}`,
    ),
    check("planning_string_member_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "planning_string_member_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.stringId],
      foreignColumns: [planningString.workspaceId, planningString.id],
      name: "planning_string_member_string_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [t.workspaceId, t.groupId],
      foreignColumns: [planningPanelGroup.workspaceId, planningPanelGroup.id],
      name: "planning_string_member_group_fk",
    }).onDelete("restrict"),
  ],
);
