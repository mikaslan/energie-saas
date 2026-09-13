// F1-06 Lead-Wiedervorlage: Fälligkeitszeitpunkt je Anfrage setzen/löschen.
// In-App-Eskalation ohne Mailversand — die Bänder berechnet die Leseregel
// (lib/follow-up.ts) aus dem gespeicherten Wert. Berechtigung: bestehendes
// project.write (KEIN neuer Key). Kein Revision-CAS: Zeitstempel ist
// Last-Writer-Wins (harmlos, kein Beleg), Zeilensperre hält Audit atomar.
import { sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { followUpBandForDate, parseFollowUpAt, type FollowUpBand } from "@/lib/follow-up";
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class FollowUpValidationError extends Error {
  constructor(message = "follow-up input invalid") {
    super(message);
    this.name = "FollowUpValidationError";
  }
}

export class FollowUpNotFoundError extends Error {
  constructor() {
    super("project not found");
    this.name = "FollowUpNotFoundError";
  }
}

const followUpCommandSchema = z.object({
  projectId: z.uuid(),
  // ISO-Datumzeit mit Offset (datetime-local wird in der Action ergänzt);
  // null löscht die Wiedervorlage. Jahr 2020–2100 gegen Tippfehler.
  followUpAt: z
    .string()
    .refine((value) => {
      const date = parseFollowUpAt(value);
      return date !== null && date.getUTCFullYear() >= 2020 && date.getUTCFullYear() <= 2100;
    }, "follow-up datetime invalid")
    .nullable(),
});

export type FollowUpResult = {
  projectId: string;
  followUpAt: string | null;
};

export async function getProjectFollowUp(
  tx: TenantTx,
  ctx: ServiceCtx,
  projectId: string,
): Promise<FollowUpResult> {
  if (!can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", "project", projectId, ctx.actor);
  }
  const found = await tx.execute<{ follow_up_at: Date | string | null }>(sql`
    select follow_up_at
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${projectId}::uuid
  `);
  const row = found.rows[0];
  if (!row) throw new FollowUpNotFoundError();
  const at = parseFollowUpAt(row.follow_up_at);
  return { projectId, followUpAt: at === null ? null : at.toISOString() };
}

export type FollowUpDashboardEntry = {
  projectId: string;
  name: string;
  followUpAt: string;
  band: Exclude<FollowUpBand, "scheduled">;
};

const DASHBOARD_DEFAULT_LIMIT = 5;
const DASHBOARD_MAX_LIMIT = 20;

// F1-06b Dashboard-Widget: handlungsbedürftige Wiedervorlagen über alle
// offenen Anfragen (fällig/überfällig/eskaliert, fälligste zuerst).
// Kein neuer Permission-Key (project.read); Externe sehen bewusst nichts
// (internes Arbeitsdatum, gleiche Regel wie Board-Filter).
export async function listFollowUpDashboard(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { limit?: number } = {},
): Promise<FollowUpDashboardEntry[]> {
  if (!can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", "project", undefined, ctx.actor);
  }
  if (isExternalOnly(ctx)) return [];
  const limit = query.limit ?? DASHBOARD_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > DASHBOARD_MAX_LIMIT) {
    throw new FollowUpValidationError("dashboard limit invalid");
  }
  const rows = (
    await tx.execute<{ id: string; name: string; follow_up_at: Date | string }>(sql`
      select id, name, follow_up_at
        from project
       where workspace_id = ${ctx.workspaceId}::uuid
         and phase = 'request'
         and outcome = 'open'
         and follow_up_at is not null
       order by follow_up_at asc, id asc
       limit ${limit}
    `)
  ).rows;
  const now = new Date();
  const entries: FollowUpDashboardEntry[] = [];
  for (const row of rows) {
    const at = parseFollowUpAt(row.follow_up_at);
    if (at === null) continue;
    const band = followUpBandForDate(at, now);
    if (band === "scheduled") continue;
    entries.push({ projectId: row.id, name: row.name, followUpAt: at.toISOString(), band });
  }
  return entries;
}

export async function setProjectFollowUp(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: { projectId: string; followUpAt: string | null },
): Promise<FollowUpResult> {
  if (!can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", "project", input.projectId, ctx.actor);
  }
  const parsed = followUpCommandSchema.safeParse(input);
  if (!parsed.success) throw new FollowUpValidationError();
  const command = parsed.data;

  const locked = await tx.execute<{ id: string }>(sql`
    select id
      from project
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
     for update
  `);
  if (!locked.rows[0]) throw new FollowUpNotFoundError();

  const followUpAt = command.followUpAt === null
    ? null
    : parseFollowUpAt(command.followUpAt)!.toISOString();
  await tx.execute(sql`
    update project
       set follow_up_at = ${followUpAt}::timestamptz,
           updated_at = now()
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${command.projectId}::uuid
  `);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: "project",
    aggregateId: command.projectId,
    eventType: "project.follow_up_changed",
    actor: ctx.actor,
    payload: { cleared: followUpAt === null },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "project.follow_up",
    resource: "project",
    allowed: true,
    details: { projectId: command.projectId, cleared: followUpAt === null },
  });
  return { projectId: command.projectId, followUpAt };
}
