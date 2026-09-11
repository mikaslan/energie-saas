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
import { workspace } from "./core";
import { project } from "./project";

// F13-01 Serviceauftrag: Filing-Objekt je Projekt mit kleiner
// Statusmaschine (open → in_progress → done, cancelled aus open/
// in_progress; done/cancelled terminal). Reopen nur via neuen Vorgang.
export const serviceCase = pgTable(
  "service_case",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").notNull().default("open"),
    dueDate: text("due_date"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("service_case_ws_id_uq").on(t.workspaceId, t.id),
    index("service_case_ws_project_idx").on(t.workspaceId, t.projectId, t.status),
    check("service_case_status_ck", sql`${t.status} in ('open', 'in_progress', 'done', 'cancelled')`),
    check(
      "service_case_title_ck",
      sql`pg_catalog.length(pg_catalog.btrim(${t.title})) between 1 and 160`,
    ),
    check(
      "service_case_description_ck",
      sql`${t.description} is null or (pg_catalog.length(${t.description}) between 1 and 2000 and ${t.description} = pg_catalog.btrim(${t.description}))`,
    ),
    check(
      "service_case_completed_ck",
      sql`(${t.status} = 'done' and ${t.completedAt} is not null) or (${t.status} <> 'done' and ${t.completedAt} is null)`,
    ),
    check(
      "service_case_confirmed_ck",
      sql`${t.confirmedAt} is null or ${t.status} = 'done'`,
    ),
    check("service_case_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "service_case_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "service_case_project_fk",
    }),
  ],
);
