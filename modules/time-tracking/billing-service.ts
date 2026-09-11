// F9-07 Abrechnungslauf — freigegebene Einträge je Zeitraum übernehmen,
// Lauf schließen (Snapshot-Summen). Kein Delete.
// Keine neuen Permissions: time.read/time.write.
import { sql } from "drizzle-orm";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  BILLING_RUN_SCHEMA_VERSION,
  billingRunBreakdownDtoSchema,
  billingRunDtoSchema,
  closeBillingRunCommandSchema,
  createBillingRunCommandSchema,
  getBillingRunBreakdownCommandSchema,
  type BillingRunBreakdownDto,
  type BillingRunDto,
  type CloseBillingRunCommand,
  type CreateBillingRunCommand,
  type GetBillingRunBreakdownCommand,
} from "@/lib/integrations/time-tracking/billing-contract";
import { listTimeMemberOptions } from "./service";
import {
  TimeTrackingConflictError,
  TimeTrackingNotFoundError,
  TimeTrackingValidationError,
} from "./errors";

function requireRead(ctx: ServiceCtx): void {
  if (!can(ctx, "time.read")) {
    throw new PermissionDeniedError("time.read", "time_tracking", undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (!can(ctx, "time.write")) {
    throw new PermissionDeniedError("time.write", "time_tracking", undefined, ctx.actor);
  }
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
    resource: "time_tracking",
    allowed: true,
    details,
  });
}

type BillingRunRow = {
  id: string;
  label: string;
  period_start: string;
  period_end: string;
  status: "open" | "closed";
  total_minutes: number;
  entry_count: number;
  closed_by: string | null;
  closed_at: string | null;
  created_at: string;
  updated_at: string;
};

const RUN_SELECT = sql`
  select id, label, period_start::text, period_end::text, status,
         total_minutes, entry_count, closed_by, closed_at,
         created_at, updated_at
    from billing_run
`;

function toDto(row: BillingRunRow, canWrite: boolean): BillingRunDto {
  return billingRunDtoSchema.parse({
    schemaVersion: BILLING_RUN_SCHEMA_VERSION,
    id: row.id,
    label: row.label,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    totalMinutes: row.total_minutes,
    entryCount: row.entry_count,
    closedBy: row.closed_by,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    permissions: { canWrite },
  });
}

export async function listBillingRuns(
  tx: TenantTx,
  ctx: ServiceCtx,
): Promise<BillingRunDto[]> {
  requireRead(ctx);
  const result = await tx.execute<BillingRunRow>(sql`
    ${RUN_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
   order by period_start desc, period_end desc, id asc
  `);
  const write = can(ctx, "time.write");
  return result.rows.map((row) => toDto(row, write));
}

export async function createBillingRun(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateBillingRunCommand,
): Promise<BillingRunDto> {
  requireWrite(ctx);
  const parsed = createBillingRunCommandSchema.safeParse(input);
  if (!parsed.success) throw new TimeTrackingValidationError("billing run invalid");
  const command = parsed.data;

  const inserted = await tx.execute<BillingRunRow>(sql`
    insert into billing_run (
      workspace_id, label, period_start, period_end, created_by
    ) values (
      ${ctx.workspaceId}::uuid,
      ${command.label},
      ${command.periodStart}::date,
      ${command.periodEnd}::date,
      ${ctx.actor}::uuid
    )
    returning id, label, period_start::text, period_end::text, status,
              total_minutes, entry_count, closed_by, closed_at,
              created_at, updated_at
  `);
  const row = inserted.rows[0]!;
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "billing_run",
    aggregateId: row.id,
    eventType: "billing_run.created",
    actor: ctx.actor,
    payload: { label: command.label },
  });
  await writeAuditFor(tx, ctx, "time.billing_run.create", { id: row.id });
  return toDto(row, true);
}

// Lauf schließen: übernimmt atomar alle abrechenbaren Einträge des Zeitraums
// (beendet, freigegeben, nicht archiviert, Start-Tag Europe/Berlin im Zeitraum,
// noch in keinem Lauf) und friert Anzahl + Bruttosumme ein.
export async function closeBillingRun(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CloseBillingRunCommand,
): Promise<BillingRunDto> {
  requireWrite(ctx);
  const parsed = closeBillingRunCommandSchema.safeParse(input);
  if (!parsed.success) throw new TimeTrackingValidationError("billing run invalid");

  const current = await tx.execute<BillingRunRow>(sql`
    ${RUN_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     and id = ${parsed.data.id}::uuid
     for update
  `);
  const run = current.rows[0];
  if (!run) throw new TimeTrackingNotFoundError("billing_run", parsed.data.id);
  if (run.status !== "open") throw new TimeTrackingConflictError("billing run already closed");

  await tx.execute(sql`
    insert into billing_run_entry (run_id, workspace_id, time_entry_id)
    select ${run.id}::uuid, ${ctx.workspaceId}::uuid, e.id
      from time_entry e
     where e.workspace_id = ${ctx.workspaceId}::uuid
       and e.end_at is not null
       and e.approved_at is not null
       and e.archived_at is null
       and (e.start_at at time zone 'Europe/Berlin')::date
           between ${run.period_start}::date and ${run.period_end}::date
       and not exists (
         select 1 from billing_run_entry b
          where b.workspace_id = ${ctx.workspaceId}::uuid
            and b.time_entry_id = e.id
       )
  `);
  const totals = await tx.execute<{ entry_count: number; total_minutes: number }>(sql`
    select count(*)::int as entry_count,
           coalesce(sum(e.working_time_minutes), 0)::int as total_minutes
      from billing_run_entry b
      join time_entry e
        on e.workspace_id = b.workspace_id and e.id = b.time_entry_id
     where b.workspace_id = ${ctx.workspaceId}::uuid
       and b.run_id = ${run.id}::uuid
  `);
  const snapshot = totals.rows[0]!;
  const updated = await tx.execute<BillingRunRow>(sql`
    update billing_run
       set status = 'closed',
           total_minutes = ${snapshot.total_minutes},
           entry_count = ${snapshot.entry_count},
           closed_by = ${ctx.actor}::uuid,
           closed_at = statement_timestamp(),
           updated_at = statement_timestamp()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${run.id}::uuid
    returning id, label, period_start::text, period_end::text, status,
              total_minutes, entry_count, closed_by, closed_at,
              created_at, updated_at
  `);
  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "billing_run",
    aggregateId: run.id,
    eventType: "billing_run.closed",
    actor: ctx.actor,
    payload: { entryCount: snapshot.entry_count, totalMinutes: snapshot.total_minutes },
  });
  await writeAuditFor(tx, ctx, "time.billing_run.close", { id: run.id });
  return toDto(updated.rows[0]!, true);
}

// F9-08 Lauf-Auswertung — Zeilen je Person aus dem eingefrorenen Lauf.
// Reiner Lesepfad (time.read): Die Zeilensummen müssen exakt dem Snapshot
// entsprechen, sonst Integritätsfehler statt stiller Anzeige. Offene Läufe
// liefern leere Zeilen (keine vorweggenommene Auswertung).
export async function getBillingRunBreakdown(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: GetBillingRunBreakdownCommand,
): Promise<BillingRunBreakdownDto> {
  requireRead(ctx);
  const parsed = getBillingRunBreakdownCommandSchema.safeParse(input);
  if (!parsed.success) throw new TimeTrackingValidationError("billing run breakdown invalid");
  const runResult = await tx.execute<BillingRunRow>(sql`
    ${RUN_SELECT}
   where workspace_id = ${ctx.workspaceId}::uuid
     and id = ${parsed.data.billingRunId}::uuid
  `);
  const run = runResult.rows[0];
  if (!run) throw new TimeTrackingNotFoundError("billing_run", parsed.data.billingRunId);
  if (run.status !== "closed") {
    return billingRunBreakdownDtoSchema.parse({
      schemaVersion: BILLING_RUN_SCHEMA_VERSION,
      billingRunId: run.id,
      entryCount: 0,
      totalMinutes: 0,
      rows: [],
    });
  }
  const members = await listTimeMemberOptions(tx, ctx);
  const labelByUserId = new Map(members.map((member) => [member.userId, member.label]));
  const rows = await tx.execute<{
    user_id: string;
    entry_count: number;
    total_minutes: number;
  }>(sql`
    select e.user_id,
           count(*)::int as entry_count,
           coalesce(sum(e.working_time_minutes), 0)::int as total_minutes
      from billing_run_entry b
      join time_entry e
        on e.workspace_id = b.workspace_id and e.id = b.time_entry_id
     where b.workspace_id = ${ctx.workspaceId}::uuid
       and b.run_id = ${run.id}::uuid
     group by e.user_id
     order by coalesce(sum(e.working_time_minutes), 0) desc, e.user_id asc
  `);
  const entryCount = rows.rows.reduce((sum, row) => sum + row.entry_count, 0);
  const totalMinutes = rows.rows.reduce((sum, row) => sum + row.total_minutes, 0);
  if (entryCount !== run.entry_count || totalMinutes !== run.total_minutes) {
    throw new TimeTrackingValidationError("billing run snapshot mismatch");
  }
  return billingRunBreakdownDtoSchema.parse({
    schemaVersion: BILLING_RUN_SCHEMA_VERSION,
    billingRunId: run.id,
    entryCount,
    totalMinutes,
    rows: rows.rows.map((row) => ({
      schemaVersion: BILLING_RUN_SCHEMA_VERSION,
      userId: row.user_id,
      label: labelByUserId.get(row.user_id) ?? "Unbekannt",
      entryCount: row.entry_count,
      totalWorkingMinutes: row.total_minutes,
    })),
  });
}

// F9-07-Sperre: Einträge in geschlossenem Lauf sind gegen Unapprove gesperrt
// (ansonsten wäre der Snapshot nachträglich falsch).
export async function isEntryBilled(
  tx: TenantTx,
  ctx: ServiceCtx,
  timeEntryId: string,
): Promise<boolean> {
  const result = await tx.execute<{ billed: boolean }>(sql`
    select exists (
      select 1
        from billing_run_entry b
        join billing_run r
          on r.workspace_id = b.workspace_id and r.id = b.run_id
       where b.workspace_id = ${ctx.workspaceId}::uuid
         and b.time_entry_id = ${timeEntryId}::uuid
         and r.status = 'closed'
    ) as billed
  `);
  return result.rows[0]!.billed;
}
