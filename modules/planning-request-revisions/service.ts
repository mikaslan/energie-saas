// F13-14 Planungsservice-Revision (Katalog F13.3, Spec §2): signierte
// Revisionsnotizen je Planungsanfrage. Berechtigung: Wiederverwendung
// installation.read/write (KEINE neuen Permission-Keys —
// F13-01-Präzedenz). Modul ist server-only (Muster
// modules/planning-requests/service.ts).
// Unveraenderlich: nur Anlage + Lesen; die Signatur ist Click-only
// (rein interner Klick-Nachweis, KEIN E-Sign-Anbieter) und setzt
// signed_at einmalig NULL → Zeit, danach kein Update/Delete.
// KEIN Event (reine Notiz; Audit via created_by/created_at).
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";
import type { TenantTx } from "@/lib/db/types";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class PlanningRequestRevisionNotFoundError extends Error {
  constructor(public readonly revisionId: string) {
    super(`planning request revision not found: ${revisionId}`);
    this.name = "PlanningRequestRevisionNotFoundError";
  }
}

export class PlanningRequestRevisionValidationError extends Error {
  constructor(message = "planning request revision validation failed") {
    super(message);
    this.name = "PlanningRequestRevisionValidationError";
  }
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const createRevisionCommandSchema = z.strictObject({
  projectId: uuidSchema,
  planningRequestId: uuidSchema,
  note: z.string().max(2000),
});

const signRevisionCommandSchema = z.strictObject({
  id: uuidSchema,
});

export type PlanningRequestRevisionDto = {
  id: string;
  projectId: string;
  planningRequestId: string;
  note: string;
  createdBy: string;
  createdAt: string;
  signedAt: string | null;
  permissions: { canWrite: boolean };
};

type PlanningRequestRevisionRow = {
  id: string;
  project_id: string;
  planning_request_id: string;
  note: string;
  created_by: string;
  created_at: string | Date;
  signed_at: string | Date | null;
};

function toDto(row: PlanningRequestRevisionRow, canWrite: boolean): PlanningRequestRevisionDto {
  return {
    id: row.id,
    projectId: row.project_id,
    planningRequestId: row.planning_request_id,
    note: row.note,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
    signedAt: row.signed_at === null ? null : new Date(row.signed_at).toISOString(),
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

// Service-seitiges Spiegelbild des DB-CHECKs (getrimmt, 1..2000, keine
// Steuerzeichen): saubere ValidationError statt rohem DB-Fehler.
function cleanNote(raw: string): string {
  const note = raw.trim();
  if (note.length < 1 || note.length > 2000) {
    throw new PlanningRequestRevisionValidationError("note must be 1..2000 chars");
  }
  if (/[\u0000-\u001f\u007f]/u.test(note)) {
    throw new PlanningRequestRevisionValidationError("note contains control chars");
  }
  return note;
}

async function requireParentRequest(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  planningRequestId: string,
): Promise<void> {
  const scope = await tx.execute<{ id: string }>(sql`
    select id from planning_request
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${planningRequestId}::uuid
       and project_id = ${projectId}::uuid
     limit 1
  `);
  if (!scope.rows[0]) {
    throw new PlanningRequestRevisionNotFoundError(planningRequestId);
  }
}

export async function createPlanningRequestRevision(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; planningRequestId: string; note: string },
): Promise<PlanningRequestRevisionDto> {
  requireWrite(ctx);
  const parsed = createRevisionCommandSchema.safeParse(input);
  if (!parsed.success) throw new PlanningRequestRevisionValidationError();
  const note = cleanNote(parsed.data.note);
  await requireParentRequest(tx, ctx, parsed.data.projectId, parsed.data.planningRequestId);
  const inserted = await tx.execute<PlanningRequestRevisionRow>(sql`
    insert into planning_request_revision (
      workspace_id, project_id, planning_request_id, note, created_by
    ) values (
      ${ctx.workspaceId}::uuid,
      ${parsed.data.projectId}::uuid,
      ${parsed.data.planningRequestId}::uuid,
      ${note},
      ${ctx.actor}::uuid
    )
    returning id, project_id, planning_request_id, note, created_by,
              created_at, signed_at
  `);
  const created = inserted.rows[0];
  if (!created) throw new PlanningRequestRevisionValidationError("concurrent insert failed");
  return toDto(created, true);
}

export async function signPlanningRequestRevision(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { id: string },
): Promise<PlanningRequestRevisionDto> {
  requireWrite(ctx);
  const parsed = signRevisionCommandSchema.safeParse(input);
  if (!parsed.success) throw new PlanningRequestRevisionValidationError();
  const current = await tx.execute<{ signed_at: string | Date | null }>(sql`
    select signed_at from planning_request_revision
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.id}::uuid
     limit 1
  `);
  const row = current.rows[0];
  if (!row) throw new PlanningRequestRevisionNotFoundError(parsed.data.id);
  if (row.signed_at !== null) {
    throw new PlanningRequestRevisionValidationError("revision already signed");
  }
  const updated = await tx.execute<PlanningRequestRevisionRow>(sql`
    update planning_request_revision
       set signed_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.id}::uuid
       and signed_at is null
    returning id, project_id, planning_request_id, note, created_by,
              created_at, signed_at
  `);
  const signed = updated.rows[0];
  if (!signed) throw new PlanningRequestRevisionValidationError("revision already signed");
  return toDto(signed, true);
}

export async function listPlanningRequestRevisions(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string; planningRequestId: string },
): Promise<PlanningRequestRevisionDto[]> {
  requireRead(ctx);
  const parsed = z
    .strictObject({ projectId: uuidSchema, planningRequestId: uuidSchema })
    .safeParse(query);
  if (!parsed.success) throw new PlanningRequestRevisionValidationError();
  await requireParentRequest(tx, ctx, parsed.data.projectId, parsed.data.planningRequestId);
  const canWrite = can(ctx, "installation.write");
  const rows = await tx.execute<PlanningRequestRevisionRow>(sql`
    select id, project_id, planning_request_id, note, created_by,
           created_at, signed_at
      from planning_request_revision
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${parsed.data.projectId}::uuid
       and planning_request_id = ${parsed.data.planningRequestId}::uuid
     order by created_at, id
  `);
  return rows.rows.map((entry) => toDto(entry, canWrite));
}
