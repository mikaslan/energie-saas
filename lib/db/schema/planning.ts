import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import {
  PLANNING_MODE_DEFAULT,
  type PlanningMode,
} from "@/lib/integrations/planning/contract";
import { membership, workspace } from "./core";

export const workspacePlanningSettings = pgTable(
  "workspace_planning_settings",
  {
    workspaceId: uuid("workspace_id").primaryKey(),
    defaultPlanningMode: text("default_planning_mode")
      .$type<PlanningMode>()
      .notNull()
      .default(PLANNING_MODE_DEFAULT),
    revision: integer("revision").notNull().default(1),
    updatedBy: uuid("updated_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "workspace_planning_settings_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.updatedBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "workspace_planning_settings_updated_by_fk",
    }),
    check(
      "workspace_planning_settings_mode_ck",
      sql`${t.defaultPlanningMode} in ('quick', '2d', '3d')`,
    ),
    check(
      "workspace_planning_settings_revision_ck",
      sql`${t.revision} between 1 and 2147483647`,
    ),
    check(
      "workspace_planning_settings_timestamps_ck",
      sql`${t.updatedAt} >= ${t.createdAt}
        and isfinite(${t.createdAt})
        and isfinite(${t.updatedAt})`,
    ),
  ],
);
