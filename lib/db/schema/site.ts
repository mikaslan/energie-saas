import { pgTable, uuid, text, doublePrecision, boolean, timestamp, index } from "drizzle-orm/pg-core";

// Site (Standort) — schmale Referenz-Entität für M0. Contact-FK kommt in M1
// (Contact-Tabelle existiert dort noch nicht) als additive Spalte nach.
export const site = pgTable("site", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  label: text("label"),
  street: text("street"),
  houseNumber: text("house_number"),
  postalCode: text("postal_code"),
  city: text("city"),
  country: text("country").notNull().default("DE"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  pinConfirmed: boolean("pin_confirmed").notNull().default(false), // Blaupause F1.3: Pin zählt fürs Planen
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("site_ws_idx").on(t.workspaceId)]);
