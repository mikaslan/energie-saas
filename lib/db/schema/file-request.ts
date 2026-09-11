import {
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
import { subsidyCase } from "./subsidy-case";

// F10-04 Datei-Anfragen: interne Bitte um Kundendatei je Projekt
// (v1 ein Beleg je Anfrage, 10 MiB-Grenze als ESTIMATE). Maschine:
// offen → hochgeladen (Kunde via Token-DEFINER) → erledigt;
// storniert nur aus offen, terminal. Zeiten setzt der Service je
// Übergang (uploaded/completed), nie per Hand. Storage-Key und
// Prüfsumme sind rein intern (nie Portal-projiziert).
export const fileRequest = pgTable(
  "file_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    subsidyCaseId: uuid("subsidy_case_id"),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("offen"),
    storageKey: text("storage_key"),
    fileSha256: text("file_sha256"),
    contentType: text("content_type"),
    byteSize: integer("byte_size"),
    originalFilename: text("original_filename"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("file_request_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "file_request_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "file_request_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.subsidyCaseId],
      foreignColumns: [subsidyCase.workspaceId, subsidyCase.id],
      name: "file_request_subsidy_case_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "file_request_created_by_fk",
    }),
    check(
      "file_request_status_ck",
      sql`${t.status} in (
        'offen', 'hochgeladen', 'erledigt', 'storniert'
      )`,
    ),
    check(
      "file_request_title_ck",
      sql`pg_catalog.length(pg_catalog.btrim(${t.title})) between 1 and 160`,
    ),
    check(
      "file_request_description_ck",
      sql`${t.description} is null or pg_catalog.length(${t.description}) between 1 and 2000`,
    ),
    check(
      "file_request_receipt_ck",
      sql`case when ${t.status} in ('hochgeladen', 'erledigt')
        then ${t.storageKey} is not null
         and ${t.fileSha256} is not null
         and ${t.contentType} is not null
         and ${t.byteSize} is not null
         and ${t.originalFilename} is not null
         and ${t.uploadedAt} is not null
      else ${t.storageKey} is null
       and ${t.fileSha256} is null
       and ${t.contentType} is null
       and ${t.byteSize} is null
       and ${t.originalFilename} is null
       and ${t.uploadedAt} is null
      end`,
    ),
    check(
      "file_request_byte_size_ck",
      sql`${t.byteSize} is null or (${t.byteSize} between 1 and 10485760)`,
    ),
    index("file_request_ws_project_idx").on(t.workspaceId, t.projectId, t.status),
    index("file_request_ws_case_idx").on(t.workspaceId, t.subsidyCaseId),
  ],
);
