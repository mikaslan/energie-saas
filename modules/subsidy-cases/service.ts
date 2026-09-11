// F13-03 Förderservice-Akte (KfW/BAFA, Katalog F13.2 Slice 1): EIN
// Datensatz je Projekt (v1-Grenze) mit Maschine vorbereitung →
// bza_eingereicht → bza_bewilligt → bnd_eingereicht → abgeschlossen
// (+ korrektur mit Wiedereinstieg je Phase, storniert terminal).
// Berechtigung: installation.read/write (KEINE neuen Keys — Mandat).
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class SubsidyCaseNotFoundError extends Error {
  constructor(public readonly projectId: string) {
    super("subsidy case not found");
    this.name = "SubsidyCaseNotFoundError";
  }
}

export class SubsidyCaseValidationError extends Error {
  constructor(message = "subsidy case validation failed") {
    super(message);
    this.name = "SubsidyCaseValidationError";
  }
}

export const subsidyCaseStatuses = [
  "vorbereitung",
  "bza_eingereicht",
  "korrektur",
  "bza_bewilligt",
  "bnd_eingereicht",
  "abgeschlossen",
  "storniert",
] as const;
export type SubsidyCaseStatus = (typeof subsidyCaseStatuses)[number];

export const SUBSIDY_CASE_STATUS_LABEL: Record<SubsidyCaseStatus, string> = {
  vorbereitung: "In Vorbereitung",
  bza_eingereicht: "BzA eingereicht",
  korrektur: "Korrektur",
  bza_bewilligt: "BzA bewilligt",
  bnd_eingereicht: "BnD eingereicht",
  abgeschlossen: "Abgeschlossen",
  storniert: "Storniert",
};

export const subsidyCasePrograms = ["kfw", "bafa", "sonstige"] as const;
export type SubsidyCaseProgram = (typeof subsidyCasePrograms)[number];

export const SUBSIDY_CASE_PROGRAM_LABEL: Record<SubsidyCaseProgram, string> = {
  kfw: "KfW",
  bafa: "BAFA",
  sonstige: "Sonstige",
};

const allowedTransitions: Record<SubsidyCaseStatus, SubsidyCaseStatus[]> = {
  vorbereitung: ["bza_eingereicht", "storniert"],
  bza_eingereicht: ["bza_bewilligt", "korrektur", "storniert"],
  korrektur: ["bza_eingereicht", "bnd_eingereicht", "storniert"],
  bza_bewilligt: ["bnd_eingereicht", "storniert"],
  bnd_eingereicht: ["abgeschlossen", "korrektur", "storniert"],
  abgeschlossen: [],
  storniert: [],
};

export function nextSubsidyCaseStatuses(from: SubsidyCaseStatus): SubsidyCaseStatus[] {
  return allowedTransitions[from];
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const detailsSchema = z.strictObject({
  program: z.enum(subsidyCasePrograms).nullable(),
  bzaNumber: z.string().trim().min(1).max(64).nullable(),
});

export type SubsidyCaseDto = {
  id: string;
  projectId: string;
  status: SubsidyCaseStatus;
  program: SubsidyCaseProgram | null;
  bzaNumber: string | null;
  bzaSubmittedAt: string | null;
  bzaApprovedAt: string | null;
  bndSubmittedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

type SubsidyCaseRow = {
  id: string;
  project_id: string;
  status: string;
  program: string | null;
  bza_number: string | null;
  bza_submitted_at: Date | string | null;
  bza_approved_at: Date | string | null;
  bnd_submitted_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  [key: string]: unknown;
};

const ROW_COLUMNS = sql`
  id, project_id, status, program, bza_number,
  bza_submitted_at, bza_approved_at, bnd_submitted_at,
  completed_at, created_at, updated_at
`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDto(row: SubsidyCaseRow, ctx: ServiceCtx): SubsidyCaseDto {
  return {
    id: row.id,
    projectId: row.project_id,
    status: row.status as SubsidyCaseStatus,
    program: row.program as SubsidyCaseProgram | null,
    bzaNumber: row.bza_number,
    bzaSubmittedAt: row.bza_submitted_at === null ? null : toIso(row.bza_submitted_at),
    bzaApprovedAt: row.bza_approved_at === null ? null : toIso(row.bza_approved_at),
    bndSubmittedAt: row.bnd_submitted_at === null ? null : toIso(row.bnd_submitted_at),
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    permissions: { canWrite: can(ctx, "installation.write") },
  };
}

function requireRead(ctx: ServiceCtx, projectId: string): void {
  if (!can(ctx, "installation.read")) {
    throw new PermissionDeniedError("installation.read", "subsidy_case", projectId, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx, projectId: string): void {
  if (!can(ctx, "installation.write")) {
    throw new PermissionDeniedError("installation.write", "subsidy_case", projectId, ctx.actor);
  }
}

async function readByProject(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<SubsidyCaseRow | null> {
  const found = await tx.execute<SubsidyCaseRow>(sql`
    select ${ROW_COLUMNS} from subsidy_case
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
     limit 1
  `);
  return found.rows[0] ?? null;
}

export async function getSubsidyCase(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<SubsidyCaseDto | null> {
  requireRead(ctx, projectId);
  if (!uuidSchema.safeParse(projectId).success) throw new SubsidyCaseValidationError();
  const row = await readByProject(tx, ctx, projectId);
  return row === null ? null : toDto(row, ctx);
}

// Idempotent je Projekt (UNIQUE): anlegen oder bestehenden liefern.
export async function ensureSubsidyCase(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<SubsidyCaseDto> {
  requireWrite(ctx, projectId);
  if (!uuidSchema.safeParse(projectId).success) throw new SubsidyCaseValidationError();
  const project = await tx.execute<{ id: string }>(sql`
    select id from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
     limit 1
  `);
  if (!project.rows[0]) throw new SubsidyCaseNotFoundError(projectId);
  const existing = await readByProject(tx, ctx, projectId);
  if (existing) return toDto(existing, ctx);

  try {
    const inserted = await tx.execute<SubsidyCaseRow>(sql`
      insert into subsidy_case (workspace_id, project_id, created_by)
      values (${ctx.workspaceId}::uuid, ${projectId}::uuid, ${ctx.actor}::uuid)
      returning ${ROW_COLUMNS}
    `);
    const row = inserted.rows[0];
    if (!row) throw new SubsidyCaseNotFoundError(projectId);
    await emitEvent(tx, {
      workspaceId: ctx.workspaceId,
      aggregateType: "project",
      aggregateId: projectId,
      eventType: "subsidy_case.created",
      actor: ctx.actor,
      payload: { caseId: row.id },
    });
    await writeAudit(tx, {
      workspaceId: ctx.workspaceId,
      actor: ctx.actor,
      action: "subsidy_case.create",
      resource: "project",
      allowed: true,
      details: { projectId, caseId: row.id },
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

export async function setSubsidyCaseDetails(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; program: SubsidyCaseProgram | null; bzaNumber: string | null },
): Promise<SubsidyCaseDto> {
  requireWrite(ctx, input.projectId);
  const parsed = detailsSchema.safeParse({
    program: input.program,
    bzaNumber: input.bzaNumber,
  });
  if (!parsed.success || !uuidSchema.safeParse(input.projectId).success) {
    throw new SubsidyCaseValidationError();
  }
  const updated = await tx.execute<SubsidyCaseRow>(sql`
    update subsidy_case
       set program = ${parsed.data.program},
           bza_number = ${parsed.data.bzaNumber},
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
    returning ${ROW_COLUMNS}
  `);
  const row = updated.rows[0];
  if (!row) throw new SubsidyCaseNotFoundError(input.projectId);
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "subsidy_case.details",
    resource: "project",
    allowed: true,
    details: { projectId: input.projectId },
  });
  return toDto(row, ctx);
}

export async function transitionSubsidyCase(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; status: SubsidyCaseStatus },
): Promise<SubsidyCaseDto> {
  requireWrite(ctx, input.projectId);
  if (!uuidSchema.safeParse(input.projectId).success) {
    throw new SubsidyCaseValidationError();
  }
  if (!(subsidyCaseStatuses as readonly string[]).includes(input.status)) {
    throw new SubsidyCaseValidationError();
  }
  const current = await tx.execute<SubsidyCaseRow>(sql`
    select ${ROW_COLUMNS} from subsidy_case
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
     for update
  `);
  const row = current.rows[0];
  if (!row) throw new SubsidyCaseNotFoundError(input.projectId);
  const from = row.status as SubsidyCaseStatus;
  if (!allowedTransitions[from].includes(input.status)) {
    throw new SubsidyCaseValidationError(`illegal transition ${from} -> ${input.status}`);
  }

  const updated = await tx.execute<SubsidyCaseRow>(sql`
    update subsidy_case
       set status = ${input.status},
           bza_submitted_at = case
             when ${input.status} = 'bza_eingereicht' then statement_timestamp()
             else bza_submitted_at end,
           bza_approved_at = case
             when ${input.status} = 'bza_bewilligt' then statement_timestamp()
             else bza_approved_at end,
           bnd_submitted_at = case
             when ${input.status} = 'bnd_eingereicht' then statement_timestamp()
             else bnd_submitted_at end,
           completed_at = case
             when ${input.status} = 'abgeschlossen' then statement_timestamp()
             else completed_at end,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
    returning ${ROW_COLUMNS}
  `);
  const next = updated.rows[0];
  if (!next) throw new SubsidyCaseNotFoundError(input.projectId);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: input.projectId,
    eventType: "subsidy_case.status_changed",
    actor: ctx.actor,
    payload: { from, to: input.status },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "subsidy_case.transition",
    resource: "project",
    allowed: true,
    details: { projectId: input.projectId, from, to: input.status },
  });
  return toDto(next, ctx);
}
