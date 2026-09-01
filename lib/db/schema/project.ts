import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { contact } from "./crm";
import { kanbanBoard, kanbanColumn } from "./boards";
import { workspace } from "./core";
import { site } from "./site";
import { projectLossReason } from "./project-loss-reason";

export const projectPhases = ["request", "offer", "installation"] as const;
export const projectOutcomes = ["open", "won", "lost", "cannot_fulfill"] as const;

export const project = pgTable(
  "project",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    siteId: uuid("site_id").notNull(),
    kanbanBoardId: uuid("kanban_board_id").notNull(),
    kanbanColumnId: uuid("kanban_column_id").notNull(),
    name: text("name").notNull(),
    phase: text("phase").$type<(typeof projectPhases)[number]>().notNull().default("request"),
    outcome: text("outcome").$type<(typeof projectOutcomes)[number]>().notNull().default("open"),
    sourceKey: text("source_key").notNull(),
    dedupeReviewRequired: boolean("dedupe_review_required").notNull().default(false),
    catalogResolutionStatus: text("catalog_resolution_status").notNull().default("pending"),
    assignmentRevision: integer("assignment_revision").notNull().default(0),
    outcomeRevision: integer("outcome_revision").notNull().default(0),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    lossReasonId: uuid("loss_reason_id"),
    lossReasonText: text("loss_reason_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("project_ws_contact_idx").on(t.workspaceId, t.contactId),
    index("project_ws_site_idx").on(t.workspaceId, t.siteId),
    index("project_ws_kanban_created_idx").on(
      t.workspaceId,
      t.kanbanColumnId,
      t.createdAt,
      t.id,
    ),
    index("project_ws_request_closed_idx")
      .on(t.workspaceId, t.closedAt.desc().nullsLast(), t.id.desc().nullsLast())
      .where(sql`${t.phase} = 'request' and ${t.outcome} in ('won', 'lost')`),
    unique("project_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_ws_id_site_uq").on(t.workspaceId, t.id, t.siteId),
    unique("project_ws_id_contact_site_uq").on(
      t.workspaceId,
      t.id,
      t.contactId,
      t.siteId,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.contactId],
      foreignColumns: [contact.workspaceId, contact.id],
      name: "project_contact_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.contactId, t.siteId],
      foreignColumns: [site.workspaceId, site.contactId, site.id],
      name: "project_site_contact_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.kanbanBoardId],
      foreignColumns: [kanbanBoard.workspaceId, kanbanBoard.id],
      name: "project_kanban_board_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.kanbanBoardId, t.kanbanColumnId],
      foreignColumns: [
        kanbanColumn.workspaceId,
        kanbanColumn.boardId,
        kanbanColumn.id,
      ],
      name: "project_kanban_column_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.lossReasonId],
      foreignColumns: [projectLossReason.workspaceId, projectLossReason.id],
      name: "project_loss_reason_fk",
    }),
    check("project_name_ck", sql`length(btrim(${t.name})) between 1 and 200`),
    check("project_phase_ck", sql`${t.phase} in ('request', 'offer', 'installation')`),
    check("project_outcome_ck", sql`${t.outcome} in ('open', 'won', 'lost', 'cannot_fulfill')`),
    check("project_source_key_ck", sql`length(btrim(${t.sourceKey})) between 1 and 80`),
    check(
      "project_catalog_resolution_ck",
      sql`${t.catalogResolutionStatus} in ('pending', 'resolved')`,
    ),
    check("project_assignment_revision_ck", sql`${t.assignmentRevision} >= 0`),
    check(
      "project_outcome_revision_ck",
      sql`${t.outcomeRevision} between 0 and 2147483647`,
    ),
    check(
      "project_closed_at_ck",
      sql`${t.closedAt} is null or isfinite(${t.closedAt})`,
    ),
    check(
      "project_loss_reason_text_ck",
      sql`${t.lossReasonText} is null or (
        length(${t.lossReasonText}) between 1 and 500
        and ${t.lossReasonText} = btrim(${t.lossReasonText})
        and ${t.lossReasonText} = normalize(${t.lossReasonText}, NFKC)
        and ${t.lossReasonText} !~ '[[:cntrl:]]'
      )`,
    ),
    check(
      "project_outcome_state_ck",
      sql`(
        ${t.outcome} = 'open'
        and ${t.closedAt} is null
        and ${t.lossReasonId} is null
        and ${t.lossReasonText} is null
      ) or (
        ${t.outcome} = 'won'
        and ${t.closedAt} is not null
        and ${t.lossReasonId} is null
        and ${t.lossReasonText} is null
      ) or (
        ${t.outcome} = 'lost'
        and ${t.closedAt} is not null
        and ${t.lossReasonId} is not null
      ) or (
        ${t.outcome} = 'cannot_fulfill'
        and ${t.closedAt} is not null
        and ${t.lossReasonId} is null
        and ${t.lossReasonText} is null
      )`,
    ),
  ],
);
