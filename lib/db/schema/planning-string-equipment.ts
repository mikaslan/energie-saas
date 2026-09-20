import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";
import { planningString } from "./planning-string";

// F3-05b String-Equipment Stufe-0 (Katalog F3.5): Optimierer pro
// String/Panel + Mikro-WR je Panel (Panel-Ref {group_id, row, col}
// nur range-validiert, kein Vorgriff auf F3-04b). Mengen- und
// Kreuzregeln als Inline-CHECKs (subquery-frei); Raster-Tiefe
// (Gruppe existiert, row/col im Raster) prüft der Service.
export const planningStringEquipment = pgTable(
  "planning_string_equipment",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    stringId: uuid("string_id").notNull(),
    scope: text("scope").notNull(),
    panelRefJson: jsonb("panel_ref_json"),
    equipment: text("equipment").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("planning_string_equipment_ws_id_uq").on(t.workspaceId, t.id),
    index("planning_string_equipment_ws_string_idx").on(t.workspaceId, t.stringId),
    check(
      "planning_string_equipment_scope_ck",
      sql`${t.scope} in ('string', 'panel')`,
    ),
    check(
      "planning_string_equipment_type_ck",
      sql`${t.equipment} in ('optimizer', 'micro_inverter')`,
    ),
    check(
      "planning_string_equipment_ref_ck",
      // IS-NOT-NULL-Anker zuerst: jsonb_typeof(NULL) ist NULL (kein
      // FALSE) und ließe scope=panel ohne Ref passieren.
      sql`(${t.scope} = 'string' AND ${t.panelRefJson} IS NULL)
        OR (${t.scope} = 'panel'
          AND ${t.panelRefJson} IS NOT NULL
          AND jsonb_typeof(${t.panelRefJson}) = 'object'
          AND (${t.panelRefJson} ? 'group_id')
          AND (${t.panelRefJson}->>'row')::integer >= 1
          AND (${t.panelRefJson}->>'col')::integer >= 1)`,
    ),
    check(
      "planning_string_equipment_micro_ck",
      sql`${t.equipment} <> 'micro_inverter' OR ${t.scope} = 'panel'`,
    ),
    check("planning_string_equipment_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "planning_string_equipment_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.stringId],
      foreignColumns: [planningString.workspaceId, planningString.id],
      name: "planning_string_equipment_string_fk",
    }).onDelete("restrict"),
  ],
);
