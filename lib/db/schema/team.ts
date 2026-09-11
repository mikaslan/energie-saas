import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { membership, workspace } from "./core";

// F1-12 · Teams (Slice 1): benannte Monteurs-/Vertriebsteams mit
// Mitgliedern (Membership-Bindung, M1-09-Muster). Archiv statt Delete
// (F7.3/F16.3-Muster); Revision-CAS bei Umbenennen/Aktivieren.
export const team = pgTable(
  "team",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    name: text("name").notNull(),
    nameNormalized: text("name_normalized").notNull(),
    active: boolean("active").notNull().default(true),
    revision: integer("revision").notNull().default(1),
    createdBy: uuid("created_by").notNull(),
    updatedBy: uuid("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("team_ws_active_idx").on(t.workspaceId, t.active),
    uniqueIndex("team_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("team_ws_active_name_uq")
      .on(t.workspaceId, t.nameNormalized)
      .where(sql`${t.active}`),
    check("team_name_ck", sql`${t.name} ~ '^[^[:space:]].*$' and pg_catalog.length(${t.name}) <= 120 and ${t.name} !~ '[[:cntrl:]]'`),
    check("team_name_normalized_ck", sql`${t.nameNormalized} = pg_catalog.lower(pg_catalog.btrim(${t.nameNormalized}))`),
    check("team_revision_ck", sql`${t.revision} between 1 and 2147483647`),
    check("team_timestamps_ck", sql`${t.updatedAt} >= ${t.createdAt} and pg_catalog.isfinite(${t.createdAt}) and pg_catalog.isfinite(${t.updatedAt})`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "team_workspace_id_fk",
    }),
  ],
);

// F1-12 · Team-Mitglieder (Voll-Replace, Last-Writer-Wins; nur interne
// Memberships — external_only scheidet im Service aus, nie still).
export const teamMember = pgTable(
  "team_member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    teamId: uuid("team_id").notNull(),
    membershipId: uuid("membership_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("team_member_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("team_member_ws_team_membership_uq").on(t.workspaceId, t.teamId, t.membershipId),
    index("team_member_ws_membership_idx").on(t.workspaceId, t.membershipId),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "team_member_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.teamId],
      foreignColumns: [team.workspaceId, team.id],
      name: "team_member_team_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.membershipId],
      foreignColumns: [membership.workspaceId, membership.id],
      name: "team_member_membership_fk",
    }),
  ],
);
