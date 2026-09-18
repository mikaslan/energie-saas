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
import { bytea } from "./types";
import { contact } from "./crm";
import { workspace } from "./core";
import { project } from "./project";

// F1-15 (0230): Broker-Intake via REST (Katalog F1.2). Ein Receipt je
// (Workspace, Broker, Broker-Record-ID) — gleicher Record + gleicher Hash
// ist ein idempotentes Replay, Hash-Drift ein Conflict (fail-closed).
// Cross-Broker-Dedupe läuft ausschließlich kontaktbasiert
// (contactResolution/reviewRequired wie Rechner-Intake).
export const inboundBrokerReceipt = pgTable(
  "inbound_broker_receipt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    brokerKey: text("broker_key").notNull(),
    brokerRecordId: text("broker_record_id").notNull(),
    contractVersion: text("contract_version").notNull(),
    bodySha256: bytea("body_sha256").notNull(),
    authKeyId: text("auth_key_id").notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    contactResolution: text("contact_resolution").notNull(),
    contactId: uuid("contact_id").notNull(),
    emailMatchContactId: uuid("email_match_contact_id"),
    phoneMatchContactId: uuid("phone_match_contact_id"),
    siteId: uuid("site_id").notNull(),
    projectId: uuid("project_id").notNull(),
    note: text("note"),
  },
  (t) => [
    index("inbound_broker_receipt_ws_received_idx").on(t.workspaceId, t.authKeyId, t.receivedAt),
    unique("inbound_broker_receipt_ws_id_uq").on(t.workspaceId, t.id),
    uniqueIndex("inbound_broker_receipt_ws_broker_record_uq").on(
      t.workspaceId,
      t.brokerKey,
      t.brokerRecordId,
    ),
    uniqueIndex("inbound_broker_receipt_ws_project_uq").on(t.workspaceId, t.projectId),
    unique("inbound_broker_receipt_ws_id_project_uq").on(t.workspaceId, t.id, t.projectId),
    unique("inbound_broker_receipt_ws_id_project_hash_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
      t.bodySha256,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "inbound_broker_receipt_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId, t.contactId, t.siteId],
      foreignColumns: [project.workspaceId, project.id, project.contactId, project.siteId],
      name: "inbound_broker_receipt_project_graph_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.emailMatchContactId],
      foreignColumns: [contact.workspaceId, contact.id],
      name: "inbound_broker_receipt_email_match_contact_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.phoneMatchContactId],
      foreignColumns: [contact.workspaceId, contact.id],
      name: "inbound_broker_receipt_phone_match_contact_fk",
    }),
    check(
      "inbound_broker_receipt_broker_ck",
      sql`${t.brokerKey} in ('wattfox', 'aroundhome', 'daa', 'eza', 'interlead', 'bitrix')`,
    ),
    check(
      "inbound_broker_receipt_record_ck",
      sql`length(btrim(${t.brokerRecordId})) between 1 and 128`,
    ),
    check("inbound_broker_receipt_contract_ck", sql`${t.contractVersion} = 'broker-intake.v1'`),
    check("inbound_broker_receipt_hash_ck", sql`octet_length(${t.bodySha256}) = 32`),
    check(
      "inbound_broker_receipt_auth_key_ck",
      sql`${t.authKeyId} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`,
    ),
    check(
      "inbound_broker_receipt_contact_resolution_ck",
      sql`${t.contactResolution} in ('created', 'email_match', 'phone_match', 'review_created')`,
    ),
    check(
      "inbound_broker_receipt_note_ck",
      sql`${t.note} is null or char_length(${t.note}) <= 2000`,
    ),
  ],
);
