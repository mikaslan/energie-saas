// F13-02 Netzanmeldung: EIN Datensatz je Projekt (v1-Grenze) mit
// Maschine vorbereitung → eingereicht → genehmigt → fertiggemeldet →
// abgeschlossen (+ storniert terminal, keine Rückübergänge).
// Berechtigung: installation.read/write (KEINE neuen Keys — Mandat).
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class GridRegistrationNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super("grid registration not found");
    this.name = "GridRegistrationNotFoundError";
  }
}

export class GridRegistrationValidationError extends Error {
  constructor(message = "grid registration validation failed") {
    super(message);
    this.name = "GridRegistrationValidationError";
  }
}

export const gridRegistrationStatuses = [
  "vorbereitung",
  "eingereicht",
  "genehmigt",
  "fertiggemeldet",
  "abgeschlossen",
  "storniert",
] as const;
export type GridRegistrationStatus = (typeof gridRegistrationStatuses)[number];

export const GRID_REGISTRATION_STATUS_LABEL: Record<GridRegistrationStatus, string> = {
  vorbereitung: "In Vorbereitung",
  eingereicht: "Eingereicht",
  genehmigt: "Genehmigt",
  fertiggemeldet: "Fertig gemeldet",
  abgeschlossen: "Abgeschlossen",
  storniert: "Storniert",
};

const allowedTransitions: Record<GridRegistrationStatus, GridRegistrationStatus[]> = {
  vorbereitung: ["eingereicht", "storniert"],
  eingereicht: ["genehmigt", "storniert"],
  genehmigt: ["fertiggemeldet", "storniert"],
  fertiggemeldet: ["abgeschlossen", "storniert"],
  abgeschlossen: [],
  storniert: [],
};

export function nextGridRegistrationStatuses(from: GridRegistrationStatus): GridRegistrationStatus[] {
  return allowedTransitions[from];
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const detailsSchema = z.strictObject({
  operatorName: z.string().trim().min(1).max(160).nullable(),
  meterNumber: z.string().trim().min(1).max(64).nullable(),
});

export type GridRegistrationDto = {
  id: string;
  projectId: string;
  status: GridRegistrationStatus;
  operatorName: string | null;
  meterNumber: string | null;
  submittedAt: string | null;
  decidedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

type GridRegistrationRow = {
  id: string;
  project_id: string;
  status: string;
  operator_name: string | null;
  meter_number: string | null;
  submitted_at: Date | string | null;
  decided_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  [key: string]: unknown;
};

const ROW_COLUMNS = sql`
  id, project_id, status, operator_name, meter_number,
  submitted_at, decided_at, completed_at, created_at, updated_at
`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDto(row: GridRegistrationRow, ctx: ServiceCtx): GridRegistrationDto {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status as GridRegistrationStatus,
    operatorName: row.operator_name,
    meterNumber: row.meter_number,
    submittedAt: row.submitted_at === null ? null : toIso(row.submitted_at),
    decidedAt: row.decided_at === null ? null : toIso(row.decided_at),
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    permissions: { canWrite: can(ctx, "installation.write") },
  };
}

function requireRead(ctx: ServiceCtx, projectId: string): void {
  if (!can(ctx, "installation.read")) {
    throw new PermissionDeniedError("installation.read", "grid_registration", projectId, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx, projectId: string): void {
  if (!can(ctx, "installation.write")) {
    throw new PermissionDeniedError("installation.write", "grid_registration", projectId, ctx.actor);
  }
}

async function readByProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<GridRegistrationRow | null> {
  const found = await tx.execute<GridRegistrationRow>(sql`
    select ${ROW_COLUMNS} from grid_registration
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
     limit 1
  `);
  return found.rows[0] ?? null;
}

export async function getGridRegistration(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<GridRegistrationDto | null> {
  requireRead(ctx, projectId);
  if (!uuidSchema.safeParse(projectId).success) throw new GridRegistrationValidationError();
  const row = await readByProject(tx, ctx, projectId);
  return row === null ? null : toDto(row, ctx);
}

// Idempotent je Projekt (UNIQUE): anlegen oder bestehenden liefern.
export async function ensureGridRegistration(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<GridRegistrationDto> {
  requireWrite(ctx, projectId);
  if (!uuidSchema.safeParse(projectId).success) throw new GridRegistrationValidationError();
  const project = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     limit 1
  `);
  if (!project.rows[0]) throw new GridRegistrationNotFoundError(projectId);
  const existing = await readByProject(tx, ctx, projectId);
  if (existing) return toDto(existing, ctx);

  try {
    const inserted = await tx.execute<GridRegistrationRow>(sql`
      insert into grid_registration (workspace_id, project_id, created_by)
      values (${ctx.workspaceId}::uuid, ${projectId}::uuid, ${ctx.actor}::uuid)
      returning ${ROW_COLUMNS}
    `);
    const row = inserted.rows[0];
    if (!row) throw new GridRegistrationNotFoundError(projectId);
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "project",
      aggregateId: projectId,
      eventType: "grid_registration.created",
      actor: ctx.actor,
      payload: { registrationId: row.id },
    });
    await writeAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      action: "grid_registration.create",
      resource: "project",
      allowed: true,
      details: { projectId, registrationId: row.id },
    });
    return toDto(row, ctx);
  } catch (error) {
    // Race zweier Anlagen: UNIQUE greift → bestehenden liefern.
    const cause = (error as { cause?: unknown }).cause;
    const code = cause && typeof cause === "object" && "code" in cause
      ? (cause as { code?: unknown }).code
      : null;
    if (code === "23505") {
      const raced = await readByProject(tx, ctx, projectId);
      if (raced) return toDto(raced, ctx);
    }
    throw error;
  }
}

export async function setGridRegistrationDetails(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; operatorName: string | null; meterNumber: string | null },
): Promise<GridRegistrationDto> {
  requireWrite(ctx, input.projectId);
  const parsed = detailsSchema.safeParse({
    operatorName: input.operatorName,
    meterNumber: input.meterNumber,
  });
  if (!parsed.success || !uuidSchema.safeParse(input.projectId).success) {
    throw new GridRegistrationValidationError();
  }
  const updated = await tx.execute<GridRegistrationRow>(sql`
    update grid_registration
       set operator_name = ${parsed.data.operatorName},
           meter_number = ${parsed.data.meterNumber},
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
    returning ${ROW_COLUMNS}
  `);
  const row = updated.rows[0];
  if (!row) throw new GridRegistrationNotFoundError(input.projectId);
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "grid_registration.details",
    resource: "project",
    allowed: true,
    details: { projectId: input.projectId },
  });
  return toDto(row, ctx);
}

export async function transitionGridRegistration(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; status: GridRegistrationStatus },
): Promise<GridRegistrationDto> {
  requireWrite(ctx, input.projectId);
  if (!uuidSchema.safeParse(input.projectId).success) {
    throw new GridRegistrationValidationError();
  }
  if (!(gridRegistrationStatuses as readonly string[]).includes(input.status)) {
    throw new GridRegistrationValidationError();
  }
  const current = await tx.execute<GridRegistrationRow>(sql`
    select ${ROW_COLUMNS} from grid_registration
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
     for update
  `);
  const row = current.rows[0];
  if (!row) throw new GridRegistrationNotFoundError(input.projectId);
  const from = row.status as GridRegistrationStatus;
  if (!allowedTransitions[from].includes(input.status)) {
    throw new GridRegistrationValidationError(`illegal transition ${from} -> ${input.status}`);
  }

  const updated = await tx.execute<GridRegistrationRow>(sql`
    update grid_registration
       set status = ${input.status},
           submitted_at = case
             when ${input.status} = 'eingereicht' then statement_timestamp()
             else submitted_at end,
           decided_at = case
             when ${input.status} = 'genehmigt' then statement_timestamp()
             else decided_at end,
           completed_at = case
             when ${input.status} = 'abgeschlossen' then statement_timestamp()
             else completed_at end,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
    returning ${ROW_COLUMNS}
  `);
  const next = updated.rows[0];
  if (!next) throw new GridRegistrationNotFoundError(input.projectId);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: input.projectId,
    eventType: "grid_registration.status_changed",
    actor: ctx.actor,
    payload: { from, to: input.status },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "grid_registration.transition",
    resource: "project",
    allowed: true,
    details: { projectId: input.projectId, from, to: input.status },
  });
  return toDto(next, ctx);
}
