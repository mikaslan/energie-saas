// F2.1: Angebotsnummernformat je Workspace (Migration 0240).
// Hinweis: KEIN "server-only"-Import — Muster modules/lead-sources.
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  OFFER_NUMBER_FORMAT_DEFAULT_PADDING,
  OFFER_NUMBER_FORMAT_DEFAULT_PREFIX,
  OFFER_NUMBER_FORMAT_SCHEMA_VERSION,
  offerNumberFormatDtoSchema,
  setOfferNumberFormatCommandSchema,
  type OfferNumberFormatDto,
  type SetOfferNumberFormatCommand,
} from "@/lib/integrations/offers/contract";

export class OfferNumberFormatNotFoundError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`offer_number_format not found: ${workspaceId}`);
    this.name = "OfferNumberFormatNotFoundError";
  }
}

export class OfferNumberFormatConflictError extends Error {
  constructor(public readonly workspaceId: string) {
    super(`offer_number_format revision conflict: ${workspaceId}`);
    this.name = "OfferNumberFormatConflictError";
  }
}

export class OfferNumberFormatValidationError extends Error {
  constructor(message = "offer_number_format validation failed") {
    super(message);
    this.name = "OfferNumberFormatValidationError";
  }
}

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "offer_number_format.read")) {
    throw new PermissionDeniedError("offer_number_format.read", "workspace_offer_number_format", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "offer_number_format.write")) {
    throw new PermissionDeniedError("offer_number_format.write", "workspace_offer_number_format", undefined, ctx.actor);
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

type FormatRow = {
  prefix: string;
  padding: number;
  revision: number;
  updated_at: string;
};

function previewFor(prefix: string, padding: number): string {
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${"1".padStart(padding, "0")}`;
}

function toDto(
  row: FormatRow | null,
  workspaceId: string,
  canWrite: boolean,
): OfferNumberFormatDto {
  const prefix = row?.prefix ?? OFFER_NUMBER_FORMAT_DEFAULT_PREFIX;
  const padding = row?.padding ?? OFFER_NUMBER_FORMAT_DEFAULT_PADDING;
  return offerNumberFormatDtoSchema.parse({
    schemaVersion: OFFER_NUMBER_FORMAT_SCHEMA_VERSION,
    prefix,
    padding,
    revision: row?.revision ?? 1,
    isDefault: row === null,
    preview: previewFor(prefix, padding),
    permissions: { canWrite },
  });
}

export async function getOfferNumberFormat(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<OfferNumberFormatDto> {
  requireRead(ctx);
  const result = await tx.execute<FormatRow>(sql`
    select prefix, padding, revision, updated_at
      from workspace_offer_number_format
     where workspace_id = ${ctx.workspaceId}::uuid
     limit 1
  `);
  return toDto(result.rows[0] ?? null, ctx.workspaceId, can(ctx, "offer_number_format.write"));
}

export async function setOfferNumberFormat(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: SetOfferNumberFormatCommand,
): Promise<OfferNumberFormatDto> {
  requireWrite(ctx);
  const parsed = setOfferNumberFormatCommandSchema.safeParse(input);
  if (!parsed.success) throw new OfferNumberFormatValidationError();
  const command = parsed.data;

  let row: FormatRow;
  try {
    if (command.expectedRevision === null) {
      const inserted = await tx.execute<FormatRow>(sql`
        insert into workspace_offer_number_format (
          workspace_id, prefix, padding, revision, created_by, updated_by
        ) values (
          ${ctx.workspaceId}::uuid,
          ${command.prefix},
          ${command.padding},
          1,
          ${ctx.actor}::uuid,
          ${ctx.actor}::uuid
        )
        returning prefix, padding, revision, updated_at
      `);
      row = inserted.rows[0]!;
    } else {
      const updated = await tx.execute<FormatRow>(sql`
        update workspace_offer_number_format
           set prefix = ${command.prefix},
               padding = ${command.padding},
               revision = revision + 1,
               updated_by = ${ctx.actor}::uuid,
               updated_at = statement_timestamp()
         where workspace_id = ${ctx.workspaceId}::uuid
           and revision = ${command.expectedRevision}
        returning prefix, padding, revision, updated_at
      `);
      const current = updated.rows[0];
      if (!current) throw new OfferNumberFormatConflictError(ctx.workspaceId);
      row = current;
    }
  } catch (error) {
    if (error instanceof OfferNumberFormatConflictError) throw error;
    const code = postgresErrorCode(error);
    if (code === "23505") throw new OfferNumberFormatConflictError(ctx.workspaceId);
    if (code === "23514") throw new OfferNumberFormatValidationError();
    throw error;
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "workspace_offer_number_format",
    aggregateId: ctx.workspaceId,
    eventType: "offer_number_format.updated",
    actor: ctx.actor,
    payload: { prefix: command.prefix, padding: command.padding, revision: row.revision },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "offer_number_format.update",
    resource: "workspace_offer_number_format",
    allowed: true,
    details: { prefix: command.prefix, padding: command.padding },
  });

  return toDto(row, ctx.workspaceId, true);
}
