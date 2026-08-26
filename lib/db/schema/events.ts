import { pgTable, uuid, text, jsonb, timestamp, boolean, index } from "drizzle-orm/pg-core";

// Outbox-Muster: jede Service-Funktion (ab M1) schreibt ihr Domain-Event in
// derselben Transaktion wie die eigentliche Änderung — kein separater
// Publish-Schritt, kein Zwei-Phasen-Commit. Rollback der Transaktion nimmt
// automatisch das Event mit. Append-only per Trigger (siehe
// drizzle/0004_append_only.sql), UPDATE/DELETE sind bewusst unmöglich.
export const domainEvents = pgTable(
  "domain_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    eventType: text("event_type").notNull(),
    actor: text("actor").notNull(), // user_identity.id oder "system"/"api:<key>"
    payload: jsonb("payload").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("domain_events_aggregate_idx").on(t.workspaceId, t.aggregateType, t.aggregateId)],
);

// Append-only Audit-Trail: ERLAUBTE und ABGELEHNTE Zugriffe landen hier
// (Architektur §4) — das ist der Unterschied zu domain_events, das nur
// tatsächliche fachliche Zustandsänderungen protokolliert.
export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  workspaceId: uuid("workspace_id").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  resource: text("resource").notNull(),
  allowed: boolean("allowed").notNull(),
  details: jsonb("details").notNull().default({}),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});
