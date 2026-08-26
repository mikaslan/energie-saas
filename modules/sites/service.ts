import { site } from "@/lib/db/schema";
import type { TenantTx } from "@/lib/db/tenant";
import { can, type PermissionCtx, type Action } from "@/lib/permissions";
import { emitEvent } from "@/lib/events";

// ═══════════════════════════════════════════════════════════════════════
// Referenz-Service-Muster (gilt für alle M1+-Module):
//
// Autorisierungs-Grenze (Controller-Ruling, siehe lib/audit.ts für den
// vollständigen Transaktionsgrenzen-Vertrag): eine Service-Funktion, die
// innerhalb einer TenantTx läuft, schreibt bei can()-Ablehnung KEINEN
// Denial-Audit in dieser (dann aussterbenden) Transaktion — ein
// writeAudit(tx, { allowed: false, ... }) gefolgt von throw würde mit dem
// abgebrochenen tx zusammen zurückgerollt und wäre spurlos verschwunden.
//
// Stattdessen wirft der Service einen typisierten PermissionDeniedError
// (mit action + resource als Feldern). Die AUFRUFGRENZE — ab M1 der
// Server-Action-Wrapper, der die Transaktion geöffnet hat bzw. den Abort
// sieht — fängt diesen Fehler und schreibt den Denial-Audit in einer
// EIGENEN, NEUEN Transaktion NACH dem Abort (siehe tests/db/site.test.ts
// für das vollständige Boundary-Pattern).
//
// Der Erfolgspfad bleibt unverändert in-tx: emitEvent läuft in DERSELBEN
// Transaktion wie der Insert, damit ein Rollback automatisch auch das
// Event zurücknimmt (Outbox-Garantie, siehe lib/events.ts).
// ═══════════════════════════════════════════════════════════════════════

export class PermissionDeniedError extends Error {
  constructor(
    public readonly action: Action,
    public readonly resource: string,
  ) {
    super(`permission denied: ${action} on ${resource}`);
    this.name = "PermissionDeniedError";
  }
}

export type ServiceCtx = PermissionCtx & { workspaceId: string; actor: string };

export type CreateSiteInput = {
  label?: string;
  street?: string;
  houseNumber?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  lat?: number;
  lng?: number;
  pinConfirmed?: boolean;
};

export async function createSite(tx: TenantTx, ctx: ServiceCtx, input: CreateSiteInput): Promise<{ id: string }> {
  if (!can(ctx, "project.write")) {
    // KEIN writeAudit hier — siehe Boundary-Kommentar oben.
    throw new PermissionDeniedError("project.write", "site");
  }
  const [row] = await tx.insert(site).values({ workspaceId: ctx.workspaceId, ...input }).returning({ id: site.id });
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "site",
    aggregateId: row.id,
    eventType: "site.created",
    actor: ctx.actor,
    payload: input,
  });
  return row;
}
