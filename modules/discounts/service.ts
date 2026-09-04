// F16.3 Slice A Rabatt-Vorlagen — Template-CRUD + reine Apply-Funktion.
// Kein "server-only" (konsistent mit Checklisten-/Time-Modulen).
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  DISCOUNT_KIND_FIX,
  DISCOUNT_TEMPLATE_SCHEMA_VERSION,
  createDiscountTemplateCommandSchema,
  discountTemplateDtoSchema,
  updateDiscountTemplateCommandSchema,
  type CreateDiscountTemplateCommand,
  type DiscountTemplateDto,
  type UpdateDiscountTemplateCommand,
} from "@/lib/integrations/discounts/contract";
import {
  DiscountTemplateConflictError,
  DiscountTemplateNotFoundError,
  DiscountTemplateValidationError,
} from "./errors";

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "discount_template.read")) {
    throw new PermissionDeniedError("discount_template.read", "discount_template", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "discount_template.write")) {
    throw new PermissionDeniedError("discount_template.write", "discount_template", undefined, ctx.actor);
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

export function normalizeDiscountTemplateName(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

type TemplateRow = {
  id: string;
  name: string;
  kind: string;
  amount_cents: number | null;
  percent_bps: number | null;
  cap_cents: number | null;
  position: number;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const TEMPLATE_SELECT = sql`
  select id, name, kind, amount_cents, percent_bps, cap_cents,
         position, active, created_at, updated_at
    from discount_template
`;

function toDto(row: TemplateRow, canWrite: boolean): DiscountTemplateDto {
  return discountTemplateDtoSchema.parse({
    schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
    id: row.id,
    name: row.name,
    kind: row.kind,
    amountCents: row.amount_cents,
    percentBps: row.percent_bps,
    capCents: row.cap_cents,
    position: row.position,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

export async function listDiscountTemplates(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { includeArchived?: boolean } = {},
): Promise<DiscountTemplateDto[]> {
  requireRead(ctx);
  const includeArchived = query.includeArchived === true;
  const result = await tx.execute<TemplateRow>(sql`
    ${TEMPLATE_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     ${includeArchived ? sql`` : sql`and active = true`}
   order by position asc, name asc, id asc
  `);
  const canWrite = can(ctx, "discount_template.write");
  return result.rows.map((row) => toDto(row, canWrite));
}

export async function createDiscountTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateDiscountTemplateCommand,
): Promise<DiscountTemplateDto> {
  requireWrite(ctx);
  const parsed = createDiscountTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new DiscountTemplateValidationError();
  const command = parsed.data;

  let row: TemplateRow;
  try {
    const inserted = await tx.execute<TemplateRow>(sql`
      insert into discount_template (
        workspace_id, name, name_normalized, kind, amount_cents,
        percent_bps, cap_cents, position, created_by
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.name},
        ${normalizeDiscountTemplateName(command.name)},
        ${command.kind},
        ${command.amountCents},
        ${command.percentBps},
        ${command.capCents},
        ${command.position ?? 0},
        ${ctx.actor}::uuid
      )
      returning id, name, kind, amount_cents, percent_bps, cap_cents,
                position, active, created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new DiscountTemplateConflictError(command.name);
    if (code === "23514") throw new DiscountTemplateValidationError();
    throw error;
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "discount_template",
    aggregateId: row.id,
    eventType: "discount_template.created",
    actor: ctx.actor,
    payload: { name: command.name, kind: command.kind },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "discount_template.write",
    resource: "discount_template",
    allowed: true,
    details: { name: command.name },
  });
  return toDto(row, true);
}

export async function updateDiscountTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdateDiscountTemplateCommand,
): Promise<DiscountTemplateDto> {
  requireWrite(ctx);
  const parsed = updateDiscountTemplateCommandSchema.safeParse(input);
  if (!parsed.success) throw new DiscountTemplateValidationError();
  const command = parsed.data;

  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update discount_template
         set name = ${command.name},
             name_normalized = ${normalizeDiscountTemplateName(command.name)},
             kind = ${command.kind},
             amount_cents = ${command.amountCents},
             percent_bps = ${command.percentBps},
             cap_cents = ${command.capCents},
             position = ${command.position},
             updated_by = ${ctx.actor}::uuid,
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.id}::uuid
       returning id, name, kind, amount_cents, percent_bps, cap_cents,
                 position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new DiscountTemplateConflictError(command.name);
    if (code === "23514") throw new DiscountTemplateValidationError();
    throw error;
  }
  if (!rows[0]) throw new DiscountTemplateNotFoundError(command.id);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "discount_template",
    aggregateId: command.id,
    eventType: "discount_template.updated",
    actor: ctx.actor,
    payload: { name: command.name, kind: command.kind },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "discount_template.write",
    resource: "discount_template",
    allowed: true,
    details: { id: command.id },
  });
  return toDto(rows[0], true);
}

async function setTemplateActive(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
  active: boolean,
): Promise<DiscountTemplateDto> {
  requireWrite(ctx);
  let rows: TemplateRow[];
  try {
    const updated = await tx.execute<TemplateRow>(sql`
      update discount_template
         set active = ${active},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${id}::uuid
         and active is distinct from ${active}
       returning id, name, kind, amount_cents, percent_bps, cap_cents,
                 position, active, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new DiscountTemplateConflictError(id);
    if (code === "23514") throw new DiscountTemplateValidationError();
    throw error;
  }
  const row = rows[0];
  if (!row) {
    const current = await tx.execute<TemplateRow>(sql`
      ${TEMPLATE_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id}::uuid
     limit 1
    `);
    if (!current.rows[0]) throw new DiscountTemplateNotFoundError(id);
    return toDto(current.rows[0], true);
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "discount_template",
    aggregateId: id,
    eventType: active ? "discount_template.restored" : "discount_template.archived",
    actor: ctx.actor,
    payload: {},
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "discount_template.write",
    resource: "discount_template",
    allowed: true,
    details: { id, active },
  });
  return toDto(row, true);
}

export function archiveDiscountTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<DiscountTemplateDto> {
  return setTemplateActive(tx, ctx, id, false);
}

export function restoreDiscountTemplate(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<DiscountTemplateDto> {
  return setTemplateActive(tx, ctx, id, true);
}

// Reine Apply-Funktion (kein DB-Zugriff, Cent-Integer-Arithmetik, floor):
// fix zieht den Betrag ab (nie unter 0), percent zieht bps/10000 ab,
// gedeckelt auf capCents. Steuer rechnet das Angebot downstream.
export function applyDiscountTemplate(
  netCents: number,
  template: Pick<DiscountTemplateDto, "kind" | "amountCents" | "percentBps" | "capCents">,
): number {
  if (!Number.isInteger(netCents) || netCents < 0) {
    throw new DiscountTemplateValidationError("netCents muss ein nicht-negativer Integer sein");
  }
  if (template.kind === DISCOUNT_KIND_FIX) {
    if (template.amountCents === null) throw new DiscountTemplateValidationError("fix ohne amount");
    return Math.max(0, netCents - template.amountCents);
  }
  if (template.percentBps === null) throw new DiscountTemplateValidationError("percent ohne bps");
  const raw = Math.floor((netCents * template.percentBps) / 10_000);
  const capped = template.capCents === null ? raw : Math.min(raw, template.capCents);
  return Math.max(0, netCents - capped);
}
