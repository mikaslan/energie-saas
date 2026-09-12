// F7-08 Workbook: zu installierende Variante + Stückliste (lesend).
// F7-10: kWp/kWh-Rollups aus demselben Snapshot (F7-09-Projektor).
//
// Explizite Varianten-Bindung (kein Eingriff in den versiegelten
// Signatur-Ablauf) und Read-only-Projektion aus dem hash-geprüften
// Current-Revision-Snapshot. Keine Einkaufspreise (Monteur-Sicht),
// nur sichtbare Zeilen, keine erfundene Physik (Custom-Positionen
// tragen keine zertifizierte Leistung).
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  deriveCertifiedCapacities,
  type CertifiedCapacities,
} from "@/lib/integrations/offers/certified-capacities";
import type { CatalogTechnicalDataV1 } from "@/lib/integrations/catalog/contract";
import { validateOfferVariantSnapshot } from "@/lib/integrations/offers/contract";
import { OfferIntegrityError, OfferNotFoundError } from "@/modules/offers/errors";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  InstallationConflictError,
  InstallationNotFoundError,
  InstallationValidationError,
} from "./service";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

function requireWorkbookRead(ctx: ServiceCtx): void {
  if (!can(ctx, "installation.read")) {
    throw new PermissionDeniedError("installation.read", "installation", undefined, ctx.actor);
  }
}

function requireWorkbookWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "installation.write")) {
    throw new PermissionDeniedError("installation.write", "installation", undefined, ctx.actor);
  }
}

export type InstallableVariantOption = {
  offerId: string;
  offerNumber: string | null;
  variantId: string;
  variantName: string;
  revision: number;
  signed: boolean;
};

export async function listInstallableVariants(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string },
): Promise<InstallableVariantOption[]> {
  requireWorkbookRead(ctx);
  const parsed = z.strictObject({ projectId: uuidSchema }).safeParse(query);
  if (!parsed.success) throw new InstallationValidationError();
  const rows = await tx.execute<{
    offer_id: string;
    offer_number: string | null;
    variant_id: string;
    variant_name: string;
    revision: number;
    signed: boolean;
    [key: string]: unknown;
  }>(sql`
    select offer_record.id as offer_id, offer_record.offer_number,
           variant.id as variant_id, variant.name as variant_name,
           variant.current_revision as revision,
           exists (
             select 1 from signature_request
              where workspace_id = ${ctx.workspaceId}::uuid
                and offer_id = offer_record.id
                and variant_id = variant.id
                and status = 'signed'
           ) as signed
      from offer as offer_record
      join offer_variant as variant
        on variant.workspace_id = offer_record.workspace_id
       and variant.offer_id = offer_record.id
     where offer_record.workspace_id = ${ctx.workspaceId}::uuid
       and offer_record.project_id = ${parsed.data.projectId}::uuid
     order by offer_record.offer_number nulls last, offer_record.id,
              variant.name, variant.id
  `);
  return rows.rows.map((row) => ({
    offerId: row.offer_id,
    offerNumber: row.offer_number,
    variantId: row.variant_id,
    variantName: row.variant_name,
    revision: Number(row.revision),
    signed: row.signed,
  }));
}

const setVariantCommandSchema = z.strictObject({
  projectId: uuidSchema,
  variantId: uuidSchema,
});

export async function setInstallationVariant(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; variantId: string },
): Promise<{ installationId: string; offerId: string; variantId: string }> {
  requireWorkbookWrite(ctx);
  const parsed = setVariantCommandSchema.safeParse(input);
  if (!parsed.success) throw new InstallationValidationError();

  const locked = await tx.execute<{ id: string; status: string }>(sql`
    select id, status from installation
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${parsed.data.projectId}::uuid
     limit 1
     for update
  `);
  const installation = locked.rows[0];
  if (!installation) throw new InstallationNotFoundError(parsed.data.projectId);
  // Abgeschlossene Installation ist eingefroren (F7-04-Präzedenz).
  if (installation.status === "completed") throw new InstallationConflictError(parsed.data.projectId);

  // Scope: Variante gehört zu einem Angebot DIESES Projekts (kein Leak).
  const scope = await tx.execute<{ offer_id: string; variant_id: string }>(sql`
    select offer_record.id as offer_id, variant.id as variant_id
      from offer_variant as variant
      join offer as offer_record
        on offer_record.workspace_id = variant.workspace_id
       and offer_record.id = variant.offer_id
       and offer_record.project_id = ${parsed.data.projectId}::uuid
     where variant.workspace_id = ${ctx.workspaceId}::uuid
       and variant.id = ${parsed.data.variantId}::uuid
     limit 1
  `);
  const hit = scope.rows[0];
  if (!hit) throw new OfferNotFoundError();

  await tx.execute(sql`
    update installation
       set offer_id = ${hit.offer_id}::uuid,
           variant_id = ${hit.variant_id}::uuid,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${installation.id}::uuid
  `);
  const evidence = {
    workspaceId: ctx.workspaceId,
    projectId: parsed.data.projectId,
    installationId: installation.id,
    offerId: hit.offer_id,
    variantId: hit.variant_id,
  };
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "installation",
    aggregateId: installation.id,
    eventType: "installation.variant_selected",
    actor: ctx.actor,
    payload: evidence,
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "installation.variant.select",
    resource: "installation",
    allowed: true,
    details: evidence,
  });
  return { installationId: installation.id, offerId: hit.offer_id, variantId: hit.variant_id };
}

export type WorkbookLine = {
  position: number;
  // F7-12: Domain-Referenz für Nachbestellungen (UUID, kein Geheimnis).
  lineDomainId: string;
  name: string;
  quantity: string;
  unit: string;
  grossCents: number;
};

export type WorkbookSection = {
  position: number;
  category: string;
  title: string;
  lines: WorkbookLine[];
};

export type InstallationWorkbook = {
  installationId: string;
  projectId: string;
  offerId: string;
  offerNumber: string | null;
  variantId: string;
  variantName: string;
  revision: number;
  sections: WorkbookSection[];
  visibleGrossCents: number;
  // F7-10: Aggregate aus dem versiegelten Snapshot (keine Rohdaten).
  capacities: CertifiedCapacities;
};

function formatQuantity(quantityMilli: number, unit: string): string {
  if (unit === "meter") return `${(quantityMilli / 1000).toLocaleString("de-DE")} m`;
  return `${(quantityMilli / 1000).toLocaleString("de-DE")} ${unit}`;
}

// F7-10: flache Watt-Sicht auf die diskriminierten Katalogdaten; der
// Projektor validiert Schema-Passung und Wertebereiche fail-closed.
function capacityWatts(data: CatalogTechnicalDataV1): {
  nominalPowerWatts?: number;
  nominalAcPowerWatts?: number;
  usableCapacityWh?: number;
  maxChargingPowerWatts?: number;
} {
  switch (data.schemaVersion) {
    case "module.v1": return { nominalPowerWatts: data.nominalPowerWatts };
    case "inverter.v1": return { nominalAcPowerWatts: data.nominalAcPowerWatts };
    case "battery.v1": return { usableCapacityWh: data.usableCapacityWh };
    case "wallbox.v1": return { maxChargingPowerWatts: data.maxChargingPowerWatts };
    default: return {};
  }
}

export async function getInstallationWorkbook(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string },
): Promise<InstallationWorkbook | null> {
  requireWorkbookRead(ctx);
  const parsed = z.strictObject({ projectId: uuidSchema }).safeParse(query);
  if (!parsed.success) throw new InstallationValidationError();

  const linked = await tx.execute<{
    installation_id: string;
    offer_id: string;
    offer_number: string | null;
    variant_id: string;
    variant_name: string;
    revision: number;
    revision_snapshot: unknown;
    snapshot_sha256_hex: string;
    [key: string]: unknown;
  }>(sql`
    select installation.id as installation_id,
           offer_record.id as offer_id, offer_record.offer_number,
           variant.id as variant_id, variant.name as variant_name,
           revision.revision,
           revision.revision_snapshot,
           encode(revision.snapshot_sha256, 'hex') as snapshot_sha256_hex
      from installation
      join offer as offer_record
        on offer_record.workspace_id = installation.workspace_id
       and offer_record.id = installation.offer_id
      join offer_variant as variant
        on variant.workspace_id = installation.workspace_id
       and variant.id = installation.variant_id
       and variant.offer_id = offer_record.id
      join offer_variant_revision as revision
        on revision.workspace_id = installation.workspace_id
       and revision.offer_id = offer_record.id
       and revision.variant_id = variant.id
       and revision.revision = variant.current_revision
     where installation.workspace_id = ${ctx.workspaceId}::uuid
       and installation.project_id = ${parsed.data.projectId}::uuid
     limit 1
  `);
  const row = linked.rows[0];
  if (!row) return null;
  const validated = validateOfferVariantSnapshot(row.revision_snapshot);
  if (!validated.ok || validated.value.snapshotSha256 !== row.snapshot_sha256_hex) {
    throw new OfferIntegrityError();
  }
  const sections: WorkbookSection[] = validated.value.sections
    .slice()
    .sort((left, right) => left.position - right.position)
    .map((section) => ({
      position: section.position,
      category: section.category,
      title: section.title,
      lines: section.lines
        .filter((line) => !line.isHidden)
        .slice()
        .sort((left, right) => left.position - right.position)
        .map((line) => ({
          position: line.position,
          lineDomainId: line.lineDomainId,
          name: line.product.displayName,
          quantity: formatQuantity(line.quantityMilli, line.product.unit),
          unit: line.product.unit,
          grossCents: line.computed.salesGrossCents,
        })),
    }));
  const visibleGrossCents = sections.reduce(
    (sum, section) => sum + section.lines.reduce((inner, line) => inner + line.grossCents, 0),
    0,
  );
  // F7-10: Rollups aus dem VOLLEN Snapshot (technicalData ist hier
  // vorhanden; an den Client gehen nur die Aggregate im Typ oben).
  const capacities = deriveCertifiedCapacities(
    validated.value.sections.flatMap((section) => section.lines.map((line) => ({
      positionType: line.positionType,
      isHidden: line.isHidden,
      quantityMilli: line.quantityMilli,
      componentCategory: line.componentCategory,
      productKind: line.product.kind,
      technicalData: line.product.kind === "catalog" ? {
        schemaVersion: line.product.technicalData.schemaVersion,
        ...capacityWatts(line.product.technicalData),
      } : null,
    }))),
  );
  return {
    installationId: row.installation_id,
    projectId: parsed.data.projectId,
    offerId: row.offer_id,
    offerNumber: row.offer_number,
    variantId: row.variant_id,
    variantName: row.variant_name,
    revision: Number(row.revision),
    sections,
    visibleGrossCents,
    capacities,
  };
}
