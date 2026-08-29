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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { workspace } from "./core";

export const kanbanBoardScopes = ["residential", "commercial"] as const;
export const kanbanColumnTypes = ["lead", "offer", "won", "lost"] as const;
export const kanbanColumnColors = ["neutral", "blue", "amber", "green"] as const;

export const kanbanBoard = pgTable(
  "kanban_board",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    scope: text("scope").$type<(typeof kanbanBoardScopes)[number]>().notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("kanban_board_ws_scope_idx").on(t.workspaceId, t.scope),
    unique("kanban_board_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("kanban_board_ws_scope_default_uq")
      .on(t.workspaceId, t.scope)
      .where(sql`${t.isDefault} = true and ${t.archivedAt} is null`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "kanban_board_workspace_id_fk",
    }),
    check("kanban_board_name_ck", sql`length(btrim(${t.name})) between 1 and 120`),
    check("kanban_board_scope_ck", sql`${t.scope} in ('residential', 'commercial')`),
    check(
      "kanban_board_default_active_ck",
      sql`${t.isDefault} = false or ${t.archivedAt} is null`,
    ),
  ],
);

export const kanbanColumn = pgTable(
  "kanban_column",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    boardId: uuid("board_id").notNull(),
    name: text("name").notNull(),
    columnType: text("column_type")
      .$type<(typeof kanbanColumnTypes)[number]>()
      .notNull(),
    position: integer("position").notNull(),
    color: text("color")
      .$type<(typeof kanbanColumnColors)[number]>()
      .notNull()
      .default("neutral"),
    isIntake: boolean("is_intake").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("kanban_column_ws_board_idx").on(t.workspaceId, t.boardId),
    unique("kanban_column_ws_id_uq").on(t.workspaceId, t.id),
    unique("kanban_column_ws_board_id_uq").on(t.workspaceId, t.boardId, t.id),
    uniqueIndex("kanban_column_ws_board_position_active_uq")
      .on(t.workspaceId, t.boardId, t.position)
      .where(sql`${t.archivedAt} is null`),
    uniqueIndex("kanban_column_ws_board_intake_active_uq")
      .on(t.workspaceId, t.boardId)
      .where(sql`${t.isIntake} = true and ${t.archivedAt} is null`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "kanban_column_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.boardId],
      foreignColumns: [kanbanBoard.workspaceId, kanbanBoard.id],
      name: "kanban_column_board_fk",
    }),
    check("kanban_column_name_ck", sql`length(btrim(${t.name})) between 1 and 120`),
    check(
      "kanban_column_type_ck",
      sql`${t.columnType} in ('lead', 'offer', 'won', 'lost')`,
    ),
    check("kanban_column_position_ck", sql`${t.position} > 0`),
    check(
      "kanban_column_color_ck",
      sql`${t.color} in ('neutral', 'blue', 'amber', 'green')`,
    ),
    check(
      "kanban_column_intake_lead_ck",
      sql`${t.isIntake} = false or ${t.columnType} = 'lead'`,
    ),
  ],
);
