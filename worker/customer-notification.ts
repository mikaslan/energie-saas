import { Pool } from "pg";
import {
  CUSTOMER_NOTIFICATION_TEMPLATE_ID,
  parseCustomerNotificationDispatchV1,
} from "../lib/integrations/notifications/contract";
import {
  customerNotificationTransportFailure,
  type CustomerNotificationTransport,
} from "../lib/integrations/notifications/resend-transport";
import { servicePoolConfig } from "../lib/db/role-env";

export type CustomerNotificationDatabase = Readonly<{
  resolveRecipient(workspaceId: string, notificationId: string): Promise<string | null>;
  deliver(input: {
    workspaceId: string;
    notificationId: string;
    attemptNumber: number;
    outcome: "delivered" | "failed_retriable" | "failed_final";
    errorClass: string | null;
  }): Promise<void>;
  cancelErased(workspaceId: string, notificationId: string): Promise<void>;
}>;

type HandlerDependencies = Readonly<{
  database: CustomerNotificationDatabase;
  transport: CustomerNotificationTransport;
}>;

/**
 * Customer-Notification-Handler: Empfaenger wird LIVE aufgeloest (keine PII in
 * der DB), Zustellung laeuft ueber den Resend-Transport (Idempotency-Key =
 * Notification-ID), Evidenz je Versuch ueber die Definer-Kapseln.
 *
 * Review-Befund P1-3: pgboss ist die einzige Retry-Quelle. Bei retriable
 * Fehlern wird failed_retriable verbucht und der Fehler erneut geworfen, damit
 * pg-boss retried; die Outbox bleibt dabei zustellbar (queued/failed_retriable).
 */
export function createCustomerNotificationHandler(
  dependencies: HandlerDependencies,
): (jobs: unknown[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      const payload = job !== null && typeof job === "object" && "data" in job
        ? (job as { data?: unknown }).data
        : undefined;
      const dispatch = parseCustomerNotificationDispatchV1(payload);

      const recipient = await dependencies.database.resolveRecipient(
        dispatch.workspaceId,
        dispatch.notificationId,
      );
      if (recipient === null) {
        await dependencies.database.cancelErased(
          dispatch.workspaceId,
          dispatch.notificationId,
        );
        continue;
      }

      try {
        await dependencies.transport.send({
          idempotencyKey: dispatch.notificationId,
          templateId: CUSTOMER_NOTIFICATION_TEMPLATE_ID,
          recipient: { email: recipient },
        });
        await dependencies.database.deliver({
          workspaceId: dispatch.workspaceId,
          notificationId: dispatch.notificationId,
          attemptNumber: dispatch.attemptNumber,
          outcome: "delivered",
          errorClass: null,
        });
      } catch (error) {
        const failure = customerNotificationTransportFailure(error);
        if (failure === null) throw error;
        const outcome = failure.retryable ? "failed_retriable" : "failed_final";
        await dependencies.database.deliver({
          workspaceId: dispatch.workspaceId,
          notificationId: dispatch.notificationId,
          attemptNumber: dispatch.attemptNumber,
          outcome,
          errorClass: failure.errorClass,
        });
        if (failure.retryable) throw error;
      }
    }
  };
}

export interface CustomerNotificationDatabaseGateway {
  database: CustomerNotificationDatabase;
  probe(): Promise<void>;
  close(): Promise<void>;
}

export function createCustomerNotificationDatabaseGateway(
  connectionString: string,
  onPoolError: (error: Error) => void,
  max = 2,
): CustomerNotificationDatabaseGateway {
  const pool = new Pool(servicePoolConfig(connectionString, "app_worker", max));
  pool.on("error", onPoolError);

  const database: CustomerNotificationDatabase = {
    async resolveRecipient(workspaceId, notificationId) {
      const result = await pool.query(
        "select public._m111b_worker_resolve_recipient($1::uuid, $2::uuid) as email",
        [workspaceId, notificationId],
      );
      const email = result.rows[0]?.email as string | null | undefined;
      return email ?? null;
    },
    async deliver(input) {
      await pool.query(
        "select public._m111b_worker_deliver($1::uuid, $2::uuid, $3::int, $4::text, $5::text)",
        [
          input.workspaceId,
          input.notificationId,
          input.attemptNumber,
          input.outcome,
          input.errorClass,
        ],
      );
    },
    async cancelErased(workspaceId, notificationId) {
      await pool.query(
        "select public._m111b_worker_cancel_erased($1::uuid, $2::uuid)",
        [workspaceId, notificationId],
      );
    },
  };

  return {
    database,
    async probe() {
      await pool.query("select 1");
    },
    async close() {
      await pool.end();
    },
  };
}
