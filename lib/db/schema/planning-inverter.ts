import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";
import { project } from "./project";

// F3-05a Wechselrichter-Registry Stufe-0 (Katalog F3.5): ein WR je
// Eintrag (Label, MPP-Tracker-Zahl, optionale Advisory-Max-Länge
// für Strings). Kein Katalog-Join, kein Modell, keine Auslegung
// (Folge). Slot ≤ Tracker gilt nur App-Level (Spec ESTIMATE).
export const planningInverter = pgTable(
  "planning_inverter",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    label: text("label").notNull(),
    mppTrackers: integer("mpp_trackers").notNull(),
    maxStringModules: integer("max_string_modules"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Inline-UNIQUE (project.ts-Muster): Der String-FK derselben
    // Migration braucht den Constraint VOR den FK-ALTERs.
    unique("planning_inverter_ws_id_uq").on(t.workspaceId, t.id),
    index("planning_inverter_ws_project_idx").on(t.workspaceId, t.projectId),
    check(
      "planning_inverter_label_ck",
      sql`char_length(${t.label}) > 0`,
    ),
    check(
      "planning_inverter_mpp_ck",
      sql`${t.mppTrackers} >= 1 AND ${t.mppTrackers} <= 12`,
    ),
    check(
      "planning_inverter_max_ck",
      sql`${t.maxStringModules} IS NULL OR ${t.maxStringModules} >= 1`,
    ),
    check("planning_inverter_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "planning_inverter_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "planning_inverter_project_fk",
    }).onDelete("restrict"),
  ],
);
