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
  SchematicEdge,
  SchematicNode,
} from "@/lib/integrations/schematic/single-line-v1";
import { workspace } from "./core";
import { offer } from "./offers";

// F6-01: Persistierte Einlinien-Schaltbilder je Angebotsvariante
// ( offeringssichtbarer Snapshot, keine Editierung). Genau eine Zeile je
// (Workspace, Angebot, Varianten-Revision); Neuauslegung schreibt per
// UPDATE (revision-Bump, Muster offer_bom_line). netlist ist der kanonische
// Builder-Stand (JCS-Seal-kompatibel: nur nodes/edges, keine Metadaten).
export type SchematicNetlistV1 = {
  nodes: SchematicNode[];
  edges: SchematicEdge[];
};

export const schematicDiagrams = pgTable(
  "schematic_diagrams",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    variantRevision: integer("variant_revision").notNull(),
    netlist: jsonb("netlist").$type<SchematicNetlistV1>().notNull(),
    nodeCount: integer("node_count"),
    edgeCount: integer("edge_count"),
    builderVersion: text("builder_version").notNull().default("single-line-v1"),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("schematic_diagrams_ws_id_uq").on(t.workspaceId, t.id),
    unique("schematic_diagrams_ws_offer_revision_uq").on(
      t.workspaceId,
      t.offerId,
      t.variantRevision,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "schematic_diagrams_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offer.workspaceId, offer.id],
      name: "schematic_diagrams_offer_fk",
    }),
    check("schematic_diagrams_revision_ck", sql`${t.revision} >= 1`),
    check(
      "schematic_diagrams_counts_ck",
      sql`${t.nodeCount} >= 0 and ${t.edgeCount} >= 0`,
    ),
    check(
      "schematic_diagrams_netlist_ck",
      sql`pg_catalog.jsonb_typeof(${t.netlist}) = 'object' and pg_catalog.jsonb_typeof(${t.netlist}->'nodes') = 'array' and pg_catalog.jsonb_typeof(${t.netlist}->'edges') = 'array'`,
    ),
  ],
);
