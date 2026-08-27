import { domainEvents } from "./db/schema";
import type { TenantTx } from "./db/tenant";

// Outbox: MUSS innerhalb derselben TenantTx aufgerufen werden wie die
// fachliche Änderung, die das Event auslöst — ab M1 ruft jede
// Service-Funktion emitEvent in ihrer eigenen Transaktion auf, damit ein
// Rollback automatisch auch das Event zurücknimmt.
export async function emitEvent(
  tx: TenantTx,
  e: {
    workspaceId: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    actor: string;
    payload?: unknown;
  },
): Promise<void> {
  await tx.insert(domainEvents).values({ ...e, payload: e.payload ?? {} });
}
