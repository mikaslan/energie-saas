import {
  check,
  doublePrecision,
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
import { planningRoofMin } from "./planning-roof-min";

// F3-03b Dach-Sperrzonen Stufe-0 (Katalog F3.3): generisches Rechteck
// je Dach (Schornstein/Fenster/Sonstige + optionale Höhe). Kein
// Schattenwurf-Modell, keine Überlapp-Prüfung (Folge). Rechteck-in-
// Polygon auf App-Ebene (Contract); DB-CHECKs nur Maße/Höhe.
export const planningRoofRestriction = pgTable(
  "planning_roof_restriction",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    roofId: uuid("roof_id").notNull(),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    rectJson: jsonb("rect_json").notNull(),
    heightM: doublePrecision("height_m"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("planning_roof_restriction_ws_id_uq").on(t.workspaceId, t.id),
    index("planning_roof_restriction_ws_roof_idx").on(t.workspaceId, t.roofId),
    check(
      "planning_roof_restriction_kind_ck",
      sql`${t.kind} in ('chimney', 'window', 'other')`,
    ),
    check(
      "planning_roof_restriction_rect_ck",
      sql`jsonb_typeof(${t.rectJson}) = 'object'
        AND (${t.rectJson}->>'width')::double precision > 0
        AND (${t.rectJson}->>'height')::double precision > 0`,
    ),
    check(
      "planning_roof_restriction_height_ck",
      sql`${t.heightM} IS NULL OR (${t.heightM} >= 0 AND ${t.heightM} <= 50)`,
    ),
    check(
      "planning_roof_restriction_label_ck",
      sql`char_length(${t.label}) > 0`,
    ),
    check("planning_roof_restriction_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "planning_roof_restriction_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.roofId],
      foreignColumns: [planningRoofMin.workspaceId, planningRoofMin.id],
      name: "planning_roof_restriction_roof_fk",
    }),
  ],
);
