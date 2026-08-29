import { site } from "@/lib/db/schema";
import type { TenantTx } from "@/lib/db/types";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import { emitEvent } from "@/lib/events";
import { writeAudit } from "@/lib/audit";

// Kanonischer Ort für beide ist lib/permissions.ts (der autorisierte Kontext
// wird dort definiert und von lib/db/tenant.ts#withAuthorizedTenant gebaut) —
// hier nur Re-Export, damit die Modul-Public-API stabil bleibt.
export { PermissionDeniedError };
export type { ServiceCtx };

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
// (mit action + resource als Feldern und dem bereits aufgelösten Actor aus
// dem ctx). Die AUFRUFGRENZE — ab M1 lib/action.ts, das die Transaktion
// geöffnet hat bzw. den Abort sieht — fängt diesen Fehler und schreibt den
// Denial-Audit in einer EIGENEN, NEUEN Transaktion NACH dem Abort.
//
// Der Erfolgspfad bleibt unverändert in-tx: emitEvent läuft in DERSELBEN
// Transaktion wie der Insert, damit ein Rollback automatisch auch das
// Event zurücknimmt (Outbox-Garantie, siehe lib/events.ts).
// ═══════════════════════════════════════════════════════════════════════

export type CreateSiteInput = {
  label?: string;
  street?: string;
  houseNumber?: string;
  postalCode?: string;
  city?: string;
  country?: string;
  lat?: number;
  lng?: number;
};

export async function createSite(tx: TenantTx, ctx: ServiceCtx, input: CreateSiteInput): Promise<{ id: string }> {
  if (!can(ctx, "project.write")) {
    // KEIN writeAudit hier — siehe Boundary-Kommentar oben.
    throw new PermissionDeniedError("project.write", "site", undefined, ctx.actor);
  }
  if (ctx.capabilities.external_only === true) {
    throw new PermissionDeniedError(
      "project.write",
      "site",
      "external_only_without_assignment",
      ctx.actor,
    );
  }

  // Explizites Mapping ist zugleich Mass-Assignment-Schutz: strukturell
  // eingeschleuste Felder (insbesondere pinConfirmed/workspaceId) werden
  // nicht persistiert. Legacy-Sites beginnen immer unbestätigt; die einzige
  // Bestätigungsgrenze ist die projektgebundene revisionsgeprüfte Fachaktion.
  const [row] = await tx.insert(site).values({
    workspaceId: ctx.workspaceId,
    label: input.label,
    street: input.street,
    houseNumber: input.houseNumber,
    postalCode: input.postalCode,
    city: input.city,
    country: input.country,
    lat: input.lat,
    lng: input.lng,
    pinConfirmed: false,
  }).returning({ id: site.id });

  // ═══════════════════════════════════════════════════════════════════
  // Codex-Review #12 (DSGVO): payload trug vorher `input` — also Straße,
  // Hausnummer, PLZ, Ort und Koordinaten. domain_events ist append-only
  // (drizzle/0004, 0005): dieser Klartext wäre NIE wieder löschbar gewesen.
  //
  // docs/konzepte/dsgvo-loeschkonzept.md, Regel 1: "Personenbezug in
  // Events/Audit NUR als IDs, nie als Klartext (kein Name/E-Mail im
  // payload)." Wer die Adresse braucht, liest sie über die siteId aus der
  // site-Tabelle — die ist löschbar bzw. pseudonymisierbar (Regel 2).
  // ═══════════════════════════════════════════════════════════════════
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "site",
    aggregateId: row.id,
    eventType: "site.created",
    actor: ctx.actor,
    payload: { siteId: row.id },
  });

  // Codex-Review #13a: der Erfolgspfad schrieb bisher gar keinen Audit — das
  // Audit-Versprechen aus Architektur §4 ("erlaubte UND abgelehnte Zugriffe")
  // war damit nur zur Hälfte eingelöst. Der Erfolgs-Audit gehört ATOMAR zur
  // Mutation, also in DIESELBE Transaktion: rollt der Insert zurück, rollt
  // der Audit mit. (Nur der DENIAL-Audit darf das nicht — siehe
  // Boundary-Kommentar oben und lib/audit.ts.)
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.write",
    resource: "site",
    allowed: true,
    details: { siteId: row.id },
  });

  return row;
}
