import { sql } from "drizzle-orm";
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
  (t) => [
    index("domain_events_aggregate_idx").on(
      t.workspaceId,
      t.aggregateType,
      t.aggregateId,
    ),
    index("domain_events_project_activity_idx")
      .on(
        t.workspaceId,
        t.aggregateId,
        t.occurredAt.desc().nullsFirst(),
        t.id.desc().nullsFirst(),
      )
      .concurrently()
      .where(sql`${t.aggregateType} = 'project' and ${t.eventType} in (
        'project.task_created', 'project.task_updated',
        'project.task_checklist_changed', 'project.task_completed',
        'project.task_reopened', 'project.task_archived',
        'project.outcome_won', 'project.outcome_lost',
        'project.outcome_reopened',
        'project.note_created', 'project.note_updated',
        'project.note_deleted', 'project.note_pinned',
        'project.note_unpinned',
        'project.appointment_created', 'project.appointment_updated',
        'project.appointment_deleted'
      )`),
  ],
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
