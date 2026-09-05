// F2.5 Slice A: Zahlarten-Stammdaten (reine Anzeige, kein Provider).
// Hinweis: KEIN "server-only"-Import — Muster modules/lead-sources.
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  PAYMENT_OPTION_SCHEMA_VERSION,
  createPaymentOptionCommandSchema,
  paymentOptionDtoSchema,
  updatePaymentOptionCommandSchema,
  type CreatePaymentOptionCommand,
  type PaymentOptionDto,
  type UpdatePaymentOptionCommand,
} from "@/lib/integrations/offers/contract";

export class PaymentOptionNotFoundError extends Error {
  constructor(public readonly paymentOptionId: string) {
    super(`payment_option not found: ${paymentOptionId}`);
    this.name = "PaymentOptionNotFoundError";
  }
}

export class PaymentOptionConflictError extends Error {
  constructor(public readonly key: string) {
    super(`payment_option key conflict: ${key}`);
    this.name = "PaymentOptionConflictError";
  }
}

export class PaymentOptionValidationError extends Error {
  constructor(message = "payment_option validation failed") {
    super(message);
    this.name = "PaymentOptionValidationError";
  }
}

const KEY_KIND = {
  purchase: "purchase",
  financing_classic: "financing",
  leasing: "leasing",
} as const;

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "payment_option.read")) {
    throw new PermissionDeniedError("payment_option.read", "payment_option", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "payment_option.write")) {
    throw new PermissionDeniedError("payment_option.write", "payment_option", undefined, ctx.actor);
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

type PaymentOptionRow = {
  id: string;
  key: string;
  label: string;
  kind: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

function toDto(row: PaymentOptionRow, canWrite: boolean): PaymentOptionDto {
  return paymentOptionDtoSchema.parse({
    schemaVersion: PAYMENT_OPTION_SCHEMA_VERSION,
    id: row.id,
    key: row.key,
    label: row.label,
    kind: row.kind,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

const ROW_SELECT = sql`
  select id, key, label, kind, archived_at, created_at, updated_at
    from payment_option
`;

export async function listPaymentOptions(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { includeArchived?: boolean } = {},
): Promise<PaymentOptionDto[]> {
  requireRead(ctx);
  const includeArchived = query.includeArchived === true;
  const result = await tx.execute<PaymentOptionRow>(sql`
    ${ROW_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     ${includeArchived ? sql`` : sql`and archived_at is null`}
   order by label asc, id asc
  `);
  const canWrite = can(ctx, "payment_option.write");
  return result.rows.map((row) => toDto(row, canWrite));
}

async function writeAuditFor(
  tx: TenantTx,
  ctx: ServiceCtx,
  action: string,
  details: Record<string, unknown>,
): Promise<void> {
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action,
    resource: "payment_option",
    allowed: true,
    details,
  });
}

export async function createPaymentOption(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreatePaymentOptionCommand,
): Promise<PaymentOptionDto> {
  requireWrite(ctx);
  const parsed = createPaymentOptionCommandSchema.safeParse(input);
  if (!parsed.success) throw new PaymentOptionValidationError();
  const command = parsed.data;

  let row: PaymentOptionRow;
  try {
    const inserted = await tx.execute<PaymentOptionRow>(sql`
      insert into payment_option (
        workspace_id, key, label, kind
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.key},
        ${command.label},
        ${KEY_KIND[command.key]}
      )
      returning id, key, label, kind, archived_at, created_at, updated_at
    `);
    row = inserted.rows[0]!;
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23505") throw new PaymentOptionConflictError(command.key);
    if (code === "23514") throw new PaymentOptionValidationError();
    throw error;
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "payment_option",
    aggregateId: row.id,
    eventType: "payment_option.created",
    actor: ctx.actor,
    payload: { key: command.key, label: command.label },
  });
  await writeAuditFor(tx, ctx, "payment_option.create", { key: command.key });

  return toDto(row, true);
}

export async function updatePaymentOption(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdatePaymentOptionCommand,
): Promise<PaymentOptionDto> {
  requireWrite(ctx);
  const parsed = updatePaymentOptionCommandSchema.safeParse(input);
  if (!parsed.success) throw new PaymentOptionValidationError();
  const command = parsed.data;

  const updated = await tx.execute<PaymentOptionRow>(sql`
    update payment_option
       set label = ${command.label},
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.id}::uuid
    returning id, key, label, kind, archived_at, created_at, updated_at
  `);
  const row = updated.rows[0];
  if (!row) throw new PaymentOptionNotFoundError(command.id);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "payment_option",
    aggregateId: command.id,
    eventType: "payment_option.updated",
    actor: ctx.actor,
    payload: { label: command.label },
  });
  await writeAuditFor(tx, ctx, "payment_option.update", { id: command.id });

  return toDto(row, true);
}

async function setArchived(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
  archived: boolean,
  action: "archive" | "restore",
): Promise<PaymentOptionDto> {
  requireWrite(ctx);
  let rows: PaymentOptionRow[];
  try {
    const updated = await tx.execute<PaymentOptionRow>(sql`
      update payment_option
         set archived_at = ${archived ? sql`statement_timestamp()` : sql`null`},
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${id}::uuid
         and (${archived ? sql`archived_at is null` : sql`archived_at is not null`})
      returning id, key, label, kind, archived_at, created_at, updated_at
    `);
    rows = updated.rows;
  } catch (error) {
    // Restore kollidiert mit einem zwischenzeitlich neu vergebenen aktiven
    // Schlüssel (partieller Unique-Index) → Conflict statt rohem 23505.
    const code = postgresErrorCode(error);
    if (code === "23505") throw new PaymentOptionConflictError(id);
    if (code === "23514") throw new PaymentOptionValidationError();
    throw error;
  }
  const row = rows[0];
  if (!row) {
    // Idempotenz: Zustand bereits erreicht → aktuellen Datensatz zurückgeben,
    // existiert er nicht → NotFound.
    const current = await tx.execute<PaymentOptionRow>(sql`
      ${ROW_SELECT}
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${id}::uuid
     limit 1
    `);
    if (!current.rows[0]) throw new PaymentOptionNotFoundError(id);
    return toDto(current.rows[0], true);
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "payment_option",
    aggregateId: id,
    eventType: archived ? "payment_option.archived" : "payment_option.restored",
    actor: ctx.actor,
    payload: {},
  });
  await writeAuditFor(tx, ctx, `payment_option.${action}`, { id });

  return toDto(row, true);
}

export function archivePaymentOption(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<PaymentOptionDto> {
  return setArchived(tx, ctx, id, true, "archive");
}

export function restorePaymentOption(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<PaymentOptionDto> {
  return setArchived(tx, ctx, id, false, "restore");
}
