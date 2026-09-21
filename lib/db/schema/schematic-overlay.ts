import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  OverlayElementInput,
} from "@/lib/integrations/schematic/editor-overlay-v1";
import { workspace } from "./core";
import { offer } from "./offers";

// F6-02a: Frei platzierbare Editor-Ergänzungen je Angebotsvariante
// (Backbone-unantastbar, Overlay hängt an parent_revision der
// schematic_diagrams-Zeile). Genau eine Zeile je (Workspace, Angebot,
// Varianten-Revision); Schreiben nur per CAS (expectedRevision).
export type SchematicOverlayV1 = {
  elements: OverlayElementInput[];
};

export const schematicOverlays = pgTable(
  "schematic_overlays",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    variantRevision: integer("variant_revision").notNull(),
    parentRevision: integer("parent_revision").notNull(),
    elements: jsonb("elements").$type<SchematicOverlayV1>().notNull(),
    elementCount: integer("element_count"),
    editorVersion: text("editor_version").notNull().default("editor-overlay.v1"),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("schematic_overlays_ws_id_uq").on(t.workspaceId, t.id),
    unique("schematic_overlays_ws_offer_revision_uq").on(
      t.workspaceId,
      t.offerId,
      t.variantRevision,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "schematic_overlays_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offer.workspaceId, offer.id],
      name: "schematic_overlays_offer_fk",
    }),
    check("schematic_overlays_revision_ck", sql`${t.revision} >= 1`),
    check(
      "schematic_overlays_parent_revision_ck",
      sql`${t.parentRevision} >= 1`,
    ),
    check(
      "schematic_overlays_counts_ck",
      sql`${t.elementCount} >= 0`,
    ),
    check(
      "schematic_overlays_elements_ck",
      sql`pg_catalog.jsonb_typeof(${t.elements}) = 'object' and (${t.elements} ? 'elements') and pg_catalog.jsonb_typeof(${t.elements}->'elements') = 'array'`,
    ),
  ],
);
