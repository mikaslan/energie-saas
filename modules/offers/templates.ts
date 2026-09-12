// F16-06 Angebots-Vorlagen — Template-CRUD + Anwenden je Variante.
// Kein "server-only" (konsistent mit Payment-/Discount-Modulen).
// Keine neuen Permissions: discount_template.read/discount_template.write
// für die Verwaltung; den Angebots-Schreibschutz (project.write) prüft der
// Angebots-Pfad selbst (setVariantPaymentOption/reviseOfferVariant).
// F16-09: drittes Preset Förder-Vorlage (subsidy_template), gleiche
// Leseschranke (subsidy_template.read, Viewer-ok), ein Revisions-Call.
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  OFFER_TEMPLATE_SCHEMA_VERSION,
  applyOfferTemplateCommandSchema,
  archiveOfferTemplateCommandSchema,
  createOfferTemplateCommandSchema,
  offerTemplateDtoSchema,
  updateOfferTemplateCommandSchema,
  type ApplyOfferTemplateCommand,
  type ArchiveOfferTemplateCommand,
  type CreateOfferTemplateCommand,
  type OfferTemplateDto,
  type UpdateOfferTemplateCommand,
} from "@/lib/integrations/offers/template-contract";
import {
  OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
  OFFER_VARIANT_REVISE_COMMAND_VERSION,
} from "@/lib/integrations/offers/contract";
import {
  applyPlanningTemplateCommandSchema,
  type ApplyPlanningTemplateCommand,
} from "@/lib/integrations/planning/template-contract";
import {
  findActivePlanningTemplate,
  PlanningTemplateNotFoundError,
  PlanningTemplateValidationError,
} from "@/modules/planning";
import {
  DISCOUNT_KIND_FIX,
  DISCOUNT_KIND_PERCENT,
} from "@/lib/integrations/discounts/contract";
import {
  SUBSIDY_KIND_FIX,
  SUBSIDY_KIND_PERCENT,
} from "@/lib/integrations/subsidies/contract";
import {
  DiscountTemplateNotFoundError,
  DiscountTemplateValidationError,
} from "@/modules/discounts";
import {
  SubsidyTemplateNotFoundError,
  SubsidyTemplateValidationError,
} from "@/modules/subsidies";
import {
  reviseOfferVariant,
  setVariantPaymentOption,
  type OfferMutationResult,
} from "./service";

export class OfferTemplateNotFoundError extends Error {
  constructor() {
    super("offer template was not found");
    this.name = "OfferTemplateNotFoundError";
  }
}

export class OfferTemplateConflictError extends Error {
  constructor() {
    super("offer template name is taken");
    this.name = "OfferTemplateConflictError";
  }
}

export class OfferTemplateValidationError extends Error {
  constructor(message = "offer_template validation failed") {
    super(message);
    this.name = "OfferTemplateValidationError";
  }
}

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "discount_template.read")) {
    throw new PermissionDeniedError("discount_template.read", "offer_template", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "discount_template.write")) {
    throw new PermissionDeniedError("discount_template.write", "offer_template", undefined, ctx.actor);
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

export function normalizeOfferTemplateName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

type TemplateRow = {
  id: string;
  name: string;
  payment_option_id: string | null;
  discount_template_id: string | null;
  subsidy_template_id: string | null;
  position: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const TEMPLATE_SELECT = sql`
  select id, name, payment_option_id, discount_template_id,
         subsidy_template_id, position, active, created_at, updated_at
    from offer_template
`;

// Aktive Preset-Zeile aus discount_template/subsidy_template (gleiche
// Spaltenform beider F16.3-Tabellen): nur aktive Vorlagen sind anwendbar,
// der Aufrufer wirft die NotFound-Fehler der Fachmodule.
type PresetTemplateRow = {
  id: string;
  kind: string;
  amount_cents: number | null;
  percent_bps: number | null;
  cap_cents: number | null;
};

function toDto(row: TemplateRow, canWrite: boolean): OfferTemplateDto {
  return offerTemplateDtoSchema.parse({
    schemaVersion: OFFER_TEMPLATE_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    paymentOptionId: row.payment_option_id,
    discountTemplateId: row.discount_template_id,
    subsidyTemplateId: row.subsidy_template_id,
    position: row.position,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

// Referenzierte Stammdaten müssen im selben Workspace liegen (FK sichert
// nur die Existenz). Archivierte Zahlarten / inaktive Rabatt-Vorlagen sind
// als Referenz speicherbar (Historienbindung), aber nicht anwendbar.
async function assertPresetReferences(
  tx: TenantTx,
  ctx: ServiceCtx,
  paymentOptionId: string | null | undefined,
  discountTemplateId: string | null | undefined,
  subsidyTemplateId: string | null | undefined,
): Promise<void> {
  if (paymentOptionId != null) {
    const option = await tx.execute<{ id: string }>(sql`
      select id from payment_option
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${paymentOptionId}::uuid
       limit 1
    `);
    if (!option.rows[0]) throw new OfferTemplateValidationError("Zahlart ist nicht belegt");
  }
  if (discountTemplateId != null) {
    const template = await tx.execute<{ id: string }>(sql`
      select id from discount_template
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${discountTemplateId}::uuid
       limit 1
    `);
    if (!template.rows[0]) throw new OfferTemplateValidationError("Rabatt-Vorlage ist nicht belegt");
  }
  if (subsidyTemplateId != null) {
    const template = await tx.execute<{ id: string }>(sql`
      select id from subsidy_template
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${subsidyTemplateId}::uuid
       limit 1
    `);
    if (!template.rows[0]) throw new OfferTemplateValidationError("Förder-Vorlage ist nicht belegt");
  }
}

export async function listOfferTemplates(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { includeArchived?: boolean } = {},
): Promise<OfferTemplateDto[]> {
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

export async function createOfferTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateOfferTemplateCommand,
): Promise<OfferTemplateDto> {
  requireWrite(ctx);
  const parsed = createOfferTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new OfferTemplateValidationError();
  const command = parsed.data;
  await assertPresetReferences(tx, ctx, command.paymentOptionId, command.discountTemplateId, command.subsidyTemplateId);

  let row: TemplateRow;
  try {
    const inserted = await tx.execute<TemplateRow>(sql`
      insert into offer_template (
        workspace_id, name, name_normalized, payment_option_id,
        discount_template_id, subsidy_template_id, position, created_by
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.name},
        ${normalizeOfferTemplateName(command.name)},
        ${command.paymentOptionId ?? null}::uuid,
        ${command.discountTemplateId ?? null}::uuid,
        ${command.subsidyTemplateId ?? null}::uuid,
        ${command.position ?? 0},
        ${ctx.actor}::uuid
      )
      returning id, name, payment_option_id, discount_template_id,
                subsidy_template_id, position, active, created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new OfferTemplateConflictError();
    if (code === "23514" || code === "23503") throw new OfferTemplateValidationError();
    throw error;
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "offer_template",
    aggregateId: row.id,
    eventType: "offer_template.created",
    actor: ctx.actor,
    payload: { name: command.name },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "offer_template.write",
    resource: "offer_template",
    allowed: true,
    details: { name: command.name },
  });
  return toDto(row, true);
}

export async function updateOfferTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdateOfferTemplateCommand,
): Promise<OfferTemplateDto> {
  requireWrite(ctx);
  const parsed = updateOfferTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new OfferTemplateValidationError();
  const command = parsed.data;
  await assertPresetReferences(tx, ctx, command.paymentOptionId, command.discountTemplateId, command.subsidyTemplateId);

  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update offer_template
         set name = ${command.name},
             name_normalized = ${normalizeOfferTemplateName(command.name)},
             payment_option_id = ${command.paymentOptionId ?? null}::uuid,
             discount_template_id = ${command.discountTemplateId ?? null}::uuid,
             subsidy_template_id = ${command.subsidyTemplateId ?? null}::uuid,
             position = ${command.position},
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
      returning id, name, payment_option_id, discount_template_id,
                subsidy_template_id, position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new OfferTemplateConflictError();
    if (code === "23514" || code === "23503") throw new OfferTemplateValidationError();
    throw error;
  }
  if (!rows[0]) throw new OfferTemplateNotFoundError();
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "offer_template",
    aggregateId: command.id,
    eventType: "offer_template.updated",
    actor: ctx.actor,
    payload: { name: command.name },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "offer_template.write",
    resource: "offer_template",
    allowed: true,
    details: { id: command.id },
  });
  return toDto(rows[0], true);
}

async function setTemplateActive(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveOfferTemplateCommand,
): Promise<OfferTemplateDto> {
  requireWrite(ctx);
  const parsed = archiveOfferTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new OfferTemplateValidationError();
  const command = parsed.data;
  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update offer_template
         set active = ${command.active},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
         and active is distinct from ${command.active}
      returning id, name, payment_option_id, discount_template_id,
                subsidy_template_id, position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new OfferTemplateConflictError();
    if (code === "23514") throw new OfferTemplateValidationError();
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
    if (!current.rows[0]) throw new OfferTemplateNotFoundError();
    return toDto(current.rows[0], true);
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "offer_template",
    aggregateId: command.id,
    eventType: command.active ? "offer_template.restored" : "offer_template.archived",
    actor: ctx.actor,
    payload: {},
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "offer_template.write",
    resource: "offer_template",
    allowed: true,
    details: { id: command.id, active: command.active },
  });
  return toDto(row, true);
}

export function archiveOfferTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveOfferTemplateCommand,
): Promise<OfferTemplateDto> {
  return setTemplateActive(tx, ctx, { ...input, active: false });
}

export function restoreOfferTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ArchiveOfferTemplateCommand,
): Promise<OfferTemplateDto> {
  return setTemplateActive(tx, ctx, { ...input, active: true });
}

export type ApplyOfferTemplateResult = OfferMutationResult & {
  templateId: string;
  paymentOptionApplied: boolean;
  discountApplied: boolean;
  subsidyApplied: boolean;
};

// Vorlage an einer Variante anwenden: Rabatt + Förderung in EINER Revision
// (revisionsgeführt, fail-closed bei veralteter Revision), danach die
// Zahlart (ohne Revisionsbindung, kein Revisionsbump). Eine Revision je
// Anwenden ist kein Stil, sondern DB-Invariant: der Deferred-Mirror-Trigger
// verlangt current_revision = höchste Revision je Transaktion, zwei Revises
// in einer Tx committen nie. Rabatt und Förderung teilen sich je Kind einen
// Slot (Prozent → globalDiscountBps, Fix → globalFixDiscountCents): Ordnung
// Rabatt zuerst, Förderung danach — der spätere Schritt gewinnt, Flags +
// Payload machen das sichtbar. Archivierte Zahlarten / inaktive
// Rabatt-/Förder-Vorlagen sind nicht anwendbar (NotFound der Fachmodule,
// Fehlermeldungen wörtlich wie dort).
export async function applyOfferTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ApplyOfferTemplateCommand,
): Promise<ApplyOfferTemplateResult> {
  requireWrite(ctx);
  const parsed = applyOfferTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new OfferTemplateValidationError();
  const command = parsed.data;
  const found = await tx.execute<TemplateRow>(sql`
    ${TEMPLATE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     and id = ${command.templateId}::uuid
     and active = true
   limit 1
  `);
  const template = found.rows[0];
  if (!template) throw new OfferTemplateNotFoundError();

  type GlobalOperation =
    | { operation: "set_global_discount"; discountBps: number; capCents: number | null }
    | { operation: "set_global_fix_discount"; fixDiscountCents: number };
  const operations: GlobalOperation[] = [];
  let discountApplied = false;
  let subsidyApplied = false;
  if (template.discount_template_id !== null) {
    const found = await tx.execute<PresetTemplateRow>(sql`
      select id, kind, amount_cents, percent_bps, cap_cents
        from discount_template
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${template.discount_template_id}::uuid
         and active = true
       limit 1
    `);
    const row = found.rows[0];
    if (!row) throw new DiscountTemplateNotFoundError(template.discount_template_id);
    if (row.kind === DISCOUNT_KIND_FIX) {
      if (row.amount_cents === null) {
        throw new DiscountTemplateValidationError("Fix-Vorlage ohne Betrag ist nicht anwendbar");
      }
      operations.push({ operation: "set_global_fix_discount", fixDiscountCents: row.amount_cents });
    } else if (row.kind === DISCOUNT_KIND_PERCENT && row.percent_bps !== null) {
      operations.push({ operation: "set_global_discount", discountBps: row.percent_bps, capCents: row.cap_cents });
    } else {
      throw new DiscountTemplateValidationError("nur Prozent-Vorlagen sind global anwendbar");
    }
    discountApplied = true;
  }
  if (template.subsidy_template_id !== null) {
    const found = await tx.execute<PresetTemplateRow>(sql`
      select id, kind, amount_cents, percent_bps, cap_cents
        from subsidy_template
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${template.subsidy_template_id}::uuid
         and active = true
       limit 1
    `);
    const row = found.rows[0];
    if (!row) throw new SubsidyTemplateNotFoundError(template.subsidy_template_id);
    if (row.kind === SUBSIDY_KIND_FIX) {
      if (row.amount_cents === null) {
        throw new SubsidyTemplateValidationError("Fix-Vorlage ohne Betrag ist nicht anwendbar");
      }
      operations.push({ operation: "set_global_fix_discount", fixDiscountCents: row.amount_cents });
    } else if (row.kind === SUBSIDY_KIND_PERCENT && row.percent_bps !== null) {
      operations.push({ operation: "set_global_discount", discountBps: row.percent_bps, capCents: row.cap_cents });
    } else {
      throw new SubsidyTemplateValidationError("nur Prozent-Vorlagen sind global anwendbar");
    }
    subsidyApplied = true;
  }
  let result: OfferMutationResult | null = null;
  if (operations.length > 0) {
    result = await reviseOfferVariant(tx, ctx, {
      schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
      offerId: command.offerId,
      variantId: command.variantId,
      expectedRevision: command.expectedRevision,
      operations,
    });
  }
  let paymentOptionApplied = false;
  if (template.payment_option_id !== null) {
    const payment = await setVariantPaymentOption(tx, ctx, {
      schemaVersion: OFFER_VARIANT_PAYMENT_OPTION_COMMAND_VERSION,
      offerId: command.offerId,
      variantId: command.variantId,
      paymentOptionId: template.payment_option_id,
    });
    paymentOptionApplied = payment.changed;
    result = { offerId: payment.offerId, variantId: payment.variantId, revision: result?.revision ?? command.expectedRevision };
  }
  if (!result) throw new OfferTemplateValidationError("Vorlage ohne Preset ist nicht anwendbar");
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "offer_template",
    aggregateId: template.id,
    eventType: "offer_template.applied",
    actor: ctx.actor,
    payload: { offerId: result.offerId, variantId: result.variantId, discountApplied, subsidyApplied, paymentOptionApplied },
  });
  return { ...result, templateId: template.id, paymentOptionApplied, discountApplied, subsidyApplied };
}

// F16-08: Planungs-Vorlage an einer Variante anwenden (Modus-Preset via
// set_planning_mode-Revision, nur aktive Vorlagen; veraltete Revision und
// Varianten-Sperren meldet der Angebots-Pfad selbst — Offer-Fehler laufen
// transparent durch).
export async function applyPlanningTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ApplyPlanningTemplateCommand,
): Promise<OfferMutationResult & { templateId: string; mode: "quick" | "2d" | "3d" }> {
  if (!can(ctx, "planning.settings.read")) {
    throw new PermissionDeniedError("planning.settings.read", "planning_template", undefined, ctx.actor);
  }
  const parsed = applyPlanningTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new PlanningTemplateValidationError();
  const command = parsed.data;
  const template = await findActivePlanningTemplate(tx, ctx, command.templateId);
  if (!template) throw new PlanningTemplateNotFoundError();
  const result = await reviseOfferVariant(tx, ctx, {
    schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
    offerId: command.offerId,
    variantId: command.variantId,
    expectedRevision: command.expectedRevision,
    operations: [{ operation: "set_planning_mode", planningMode: template.mode }],
  });
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "planning_template",
    aggregateId: template.id,
    eventType: "planning_template.applied",
    actor: ctx.actor,
    payload: { offerId: result.offerId, variantId: result.variantId, mode: template.mode },
  });
  return { ...result, templateId: template.id, mode: template.mode };
}
