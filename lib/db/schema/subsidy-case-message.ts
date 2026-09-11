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
import { subsidyCase } from "./subsidy-case";

// F13-10 Kundenchat zur Förderakte (Katalog F10.2 „KfW mit Chat“):
// Nachrichten je Projekt-Akte, beide Richtungen (internal ↔ customer).
// created_by ist NULL für Kundennachrichten (keine Identität); der
// Token-Pfad schreibt ausschließlich über die DEFINER-Kapsel
// post_subsidy_message (Muster confirm_service_case, F13-06).
export const subsidyCaseMessage = pgTable(
  "subsidy_case_message",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    subsidyCaseId: uuid("subsidy_case_id").notNull(),
    authorSide: text("author_side").notNull(),
    body: text("body").notNull(),
    createdBy: uuid("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("subsidy_case_message_ws_id_uq").on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "subsidy_case_message_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "subsidy_case_message_project_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.subsidyCaseId],
      foreignColumns: [subsidyCase.workspaceId, subsidyCase.id],
      name: "subsidy_case_message_case_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "subsidy_case_message_created_by_fk",
    }),
    check(
      "subsidy_case_message_side_ck",
      sql`${t.authorSide} in ('internal', 'customer')`,
    ),
    check(
      "subsidy_case_message_body_ck",
      sql`${t.body} = pg_catalog.btrim(${t.body}) and pg_catalog.length(${t.body}) between 1 and 2000 and ${t.body} !~ '[[:cntrl:]]'`,
    ),
    check(
      "subsidy_case_message_author_ck",
      sql`(${t.authorSide} = 'customer' and ${t.createdBy} is null) or (${t.authorSide} = 'internal' and ${t.createdBy} is not null)`,
    ),
    index("subsidy_case_message_ws_case_idx").on(t.workspaceId, t.subsidyCaseId, t.createdAt, t.id),
  ],
);
