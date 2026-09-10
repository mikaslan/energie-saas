import {
  check,
  date,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { workspace } from "./core";
import { timeEntry } from "./time-tracking";

// F9-07 Abrechnungslauf: freigegebene Zeiteinträge je Zeitraum übernehmen,
// Lauf schließen (Snapshot-Summen). Kein Delete (Revisionssicherheit).
// Keine neuen Permissions: time.read/time.write im Service-Layer.
export const billingRun = pgTable(
  "billing_run",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    label: text("label").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    status: text("status").$type<"open" | "closed">().notNull().default("open"),
    totalMinutes: integer("total_minutes").notNull().default(0),
    entryCount: integer("entry_count").notNull().default(0),
    createdBy: uuid("created_by").notNull(),
    closedBy: uuid("closed_by"),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("billing_run_ws_id_uq").on(t.workspaceId, t.id),
    index("billing_run_ws_status_idx").on(t.workspaceId, t.status, t.periodStart),
    check("billing_run_label_ck", sql`pg_catalog.length(pg_catalog.btrim(${t.label})) between 1 and 120 and ${t.label} !~ '[[:cntrl:]]'`),
    check("billing_run_period_ck", sql`${t.periodStart} <= ${t.periodEnd} and (${t.periodEnd} - ${t.periodStart}) <= 366`),
    check("billing_run_status_ck", sql`${t.status} in ('open', 'closed')`),
    check("billing_run_totals_ck", sql`${t.totalMinutes} >= 0 and ${t.entryCount} >= 0`),
    check("billing_run_closed_ck", sql`(${t.status} = 'open' and ${t.closedAt} is null and ${t.closedBy} is null) or (${t.status} = 'closed' and ${t.closedAt} is not null and ${t.closedBy} is not null)`),
    check("billing_run_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt}) and (${t.closedAt} is null or pg_catalog.isfinite(${t.closedAt}))`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "billing_run_workspace_id_fk",
    }),
  ],
);

export const billingRunEntry = pgTable(
  "billing_run_entry",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id").notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    timeEntryId: uuid("time_entry_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("billing_run_entry_ws_id_uq").on(t.workspaceId, t.id),
    // Ein Eintrag wird höchstens einmal abgerechnet (Doppelabrechnung fail-closed).
    unique("billing_run_entry_ws_entry_uq").on(t.workspaceId, t.timeEntryId),
    index("billing_run_entry_ws_run_idx").on(t.workspaceId, t.runId),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "billing_run_entry_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.runId],
      foreignColumns: [billingRun.workspaceId, billingRun.id],
      name: "billing_run_entry_run_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.timeEntryId],
      foreignColumns: [timeEntry.workspaceId, timeEntry.id],
      name: "billing_run_entry_entry_fk",
    }),
  ],
);
