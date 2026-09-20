// F13-03 Förderservice-Akte (KfW/BAFA, Katalog F13.2 Slice 1): EIN
// Datensatz je Projekt (v1-Grenze) mit Maschine draft → vorbereitung →
// bza_eingereicht → bza_bewilligt → bnd_eingereicht → abgeschlossen
// (+ korrektur mit Wiedereinstieg je Phase, storniert terminal).
// F13-00: Anlage als draft, Submit-Freeze in setSubsidyCaseDetails,
// Übergangs-Event subsidy_case.transition (Naming-Doktrin).
// Berechtigung: installation.read/write (KEINE neuen Keys — Mandat).
import { sql } from "drizzle-orm";
import type { Pool } from "pg";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { hashPortalToken } from "@/lib/integrations/portal/portal-contract";
import {
  subsidyChatBodySchema,
  type SubsidyChatMessage,
} from "@/lib/integrations/subsidies/chat-contract";
import { PortalNotFoundError, resolvePortalByToken } from "@/modules/portal";
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
  addBusinessDaysBerlin,
  canEditFilingDetails,
  isAllowedSubsidyCaseTransition,
  isPortalInviteUsable,
  isSubsidyCaseOverdue,
  isSubsidyCasePreApproval,
  SUBSIDY_CASE_BND_DUE_WORKDAYS,
  SUBSIDY_CASE_BZA_DUE_WORKDAYS,
  SUBSIDY_CASE_FEE_DEFAULT_CENTS,
  SUBSIDY_CASE_NAMEPLATE_SLOT,
  SUBSIDY_CASE_TRANSITION_EVENT,
  subsidyCasePrograms,
  subsidyCaseStatuses,
  suggestSubsidyProgram,
  todayBerlinIso,
  type SubsidyCaseDto,
  type SubsidyCasePortalActivation,
  type SubsidyCaseProgram,
  type SubsidyCaseStatus,
  type SubsidyProgramSuggestion,
  type SubsidyProgramSuggestionSignals,
} from "@/lib/subsidy-case";
import { bundHolidaysBerlin } from "@/lib/subsidy-holidays";
import type { FileRequestDto } from "@/lib/file-request";
import { createFileRequest } from "@/modules/file-requests";

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
  fee_cents: number;
  bza_due_date: Date | string | null;
  bnd_due_date: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  [key: string]: unknown;
};

const ROW_COLUMNS = sql`
  id, project_id, status, program, bza_number,
  bza_submitted_at, bza_approved_at, bnd_submitted_at,
  completed_at, fee_cents, bza_due_date, bnd_due_date,
  created_at, updated_at
`;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toDateOnly(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value.slice(0, 10);
}

function toDto(row: SubsidyCaseRow, ctx: ServiceCtx): SubsidyCaseDto {
  const status = row.status as SubsidyCaseStatus;
  const bzaDueDate = row.bza_due_date === null ? null : toDateOnly(row.bza_due_date);
  const bndDueDate = row.bnd_due_date === null ? null : toDateOnly(row.bnd_due_date);
  return {
    id: row.id,
    projectId: row.project_id,
    status,
    program: row.program as SubsidyCaseProgram | null,
    bzaNumber: row.bza_number,
    bzaSubmittedAt: row.bza_submitted_at === null ? null : toIso(row.bza_submitted_at),
    bzaApprovedAt: row.bza_approved_at === null ? null : toIso(row.bza_approved_at),
    bndSubmittedAt: row.bnd_submitted_at === null ? null : toIso(row.bnd_submitted_at),
    completedAt: row.completed_at === null ? null : toIso(row.completed_at),
    // F13-13: Snapshot + Fälligkeiten aus der Zeile; Badges rein lesend.
    // Phase offen = Wartestatus der jeweiligen Phase (eingereicht, noch
    // nicht beantwortet — ESTIMATE, keine Behördenzusage).
    feeCents: Number(row.fee_cents),
    bzaDueDate,
    bndDueDate,
    overdue:
      isSubsidyCaseOverdue({ dueDate: bzaDueDate, phaseOpen: status === "bza_eingereicht" }) ||
      isSubsidyCaseOverdue({ dueDate: bndDueDate, phaseOpen: status === "bnd_eingereicht" }),
    preApproval: isSubsidyCasePreApproval(status),
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

// F13-13 §1: Workspace-Stammdatum lesen — ohne Zeile gilt der Default
// 21000 (kein DB-Default, kein Wert ohne explizite Zeile).
async function readFeeSettingCents(tx: TenantTx, ctx: ServiceCtx): Promise<number> {
  const found = await tx.execute<{ fee_cents: number }>(sql`
    select fee_cents from subsidy_case_fee_setting
     where workspace_id = ${ctx.workspaceId}::uuid
     limit 1
  `);
  const row = found.rows[0];
  return row ? Number(row.fee_cents) : SUBSIDY_CASE_FEE_DEFAULT_CENTS;
}

// F13-13 §2: Fälligkeit ab Versandtag-Berlin-Datum (Feiertagsquelle Bund,
// Folgejahr eingeschlossen für den Jahreswechsel). Nur der jeweilige
// Versand-Übergang setzt sein Datum; Re-Transition überschreibt.
function dueDatesForTransition(
  todayIso: string,
  status: SubsidyCaseStatus,
): { bzaDue: string | null; bndDue: string | null } {
  const year = Number(todayIso.slice(0, 4));
  const holidays = [...bundHolidaysBerlin(year), ...bundHolidaysBerlin(year + 1)];
  return {
    bzaDue:
      status === "bza_eingereicht"
        ? addBusinessDaysBerlin(todayIso, SUBSIDY_CASE_BZA_DUE_WORKDAYS, holidays)
        : null,
    bndDue:
      status === "bnd_eingereicht"
        ? addBusinessDaysBerlin(todayIso, SUBSIDY_CASE_BND_DUE_WORKDAYS, holidays)
        : null,
  };
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
    // F13-13 §1: Betragssnapshot bei Anlage (Setting oder Default 21000).
    // KEINE Auto-F8-Rechnung — reine Wertdarstellung an der Akte.
    const feeCents = await readFeeSettingCents(tx, ctx);
    const inserted = await tx.execute<SubsidyCaseRow>(sql`
      insert into subsidy_case (workspace_id, project_id, created_by, fee_cents)
      values (${ctx.workspaceId}::uuid, ${projectId}::uuid, ${ctx.actor}::uuid, ${feeCents})
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
  // F13-00 §2 Submit-Freeze: Feld-Edits nur in draft/korrektur, danach
  // transition-only (fail-closed, illegaler Zustand benannt).
  const current = await tx.execute<SubsidyCaseRow>(sql`
    select ${ROW_COLUMNS} from subsidy_case
     where workspace_id = ${ctx.workspaceId}::uuid
       and project_id = ${input.projectId}::uuid
     for update
  `);
  const currentRow = current.rows[0];
  if (!currentRow) throw new SubsidyCaseNotFoundError(input.projectId);
  if (!canEditFilingDetails(currentRow.status as SubsidyCaseStatus)) {
    throw new SubsidyCaseValidationError(
      `details frozen in status ${currentRow.status} (editable: draft, korrektur)`,
    );
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

  // F13-13 §2: Fälligkeit je Versand-Übergang (BzA +3 AT, BnD +5 AT ab
  // Versandtag-Berlin-Datum). Maschine UNVERÄNDERT, keine Sperren, keine
  // Eskalations-Automatik — nur das Datum, Badge ist reine Anzeige.
  const { bzaDue, bndDue } = dueDatesForTransition(todayBerlinIso(), input.status);
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
           bza_due_date = case
             when ${input.status} = 'bza_eingereicht' then ${bzaDue}::date
             else bza_due_date end,
           bnd_due_date = case
             when ${input.status} = 'bnd_eingereicht' then ${bndDue}::date
             else bnd_due_date end,
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
    eventType: SUBSIDY_CASE_TRANSITION_EVENT,
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

// ═══════════════════════════════════════════════════════════════════════
// F13-13 §1: Workspace-Stammdatum „Förderservice-Preis" (Cent, änderbar,
// Default 21000). Lesen installation.read; Schreiben installation.write
// + Audit. Altschutz: nur neue Akten snapshotten den geänderten Wert.
// ═══════════════════════════════════════════════════════════════════════
export async function getSubsidyCaseFee(tx: TenantTx, ctx: ServiceCtx): Promise<number> {
  if (!can(ctx, "installation.read")) {
    throw new PermissionDeniedError("installation.read", "subsidy_case_fee_setting", ctx.workspaceId, ctx.actor);
  }
  return readFeeSettingCents(tx, ctx);
}

const feeSettingSchema = z.strictObject({
  projectId: uuidSchema,
  feeCents: z.number().int().min(0),
});

export async function setSubsidyCaseFee(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; feeCents: number },
): Promise<number> {
  const parsed = feeSettingSchema.safeParse(input);
  if (!parsed.success) throw new SubsidyCaseValidationError();
  requireWrite(ctx, parsed.data.projectId);
  const saved = await tx.execute<{ fee_cents: number }>(sql`
    insert into subsidy_case_fee_setting (workspace_id, fee_cents, updated_at)
    values (${ctx.workspaceId}::uuid, ${parsed.data.feeCents}, statement_timestamp())
    on conflict (workspace_id)
      do update set fee_cents = excluded.fee_cents, updated_at = statement_timestamp()
    returning fee_cents
  `);
  const row = saved.rows[0];
  if (!row) throw new SubsidyCaseValidationError();
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "subsidy_case.fee_setting",
    resource: "project",
    allowed: true,
    details: { projectId: parsed.data.projectId, feeCents: Number(row.fee_cents) },
  });
  return Number(row.fee_cents);
}

// ═══════════════════════════════════════════════════════════════════════
// F13-13 §4: Typenschild-Foto-Slot (ohne KI-Auswertung). Datei-Anfrage im
// F13-07-Muster (anfordern → Portal-Upload → „Beleg erhalten"), verknüpft
// mit der Akte (subsidyCaseId), strukturierter Slot-Typ typenschild_foto
// (F13-00 §4). Die Akte muss existieren; Berechtigung prüft
// createFileRequest (project.write, keine neuen Keys).
// ═══════════════════════════════════════════════════════════════════════
export async function requestNameplatePhoto(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string },
): Promise<FileRequestDto> {
  if (!uuidSchema.safeParse(input.projectId).success) throw new SubsidyCaseValidationError();
  const kase = await readByProject(tx, ctx, input.projectId);
  if (!kase) throw new SubsidyCaseNotFoundError(input.projectId);
  return createFileRequest(tx, ctx, {
    projectId: input.projectId,
    title: SUBSIDY_CASE_NAMEPLATE_SLOT,
    description: null,
    subsidyCaseId: kase.id,
    slotType: "typenschild_foto",
  });
}

// ═══════════════════════════════════════════════════════════════════════
// F13-10: Kundenchat zur Förderakte (Katalog F10.2 „KfW mit Chat“).
// Nachrichten je Projekt-Akte, beide Richtungen; unveränderlich (kein
// Editieren/Löschen). Intern installation.read/write (keine neue
// Permission); Kunde ausschließlich über die DEFINER-Token-Kapsel.
// ═══════════════════════════════════════════════════════════════════════
export type { SubsidyChatMessage };

export async function listSubsidyMessages(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<SubsidyChatMessage[]> {
  requireRead(ctx, projectId);
  if (!uuidSchema.safeParse(projectId).success) throw new SubsidyCaseValidationError();
  const rows = await tx.execute<{ side: string; body: string; at: Date | string }>(sql`
    select chat.author_side as side, chat.body,
           chat.created_at as at
      from subsidy_case_message as chat
      join subsidy_case as scase
        on scase.workspace_id = chat.workspace_id
       and scase.id = chat.subsidy_case_id
     where chat.workspace_id = ${ctx.workspaceId}::uuid
       and chat.project_id = ${projectId}::uuid
     order by chat.created_at, chat.id
  `);
  return rows.rows.map((row) => ({
    side: row.side === "customer" ? "customer" : "internal",
    body: row.body,
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
  }));
}

export async function postSubsidyMessage(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { caseId: string; body: string },
): Promise<SubsidyChatMessage> {
  const parsed = z.strictObject({
    caseId: uuidSchema,
    body: subsidyChatBodySchema,
  }).safeParse(input);
  if (!parsed.success) throw new SubsidyCaseValidationError();
  const cases = await tx.execute<{ id: string; project_id: string }>(sql`
    select id, project_id from subsidy_case
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.caseId}::uuid
     limit 1
  `);
  const found = cases.rows[0];
  if (!found) throw new SubsidyCaseNotFoundError(parsed.data.caseId);
  requireWrite(ctx, found.project_id);
  const inserted = await tx.execute<{ side: string; body: string; at: Date | string }>(sql`
    insert into subsidy_case_message (
      workspace_id, project_id, subsidy_case_id, author_side, body, created_by
    ) values (
      ${ctx.workspaceId}::uuid, ${found.project_id}::uuid, ${found.id}::uuid,
      'internal', ${parsed.data.body}, ${ctx.actor}::uuid
    )
    returning author_side as side, body, created_at as at
  `);
  const row = inserted.rows[0];
  if (!row) throw new SubsidyCaseNotFoundError(parsed.data.caseId);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: found.project_id,
    eventType: "subsidy_case.message_posted",
    actor: ctx.actor,
    payload: { caseId: found.id, side: "internal" },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "subsidy_case.post_message",
    resource: "project",
    allowed: true,
    details: { projectId: found.project_id, caseId: found.id, side: "internal" },
  });
  return {
    side: "internal",
    body: row.body,
    at: row.at instanceof Date ? row.at.toISOString() : String(row.at),
  };
}

export type SubsidyMessagePostOutcome = "ok" | "invalid";

export async function postSubsidyMessageByToken(
  pool: Pool,
  input: { token: string; caseId: string | null; body: string },
): Promise<{ outcome: SubsidyMessagePostOutcome }> {
  const parsed = z.strictObject({
    token: z.string().min(1),
    // NULL = die eine Akte des Projekts (Portal kennt keine IDs).
    caseId: uuidSchema.nullable(),
    body: subsidyChatBodySchema,
  }).safeParse(input);
  if (!parsed.success) {
    if (!parsed.error.issues.some((issue) => issue.path.join(".") === "body")) {
      throw new SubsidyCaseNotFoundError("portal");
    }
    return { outcome: "invalid" };
  }
  const { token, caseId, body } = parsed.data;
  let view;
  try {
    view = await resolvePortalByToken(pool, { token });
  } catch (error) {
    if (error instanceof PortalNotFoundError) {
      throw new SubsidyCaseNotFoundError(caseId ?? "portal");
    }
    throw error;
  }
  const tokenHash = hashPortalToken(token);
  if (tokenHash === null) throw new SubsidyCaseValidationError("token rejected");
  const outcome = await pool.query(
    `select public.post_subsidy_message($1::bytea, $2::uuid, $3::text) as result`,
    [tokenHash, caseId, body],
  );
  const result = z.strictObject({ result: z.string() }).safeParse(outcome.rows[0]);
  const status = result.success ? result.data.result : null;
  if (status === "ok") return { outcome: "ok" };
  if (status === "invalid") return { outcome: "invalid" };
  throw new SubsidyCaseNotFoundError(view.project.id);
}
