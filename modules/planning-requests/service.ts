// F13-11 Planungsservice (Katalog F13.3): genau eine Anfrage je Angebot
// mit Fristwahl (24 h/48 h/Datum) und kleiner Statusmaschine
// (requested → in_progress → finished → accepted). Berechtigung:
// Wiederverwendung installation.read/write (KEINE neuen Permission-Keys
// — F13-01-Präzedenz). Modul ist server-only (Muster
// modules/file-requests/service.ts).
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class PlanningRequestNotFoundError extends Error {
  constructor(public readonly requestId: string) {
    super(`planning request not found: ${requestId}`);
    this.name = "PlanningRequestNotFoundError";
  }
}

export class PlanningRequestValidationError extends Error {
  constructor(message = "planning request validation failed") {
    super(message);
    this.name = "PlanningRequestValidationError";
  }
}

export class PlanningRequestConflictError extends Error {
  constructor(public readonly offerId: string) {
    super(`planning request already exists for offer: ${offerId}`);
    this.name = "PlanningRequestConflictError";
  }
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const deadlineKinds = ["express_24h", "standard_48h", "date"] as const;
export type PlanningDeadlineKind = (typeof deadlineKinds)[number];

const planningStatuses = ["requested", "in_progress", "finished", "accepted"] as const;
export type PlanningRequestStatus = (typeof planningStatuses)[number];

const nextStatus: Record<PlanningRequestStatus, PlanningRequestStatus | null> = {
  requested: "in_progress",
  in_progress: "finished",
  finished: "accepted",
  accepted: null,
};

export type PlanningRequestOverdueProbe = {
  status: string;
  deadlineAt?: string | Date | null | undefined;
};

function toIsoDay(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new PlanningRequestValidationError("invalid date");
  return date.toISOString().slice(0, 10);
}

/**
 * F13-14 §4 Überfällig-Erkennung (rein lesend, KEINE Automatik, KEIN
 * Event): true, wenn deadline_at (F13-11-Bestand: resolveDeadlineAt —
 * 24 h/48 h ab Anlage oder Wunschtermin) überschritten ist und die
 * Anfrage noch in requested/in_progress steht. finished und accepted
 * sind nie überfällig. Tagesvergleich in UTC (kein stiller Wechsel
 * auf Werktage — Spec §4).
 */
export function isPlanningRequestOverdue(
  request: PlanningRequestOverdueProbe,
  todayIso: string = toIsoDay(new Date()),
): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(todayIso)) {
    throw new PlanningRequestValidationError("invalid reference date");
  }
  if (request.status !== "requested" && request.status !== "in_progress") return false;
  const at = request.deadlineAt;
  if (at === undefined || at === null) {
    throw new PlanningRequestValidationError("missing deadline");
  }
  return toIsoDay(at) < todayIso;
}

const requestPlanningCommandSchema = z.strictObject({
  projectId: uuidSchema,
  offerId: uuidSchema,
  deadlineKind: z.enum(deadlineKinds),
  // Nur bei deadlineKind=date: YYYY-MM-DD (Berlin), strikt zukünftig.
  deadlineDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable().optional(),
});

const setPlanningStatusCommandSchema = z.strictObject({
  id: uuidSchema,
  status: z.enum(planningStatuses),
});

export type PlanningRequestDto = {
  id: string;
  projectId: string;
  offerId: string;
  offerNumber: string | null;
  deadlineKind: PlanningDeadlineKind;
  deadlineAt: string;
  status: PlanningRequestStatus;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  permissions: { canWrite: boolean };
};

type PlanningRequestRow = {
  id: string;
  project_id: string;
  offer_id: string;
  offer_number: string | null;
  deadline_kind: string;
  deadline_at: string | Date;
  status: string;
  created_at: string | Date;
  updated_at: string | Date;
  finished_at: string | Date | null;
};

function toDto(row: PlanningRequestRow, canWrite: boolean): PlanningRequestDto {
  if (!planningStatuses.includes(row.status as PlanningRequestStatus)) {
    throw new PlanningRequestValidationError();
  }
  if (!deadlineKinds.includes(row.deadline_kind as PlanningDeadlineKind)) {
    throw new PlanningRequestValidationError();
  }
  return {
    id: row.id,
    projectId: row.project_id,
    offerId: row.offer_id,
    offerNumber: row.offer_number,
    deadlineKind: row.deadline_kind as PlanningDeadlineKind,
    deadlineAt: new Date(row.deadline_at).toISOString(),
    status: row.status as PlanningRequestStatus,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    finishedAt: row.finished_at === null ? null : new Date(row.finished_at).toISOString(),
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

function berlinToday(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

/**
 * Frist-Ableitung (Service, deterministisch): 24 h/48 h ab jetzt;
 * Datum-Art als 12:00 UTC des Tages [ESTIMATE: neutrale Tagesmitte statt
 * Tagesende/-anfang, strikt zukuenftiges Datum]. CHECK-konform
 * (deadline_at >= created_at) per Konstruktion.
 */
function resolveDeadlineAt(kind: PlanningDeadlineKind, date: string | null | undefined): Date {
  const now = Date.now();
  if (kind === "express_24h") return new Date(now + 24 * 3_600_000);
  if (kind === "standard_48h") return new Date(now + 48 * 3_600_000);
  if (typeof date !== "string" || date <= berlinToday()) {
    throw new PlanningRequestValidationError("deadline date must be a future date");
  }
  const at = new Date(`${date}T12:00:00.000Z`);
  if (Number.isNaN(at.getTime())) throw new PlanningRequestValidationError();
  return at;
}

const BASE_SELECT = sql`
  select request.id, request.project_id, request.offer_id,
         offer_record.offer_number,
         request.deadline_kind, request.deadline_at, request.status,
         request.created_at, request.updated_at, request.finished_at
    from planning_request as request
    join offer as offer_record
      on offer_record.workspace_id = request.workspace_id
     and offer_record.id = request.offer_id
`;

export async function requestPlanning(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: {
    projectId: string;
    offerId: string;
    deadlineKind: PlanningDeadlineKind;
    deadlineDate?: string | null;
  },
): Promise<PlanningRequestDto> {
  requireWrite(ctx);
  const parsed = requestPlanningCommandSchema.safeParse(input);
  if (!parsed.success) throw new PlanningRequestValidationError();
  if (parsed.data.deadlineKind === "date" && (parsed.data.deadlineDate ?? null) === null) {
    throw new PlanningRequestValidationError();
  }
  if (parsed.data.deadlineKind !== "date" && (parsed.data.deadlineDate ?? null) !== null) {
    throw new PlanningRequestValidationError();
  }
  const deadlineAt = resolveDeadlineAt(
    parsed.data.deadlineKind,
    parsed.data.deadlineDate ?? null,
  );

  // Scope: Angebot gehört zu einem Projekt DIESES Workspaces; Bindung an
  // das genannte Projekt (kein Leak über fremde Angebote).
  const scope = await tx.execute<{ id: string; project_id: string }>(sql`
    select id, project_id
      from offer
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.offerId}::uuid
       and project_id = ${parsed.data.projectId}::uuid
     limit 1
  `);
  if (!scope.rows[0]) throw new PlanningRequestNotFoundError(parsed.data.offerId);

  const inserted = await tx.execute<PlanningRequestRow>(sql`
    insert into planning_request (
      workspace_id, project_id, offer_id, deadline_kind, deadline_at, created_by
    ) values (
      ${ctx.workspaceId}::uuid,
      ${parsed.data.projectId}::uuid,
      ${parsed.data.offerId}::uuid,
      ${parsed.data.deadlineKind},
      ${deadlineAt.toISOString()}::timestamptz,
      ${ctx.actor}::uuid
    )
    on conflict (workspace_id, offer_id) do nothing
    returning id, project_id, offer_id, deadline_kind, deadline_at, status,
              created_at, updated_at, finished_at
  `);
  const created = inserted.rows[0];
  if (!created) throw new PlanningRequestConflictError(parsed.data.offerId);
  const read = await tx.execute<PlanningRequestRow>(sql`
    ${BASE_SELECT}
     where request.workspace_id = ${ctx.workspaceId}::uuid
       and request.id = ${created.id}::uuid
     limit 1
  `);
  const row = read.rows[0];
  if (!row) throw new PlanningRequestNotFoundError(created.id);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "planning_request",
    aggregateId: created.id,
    eventType: "planning_request.requested",
    actor: ctx.actor,
    payload: { projectId: parsed.data.projectId, offerId: parsed.data.offerId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_request.request",
    resource: "planning_request",
    allowed: true,
    details: { projectId: parsed.data.projectId, offerId: parsed.data.offerId },
  });
  return toDto(row, true);
}

// F13-14 §4: Dedupe für planning_request.overdue — max. 1 Event je
// Anfrage (domain_events-Check auf Aggregat + Event-Typ).
async function hasOverdueEvent(
  tx: TenantTx,
  workspaceId: string,
  requestId: string,
): Promise<boolean> {
  const existing = await tx.execute<{ id: string }>(sql`
    select id from domain_events
     where workspace_id = ${workspaceId}::uuid
       and aggregate_type = 'planning_request'
       and aggregate_id = ${requestId}::uuid
       and event_type = 'planning_request.overdue'
     limit 1
  `);
  return Boolean(existing.rows[0]);
}

async function emitOverdueOnce(
  tx: TenantTx,
  ctx: ServiceCtx,
  requestId: string,
  trigger: "check" | "finished",
): Promise<void> {
  if (await hasOverdueEvent(tx, ctx.workspaceId, requestId)) return;
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "planning_request",
    aggregateId: requestId,
    eventType: "planning_request.overdue",
    actor: ctx.actor,
    payload: { requestId },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_request.check_overdue",
    resource: "planning_request",
    allowed: true,
    details: { requestId, trigger },
  });
}

export async function setPlanningStatus(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { id: string; status: PlanningRequestStatus },
): Promise<PlanningRequestDto> {
  requireWrite(ctx);
  const parsed = setPlanningStatusCommandSchema.safeParse(input);
  if (!parsed.success) throw new PlanningRequestValidationError();
  const current = await tx.execute<{ status: string; deadline_at: string | Date }>(sql`
    select status, deadline_at from planning_request
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.id}::uuid
     limit 1
  `);
  const row = current.rows[0];
  if (!row) throw new PlanningRequestNotFoundError(parsed.data.id);
  if (!planningStatuses.includes(row.status as PlanningRequestStatus)) {
    throw new PlanningRequestValidationError();
  }
  if (nextStatus[row.status as PlanningRequestStatus] !== parsed.data.status) {
    throw new PlanningRequestValidationError("illegal status transition");
  }
  // F13-14 §4: Überfällig-Prüfung VOR dem finished-Setzen (danach wäre der
  // Status finished und die Probe immer false).
  const markFinished = parsed.data.status === "finished";
  const wasOverdue =
    markFinished &&
    isPlanningRequestOverdue({ status: row.status, deadlineAt: row.deadline_at });
  const updated = await tx.execute<PlanningRequestRow>(sql`
    update planning_request
       set status = ${parsed.data.status},
           finished_at = case when ${markFinished}::boolean
                              then statement_timestamp()
                              else finished_at end,
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.id}::uuid
       and status = ${row.status}
    returning id, project_id, offer_id, deadline_kind, deadline_at, status,
              created_at, updated_at, finished_at
  `);
  const next = updated.rows[0];
  if (!next) throw new PlanningRequestValidationError("concurrent status change");
  const read = await tx.execute<PlanningRequestRow>(sql`
    ${BASE_SELECT}
     where request.workspace_id = ${ctx.workspaceId}::uuid
       and request.id = ${next.id}::uuid
     limit 1
  `);
  const full = read.rows[0];
  if (!full) throw new PlanningRequestNotFoundError(next.id);
  if (wasOverdue) {
    await emitOverdueOnce(tx, ctx, next.id, "finished");
  }
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "planning_request",
    aggregateId: next.id,
    eventType: "planning_request.status_changed",
    actor: ctx.actor,
    payload: { status: parsed.data.status },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_request.set_status",
    resource: "planning_request",
    allowed: true,
    details: { requestId: next.id, status: parsed.data.status },
  });
  return toDto(full, true);
}

const checkPlanningOverdueCommandSchema = z.strictObject({
  requestId: uuidSchema,
});

/**
 * F13-14 §4: explizite Überfällig-Feststellung (IDEMPOTENT, kein Lesepfad,
 * keine Automatik). Emittiert planning_request.overdue max. 1x je Anfrage
 * (Dedupe via domain_events). NotFound bei fehlender Anfrage, Validation
 * wenn (noch) nicht überfällig.
 */
export async function checkPlanningRequestOverdue(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { requestId: string },
): Promise<PlanningRequestDto> {
  requireWrite(ctx);
  const parsed = checkPlanningOverdueCommandSchema.safeParse(input);
  if (!parsed.success) throw new PlanningRequestValidationError();
  const current = await tx.execute<{ status: string; deadline_at: string | Date }>(sql`
    select status, deadline_at from planning_request
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data.requestId}::uuid
     limit 1
  `);
  const row = current.rows[0];
  if (!row) throw new PlanningRequestNotFoundError(parsed.data.requestId);
  if (!isPlanningRequestOverdue({ status: row.status, deadlineAt: row.deadline_at })) {
    throw new PlanningRequestValidationError("planning request is not overdue");
  }
  await emitOverdueOnce(tx, ctx, parsed.data.requestId, "check");
  const read = await tx.execute<PlanningRequestRow>(sql`
    ${BASE_SELECT}
     where request.workspace_id = ${ctx.workspaceId}::uuid
       and request.id = ${parsed.data.requestId}::uuid
     limit 1
  `);
  const full = read.rows[0];
  if (!full) throw new PlanningRequestNotFoundError(parsed.data.requestId);
  return toDto(full, true);
}

export async function listPlanningRequests(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string },
): Promise<PlanningRequestDto[]> {
  requireRead(ctx);
  const parsed = z.strictObject({ projectId: uuidSchema }).safeParse(query);
  if (!parsed.success) throw new PlanningRequestValidationError();
  const canWrite = can(ctx, "installation.write");
  const rows = await tx.execute<PlanningRequestRow>(sql`
    ${BASE_SELECT}
     where request.workspace_id = ${ctx.workspaceId}::uuid
       and request.project_id = ${parsed.data.projectId}::uuid
     order by request.created_at, request.id
  `);
  return rows.rows.map((row) => toDto(row, canWrite));
}
