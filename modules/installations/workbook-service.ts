// F7-08 Workbook: zu installierende Variante + Stückliste (lesend).
// F7-10: kWp/kWh-Rollups aus demselben Snapshot (F7-09-Projektor).
//
// Explizite Varianten-Bindung (kein Eingriff in den versiegelten
// Signatur-Ablauf) und Read-only-Projektion aus dem hash-geprüften
// Current-Revision-Snapshot. Keine Einkaufspreise (Monteur-Sicht),
// nur sichtbare Zeilen, keine erfundene Physik (Custom-Positionen
// tragen keine zertifizierte Leistung).
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  deriveCertifiedCapacities,
  type CertifiedCapacities,
} from "@/lib/integrations/offers/certified-capacities";
import type { SchematicSectionInput } from "@/lib/integrations/schematic/single-line-v1";
import type { CatalogTechnicalDataV1 } from "@/lib/integrations/catalog/contract";
import {
  canonicalizeOfferJson,
  validateOfferVariantSnapshot,
} from "@/lib/integrations/offers/contract";
import { resolveObjectStorage } from "@/lib/storage";
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

// F7-02K: Datenblatt-Referenz für den Datenblatt-Punkt (Anzeige-
// Projektion wie 02j: Produktname + Dateiname + Komponenten-ID für den
// Link auf die Katalogseite; keine Storage-Keys, kein sha, keine Preise).
export type WorkbookDatasheetRef = {
  productName: string;
  filename: string;
  componentId: string;
};

export type WorkbookLine = {
  position: number;
  // F7-12: Domain-Referenz für Nachbestellungen (UUID, kein Geheimnis).
  lineDomainId: string;
  name: string;
  quantity: string;
  unit: string;
  grossCents: number;
  // F7-02K: Datenblatt-Referenz (nur Anzeige — NIE objectKey/sha; Custom-
  // und asset-lose Zeilen tragen null, versteckte Zeilen entfallen oben).
  datasheet: WorkbookDatasheetRef | null;
};

export type WorkbookSection = {
  position: number;
  category: string;
  title: string;
  // F7-11: summiertes Mengenlabel aus Rohwerten (serverseitig befüllt,
  // Regel wie Angebots-SchematicCard; gemischt/leer → null).
  quantityLabel: string | null;
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

// F7-11: Mengenlabel aus Rohwerten (Regel wie Angebots-SchematicCard:
// genau eine Einheit über SICHTBARE Zeilen → summiertes Label;
// gemischt/leer/nur versteckt → null). Eingabe sind Milli-Mengen +
// Einheiten aus dem Snapshot-Mapping — nie aus formatierten Strings.
export function deriveSectionQuantityLabel(
  lines: ReadonlyArray<{ quantityMilli: number; unit: string; isHidden: boolean }>,
): string | null {
  const visible = lines.filter((line) => !line.isHidden);
  const units = new Set(visible.map((line) => line.unit));
  if (units.size !== 1) return null;
  return formatQuantity(
    visible.reduce((sum, line) => sum + line.quantityMilli, 0),
    visible[0]!.unit,
  );
}

// F7-03E: flache Stückliste für {{komponenten}} (Anzeige-Substitution).
// Projektions-Reihenfolge (positions-sortiert, F7-08), nur Menge+Name,
// keine Preise (Monteur-Sicht). Leere Liste → "" (Muster steht ehrlich).
export function formatWorkbookComponentsText(sections: WorkbookSection[]): string {
  return sections
    .flatMap((section) => section.lines.map((line) => `${line.quantity} ${line.name}`))
    .join(", ");
}

// F7-02J: strukturierte Stückliste für den Komponentenlisten-Punkt
// (Anzeige-Projektion wie 03e: Titel + je Zeile Menge+Name, keine Preise,
// keine IDs). Leere Sektionen fallen raus (ehrlicher Fallback oben).
export type WorkbookComponentSection = {
  section: string;
  lines: Array<{ quantity: string; name: string }>;
};

export function projectWorkbookComponentSections(
  sections: WorkbookSection[],
): WorkbookComponentSection[] {
  return sections
    .filter((section) => section.lines.length > 0)
    .map((section) => ({
      section: section.title,
      lines: section.lines.map((line) => ({
        quantity: line.quantity,
        name: line.name,
      })),
    }));
}

// F7-11: reiner Mapper Workbook → Schaltplan-Eingaben (nah am Typ,
// neben projectWorkbookComponentSections, keine neue Schicht):
// zeilenlose Sektionen raus (Angebots-Präzedenz); unbekannte Kategorie
// fail-closed → "other" (landet in der unwired-Hinweisliste, nie Crash);
// keine Preise, keine Keys, keine PII.
function toSchematicCategory(category: string): SchematicSectionInput["category"] {
  switch (category) {
    case "module":
    case "inverter":
    case "battery":
    case "wallbox":
    case "heat_pump":
    case "mounting":
    case "other":
      return category;
    default:
      return "other";
  }
}

export function toSchematicInputs(sections: WorkbookSection[]): SchematicSectionInput[] {
  return sections
    .filter((section) => section.lines.length > 0)
    .map((section) => ({
      category: toSchematicCategory(section.category),
      title: section.title,
      quantityLabel: section.quantityLabel,
    }));
}

// F7-02K: flache Datenblatt-Referenzen für den Datenblatt-Punkt (nur
// Zeilen mit Referenz, in Projektions-Reihenfolge; keine Keys, kein
// sha, keine Preise — Links zeigen auf die berechtigungsgeprüfte
// Katalogseite).
export function projectWorkbookDatasheets(
  sections: WorkbookSection[],
): WorkbookDatasheetRef[] {
  return sections.flatMap((section) => section.lines.flatMap((line) =>
    line.datasheet === null ? [] : [line.datasheet]));
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
      // F7-11: Label aus Rohwerten des versiegelten Snapshots (der Helper
      // filtert versteckte Zeilen selbst — Regel wie SchematicCard).
      quantityLabel: deriveSectionQuantityLabel(section.lines.map((line) => ({
        quantityMilli: line.quantityMilli,
        unit: line.product.unit,
        isHidden: line.isHidden,
      }))),
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
          // F7-02K: nur Katalogzeilen mit Datenblatt-Asset tragen eine
          // Referenz (Custom-/asset-lose Zeilen → null; NIE Keys/sha).
          datasheet: line.product.kind === "catalog"
            && line.source.kind === "catalog"
            && line.product.datasheet !== null
            ? {
              productName: line.product.displayName,
              filename: line.product.datasheet.originalFilename,
              componentId: line.source.catalogComponentId,
            }
            : null,
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

// F7-02K2: Datenblatt-Bytes der GEBUNDENEN Variante (versiegelter Snapshot,
// kein Live-Katalog — Snapshot-Konsistenz; keine neue Permission —
// requireWorkbookRead, die Route gatet zusaetzlich checklist.read).
export type ReadWorkbookDatasheetInput = {
  projectId: string;
  componentId: string;
};

export type WorkbookDatasheetDownload = {
  filename: string;
  body: Buffer;
};

// 25 MiB (PROJECT_FILE_MAX_BYTES-Praezedenz: Plaene/Datenblaetter-PDFs).
const WORKBOOK_DATASHEET_MAX_BYTES = 26_214_400;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const PDF_MAGIC = "%PDF";

// Struktureller Minimalschnitt statt Voll-Validierung: Asset-Defekte
// (Rolle/MIME/Key) sind ValidationError (400), kein Integritaetsschaden;
// das Siegel (kanonischer sha) wird trotzdem hart geprueft.
const workbookDatasheetSnapshotSchema = z.object({
  snapshotSha256: z.string(),
  sections: z.array(z.object({
    position: z.number(),
    lines: z.array(z.object({
      position: z.number(),
      isHidden: z.boolean(),
      product: z.object({
        kind: z.string(),
        // Custom-Zeilen tragen keinen datasheet-Key (nullish, nie Pflicht).
        datasheet: z.object({
          role: z.string(),
          objectKey: z.string(),
          sha256: z.string(),
          mediaType: z.string(),
          originalFilename: z.string(),
        }).nullish(),
      }),
      source: z.object({
        kind: z.string(),
        catalogComponentId: z.string().optional(),
      }),
    })),
  })),
});

export async function readWorkbookDatasheet(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ReadWorkbookDatasheetInput,
): Promise<WorkbookDatasheetDownload> {
  // Guard 1: uuid (lowercased).
  const parsed = z.strictObject({
    projectId: uuidSchema,
    componentId: uuidSchema,
  }).safeParse(input);
  if (!parsed.success) throw new InstallationValidationError();
  // Guard 2: installation.read VOR dem Snapshot-Read.
  requireWorkbookRead(ctx);
  const linked = await tx.execute<{
    installation_id: string;
    revision_snapshot: unknown;
    snapshot_sha256_hex: string;
    [key: string]: unknown;
  }>(sql`
    select installation.id as installation_id,
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
  // Guard 3: Bindung fehlt → NotFound uniform.
  if (!row) throw new InstallationNotFoundError(parsed.data.projectId);
  // Siegel + Struktur (Z.374-376-Muster): Bruch/Unlesbarkeit → Integrity.
  const raw = row.revision_snapshot;
  if (typeof raw !== "object" || raw === null) throw new OfferIntegrityError();
  const { snapshotSha256, ...snapshotBody } = raw as Record<string, unknown>;
  const resealed = createHash("sha256")
    .update(canonicalizeOfferJson(snapshotBody), "utf8")
    .digest("hex");
  if (
    typeof snapshotSha256 !== "string"
    || snapshotSha256 !== row.snapshot_sha256_hex
    || resealed !== row.snapshot_sha256_hex
  ) {
    throw new OfferIntegrityError();
  }
  const structural = workbookDatasheetSnapshotSchema.safeParse(row.revision_snapshot);
  if (!structural.success) throw new OfferIntegrityError();
  // Erster Treffer in Projektionsreihenfolge (positions-sortiert, ohne
  // versteckte Zeilen — keine Bytes ohne sichtbare Ref).
  const ordered = structural.data.sections
    .slice()
    .sort((left, right) => left.position - right.position)
    .flatMap((section) => section.lines
      .filter((line) => !line.isHidden)
      .slice()
      .sort((left, right) => left.position - right.position));
  const hit = ordered.find((line) =>
    line.product.kind === "catalog"
    && line.source.kind === "catalog"
    && line.source.catalogComponentId === parsed.data.componentId);
  // Guard 3: Zeile/Asset fehlt → NotFound uniform (fremd/fehlend/leer).
  const asset = hit?.product.datasheet ?? null;
  if (!hit || asset === null) throw new InstallationNotFoundError(parsed.data.projectId);
  // Guard 4: MIME-Pin (role=datasheet erzwingt application/pdf).
  if (asset.role !== "datasheet" || asset.mediaType !== "application/pdf") {
    throw new InstallationValidationError("datasheet asset mismatch");
  }
  // Guard 5: Key-Rebuild (kein Echo fremder Keys, Traversal tot).
  if (!SHA256_HEX_PATTERN.test(asset.sha256)) {
    throw new InstallationValidationError("datasheet asset mismatch");
  }
  const expectedKey = [
    "catalog",
    ctx.workspaceId,
    parsed.data.componentId,
    `${asset.sha256}.pdf`,
  ].join("/");
  if (asset.objectKey !== expectedKey) {
    throw new InstallationValidationError("datasheet asset mismatch");
  }
  // Guard 6: fehlendes Objekt → NotFound (Normalfall, kein Writer).
  let stored: { body: Buffer; contentType: string };
  try {
    stored = await resolveObjectStorage().get(expectedKey);
  } catch (error) {
    // Integritaetsbruch ohne Key-Echo (Key-Leak-Verbot) als Integrity.
    if (error instanceof Error && error.message.includes("Integritätsbruch")) {
      throw new OfferIntegrityError();
    }
    throw new InstallationNotFoundError(parsed.data.projectId);
  }
  const bytes = stored.body;
  // Guard 7: sha-Rueckvergleich (Katalog-Keys ohne Backend-Pin).
  if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256) {
    throw new OfferIntegrityError();
  }
  // Guard 8: 1 .. 25 MiB.
  if (bytes.byteLength < 1 || bytes.byteLength > WORKBOOK_DATASHEET_MAX_BYTES) {
    throw new OfferIntegrityError();
  }
  // Guard 9: Magic-Bytes %PDF.
  if (
    bytes.byteLength < PDF_MAGIC.length
    || bytes.subarray(0, PDF_MAGIC.length).toString("latin1") !== PDF_MAGIC
  ) {
    throw new OfferIntegrityError();
  }
  // Guard 10: Dateiname 1..180 (Contract-Max).
  if (asset.originalFilename.length < 1 || asset.originalFilename.length > 180) {
    throw new OfferIntegrityError();
  }
  return { filename: asset.originalFilename, body: bytes };
}
