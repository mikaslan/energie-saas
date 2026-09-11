import { describe, expect, it, vi } from "vitest";

import {
  CUSTOMER_NOTIFICATION_DISPATCH_VERSION,
  CUSTOMER_NOTIFICATION_TEMPLATE_ID,
  PORTAL_LINK_TEMPLATE_ID,
} from "@/lib/integrations/notifications/contract";
import type {
  CustomerNotificationSendInput,
  CustomerNotificationSendResult,
} from "@/lib/integrations/notifications/resend-transport";
import {
  createCustomerNotificationHandler,
  type CustomerNotificationDatabase,
} from "@/worker/customer-notification";

const WS = "11111111-1111-4111-8111-111111111111";
const NID = "22222222-2222-4222-8222-222222222222";

function job() {
  return [{
    data: {
      schemaVersion: CUSTOMER_NOTIFICATION_DISPATCH_VERSION,
      workspaceId: WS,
      notificationId: NID,
      attemptNumber: 1,
    },
  }];
}

function stubDatabase(overrides: {
  resolveRecipient?: () => Promise<string | null>;
  resolveTemplate?: () => Promise<string | null>;
} = {}) {
  const database: CustomerNotificationDatabase = {
    resolveRecipient: vi.fn(overrides.resolveRecipient ?? (async () => "kunde@beispiel.de")),
    resolveTemplate: vi.fn(overrides.resolveTemplate ?? (async () => CUSTOMER_NOTIFICATION_TEMPLATE_ID)),
    deliver: vi.fn(async () => undefined),
    cancelErased: vi.fn(async () => undefined),
  };
  return { database };
}

describe("F10.08 customer notification handler", () => {
  it("versendet die Portal-Link-Zeile mit dem Zeilen-Template (nicht hardcoded)", async () => {
    const sent: CustomerNotificationSendInput[] = [];
    const { database } = stubDatabase({
      resolveTemplate: () => Promise.resolve(PORTAL_LINK_TEMPLATE_ID),
    });
    const handler = createCustomerNotificationHandler({
      database,
      transport: {
        send: async (input: CustomerNotificationSendInput): Promise<CustomerNotificationSendResult> => {
          sent.push(input);
          return { sent: true as const };
        },
      },
    });
    await handler(job());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      idempotencyKey: NID,
      templateId: PORTAL_LINK_TEMPLATE_ID,
      recipient: { email: "kunde@beispiel.de" },
    });
    expect(database.deliver).toHaveBeenCalledWith(expect.objectContaining({
      notificationId: NID,
      attemptNumber: 1,
      outcome: "delivered",
      errorClass: null,
    }));
  });

  it("versendet Cannot-Fulfil weiter mit cannot-fulfil.v1 (Regression)", async () => {
    const sent: CustomerNotificationSendInput[] = [];
    const { database } = stubDatabase();
    const handler = createCustomerNotificationHandler({
      database,
      transport: {
        send: async (input: CustomerNotificationSendInput): Promise<CustomerNotificationSendResult> => {
          sent.push(input);
          return { sent: true as const };
        },
      },
    });
    await handler(job());
    expect(sent[0]?.templateId).toBe(CUSTOMER_NOTIFICATION_TEMPLATE_ID);
  });

  it("storniert ohne Empfaenger als Erasure statt zu versenden", async () => {
    const sent: CustomerNotificationSendInput[] = [];
    const { database } = stubDatabase({ resolveRecipient: () => Promise.resolve(null) });
    const handler = createCustomerNotificationHandler({
      database,
      transport: {
        send: async (input: CustomerNotificationSendInput): Promise<CustomerNotificationSendResult> => {
          sent.push(input);
          return { sent: true as const };
        },
      },
    });
    await handler(job());
    expect(sent).toHaveLength(0);
    expect(database.cancelErased).toHaveBeenCalledWith(WS, NID);
    expect(database.deliver).not.toHaveBeenCalled();
  });

  it("wirft bei fehlender Outbox-Zeile (Retry via pgboss)", async () => {
    const { database } = stubDatabase({ resolveTemplate: () => Promise.resolve(null) });
    const handler = createCustomerNotificationHandler({
      database,
      transport: { send: async () => ({ sent: true as const }) },
    });
    await expect(handler(job())).rejects.toThrow(/Outbox-Zeile fehlt/);
  });

  it("verbucht unbekanntes Template als failed_final/invalid_template ohne Retry", async () => {
    const { database } = stubDatabase({ resolveTemplate: () => Promise.resolve("newsletter.v9") });
    const handler = createCustomerNotificationHandler({
      database,
      transport: {
        send: async (): Promise<CustomerNotificationSendResult> => {
          const { CustomerNotificationTransportError } = await import(
            "@/lib/integrations/notifications/contract"
          );
          throw new CustomerNotificationTransportError("invalid_template", false, "template is not pinned");
        },
      },
    });
    await handler(job());
    expect(database.deliver).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "failed_final",
      errorClass: "invalid_template",
    }));
  });
});
