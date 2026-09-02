import {
  CUSTOMER_NOTIFICATION_TEMPLATE_ID,
  CustomerNotificationTransportError,
} from "./contract";

// Resend-Transport-Grenze: KEIN echter Versand. Die Implementierung validiert
// nur die ID-only-Aufrufe und klassifiziert Fehler; sie speichert keine PII
// und versendet nichts. Der Idempotency-Key ist die Notification-ID (Review-
// Befund P1-2), damit ein Doppel-Dispatch auf Anbieterseite dedupliziert werden
// kann, sobald ein echter Provider angebunden wird.

export type CustomerNotificationRecipient = Readonly<{
  email: string;
}>;

export type CustomerNotificationSendInput = Readonly<{
  idempotencyKey: string;
  templateId: string;
  recipient: CustomerNotificationRecipient;
}>;

export type CustomerNotificationSendResult = Readonly<{
  sent: true;
}>;

export interface CustomerNotificationTransport {
  send(input: CustomerNotificationSendInput): Promise<CustomerNotificationSendResult>;
}

// Klassifiziert Fehler in retriable (transport/provider temporaer) vs. final
// (Empfaenger dauerhaft ungueltig, Vorlage ungueltig). Kein Freitext/PII.
function classify(error: unknown): {
  errorClass: "transport_unavailable" | "provider_rejected" | "invalid_template";
  retryable: boolean;
  message: string;
} | null {
  if (error instanceof CustomerNotificationTransportError) {
    return {
      errorClass: error.errorClass === "recipient_unavailable"
        ? "provider_rejected"
        : error.errorClass,
      retryable: error.retryable,
      message: error.message,
    };
  }
  return null;
}

export class NoopCustomerNotificationTransport implements CustomerNotificationTransport {
  async send(
    input: CustomerNotificationSendInput,
  ): Promise<CustomerNotificationSendResult> {
    if (input.templateId !== CUSTOMER_NOTIFICATION_TEMPLATE_ID) {
      throw new CustomerNotificationTransportError(
        "invalid_template",
        false,
        "template is not pinned",
      );
    }
    if (typeof input.recipient.email !== "string" || input.recipient.email.length === 0) {
      throw new CustomerNotificationTransportError(
        "provider_rejected",
        false,
        "recipient email is empty",
      );
    }
    // KEIN echter Versand (Parity-Grenze): der Transport attestiert nur den
    // ID-only-Aufruf und gilt als zugestellt.
    return { sent: true };
  }
}

export function customerNotificationTransportFailure(
  error: unknown,
): { errorClass: "transport_unavailable" | "provider_rejected" | "invalid_template"; retryable: boolean } | null {
  return classify(error);
}
