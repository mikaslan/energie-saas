import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { membership, workspace } from "./core";
import { project } from "./project";
import { bytea } from "./types";

export type PortalInviteStatus = "active" | "withdrawn" | "expired";

export type PortalWithdrawReason =
  | "user_request"
  | "superseded"
  | "project_closed"
  | "other";

export const portalInvite = pgTable(
  "portal_invite",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    status: text("status").$type<PortalInviteStatus>().notNull().default("active"),
    tokenHash: bytea("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdBy: uuid("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
    withdrawnBy: uuid("withdrawn_by"),
    withdrawReason: text("withdraw_reason").$type<PortalWithdrawReason>(),
  },
  (t) => [
    unique("portal_invite_ws_id_uq").on(t.workspaceId, t.id),
    unique("portal_invite_ws_token_hash_uq").on(t.tokenHash),
    uniqueIndex("portal_invite_ws_project_active_uq")
      .on(t.workspaceId, t.projectId)
      .where(sql`${t.status} = 'active'`),
    index("portal_invite_ws_project_idx").on(
      t.workspaceId,
      t.projectId,
      t.createdAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "portal_invite_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "portal_invite_project_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.workspaceId, t.createdBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "portal_invite_created_by_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.withdrawnBy],
      foreignColumns: [membership.workspaceId, membership.userId],
      name: "portal_invite_withdrawn_by_fk",
    }),
    check("portal_invite_status_ck", sql`${t.status} in (
      'active', 'withdrawn', 'expired'
    )`),
    check("portal_invite_hash_ck", sql`octet_length(${t.tokenHash}) = 32`),
    check("portal_invite_expiry_ck", sql`${t.expiresAt} > ${t.createdAt}`),
    check("portal_invite_reason_ck", sql`
      ${t.withdrawReason} is null or ${t.withdrawReason} in (
        'user_request', 'superseded', 'project_closed', 'other'
      )`),
    check("portal_invite_shape_ck", sql`case ${t.status}
      when 'active' then
        ${t.withdrawnAt} is null
        and ${t.withdrawnBy} is null
        and ${t.withdrawReason} is null
      when 'withdrawn' then
        ${t.withdrawnAt} is not null
        and ${t.withdrawnBy} is not null
        and ${t.withdrawReason} is not null
      when 'expired' then
        ${t.withdrawnAt} is null
        and ${t.withdrawnBy} is null
        and ${t.withdrawReason} is null
      else false end`),
  ],
);

export const portalViewLog = pgTable(
  "portal_view_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    portalInviteId: uuid("portal_invite_id").notNull(),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("portal_view_log_ws_id_uq").on(t.workspaceId, t.id),
    index("portal_view_log_ws_invite_idx").on(
      t.workspaceId,
      t.portalInviteId,
      t.viewedAt,
      t.id,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "portal_view_log_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.portalInviteId],
      foreignColumns: [portalInvite.workspaceId, portalInvite.id],
      name: "portal_view_log_invite_fk",
    }).onDelete("cascade"),
  ],
);

// Token-Locator für den öffentlichen Portal-Link (Muster
// signature_token_locator aus 0044): bewusst RLS-FREI, damit der
// Token-Pfad vor dem Workspace-Lookup den Token-Hash cross-tenant auflösen
// kann. Zugriff ausschließlich über SECURITY-DEFINER-Kapseln.
export const portalTokenLocator = pgTable(
  "portal_token_locator",
  {
    tokenHash: bytea("token_hash").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    portalInviteId: uuid("portal_invite_id").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "portal_token_locator_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.portalInviteId],
      foreignColumns: [portalInvite.workspaceId, portalInvite.id],
      name: "portal_token_locator_invite_fk",
    }).onDelete("cascade"),
    check("portal_token_locator_hash_ck", sql`octet_length(${t.tokenHash}) = 32`),
  ],
);
