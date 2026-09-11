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

// F13-03 Förderservice-Akte (KfW/BAFA, Katalog F13.2 Slice 1): EIN
// Datensatz je Projekt (v1-Grenze). Maschine: vorbereitung →
// bza_eingereicht → bza_bewilligt → bnd_eingereicht → abgeschlossen;
// korrektur aus bza/bnd_eingereicht mit Wiedereinstieg je Phase;
// storniert terminal. Programm-Wortschatz (kfw/bafa/sonstige) und
// BzA-Nummer sind ESTIMATE-Näherungen ohne Live-Beleg.
export const subsidyCase = pgTable(
  "subsidy_case",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    status: text("status").notNull().default("vorbereitung"),
    program: text("program"),
    bzaNumber: text("bza_number"),
    bzaSubmittedAt: timestamp("bza_submitted_at", { withTimezone: true }),
    bzaApprovedAt: timestamp("bza_approved_at", { withTimezone: true }),
    bndSubmittedAt: timestamp("bnd_submitted_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("subsidy_case_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("subsidy_case_ws_project_uq").on(t.workspaceId, t.projectId),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "subsidy_case_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "subsidy_case_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "subsidy_case_created_by_fk",
    }),
    check(
      "subsidy_case_status_ck",
      sql`${t.status} in (
        'vorbereitung', 'bza_eingereicht', 'korrektur', 'bza_bewilligt',
        'bnd_eingereicht', 'abgeschlossen', 'storniert'
      )`,
    ),
    check(
      "subsidy_case_program_ck",
      sql`${t.program} is null or ${t.program} in (
        'kfw', 'bafa', 'sonstige'
      )`,
    ),
    check(
      "subsidy_case_bza_number_ck",
      sql`${t.bzaNumber} is null or pg_catalog.length(pg_catalog.btrim(${t.bzaNumber})) between 1 and 64`,
    ),
    index("subsidy_case_ws_project_idx").on(t.workspaceId, t.projectId, t.status),
  ],
);
