import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { membership, workspace } from "./core";
import { project } from "./project";

// F13-02 Netzanmeldung: EIN Datensatz je Projekt (v1-Grenze, keine
// Durchlauf-Historie). Maschine: vorbereitung → eingereicht →
// genehmigt → fertiggemeldet → abgeschlossen; storniert aus jedem
// nicht-abgeschlossenen Zustand, terminal. Zeiten setzt der Service
// je Übergang (submitted/decided/completed), nie per Hand.
export const gridRegistration = pgTable(
  "grid_registration",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    status: text("status").notNull().default("vorbereitung"),
    operatorName: text("operator_name"),
    meterNumber: text("meter_number"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("grid_registration_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("grid_registration_ws_project_uq").on(t.workspaceId, t.projectId),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "grid_registration_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "grid_registration_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "grid_registration_created_by_fk",
    }),
    check(
      "grid_registration_status_ck",
      sql`${t.status} in (
        'vorbereitung', 'eingereicht', 'genehmigt',
        'fertiggemeldet', 'abgeschlossen', 'storniert'
      )`,
    ),
    check(
      "grid_registration_operator_ck",
      sql`${t.operatorName} is null or pg_catalog.length(pg_catalog.btrim(${t.operatorName})) between 1 and 160`,
    ),
    check(
      "grid_registration_meter_ck",
      sql`${t.meterNumber} is null or pg_catalog.length(pg_catalog.btrim(${t.meterNumber})) between 1 and 64`,
    ),
    index("grid_registration_ws_project_idx").on(t.workspaceId, t.projectId, t.status),
  ],
);
