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
import { planningRequest } from "./planning-request";
import { project } from "./project";

// F13-14 Planungsservice-Revision (Katalog F13.3, Spec §2): einzeln per
// Click-Signatur gezeichnete Revisionsnotizen je Planungsanfrage (eigene
// Tabelle + eigener Service, KEIN Provisorium in planning_request).
// Unveraenderlich wie subsidy_case_message: nur Anlage + Lesen; die
// Signatur setzt signed_at einmalig NULL → Zeit (Service-Gate), danach
// kein Update/Delete.
export const planningRequestRevision = pgTable(
  "planning_request_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    planningRequestId: uuid("planning_request_id").notNull(),
    note: text("note").notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    signedAt: timestamp("signed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("planning_request_revision_ws_id_uq").on(t.workspaceId, t.id),
    index("planning_request_revision_ws_request_idx").on(
      t.workspaceId,
      t.planningRequestId,
      t.createdAt,
      t.id,
    ),
    check(
      "planning_request_revision_note_ck",
      sql`${t.note} = pg_catalog.btrim(${t.note}) and pg_catalog.length(${t.note}) between 1 and 2000 and ${t.note} !~ '[[:cntrl:]]'`,
    ),
    check(
      "planning_request_revision_signed_ck",
      sql`${t.signedAt} is null or (${t.signedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.signedAt}))`,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "planning_request_revision_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "planning_request_revision_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.planningRequestId],
      foreignColumns: [planningRequest.workspaceId, planningRequest.id],
      name: "planning_request_revision_request_fk",
    }),
  ],
);
