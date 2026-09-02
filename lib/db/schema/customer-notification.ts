import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { project } from "./project";
import { workspace } from "./core";

// Transactional-Outbox fuer die Cannot-Fulfil-Kundenbenachrichtigung. Die
// Tabelle traegt bewusst KEINE Empfaenger- oder Inhalts-PII: der Empfaenger
// wird zum Zustellzeitpunkt live aus dem Contact-Graphen aufgeloest, der
// Mailtext stammt aus einer festen internen Vorlage (ADR 0018).
//
// Review-Befund P2-9: `cancelled_manual` ist das fachliche Storno vor der
// Zustellung (Outcome bleibt terminal); `cancelled_contact_erased` bleibt die
// DSGVO-Erasure (Betroffenenrechtspflicht), nie ein fachlicher Undo.
export const customerNotificationStatuses = [
  "queued",
  "delivered",
  "failed_retriable",
  "failed_final",
  "cancelled_contact_erased",
  "cancelled_manual",
] as const;

// Review-Befund P2-7: klassifizierte Fehlercodes statt Provider-/SMTP-
// Rohmeldungen (kein PII-Echo). Kein Freitext.
export const customerNotificationErrorClasses = [
  "recipient_unavailable",
  "transport_unavailable",
  "provider_rejected",
  "invalid_template",
] as const;

export const customerNotification = pgTable(
  "customer_notification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    projectId: uuid("project_id").notNull(),
    status: text("status").notNull().default("queued"),
    templateId: text("template_id").notNull().default("cannot-fulfil.v1"),
    idempotencyKey: text("idempotency_key").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    failedAt: timestamp("failed_at", { withTimezone: true }),
    errorCode: text("error_code"),
    errorRetryable: boolean("error_retryable"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("customer_notification_ws_id_uq").on(t.workspaceId, t.id),
    unique("customer_notification_ws_idempotency_uq").on(t.workspaceId, t.idempotencyKey),
    // Review-Befund P2-8: hoechstens EINE aktive (nicht-terminale) Notification
    // je Projekt. Terminale Zeilen duerfen mehrfach existieren (Historie), die
    // aktive ist dadurch eindeutig.
    uniqueIndex("customer_notification_ws_project_active_uq")
      .on(t.workspaceId, t.projectId)
      .where(sql`${t.status} in ('queued', 'failed_retriable')`),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "customer_notification_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.projectId],
      foreignColumns: [project.workspaceId, project.id],
      name: "customer_notification_project_fk",
    }),
    check(
      "customer_notification_status_ck",
      sql`${t.status} in ('queued', 'delivered', 'failed_retriable', 'failed_final', 'cancelled_contact_erased', 'cancelled_manual')`,
    ),
    check("customer_notification_attempt_count_ck", sql`${t.attemptCount} >= 0`),
    check(
      "customer_notification_error_class_ck",
      sql`${t.errorCode} is null or ${t.errorCode} in ('recipient_unavailable', 'transport_unavailable', 'provider_rejected', 'invalid_template')`,
    ),
    check(
      "customer_notification_timestamps_ck",
      sql`${t.updatedAt} >= ${t.createdAt}`,
    ),
  ],
);

// Append-only Zustellevidenz: eine Versuchszeile je Sendeversuch mit
// klassifiziertem Retry-Fehler. Ein Storno ist ein Statusuebergang der Outbox
// OHNE Versuchszeile. Physisches DELETE und UPDATE sind verboten (Mutationsguard).
export const customerNotificationDeliveryAttempt = pgTable(
  "customer_notification_delivery_attempt",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").notNull(),
    notificationId: uuid("notification_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    outcome: text("outcome").notNull(),
    errorClass: text("error_class"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("customer_notification_delivery_attempt_ws_id_uq").on(t.workspaceId, t.id),
    unique("customer_notification_delivery_attempt_ws_notification_attempt_uq").on(
      t.workspaceId,
      t.notificationId,
      t.attemptNumber,
    ),
    foreignKey({
      columns: [t.workspaceId],
      foreignColumns: [workspace.id],
      name: "customer_notification_delivery_attempt_workspace_id_fk",
    }),
    foreignKey({
      columns: [t.workspaceId, t.notificationId],
      foreignColumns: [customerNotification.workspaceId, customerNotification.id],
      name: "customer_notification_delivery_attempt_notification_fk",
    }),
    check(
      "customer_notification_delivery_attempt_outcome_ck",
      sql`${t.outcome} in ('delivered', 'failed_retriable', 'failed_final')`,
    ),
    check(
      "customer_notification_delivery_attempt_number_ck",
      sql`${t.attemptNumber} >= 1`,
    ),
    check(
      "customer_notification_delivery_attempt_error_ck",
      sql`(${t.outcome} = 'delivered' and ${t.errorClass} is null)
          or (${t.outcome} in ('failed_retriable', 'failed_final')
              and ${t.errorClass} in ('recipient_unavailable', 'transport_unavailable', 'provider_rejected', 'invalid_template'))`,
    ),
  ],
);
