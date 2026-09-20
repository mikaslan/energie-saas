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
import { project } from "./project";
import { site } from "./site";

// F3-02 Dachquellen-Registry (Katalog F3.2, Batch-1 providerfrei):
// Upload mit Referenzlinien-Skalierung + Selbstzeichnen je Projekt.
// Adapter-Werte (ortho/google_solar/earth_3d/building_ai/drone) sind
// RESERVED und werden vom DB-CHECK abgewiesen (Folge-Batch erweitert
// die Menge explizit). Storage-Bytes liegen WORM (immutableKey +
// putImmutable); die DB speichert nur Key/Pruefsumme/Groesse.
// Duplikat je (Projekt, sha256) ist idempotent (Partial-UQ).
export const planningSource = pgTable(
  "planning_source",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    siteId: uuid("site_id"),
    kind: text("kind").notNull(),
    storageKey: text("storage_key"),
    sha256: text("sha256"),
    byteSize: integer("byte_size"),
    scaleRefJson: jsonb("scale_ref_json"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("planning_source_ws_id_uq").on(t.workspaceId, t.id),
    index("planning_source_ws_project_idx").on(t.workspaceId, t.projectId, t.kind),
    uniqueIndex("planning_source_project_sha_uq").on(t.projectId, t.sha256),
    check(
      "planning_source_kind_ck",
      sql`${t.kind} in ('upload', 'self_drawn')`,
    ),
    check(
      "planning_source_upload_fields_ck",
      sql`(${t.kind} <> 'upload') OR (${t.storageKey} IS NOT NULL AND ${t.sha256} IS NOT NULL AND ${t.byteSize} IS NOT NULL)`,
    ),
    check(
      "planning_source_self_drawn_fields_ck",
      sql`(${t.kind} <> 'self_drawn') OR (${t.storageKey} IS NULL AND ${t.sha256} IS NULL AND ${t.byteSize} IS NULL AND ${t.scaleRefJson} IS NULL)`,
    ),
    check(
      "planning_source_scale_ref_ck",
      sql`${t.scaleRefJson} IS NULL OR (jsonb_typeof(${t.scaleRefJson}) = 'object' AND (${t.scaleRefJson}->>'meters')::double precision > 0 AND (${t.scaleRefJson}->>'pixelLength')::double precision > 0)`,
    ),
    check("planning_source_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "planning_source_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "planning_source_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.siteId],
      foreignColumns: [site.workspaceId, site.id],
      name: "planning_source_site_fk",
    }),
  ],
);
