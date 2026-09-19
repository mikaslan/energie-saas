import { sql } from "drizzle-orm";

import { writeAudit } from "../../audit";
import type { TenantTx } from "../../db/types";
import { emitEvent } from "../../events";

// F8-24a · Worker-sicherer Sweep-Kern (Täglicher Overdue-Sweep, F8.3):
// genau EINE Statuswahrheit — `payment_status` wird geschrieben, nie
// computed-on-read (DECIDED). Diese Datei ist bewusst `server-only`-frei:
// Der Worker (`worker/overdue-sweep.ts`) importiert sie direkt, der
// Request-Pfad (`modules/invoicing/overdue-service.ts`) legt nur die
// Ctx-Berechtigungspruefung darum. Kein Import aus `@/modules/*` hier,
// sonst faellt der Worker-Boot mit `server-only` um (E2E-Fund).
export const OVERDUE_SWEEP_BATCH_LIMIT = 10_000;

export type OverdueSweepResult = {
  swept: number;
  sweptDocumentIds: string[];
  truncated: boolean;
};

export type OverdueSweepOptions = {
  today?: string;
  limit?: number;
};

export function berlinTodayDate(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

// Worker-Einstieg (F8-24a): gleiche Sweep-Logik, aber ohne User-Ctx —
// der ServiceCtx darf nie frei konstruiert werden (permissions.ts), der
// Worker hat keinen Membership-Actor. Absicherung stattdessen: Rolle
// app_worker + spaltenscharfe GRANTs (Migration 0198) + tenant_isolation
// via withTenantOn; Actor-Marker "worker:overdue-sweep" macht die
// Herkunft in Events/Audit ehrlich sichtbar.
export const OVERDUE_SWEEP_WORKER_ACTOR = "worker:overdue-sweep" as const;

/**
 * F8-24a Overdue-Sweep: alle `issued`-Belege mit
 * `payment_status IN (unpaid, partially_paid)` und
 * `due_date < heute (Europe/Berlin)` → `overdue`, je Beleg mit Event
 * `commercial_document.payment_updated` und Audit `document.payment.write`
 * (recordPayment-Spiegel M301-05). Idempotent: bereits `overdue` matched das
 * Prädikat nicht mehr; `paid`/`uncollectable`/Entwürfe/stornierte Belege
 * werden nie berührt.
 */
export async function sweepOverdueDocumentsAsWorker(
  tx: TenantTx,
  workspaceId: string,
  options: OverdueSweepOptions = {},
): Promise<OverdueSweepResult> {
  return sweepOverdueDocumentsCore(tx, workspaceId, OVERDUE_SWEEP_WORKER_ACTOR, options);
}

export async function sweepOverdueDocumentsCore(
  tx: TenantTx,
  workspaceId: string,
  actor: string,
  options: OverdueSweepOptions,
): Promise<OverdueSweepResult> {
  const today = options.today ?? berlinTodayDate();
  const limit = options.limit ?? OVERDUE_SWEEP_BATCH_LIMIT;

  const candidates = await tx.execute<{ id: string; paid_cents: number }>(sql`
    select id, paid_cents
      from commercial_document
     where workspace_id = ${workspaceId}::uuid
       and status = 'issued'
       and payment_status in ('unpaid', 'partially_paid')
       and due_date < ${today}::date
     order by due_date asc, id asc
     limit ${limit + 1}
     for update
  `);
  const rows = candidates.rows;
  const truncated = rows.length > limit;
  const batch = truncated ? rows.slice(0, limit) : rows;
  if (batch.length === 0) return { swept: 0, sweptDocumentIds: [], truncated: false };

  // Zweites Prädikat als CAS: unter Nebenläufigkeit gewinnt genau ein
  // Schreiber je Zeile; bereits umgestellte Zeilen fallen hier raus.
  const batchIds = sql.join(
    batch.map((row) => sql`${row.id}::uuid`),
    sql`, `,
  );
  const updated = await tx.execute<{ id: string; paid_cents: number }>(sql`
    update commercial_document
       set payment_status = 'overdue',
           payment_updated_at = statement_timestamp(),
           updated_at = statement_timestamp()
     where workspace_id = ${workspaceId}::uuid
       and id in (${batchIds})
       and status = 'issued'
       and payment_status in ('unpaid', 'partially_paid')
    returning id, paid_cents
  `);

  for (const row of updated.rows) {
    const paidCents = Number(row.paid_cents);
    const evidence = { documentId: row.id, paymentStatus: "overdue", paidCents };
    await emitEvent(tx, {
      workspaceId,
      aggregateType: "commercial_document",
      aggregateId: row.id,
      eventType: "commercial_document.payment_updated",
      actor,
      payload: evidence,
    });
    await writeAudit(tx, {
      workspaceId,
      actor,
      action: "document.payment.write",
      resource: "commercial_document",
      allowed: true,
      details: evidence,
    });
  }
  return {
    swept: updated.rows.length,
    sweptDocumentIds: updated.rows.map((row) => row.id),
    truncated,
  };
}
