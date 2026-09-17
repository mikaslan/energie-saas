import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { membership, workspace } from "./core";
import { project } from "./project";

// F7-16 Projekt-Dateien: interne Dateiablage je Projekt (PDF/JPEG/PNG,
// 25 MiB, WORM unter immutable/<projekt>/project-files/). Zeilen sind
// immutabel (kein updated_at — file_request_upload-Muster); einziger
// UPDATE-Pfad seit F10-17: visible_to_customer (nur diese Spalte;
// Bytes/Key bleiben immutabel). Liste newest-first. Rechte im
// Service-Layer (keine neue Permission, keine Grants — Rollenvertrag
// wie 0104).
export const projectFile = pgTable(
  "project_file",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    storageKey: text("storage_key").notNull(),
    fileSha256: text("file_sha256").notNull(),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    originalFilename: text("original_filename").notNull(),
    // F10-17: Kunden-Sichtbarkeit je Datei (DEFAULT false = sicherer
    // Default: nichts wird versehentlich sichtbar).
    visibleToCustomer: boolean("visible_to_customer").notNull().default(false),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("project_file_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_file_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "project_file_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "project_file_created_by_fk",
    }),
    check(
      "project_file_name_ck",
      sql`char_length(btrim(${t.originalFilename})) between 1 and 180`,
    ),
    check(
      "project_file_content_type_ck",
      sql`${t.contentType} in ('application/pdf', 'image/jpeg', 'image/png')`,
    ),
    check(
      "project_file_byte_size_ck",
      sql`${t.byteSize} between 1 and 26214400`,
    ),
    check(
      "project_file_sha256_ck",
      sql`${t.fileSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "project_file_storage_key_ck",
      sql`char_length(${t.storageKey}) <= 512 and ${t.storageKey} ~ '^immutable/[0-9a-f-]{36}/project-files/[0-9a-f-]{36}_[0-9a-f]{8}\\.(pdf|jpg|jpeg|png)$'`,
    ),
    index("project_file_ws_project_idx").on(
      t.workspaceId,
      t.projectId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
  ],
);
