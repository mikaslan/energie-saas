import {
  check,
  doublePrecision,
  foreignKey,
  index,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";
import { planningSource } from "./planning-source";

// F3-03 Dach-Minimal (Katalog F3.3, Batch-1): genau 1 Polygon je Dach
// (3..64 Punkte), Neigung pro Kante ODER Flachdach-Einzelneigung
// (XOR), Randabstaende mit Uniform-Fallback. Selbstschnitt-Pruefung
// auf App-Ebene (Contract); DB-CHECK nur Punktanzahl. Gauben,
// Sperrzonen und Teilflaechen sind Folge-Batch.
export const planningRoofMin = pgTable(
  "planning_roof_min",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    sourceId: uuid("source_id").notNull(),
    polygonJson: jsonb("polygon_json").notNull(),
    tiltPerEdgeJson: jsonb("tilt_per_edge_json"),
    flatSingleTilt: doublePrecision("flat_single_tilt"),
    edgeMarginsJson: jsonb("edge_margins_json"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("planning_roof_min_ws_id_uq").on(t.workspaceId, t.id),
    index("planning_roof_min_ws_source_idx").on(t.workspaceId, t.sourceId),
    check(
      "planning_roof_min_polygon_ck",
      sql`jsonb_typeof(${t.polygonJson}) = 'array' AND jsonb_array_length(${t.polygonJson}) between 3 and 64`,
    ),
    check(
      "planning_roof_min_tilt_xor_ck",
      sql`(${t.tiltPerEdgeJson} IS NULL) <> (${t.flatSingleTilt} IS NULL)`,
    ),
    check(
      "planning_roof_min_flat_tilt_ck",
      sql`${t.flatSingleTilt} IS NULL OR (${t.flatSingleTilt} >= 0 AND ${t.flatSingleTilt} <= 90)`,
    ),
    check("planning_roof_min_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "planning_roof_min_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.sourceId],
      foreignColumns: [planningSource.workspaceId, planningSource.id],
      name: "planning_roof_min_source_fk",
    }),
  ],
);
