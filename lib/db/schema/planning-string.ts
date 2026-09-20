import {
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
import { planningInverter } from "./planning-inverter";

// F3-05a manuelle Strings Stufe-0 (Katalog F3.5): ein String hängt an
// einem WR-Slot und referenziert ganze Panel-Gruppen (1..200 Member).
// Kein Auto-Fill, kein Optimierer, keine Stromstärken (Folge).
// Doppelbelegung derselben Gruppe im selben WR lehnt der Service
// hart ab (App-Level, Spec ESTIMATE).
export const planningString = pgTable(
  "planning_string",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    inverterId: uuid("inverter_id").notNull(),
    trackerSlot: integer("tracker_slot").notNull(),
    label: text("label").notNull(),
    memberJson: jsonb("member_json").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("planning_string_ws_id_uq").on(t.workspaceId, t.id),
    index("planning_string_ws_inverter_idx").on(t.workspaceId, t.inverterId),
    check(
      "planning_string_label_ck",
      sql`char_length(${t.label}) > 0`,
    ),
    check(
      "planning_string_slot_ck",
      sql`${t.trackerSlot} >= 1`,
    ),
    // Nur Form (Array + Länge); Element-Form (group_id je Eintrag)
    // prüft die immutable Kapsel planning_string_members_valid
    // (0271-Muster, Hand-SQL: CHECKs dulden keine Subqueries).
    check(
      "planning_string_member_ck",
      sql`jsonb_typeof(${t.memberJson}) = 'array'
        AND jsonb_array_length(${t.memberJson}) >= 1
        AND jsonb_array_length(${t.memberJson}) <= 200`,
    ),
    check("planning_string_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "planning_string_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.inverterId],
      foreignColumns: [planningInverter.workspaceId, planningInverter.id],
      name: "planning_string_inverter_fk",
    }).onDelete("restrict"),
  ],
);
