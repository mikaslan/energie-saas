// F7.1 Slice A: Ausführungsphase je Projekt (Direktanlage, Basic-Lesen,
// Abschluss). Hinweis: KEIN "server-only"-Import — Muster
// modules/lead-sources.
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { OfferNotFoundError } from "@/modules/offers";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class InstallationNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super(`installation not found: ${projectId}`);
    this.name = "InstallationNotFoundError";
  }
}

export class InstallationConflictError extends Error {
  constructor(public readonly projectId: string) {
    super(`installation already exists: ${projectId}`);
    this.name = "InstallationConflictError";
  }
}

export class InstallationValidationError extends Error {
  constructor(message = "installation validation failed") {
    super(message);
    this.name = "InstallationValidationError";
  }
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const createInstallationCommandSchema = z.strictObject({
  projectId: uuidSchema,
  offerId: uuidSchema.nullable(),
  variantId: uuidSchema.nullable(),
}).superRefine((command, context) => {
  if (command.variantId !== null && command.offerId === null) {
    context.addIssue({
      code: "custom",
      message: "variantId requires offerId",
    });
  }
});

export type InstallationDto = {
  id: string;
  projectId: string;
  source: "direct" | "signature";
  status: "active" | "completed";
  offerId: string | null;
  variantId: string | null;
  completedAt: string | null;
  // F7-05 Abnahme: NULL = nicht abgenommen.
  handoverAt: string | null;
  handoverByName: string | null;
  handoverNote: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

type InstallationRow = {
  id: string;
  project_id: string;
  source: string;
  status: string;
  offer_id: string | null;
  variant_id: string | null;
  completed_at: string | null;
  handover_at: string | null;
  handover_by_name: string | null;
  handover_note: string | null;
  created_at: string;
  updated_at: string;
};

function toDto(row: InstallationRow, canWrite: boolean): InstallationDto {
  if (row.source !== "direct" && row.source !== "signature") {
    throw new InstallationValidationError();
  }
  if (row.status !== "active" && row.status !== "completed") {
    throw new InstallationValidationError();
  }
  return {
    id: row.id,
    projectId: row.project_id,
    source: row.source,
    status: row.status,
    offerId: row.offer_id,
    variantId: row.variant_id,
    completedAt: row.completed_at,
    handoverAt: row.handover_at,
    handoverByName: row.handover_by_name,
    handoverNote: row.handover_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  };
}

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "installation.read")) {
    throw new PermissionDeniedError("installation.read", "installation", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "installation.write")) {
    throw new PermissionDeniedError("installation.write", "installation", undefined, ctx.actor);
  }
}

const ROW_COLUMNS = sql`id, project_id, source, status, offer_id, variant_id, completed_at, handover_at, handover_by_name, handover_note, created_at, updated_at`;

export async function getInstallation(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string },
): Promise<InstallationDto | null> {
  requireRead(ctx);
  const parsed = z.strictObject({ projectId: uuidSchema }).safeParse(query);
  if (!parsed.success) throw new InstallationValidationError();
  const result = await tx.execute<InstallationRow>(sql`
    select ${ROW_COLUMNS} from installation
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${parsed.data.projectId}::uuid
     limit 1
  `);
  const row = result.rows[0];
  if (!row) return null;
  return toDto(row, can(ctx, "installation.write"));
}

export async function createInstallation(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; offerId?: string | null; variantId?: string | null },
): Promise<InstallationDto> {
  requireWrite(ctx);
  const parsed = createInstallationCommandSchema.safeParse({
    projectId: input.projectId,
    offerId: input.offerId ?? null,
    variantId: input.variantId ?? null,
  });
  if (!parsed.success) throw new InstallationValidationError();
  const command = parsed.data;

  // Projekt-Row locken: serialisiert Anlage + Phasenwechsel.
  const project = await tx.execute<{ id: string; phase: string }>(sql`
    select id, phase from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
     for update
  `);
  if (!project.rows[0]) throw new InstallationNotFoundError(command.projectId);

  const existing = await tx.execute<{ id: string }>(sql`
    select id from installation
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
     limit 1
  `);
  if (existing.rows[0]) throw new InstallationConflictError(command.projectId);

  // Offer/Variant sind reine Referenzen — Scope prüfen, kein Leak.
  if (command.offerId !== null) {
    const offer = await tx.execute<{ id: string }>(sql`
      select id from offer
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.offerId}::uuid
         and project_id = ${command.projectId}::uuid
       limit 1
    `);
    if (!offer.rows[0]) throw new OfferNotFoundError();
  }
  if (command.variantId !== null) {
    const variant = await tx.execute<{ id: string }>(sql`
      select id from offer_variant
       where workspace_id = ${ctx.workspaceId}::uuid
         and offer_id = ${command.offerId}::uuid
         and id = ${command.variantId}::uuid
       limit 1
    `);
    if (!variant.rows[0]) throw new OfferNotFoundError();
  }

  let row: InstallationRow;
  try {
    const inserted = await tx.execute<InstallationRow>(sql`
      insert into installation (
        workspace_id, project_id, source, status, offer_id, variant_id
      ) values (
        ${ctx.workspaceId}::uuid,
        ${command.projectId}::uuid,
        'direct',
        'active',
        ${command.offerId},
        ${command.variantId}
      )
      returning ${ROW_COLUMNS}
    `);
    row = inserted.rows[0]!;
    // Phasenwechsel (M2-01-Präzedenz); Spalte bleibt — kein
    // Installation-Spalten-Typ vorhanden (Slice B).
    await tx.execute(sql`
      update project
         set phase = 'installation',
             updated_at = statement_timestamp()
       where workspace_id = ${ctx.workspaceId}::uuid
         and id = ${command.projectId}::uuid
    `);
  } catch (error) {
    if (postgresErrorCode(error) === "23505") {
      throw new InstallationConflictError(command.projectId);
    }
    if (postgresErrorCode(error) === "23514") throw new InstallationValidationError();
    throw error;
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "installation",
    aggregateId: row.id,
    eventType: "installation.created",
    actor: ctx.actor,
    payload: {
      projectId: command.projectId,
      source: "direct",
      offerId: command.offerId,
      variantId: command.variantId,
    },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "installation.create",
    resource: "installation",
    allowed: true,
    details: { projectId: command.projectId },
  });

  return toDto(row, true);
}

export async function completeInstallation(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string },
): Promise<InstallationDto> {
  requireWrite(ctx);
  const parsed = z.strictObject({ projectId: uuidSchema }).safeParse(query);
  if (!parsed.success) throw new InstallationValidationError();

  const current = await tx.execute<InstallationRow>(sql`
    select ${ROW_COLUMNS} from installation
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${parsed.data.projectId}::uuid
     for update
  `);
  const row = current.rows[0];
  if (!row) throw new InstallationNotFoundError(parsed.data.projectId);
  if (row.status !== "active") throw new InstallationValidationError();

  const updated = await tx.execute<InstallationRow>(sql`
    update installation
       set status = 'completed',
           completed_at = statement_timestamp(),
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${parsed.data.projectId}::uuid
    returning ${ROW_COLUMNS}
  `);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "installation",
    aggregateId: row.id,
    eventType: "installation.completed",
    actor: ctx.actor,
    payload: { projectId: parsed.data.projectId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "installation.complete",
    resource: "installation",
    allowed: true,
    details: { projectId: parsed.data.projectId },
  });

  return toDto(updated.rows[0]!, true);
}

// ═══════════════════════════════════════════════════════════════════════
// F7-05 Abnahme: abgeschlossene Installation intern abnehmen (Wer/Wann/
// Bemerkung). Nur completed; korrigierbar via erneuter Abnahme (neuer
// Zeitstempel, auditiert). Fail-closed ohne Orakel.
// ═══════════════════════════════════════════════════════════════════════

const recordHandoverCommandSchema = z.strictObject({
  projectId: uuidSchema,
  byName: z.string().trim().min(1).max(160),
  note: z.string().trim().max(500).nullable().optional(),
});

export async function recordHandover(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; byName: string; note?: string | null },
): Promise<InstallationDto> {
  requireWrite(ctx);
  const parsed = recordHandoverCommandSchema.safeParse({
    projectId: input.projectId,
    byName: input.byName,
    note: input.note ?? null,
  });
  if (!parsed.success) throw new InstallationValidationError();
  const command = parsed.data;
  // Leere/whitespace-only Notiz gilt als fehlend (Formulare senden "").
  const note = command.note !== null && command.note !== undefined && command.note.trim() === ""
    ? null
    : (command.note ?? null);

  const current = await tx.execute<InstallationRow>(sql`
    select ${ROW_COLUMNS} from installation
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
     for update
  `);
  const row = current.rows[0];
  if (!row) throw new InstallationNotFoundError(command.projectId);
  if (row.status !== "completed") throw new InstallationValidationError("handover requires completed installation");

  const updated = await tx.execute<InstallationRow>(sql`
    update installation
       set handover_at = statement_timestamp(),
           handover_by_name = ${command.byName},
           handover_note = ${note},
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${command.projectId}::uuid
    returning ${ROW_COLUMNS}
  `);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "installation",
    aggregateId: row.id,
    eventType: "installation.handover_recorded",
    actor: ctx.actor,
    payload: { projectId: command.projectId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "installation.handover.record",
    resource: "installation",
    allowed: true,
    details: { projectId: command.projectId },
  });

  return toDto(updated.rows[0]!, true);
}

function postgresErrorCode(error: unknown): string | null {
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" ? code : null;
  }
  return null;
}
