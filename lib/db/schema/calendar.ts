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
import { membership } from "./core";
import { calendarCategory } from "./appointment";

// M1-15b Kalender-Scopes (Spec §4.1): API-treues calendar-Objekt mit den
// 4 Scopes team/tenancy/user/client; client = Nichtziel, strukturell erlaubt.
// team_id bleibt bis zum Team-Slice nullable und OHNE FK (Spec §4.1).
export const calendar = pgTable(
  "calendar",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    color: text("color"),
    categoryId: uuid("category_id"),
    calendarType: text("calendar_type").notNull(),
    membershipId: uuid("membership_id"),
    teamId: uuid("team_id"),
    active: boolean("active").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("calendar_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("calendar_ws_name_uq").on(t.workspaceId, sql`lower(btrim(${t.name}))`),
    // 1:1-Idempotenz der Auto-Provisionierung persönlicher Kalender.
    uniqueIndex("calendar_ws_membership_user_uniq")
      .on(t.workspaceId, t.membershipId)
      .where(sql`${t.calendarType} = 'user'`),
    index("calendar_ws_type_active_idx").on(
      t.workspaceId,
      t.calendarType,
      t.active,
      t.name,
      t.id,
    ),
    index("calendar_ws_membership_idx").on(t.workspaceId, t.membershipId),
    index("calendar_ws_team_idx").on(t.workspaceId, t.teamId),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "calendar_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.categoryId],
      foreignColumns: [calendarCategory.workspaceId, calendarCategory.id],
      name: "calendar_category_fk",
    }).onDelete("set null"),
    foreignKey({
      columns: [t.workspaceId, t.membershipId],
      foreignColumns: [membership.workspaceId, membership.id],
      name: "calendar_membership_fk",
    }).onDelete("restrict"),
    check(
      "calendar_type_ck",
      sql`${t.calendarType} in ('team', 'tenancy', 'user', 'client')`,
    ),
    check(
      "calendar_name_ck",
      sql`length(btrim(${t.name})) between 1 and 200
        and ${t.name} = normalize(${t.name}, NFKC)
        and ${t.name} !~ '[[:cntrl:]]'`,
    ),
    check(
      "calendar_color_ck",
      sql`${t.color} is null or ${t.color} ~ '^#[0-9a-fA-F]{6}$'`,
    ),
    // Scope-Invarianten (Spec §4.1, DECIDED).
    check(
      "calendar_scope_user_ck",
      sql`${t.calendarType} <> 'user'
        or (${t.membershipId} is not null and ${t.teamId} is null)`,
    ),
    check(
      "calendar_scope_team_ck",
      sql`${t.calendarType} <> 'team'
        or (${t.teamId} is not null and ${t.membershipId} is null)`,
    ),
    check(
      "calendar_scope_tenancy_ck",
      sql`${t.calendarType} <> 'tenancy'
        or (${t.membershipId} is null and ${t.teamId} is null)`,
    ),
    check(
      "calendar_scope_client_ck",
      sql`${t.calendarType} <> 'client'
        or (${t.membershipId} is null and ${t.teamId} is null)`,
    ),
    check(
      "calendar_revision_ck",
      sql`${t.revision} between 1 and 2147483647`,
    ),
    check(
      "calendar_timestamps_ck",
      sql`${t.updatedAt} >= ${t.createdAt}
        and isfinite(${t.createdAt})
        and isfinite(${t.updatedAt})`,
    ),
  ],
);
