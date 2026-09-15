// F16-11 Paket-Vorlagen (Katalog F16.2, erster Offshoot) — Template-CRUD
// + Anwenden je Variante (Custom-Ebene ersetzen via Revise-Ops).
// Kein "server-only" (konsistent mit Angebots-Vorlagen).
// Keine neuen Permissions: discount_template.read/discount_template.write
// für die Verwaltung (gleiche Einstellungs-Familie wie F16-06); den
// Angebots-Schreibschutz (project.write + price.edit/price.read_purchase
// für add_custom_line) prüft der Angebots-Pfad selbst (reviseOfferVariant).
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  OFFER_VARIANT_REVISE_COMMAND_VERSION,
  type OfferVariantSnapshotV1,
  type ReviseOfferVariantOperationV1,
} from "@/lib/integrations/offers/contract";
import {
  PACKAGE_TEMPLATE_SCHEMA_VERSION,
  applyPackageTemplateCommandSchema,
  archivePackageTemplateCommandSchema,
  createPackageTemplateCommandSchema,
  packageTemplateDtoSchema,
  packageTemplateLinesSchema,
  updatePackageTemplateCommandSchema,
  type ApplyPackageTemplateCommand,
  type ArchivePackageTemplateCommand,
  type CreatePackageTemplateCommand,
  type PackageTemplateCategory,
  type PackageTemplateDto,
  type PackageTemplateLine,
  type UpdatePackageTemplateCommand,
} from "@/lib/integrations/offers/package-contract";
import {
  OfferConflictError,
  OfferIntegrityError,
  readValidatedRevision,
  reviseOfferVariant,
  type OfferMutationResult,
} from "./service";

export class PackageTemplateNotFoundError extends Error {
  constructor() {
    super("package template was not found");
    this.name = "PackageTemplateNotFoundError";
  }
}

export class PackageTemplateConflictError extends Error {
  constructor() {
    super("package template name is taken");
    this.name = "PackageTemplateConflictError";
  }
}

export class PackageTemplateValidationError extends Error {
  constructor(message = "package_template validation failed") {
    super(message);
    this.name = "PackageTemplateValidationError";
  }
}

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "discount_template.read")) {
    throw new PermissionDeniedError("discount_template.read", "package_template", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "discount_template.write")) {
    throw new PermissionDeniedError("discount_template.write", "package_template", undefined, ctx.actor);
  }
}

function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}

export function normalizePackageTemplateName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

type TemplateRow = {
  id: string;
  name: string;
  section_title: string;
  category: string;
  package_lines: unknown;
  position: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const TEMPLATE_SELECT = sql`
  select id, name, section_title, category, package_lines,
         position, active, created_at, updated_at
    from package_template
`;

// Gespeicherte Paket-Zeilen lesen (DB-Check sichert Array + Cap;
// fremde Formen entfallen defensiv — Schreiben validiert strikt,
// das DTO-Schema parst den Rest exakt).
function storedPackageLines(value: unknown): PackageTemplateLine[] {
  if (!Array.isArray(value)) return [];
  const parsed = packageTemplateLinesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
}

function linesJsonLiteral(lines: readonly PackageTemplateLine[]) {
  return sql`${JSON.stringify(lines)}::jsonb`;
}

function toDto(row: TemplateRow, canWrite: boolean): PackageTemplateDto {
  return packageTemplateDtoSchema.parse({
    schemaVersion: PACKAGE_TEMPLATE_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    sectionTitle: row.section_title,
    category: row.category,
    lines: storedPackageLines(row.package_lines),
    position: row.position,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

export async function listPackageTemplates(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { includeArchived?: boolean } = {},
): Promise<PackageTemplateDto[]> {
  requireRead(ctx);
  const includeArchived = query.includeArchived === true;
  const result = await tx.execute<TemplateRow>(sql`
    ${TEMPLATE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     ${includeArchived ? sql`` : sql`and active = true`}
   order by position asc, name asc, id asc
  `);
  const write = can(ctx, "discount_template.write");
  return result.rows.map((row) => toDto(row, write));
}

export async function createPackageTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreatePackageTemplateCommand,
): Promise<PackageTemplateDto> {
  requireWrite(ctx);
  const parsed = createPackageTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new PackageTemplateValidationError();
  const command = parsed.data;

  let row: TemplateRow;
  try {
    const inserted = await tx.execute<TemplateRow>(sql`
      insert into package_template (
        workspace_id, name, name_normalized, section_title, category,
        package_lines, position, created_by
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.name},
        ${normalizePackageTemplateName(command.name)},
        ${command.sectionTitle},
        ${command.category},
        ${linesJsonLiteral(command.lines)},
        ${command.position ?? 0},
        ${ctx.actor}::uuid
      )
      returning id, name, section_title, category, package_lines,
                position, active, created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new PackageTemplateConflictError();
    if (code === "23514") throw new PackageTemplateValidationError();
    throw error;
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "package_template",
    aggregateId: row.id,
    eventType: "package_template.created",
    actor: ctx.actor,
    payload: { name: command.name, lineCount: command.lines.length },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "package_template.write",
    resource: "package_template",
    allowed: true,
    details: { name: command.name },
  });
  return toDto(row, true);
}

export async function updatePackageTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdatePackageTemplateCommand,
): Promise<PackageTemplateDto> {
  requireWrite(ctx);
  const parsed = updatePackageTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new PackageTemplateValidationError();
  const command = parsed.data;

  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update package_template
         set name = ${command.name},
             name_normalized = ${normalizePackageTemplateName(command.name)},
             section_title = ${command.sectionTitle},
             category = ${command.category},
             package_lines = ${linesJsonLiteral(command.lines)},
             position = ${command.position},
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
      returning id, name, section_title, category, package_lines,
                position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new PackageTemplateConflictError();
    if (code === "23514") throw new PackageTemplateValidationError();
    throw error;
  }
  if (!rows[0]) throw new PackageTemplateNotFoundError();
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "package_template",
    aggregateId: command.id,
    eventType: "package_template.updated",
    actor: ctx.actor,
    payload: { name: command.name, lineCount: command.lines.length },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "package_template.write",
    resource: "package_template",
    allowed: true,
    details: { id: command.id },
  });
  return toDto(rows[0], true);
}

async function setTemplateActive(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchivePackageTemplateCommand,
): Promise<PackageTemplateDto> {
  requireWrite(ctx);
  const parsed = archivePackageTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new PackageTemplateValidationError();
  const command = parsed.data;
  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update package_template
         set active = ${command.active},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
         and active is distinct from ${command.active}
      returning id, name, section_title, category, package_lines,
                position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new PackageTemplateConflictError();
    if (code === "23514") throw new PackageTemplateValidationError();
    throw error;
  }
  const row = rows[0];
  if (!row) {
    const current = await tx.execute<TemplateRow>(sql`
      ${TEMPLATE_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.id}::uuid
     limit 1
    `);
    if (!current.rows[0]) throw new PackageTemplateNotFoundError();
    return toDto(current.rows[0], true);
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "package_template",
    aggregateId: command.id,
    eventType: command.active ? "package_template.restored" : "package_template.archived",
    actor: ctx.actor,
    payload: {},
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "package_template.write",
    resource: "package_template",
    allowed: true,
    details: { id: command.id, active: command.active },
  });
  return toDto(row, true);
}

export function archivePackageTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchivePackageTemplateCommand,
): Promise<PackageTemplateDto> {
  return setTemplateActive(tx, ctx, { ...input, active: false });
}

export function restorePackageTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchivePackageTemplateCommand,
): Promise<PackageTemplateDto> {
  return setTemplateActive(tx, ctx, { ...input, active: true });
}

type PackageApplyPlan = {
  operations: ReviseOfferVariantOperationV1[];
  removedSections: number;
  removedLines: number;
};

// Ersetzungsplan: Die frei editierbare (Custom-)Ebene der Variante
// weicht dem Paket. Rein-Custom-Sektionen fallen ganz, gemischte
// Sektionen verlieren nur ihre Custom-Zeilen; Katalog-Seed bleibt
// durch die M2-Invariante unangetastet (ESTIMATE, dokumentiert).
function planCustomLayerReplacement(
  snapshot: OfferVariantSnapshotV1,
  lines: readonly PackageTemplateLine[],
  sectionTitle: string,
  category: PackageTemplateCategory,
  zeroConfirmed: boolean,
): PackageApplyPlan {
  // F16-11b: 0-%-Zeilen nur mit frischer Bestätigung des Einsetzenden
  // (nie aus der Vorlage gelesen); 19-%-Zeilen bekommen nie eine
  // Bestätigung mit (Angebots-Regel, fail-closed).
  if (
    lines.some((line) => line.taxTreatment === "zero_operator_confirmed")
    && !zeroConfirmed
  ) {
    throw new PackageTemplateValidationError("0-%-Zeilen brauchen eine frische Bestätigung");
  }
  // Reihenfolge: Add zuerst (Position = Ende der gelesenen Liste, zu
  // dem Zeitpunkt gültig), dann Removes per Domain-ID (positionsfest),
  // dann Zeilen in die neue Sektion (1..n, stabil). Fremdänderung
  // dazwischen fängt der Revisions-CAS, nie ein Halbstand.
  const sectionDomainId = randomUUID();
  const operations: ReviseOfferVariantOperationV1[] = [{
    operation: "add_custom_section",
    sectionDomainId,
    position: snapshot.sections.length + 1,
    title: sectionTitle,
    category,
  }];
  let removedSections = 0;
  let removedLines = 0;
  for (const section of snapshot.sections) {
    const customLines = section.lines.filter((line) => line.source.kind === "custom");
    if (customLines.length === section.lines.length) {
      operations.push({ operation: "remove_custom_section", sectionDomainId: section.sectionDomainId });
      removedSections += 1;
      removedLines += customLines.length;
    } else {
      for (const line of customLines) {
        operations.push({ operation: "remove_custom_line", lineDomainId: line.lineDomainId });
        removedLines += 1;
      }
    }
  }
  lines.forEach((line, index) => {
    operations.push({
      operation: "add_custom_line",
      lineDomainId: randomUUID(),
      sectionDomainId,
      position: index + 1,
      displayName: line.displayName,
      description: line.description ?? null,
      unit: line.unit,
      quantityMilli: line.quantityMilli,
      salesUnitNetCents: line.salesUnitNetCents,
      purchaseUnitNetCents: line.purchaseUnitNetCents,
      positionType: line.positionType,
      isHidden: line.isHidden,
      taxTreatment: line.taxTreatment,
      ...(line.taxTreatment === "zero_operator_confirmed"
        ? {
          zeroConfirmation: {
            code: "zero_tax_draft_operator_confirmed",
            confirmed: true,
          } as const,
        }
        : {}),
    });
  });
  return { operations, removedSections, removedLines };
}

export type ApplyPackageTemplateResult = OfferMutationResult & {
  templateId: string;
  removedSections: number;
  removedLines: number;
  addedLines: number;
};

// F16-11: Paket-Vorlage an einer Variante anwenden (Custom-Ebene
// ersetzen, nur aktive Vorlagen; veraltete Revision und
// Varianten-Sperren meldet der Angebots-Pfad selbst — Offer-Fehler
// laufen transparent durch. Gleichzeitige Fremdänderung zwischen
// Plan und Revision fällt auf Conflict, nie auf Halbstand).
export async function applyPackageTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ApplyPackageTemplateCommand,
): Promise<ApplyPackageTemplateResult> {
  requireWrite(ctx);
  const parsed = applyPackageTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new PackageTemplateValidationError();
  const command = parsed.data;
  const found = await tx.execute<TemplateRow>(sql`
    ${TEMPLATE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     and id = ${command.templateId}::uuid
     and active = true
   limit 1
  `);
  const template = found.rows[0];
  if (!template) throw new PackageTemplateNotFoundError();
  const dto = toDto(template, true);

  const current = await tx.execute<{ current_revision: number }>(sql`
    select current_revision
      from offer_variant
     where workspace_id = ${ctx.workspaceId}::uuid
       and offer_id = ${command.offerId}::uuid
       and id = ${command.variantId}::uuid
     limit 1
  `);
  const revisionRow = current.rows[0];
  if (!revisionRow) throw new OfferIntegrityError();
  if (revisionRow.current_revision !== command.expectedRevision) {
    throw new OfferConflictError(revisionRow.current_revision);
  }
  const snapshot = await readValidatedRevision(
    tx, ctx, command.offerId, command.variantId, revisionRow.current_revision,
  );
  const plan = planCustomLayerReplacement(snapshot, dto.lines, dto.sectionTitle, dto.category, command.zeroConfirmed);
  const result = await reviseOfferVariant(tx, ctx, {
    schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
    offerId: command.offerId,
    variantId: command.variantId,
    expectedRevision: command.expectedRevision,
    operations: plan.operations,
  });
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "package_template",
    aggregateId: template.id,
    eventType: "package_template.applied",
    actor: ctx.actor,
    payload: {
      offerId: result.offerId,
      variantId: result.variantId,
      removedSections: plan.removedSections,
      removedLines: plan.removedLines,
      addedLines: dto.lines.length,
    },
  });
  return {
    ...result,
    templateId: template.id,
    removedSections: plan.removedSections,
    removedLines: plan.removedLines,
    addedLines: dto.lines.length,
  };
}
