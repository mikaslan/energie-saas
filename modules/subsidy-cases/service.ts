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
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  createPortalInvite,
  getPortalStatus,
  PORTAL_INVITE_CREATE_VERSION,
  PORTAL_TTL_DAYS_DEFAULT,
} from "@/modules/portal";

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

import {
  isAllowedSubsidyCaseTransition,
  isPortalInviteUsable,
  subsidyCasePrograms,
  subsidyCaseStatuses,
  suggestSubsidyProgram,
  type SubsidyCaseDto,
  type SubsidyCasePortalActivation,
  type SubsidyCaseProgram,
  type SubsidyCaseStatus,
  type SubsidyProgramSuggestion,
  type SubsidyProgramSuggestionSignals,
} from "@/lib/subsidy-case";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const detailsSchema = z.strictObject({
  program: z.enum(subsidyCasePrograms).nullable(),
  bzaNumber: z.string().trim().min(1).max(64).nullable(),
});

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
    // Lese-/Anlagepfade lösen keine Transition aus.
    portalActivation: { outcome: "not_applicable", token: null },
  };
}

// F13-05 Portal-Aktivierung als Versand-Nebeneffekt: jede Transition mit
// Ziel bza_eingereicht erzeugt genau dann ein Portal-Invite, wenn kein
// noch gültiges aktives Invite besteht. Bestandsschutz vor Neuerzeugung;
// abgelaufene active-Zeilen zählen als fehlend (atomarer Supersede,
// F10.1). Keine neuen Rechte: Vorprüfung spiegelt requireInternalAccess
// (portal), ohne zu werfen — der Förderübergang bleibt Hauptfluss.
// Nur PermissionDenied wird zu "not_permitted" (fail-closed für künftige
// Capability-Trennung); Persistenz-/Integritätsfehler rollen den Versand
// in derselben Transaktion zurück statt halb zu aktivieren.
async function activatePortalOnDispatch(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
  status: SubsidyCaseStatus,
): Promise<SubsidyCasePortalActivation> {
  if (status !== "bza_eingereicht") {
    return { outcome: "not_applicable", token: null };
  }
  if (!can(ctx, "project.write") || isExternalOnly(ctx)) {
    return { outcome: "not_permitted", token: null };
  }
  try {
    const portal = await getPortalStatus(tx, ctx, {
      workspaceId: ctx.workspaceId,
      projectId,
    });
    if (isPortalInviteUsable(portal.active)) {
      return { outcome: "already_active", token: null };
    }
    const created = await createPortalInvite(tx, ctx, {
      schemaVersion: PORTAL_INVITE_CREATE_VERSION,
      workspaceId: ctx.workspaceId,
      projectId,
      ttlDays: PORTAL_TTL_DAYS_DEFAULT,
    });
    return { outcome: "created", token: created.token };
  } catch (error) {
    if (error instanceof PermissionDeniedError) {
      return { outcome: "not_permitted", token: null };
    }
    throw error;
  }
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

export type SubsidyDashboardSlice = { status: SubsidyCaseStatus; count: number };

export type SubsidyDashboardStats = {
  total: number;
  byStatus: SubsidyDashboardSlice[];
};

// DASH-09 Förder-Kachel: Akten je Stand (rein lesend, keine neue
// Permission — installation.read wie getSubsidyCase). Feste
// Statusordnung, nur belegte Stände plus Gesamt.
export async function getSubsidyDashboardStats(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<SubsidyDashboardStats> {
  if (!can(ctx, "installation.read")) {
    throw new PermissionDeniedError("installation.read", "subsidy_case", undefined, ctx.actor);
  }
  const result = await tx.execute<{ status: string; count: number }>(sql`
    select status, count(*)::int as count
      from subsidy_case
     where workspace_id = ${ctx.workspaceId}::uuid
     group by status
  `);
  const counts = new Map(result.rows.map((row) => [row.status, Number(row.count)]));
  const byStatus = subsidyCaseStatuses
    .filter((status) => (counts.get(status) ?? 0) > 0)
    .map((status) => ({ status, count: counts.get(status) ?? 0 }));
  return {
    total: [...counts.values()].reduce((sum, count) => sum + count, 0),
    byStatus,
  };
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

// F13-08 Programm-Vorschlag (ESTIMATE, rein lesend): Signale aus dem
// jüngsten Rechner-Snapshot (branch, answeredFieldIds, requestedProducts)
// plus jüngster Projekt-Anforderung (branch, requestedProducts, Fallback).
// Keine neue Permission (installation.read wie getSubsidyCase). Fehlform
// oder fehlende Zeilen fail-closed → no_basis (nie geraten). Der Vorschlag
// wird NICHT persistiert; die Programmentscheidung bleibt manuell.
function parseSuggestionSignals(
  snapshotJson: unknown,
  requirementsJson: unknown,
): SubsidyProgramSuggestionSignals {
  const signals: SubsidyProgramSuggestionSignals = {
    branch: null,
    answeredFieldIds: [],
    requestedProducts: null,
  };
  const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const parseBranch = (value: unknown): SubsidyProgramSuggestionSignals["branch"] =>
    value === "new_installation" || value === "existing_installation" ? value : null;
  const parseProducts = (value: unknown): SubsidyProgramSuggestionSignals["requestedProducts"] => {
    const record = asRecord(value);
    if (!record) return null;
    const storage = record["targetStorageKwh"];
    const wallbox = record["wallbox"];
    const bidirectional = record["bidirectionalCharging"];
    const backup = record["backupPower"];
    if (
      typeof storage !== "number" || !Number.isFinite(storage) ||
      typeof wallbox !== "boolean" || typeof bidirectional !== "boolean" ||
      typeof backup !== "boolean"
    ) {
      return null;
    }
    return {
      targetStorageKwh: storage,
      wallbox,
      bidirectionalCharging: bidirectional,
      backupPower: backup,
    };
  };
  const reqRecord = asRecord(requirementsJson);
  if (reqRecord) {
    signals.branch = parseBranch(reqRecord["branch"]);
    signals.requestedProducts = parseProducts(reqRecord["requestedProducts"]);
  }
  const snapRecord = asRecord(snapshotJson);
  if (snapRecord) {
    const snapBranch = parseBranch(snapRecord["branch"]);
    if (snapBranch !== null) signals.branch = snapBranch;
    const inputs = asRecord(snapRecord["inputs"]);
    if (inputs) {
      const answered = inputs["answeredFieldIds"];
      if (Array.isArray(answered)) {
        signals.answeredFieldIds = answered.filter((id): id is string => typeof id === "string");
      }
      const snapProducts = parseProducts(inputs["requestedProducts"]);
      if (snapProducts !== null) signals.requestedProducts = snapProducts;
    }
  }
  return signals;
}

export async function getSubsidyProgramSuggestion(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<SubsidyProgramSuggestion> {
  requireRead(ctx, projectId);
  if (!uuidSchema.safeParse(projectId).success) throw new SubsidyCaseValidationError();
  const snapshot = await tx.execute<{ snapshot: unknown }>(sql`
    select snapshot from calculator_snapshot
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
     order by calculated_at desc
     limit 1
  `);
  const requirement = await tx.execute<{ requirements: unknown }>(sql`
    select requirements from project_requirement
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${projectId}::uuid
     order by revision desc
     limit 1
  `);
  return suggestSubsidyProgram(
    parseSuggestionSignals(snapshot.rows[0]?.snapshot ?? null, requirement.rows[0]?.requirements ?? null),
  );
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
  if (!isAllowedSubsidyCaseTransition(from, input.status)) {
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
  // F13-05: Versand-Nebeneffekt in derselben Transaktion (kein Token in
  // Payload/Audit — nur das Outcome ist beobachtbar).
  const portalActivation = await activatePortalOnDispatch(tx, ctx, input.projectId, input.status);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: input.projectId,
    eventType: "subsidy_case.status_changed",
    actor: ctx.actor,
    payload: { from, to: input.status, portalActivation: portalActivation.outcome },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "subsidy_case.transition",
    resource: "project",
    allowed: true,
    details: { projectId: input.projectId, from, to: input.status },
  });
  return { ...toDto(next, ctx), portalActivation };
}
