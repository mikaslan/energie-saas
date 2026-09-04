import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace, userIdentity } from "./core";
import { project } from "./project";

export const timeEventType = pgTable(
  "time_event_type",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    position: integer("position").notNull().default(0),
    textColor: text("text_color"),
    backgroundColor: text("background_color"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("time_event_type_ws_idx").on(t.workspaceId, t.archivedAt),
    unique("time_event_type_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("time_event_type_ws_active_name_uq")
      .on(t.workspaceId, t.nameNormalized)
      .where(sql`${t.archivedAt} is null`),
    check("time_event_type_name_ck", sql`${t.name} ~ '^[^[:space:]].*$' and pg_catalog.length(${t.name}) <= 120`),
    check("time_event_type_name_normalized_ck", sql`${t.nameNormalized} = pg_catalog.lower(pg_catalog.btrim(${t.nameNormalized}))`),
    check("time_event_type_position_ck", sql`${t.position} >= 0`),
    check("time_event_type_colors_ck", sql`(${t.textColor} is null or ${t.textColor} ~ '^#[0-9A-Fa-f]{6}$') and (${t.backgroundColor} is null or ${t.backgroundColor} ~ '^#[0-9A-Fa-f]{6}$')`),
    check("time_event_type_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "time_event_type_workspace_id_fk",
    }),
  ],
);

export const timeEntry = pgTable(
  "time_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    userId: uuid("user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    typeId: uuid("type_id"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    // F9.2: laufende Einträge haben end_at = NULL + Minuten = NULL.
    endAt: timestamp("end_at", { withTimezone: true }),
    workingTimeMinutes: integer("working_time_minutes"),
    breakDurationMinutes: integer("break_duration_minutes").notNull().default(0),
    comment: text("comment"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("time_entry_ws_project_idx").on(t.workspaceId, t.projectId, t.startAt),
    unique("time_entry_ws_id_uq").on(t.workspaceId, t.id),
    check("time_entry_running_ck", sql`(${t.endAt} is null and ${t.workingTimeMinutes} is null) or (${t.endAt} is not null and ${t.workingTimeMinutes} is not null)`),
    check("time_entry_interval_ck", sql`(${t.endAt} is null or ${t.endAt} >= ${t.startAt}) and pg_catalog.isfinite(${t.startAt}) and (${t.endAt} is null or pg_catalog.isfinite(${t.endAt}))`),
    check("time_entry_minutes_ck", sql`${t.workingTimeMinutes} is null or ${t.workingTimeMinutes} between 0 and 1440`),
    check("time_entry_break_ck", sql`${t.breakDurationMinutes} between 0 and 1440 and (${t.workingTimeMinutes} is null or ${t.breakDurationMinutes} <= ${t.workingTimeMinutes})`),
    // F9.2: höchstens EIN laufender Eintrag je Nutzer je Workspace.
    uniqueIndex("time_entry_ws_user_running_uq")
      .on(t.workspaceId, t.userId)
      .where(sql`${t.endAt} is null`),
    check("time_entry_comment_ck", sql`${t.comment} is null or (
      pg_catalog.length(${t.comment}) between 1 and 500
      and ${t.comment} = pg_catalog.btrim(${t.comment})
      and ${t.comment} !~ '[[:cntrl:]]'
    )`),
    check("time_entry_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "time_entry_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.userId],
      foreignColumns: [userIdentity.id],
      name: "time_entry_user_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "time_entry_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.typeId],
      foreignColumns: [timeEventType.workspaceId, timeEventType.id],
      name: "time_entry_type_fk",
    }),
  ],
);

// F9.4 Slice B: unveränderliche Vorher-Bilder je Edit (Muster
// offer_variant_revision). Nur created_at, kein updated_at, kein
// Update-/Delete-Pfad — geschrieben wird ausschließlich vom Service
// beim Update, in derselben Transaktion.
export const timeEntryRevision = pgTable(
  "time_entry_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    entryId: uuid("entry_id").notNull(),
    userId: uuid("user_id").notNull(),
    projectId: uuid("project_id").notNull(),
    typeId: uuid("type_id"),
    startAt: timestamp("start_at", { withTimezone: true }).notNull(),
    endAt: timestamp("end_at", { withTimezone: true }),
    workingTimeMinutes: integer("working_time_minutes"),
    breakDurationMinutes: integer("break_duration_minutes").notNull().default(0),
    comment: text("comment"),
    revisedBy: uuid("revised_by").notNull(),
    revisedAt: timestamp("revised_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("time_entry_revision_ws_entry_idx").on(t.workspaceId, t.entryId, t.revisedAt),
    unique("time_entry_revision_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "time_entry_revision_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.entryId],
      foreignColumns: [timeEntry.workspaceId, timeEntry.id],
      name: "time_entry_revision_entry_fk",
    }),
  ],
);
