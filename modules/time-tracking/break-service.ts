// F9-06 Pausen-Segmente: Start/Ende-Protokoll je Zeiteintrag.
// Hinweis: KEIN "server-only"-Import (Modulgrenze wie service.ts).
// Berechtigung: bestehende time.read/write (KEINE neuen Keys).
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  TimeTrackingConflictError,
  TimeTrackingNotFoundError,
  TimeTrackingValidationError,
} from "./errors";

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "time.read")) {
    throw new PermissionDeniedError("time.read", "time_break_segment", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "time.write")) {
    throw new PermissionDeniedError("time.write", "time_break_segment", undefined, ctx.actor);
  }
}

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

export type BreakSegmentDto = {
  id: string;
  entryId: string;
  startedAt: string;
  endedAt: string | null;
  createdBy: string;
};

type SegmentRow = {
  id: string;
  entry_id: string;
  started_at: string;
  ended_at: string | null;
  created_by: string;
};

function toDto(row: SegmentRow): BreakSegmentDto {
  return {
    id: row.id,
    entryId: row.entry_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdBy: row.created_by,
  };
}

type EntryGate = { id: string; approved_at: string | null };

async function lockEntry(tx: TenantTx, ctx: ServiceCtx, entryId: string): Promise<EntryGate> {
  const found = await tx.execute<EntryGate>(sql`
    select id, approved_at
      from time_entry
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${entryId}::uuid
     limit 1
  `);
  const entry = found.rows[0];
  if (!entry) throw new TimeTrackingNotFoundError("time_entry", entryId);
  // F9-05-Unveränderlichkeit: freigegebene Einträge nehmen keine Segmente.
  if (entry.approved_at !== null) {
    throw new TimeTrackingConflictError("break on approved entry");
  }
  return entry;
}

/**
 * Pause starten (offenes Segment). Fail-closed bei unbekanntem Eintrag,
 * freigegebenem Eintrag oder bereits offener Pause (Partial-Unique als
 * zweite Schranke).
 */
export async function startBreak(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { entryId: string },
): Promise<BreakSegmentDto> {
  requireWrite(ctx);
  const parsed = z.strictObject({ entryId: uuidSchema }).safeParse(input);
  if (!parsed.success) throw new TimeTrackingValidationError();
  await lockEntry(tx, ctx, parsed.data.entryId);

  const open = await tx.execute<{ id: string }>(sql`
    select id from time_break_segment
     where workspace_id = ${ctx.workspaceId}::uuid
       and entry_id = ${parsed.data.entryId}::uuid
       and ended_at is null
     limit 1
  `);
  if (open.rows[0]) throw new TimeTrackingConflictError("break already open");

  const created = await tx.execute<SegmentRow>(sql`
    insert into time_break_segment (workspace_id, entry_id, created_by)
    values (${ctx.workspaceId}::uuid, ${parsed.data.entryId}::uuid, ${ctx.actor}::uuid)
    returning id, entry_id, started_at, ended_at, created_by
  `);
  const row = created.rows[0];
  if (!row) throw new TimeTrackingValidationError("break not created");

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "time_entry",
    aggregateId: parsed.data.entryId,
    eventType: "time_break.started",
    actor: ctx.actor,
    payload: { breakId: row.id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "time_break.start",
    resource: "time_break_segment",
    allowed: true,
    details: { entryId: parsed.data.entryId, breakId: row.id },
  });
  return toDto(row);
}

/**
 * Offene Pause schließen. Fail-closed ohne offene Pause, bei Ende vor
 * Beginn und bei Zukunfts-Stempeln.
 */
export async function endBreak(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { entryId: string },
): Promise<BreakSegmentDto> {
  requireWrite(ctx);
  const parsed = z.strictObject({ entryId: uuidSchema }).safeParse(input);
  if (!parsed.success) throw new TimeTrackingValidationError();
  await lockEntry(tx, ctx, parsed.data.entryId);

  const closed = await tx.execute<SegmentRow>(sql`
    update time_break_segment
       set ended_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and entry_id = ${parsed.data.entryId}::uuid
       and ended_at is null
    returning id, entry_id, started_at, ended_at, created_by
  `);
  const row = closed.rows[0];
  if (!row) throw new TimeTrackingConflictError("no open break");
  if (row.ended_at === null || row.ended_at < row.started_at) {
    throw new TimeTrackingValidationError("break end before start");
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "time_entry",
    aggregateId: parsed.data.entryId,
    eventType: "time_break.ended",
    actor: ctx.actor,
    payload: { breakId: row.id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "time_break.end",
    resource: "time_break_segment",
    allowed: true,
    details: { entryId: parsed.data.entryId, breakId: row.id },
  });
  return toDto(row);
}

/** Segmente eines Eintrags, chronologisch (offene zuletzt). */
export async function listBreaks(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { entryId: string },
): Promise<BreakSegmentDto[]> {
  requireRead(ctx);
  const parsed = z.strictObject({ entryId: uuidSchema }).safeParse(input);
  if (!parsed.success) throw new TimeTrackingValidationError();
  const result = await tx.execute<SegmentRow>(sql`
    select id, entry_id, started_at, ended_at, created_by
      from time_break_segment
     where workspace_id = ${ctx.workspaceId}::uuid
       and entry_id = ${parsed.data.entryId}::uuid
     order by started_at asc, id asc
  `);
  return result.rows.map(toDto);
}

/**
 * Summe abgeschlossener Segmente in Minuten (kaufmännisch gerundet).
 * Keine Verrechnung mit den Minutensummen des Eintrags — reine Anzeige.
 */
export async function breakMinutesTotal(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { entryId: string },
): Promise<{ entryId: string; breakMinutes: number; openBreak: boolean }> {
  requireRead(ctx);
  const parsed = z.strictObject({ entryId: uuidSchema }).safeParse(input);
  if (!parsed.success) throw new TimeTrackingValidationError();
  const result = await tx.execute<{ seconds: string; open_break: boolean }>(sql`
    select coalesce(sum(extract(epoch from (ended_at - started_at))), 0)::text as seconds,
           bool_or(ended_at is null) as open_break
      from time_break_segment
     where workspace_id = ${ctx.workspaceId}::uuid
       and entry_id = ${parsed.data.entryId}::uuid
  `);
  const row = result.rows[0];
  const seconds = Number(row?.seconds ?? 0);
  if (!Number.isFinite(seconds) || seconds < 0) throw new TimeTrackingValidationError("break total");
  return {
    entryId: parsed.data.entryId,
    breakMinutes: Math.round(seconds / 60),
    openBreak: row?.open_break === true,
  };
}
