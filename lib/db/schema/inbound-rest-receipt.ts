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

// F1-18 (0231): Generische REST-Lead-Aufnahme (Spiegel von F1-15/Broker).
// Dedupe-Domäne UNIQUE(workspace_id, client_record_id) OHNE keyId —
// Rotation erzeugt keine Duplikate (Präzedenz Rechner/Broker); Record-IDs
// sind pro Workspace über alle Creds eindeutig (Präfix-Vertrag).
// sourceName wird nur für die F1.8-Auflösung gespeichert und ist KEIN
// Dedupe-Merkmal. Partial-Unique-Nuance (8f5ed95): der Service muss eine
// selected-Site vor dem Insert per (contact, fingerprint) wiederverwenden,
// sonst verletzt der zweite Record site_ws_contact_address_fingerprint_uq.
export const inboundRestReceipt = pgTable(
  "inbound_rest_receipt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    clientRecordId: text("client_record_id").notNull(),
    sourceName: text("source_name"),
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
    index("inbound_rest_receipt_ws_received_idx").on(t.workspaceId, t.authKeyId, t.receivedAt),
    unique("inbound_rest_receipt_ws_id_uq").on(t.workspaceId, t.id),
    // Dedupe OHNE keyId: gleicher Record + gleicher Hash ist ein
    // idempotentes Replay (auch unter rotiertem Key), Hash-Drift ein
    // Conflict (fail-closed, 409 nie still).
    uniqueIndex("inbound_rest_receipt_ws_client_record_uq").on(
      t.workspaceId,
      t.clientRecordId,
    ),
    uniqueIndex("inbound_rest_receipt_ws_project_uq").on(t.workspaceId, t.projectId),
    unique("inbound_rest_receipt_ws_id_project_uq").on(t.workspaceId, t.id, t.projectId),
    unique("inbound_rest_receipt_ws_id_project_hash_uq").on(
      t.workspaceId,
      t.id,
      t.projectId,
      t.bodySha256,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "inbound_rest_receipt_workspace_id_fk",
    }),
    // Der Receipt wird vor dem Projekt-Graphen beansprucht; die FK ist in
    // der SQL-Migration DEFERRABLE INITIALLY DEFERRED (Muster
    // inbound_receipt, Drizzle kann Deferrability nicht ausdrücken).
    foreignKey({
      columns: [t.workspaceId, t.projectId, t.contactId, t.siteId],
      foreignColumns: [project.workspaceId, project.id, project.contactId, project.siteId],
      name: "inbound_rest_receipt_project_graph_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.emailMatchContactId],
      foreignColumns: [contact.workspaceId, contact.id],
      name: "inbound_rest_receipt_email_match_contact_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.phoneMatchContactId],
      foreignColumns: [contact.workspaceId, contact.id],
      name: "inbound_rest_receipt_phone_match_contact_fk",
    }),
    check(
      "inbound_rest_receipt_record_ck",
      sql`length(btrim(${t.clientRecordId})) between 1 and 128`,
    ),
    check(
      "inbound_rest_receipt_source_name_ck",
      sql`${t.sourceName} is null or length(btrim(${t.sourceName})) between 1 and 100`,
    ),
    check("inbound_rest_receipt_contract_ck", sql`${t.contractVersion} = 'rest-intake.v1'`),
    check("inbound_rest_receipt_hash_ck", sql`octet_length(${t.bodySha256}) = 32`),
    check(
      "inbound_rest_receipt_auth_key_ck",
      sql`${t.authKeyId} ~ '^[a-z0-9][a-z0-9._-]{0,63}$'`,
    ),
    check(
      "inbound_rest_receipt_contact_resolution_ck",
      sql`${t.contactResolution} in ('created', 'email_match', 'phone_match', 'review_created')`,
    ),
    check(
      "inbound_rest_receipt_note_ck",
      sql`${t.note} is null or char_length(${t.note}) <= 2000`,
    ),
  ],
);
