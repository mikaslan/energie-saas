import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { workspace } from "./core";
import { contact } from "./crm";
import { bytea } from "./types";

export type ErasureGraphIds = {
  contactId: string;
  legalHoldIds: string[];
  siteIds: string[];
  projectIds: string[];
  profileIds: string[];
  jobIds: string[];
  revisionIds: string[];
  requirementIds: string[];
  snapshotIds: string[];
  receiptIds: string[];
  taskIds?: string[];
  noteIds?: string[];
  appointmentIds?: string[];
  commercialDocumentIds?: string[];
  commercialDocumentGroupIds?: string[];
};

export const contactLegalHold = pgTable(
  "contact_legal_hold",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    reason: text("reason").notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (t) => [
    unique("contact_legal_hold_ws_id_uq").on(t.workspaceId, t.id),
    index("contact_legal_hold_active_idx")
      .on(t.workspaceId, t.contactId, t.placedAt)
      .where(sql`${t.releasedAt} is null`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "contact_legal_hold_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.contactId],
      foreignColumns: [contact.workspaceId, contact.id],
      name: "contact_legal_hold_contact_fk",
    }),
    check("contact_legal_hold_reason_ck", sql`length(btrim(${t.reason})) between 1 and 200`),
    check(
      "contact_legal_hold_release_ck",
      sql`${t.releasedAt} is null or ${t.releasedAt} >= ${t.placedAt}`,
    ),
  ],
);

// Globale, ID-only Restore-Route. Sie besitzt absichtlich keine
// `workspace_id`-Spalte und keine Runtime-ACL: replay_erasure_tombstone kennt
// beim Einstieg nur die opake Operation-ID und setzt den Tenant-Kontext erst
// nach diesem Lookup. Der eigentliche Tombstone bleibt normal FORCE-RLS-
// geschützt und trägt weiterhin exakt seinen neunspaltigen Vertrag.
export const erasureOperationLocator = pgTable(
  "erasure_operation_locator",
  {
    operationId: uuid("operation_id").primaryKey(),
    scopeId: uuid("scope_id").notNull(),
  },
  (t) => [
    unique("erasure_operation_locator_operation_scope_uq").on(t.operationId, t.scopeId),
    foreignKey({
      columns: [t.scopeId],
      foreignColumns: [workspace.id],
      name: "erasure_operation_locator_scope_id_fk",
    }),
  ],
);

export const erasureTombstone = pgTable(
  "erasure_tombstone",
  {
    operationId: uuid("operation_id").primaryKey(),
    workspaceId: uuid("workspace_id").notNull(),
    contactId: uuid("contact_id").notNull(),
    reason: text("reason").notNull(),
    graphSha256: bytea("graph_sha256").notNull(),
    tombstoneSha256: bytea("tombstone_sha256").notNull(),
    graphIds: jsonb("graph_ids").$type<ErasureGraphIds>().notNull(),
    eligibleAt: timestamp("eligible_at", { withTimezone: true }).notNull(),
    erasedAt: timestamp("erased_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    unique("erasure_tombstone_ws_contact_uq").on(t.workspaceId, t.contactId),
    unique("erasure_tombstone_operation_ws_uq").on(t.operationId, t.workspaceId),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "erasure_tombstone_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.operationId, t.workspaceId],
      foreignColumns: [erasureOperationLocator.operationId, erasureOperationLocator.scopeId],
      name: "erasure_tombstone_locator_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.contactId],
      foreignColumns: [contact.workspaceId, contact.id],
      name: "erasure_tombstone_contact_fk",
    }),
    check("erasure_tombstone_reason_ck", sql`${t.reason} = 'inactive_lead_24_months'`),
    check(
      "erasure_tombstone_hash_ck",
      sql`octet_length(${t.graphSha256}) = 32 and octet_length(${t.tombstoneSha256}) = 32`,
    ),
    check("erasure_tombstone_graph_ck", sql`jsonb_typeof(${t.graphIds}) = 'object'`),
    check("erasure_tombstone_time_ck", sql`${t.erasedAt} >= ${t.eligibleAt}`),
  ],
);
