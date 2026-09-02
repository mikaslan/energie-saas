import { z } from "zod";

// Transactional-Outbox-Vertrag fuer die Cannot-Fulfil-Kundenbenachrichtigung.
// Der Job-Payload traegt ausschliesslich ID-Bezug — KEINE Empfaenger-/Inhalts-
// PII. Der Empfaenger wird zum Zustellzeitpunkt live aus dem Contact-Graphen
// aufgeloest (ADR 0018).

export const CUSTOMER_NOTIFICATION_QUEUE = "notification.customer" as const;
export const CUSTOMER_NOTIFICATION_DISPATCH_VERSION =
  "customer-notification-dispatch.v1" as const;
export const CUSTOMER_NOTIFICATION_TEMPLATE_ID = "cannot-fulfil.v1" as const;

export const customerNotificationStatusSchema = z.enum([
  "queued",
  "delivered",
  "failed_retriable",
  "failed_final",
  "cancelled_contact_erased",
  "cancelled_manual",
]);
export type CustomerNotificationStatus = z.infer<typeof customerNotificationStatusSchema>;

// Review-Befund P2-7: klassifizierte Fehlercodes, nie Provider-/SMTP-Rohmeldungen.
export const customerNotificationErrorClassSchema = z.enum([
  "recipient_unavailable",
  "transport_unavailable",
  "provider_rejected",
  "invalid_template",
]);
export type CustomerNotificationErrorClass = z.infer<
  typeof customerNotificationErrorClassSchema
>;

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

export const customerNotificationDispatchV1Schema = z.strictObject({
  schemaVersion: z.literal(CUSTOMER_NOTIFICATION_DISPATCH_VERSION),
  workspaceId: uuidSchema,
  notificationId: uuidSchema,
  attemptNumber: z.number().int().min(1),
});
export type CustomerNotificationDispatchV1 = z.infer<
  typeof customerNotificationDispatchV1Schema
>;

export function parseCustomerNotificationDispatchV1(
  value: unknown,
): CustomerNotificationDispatchV1 {
  const parsed = customerNotificationDispatchV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new CustomerNotificationDispatchError();
  }
  return parsed.data;
}

export class CustomerNotificationDispatchError extends Error {
  constructor() {
    super("customer notification dispatch payload is invalid");
    this.name = "CustomerNotificationDispatchError";
  }
}

export class CustomerNotificationTransportError extends Error {
  constructor(
    public readonly errorClass: CustomerNotificationErrorClass,
    public readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "CustomerNotificationTransportError";
  }
}
