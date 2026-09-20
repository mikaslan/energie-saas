import "server-only";

import type { TenantTx } from "@/lib/db/types";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  sweepOverdueDocumentsCore,
  type OverdueSweepOptions,
  type OverdueSweepResult,
} from "@/lib/integrations/invoicing/overdue-sweep-core";

// F8-24a · Request-Pfad des Overdue-Sweeps: Die Sweep-Logik selbst lebt
// worker-sicher in `@/lib/integrations/invoicing/overdue-sweep-core`
// (kein `server-only`, damit `worker/overdue-sweep.ts` sie direkt
// importieren kann). Diese Datei legt nur die Ctx-Berechtigungspruefung
// darum und re-exportiert die Kern-Symbole (Barrel-Kompatibilitaet).
export {
  OVERDUE_SWEEP_BATCH_LIMIT,
  OVERDUE_SWEEP_WORKER_ACTOR,
  berlinTodayDate,
  sweepOverdueDocumentsAsWorker,
  type OverdueSweepOptions,
  type OverdueSweepResult,
} from "@/lib/integrations/invoicing/overdue-sweep-core";

function requireInvoicingWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "invoicing.write")) {
    throw new PermissionDeniedError("invoicing.write", "commercial_document", undefined, ctx.actor);
  }
}

export async function sweepOverdueDocuments(
  tx: TenantTx,
  ctx: ServiceCtx,
  options: OverdueSweepOptions = {},
): Promise<OverdueSweepResult> {
  requireInvoicingWrite(ctx);
  return sweepOverdueDocumentsCore(tx, ctx.workspaceId, ctx.actor, options);
}
