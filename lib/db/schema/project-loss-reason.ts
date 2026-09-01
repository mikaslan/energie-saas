import { sql } from "drizzle-orm";
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
import { workspace } from "./core";

export const projectLossReason = pgTable(
  "project_loss_reason",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    label: text("label").notNull(),
    position: integer("position").notNull(),
    revision: integer("revision").notNull().default(1),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("project_loss_reason_ws_id_uq").on(t.workspaceId, t.id),
    unique("project_loss_reason_ws_position_uq").on(t.workspaceId, t.position),
    uniqueIndex("project_loss_reason_ws_label_ci_uq")
      .on(t.workspaceId, sql`lower(btrim(${t.label}))`),
    index("project_loss_reason_ws_active_position_idx")
      .on(t.workspaceId, t.position, t.id)
      .where(sql`${t.archivedAt} is null`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "project_loss_reason_workspace_id_fk",
    }),
    check(
      "project_loss_reason_label_ck",
      sql`length(btrim(${t.label})) between 1 and 80
          and ${t.label} = normalize(${t.label}, NFKC)
          and ${t.label} !~ '[[:cntrl:]]'
          and ${t.label} !~ '(^[[:space:]])|([[:space:]]$)'`,
    ),
    check(
      "project_loss_reason_position_ck",
      sql`${t.position} between 1 and 2147483647`,
    ),
    check(
      "project_loss_reason_revision_ck",
      sql`${t.revision} between 1 and 2147483647`,
    ),
    check(
      "project_loss_reason_timestamps_ck",
      sql`${t.updatedAt} >= ${t.createdAt}
          and (${t.archivedAt} is null or ${t.archivedAt} >= ${t.createdAt})`,
    ),
  ],
);
