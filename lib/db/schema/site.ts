import { pgTable, uuid, text, doublePrecision, boolean, timestamp, index, uniqueIndex, foreignKey } from "drizzle-orm/pg-core";
import { workspace } from "./core";

// Site (Standort) — schmale Referenz-Entität für M0. Contact-FK kommt in M1
// (Contact-Tabelle existiert dort noch nicht) als additive Spalte nach.
//
// Tenant-sichere Verknüpfbarkeit (Codex-Review #7): site hatte weder einen
// Workspace-FK noch einen tenantgebundenen Schlüssel. Ein späteres Modul mit
// einem einfachen site_id-FK hätte damit aus Workspace A auf eine Site aus B
// zeigen können — FK-Prüfungen verwenden RLS NICHT als Sichtbarkeitsfilter.
// Deshalb: FK auf workspace UND UNIQUE (workspace_id, id) als Ziel für
// künftige ZUSAMMENGESETZTE FKs. Das Muster ist in modules/README.md
// festgeschrieben und gilt für jede weitere Tenant-Entität.
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
}, (t) => [
  index("site_ws_idx").on(t.workspaceId),
  uniqueIndex("site_ws_id_uq").on(t.workspaceId, t.id),
  foreignKey({ columns: [t.workspaceId], foreignColumns: [workspace.id], name: "site_workspace_id_fk" }),
]);
