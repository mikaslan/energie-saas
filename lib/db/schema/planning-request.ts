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
import { offer } from "./offers";
import { project } from "./project";

// F13-11 Planungsservice (Katalog F13.3): genau eine Anfrage je Angebot
// mit Fristwahl (24 h/48 h/Datum) und kleiner Statusmaschine
// (requested → in_progress → finished → accepted, terminal accepted).
// Revision ueber signierte Notizen, Preise und E-Mail-Uebergaenge sind
// eigene Folgethemen und nicht enthalten.
export const planningRequest = pgTable(
  "planning_request",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    offerId: uuid("offer_id").notNull(),
    deadlineKind: text("deadline_kind").notNull().default("standard_48h"),
    deadlineAt: timestamp("deadline_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("requested"),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("planning_request_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("planning_request_ws_offer_uq").on(t.workspaceId, t.offerId),
    index("planning_request_ws_project_idx").on(t.workspaceId, t.projectId, t.status),
    check(
      "planning_request_status_ck",
      sql`${t.status} in ('requested', 'in_progress', 'finished', 'accepted')`,
    ),
    check(
      "planning_request_deadline_kind_ck",
      sql`${t.deadlineKind} in ('express_24h', 'standard_48h', 'date')`,
    ),
    check(
      "planning_request_deadline_ck",
      sql`${t.deadlineAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.deadlineAt})`,
    ),
    check("planning_request_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "planning_request_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "planning_request_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offer.workspaceId, offer.id],
      name: "planning_request_offer_fk",
    }),
  ],
);
