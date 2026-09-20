// F3-04b Einzelmodul-Abwahl Stufe-0 (Katalog F3.4): Deselect-Zeilen
// je Panel-Gruppe (row/col, optionale Begruendung). Doppel-Abwahl
// idempotent (DESELECT_IDEMPOTENT). Kein Eingriff in String-/
// Equipment-Logik (DESELECT_NO_PROPAGATION); Gruppe mit Abwahlen ist
// nicht loeschbar (RESTRICT, DESELECT_GROUP_RESTRICT). Rechte analog
// F3-04a ueber project.read/write (keine neuen Permission-Keys).
// Events/Audit enthalten nur IDs.
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { planningPanelDeselect } from "@/lib/db/schema/planning-panel-deselect";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  deselectedEffectiveCount,
  PLANNING_PANEL_DESELECT_VERSION,
  planningPanelDeselectV1Schema,
} from "@/lib/integrations/planning/contracts/panel-deselect";
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class PlanningPanelDeselectNotFoundError extends Error {
  constructor(public readonly id?: string) {
    super(
      id
        ? `planning panel deselect not found: ${id}`
        : "planning panel deselect not found",
    );
    this.name = "PlanningPanelDeselectNotFoundError";
  }
}

export class PlanningPanelDeselectValidationError extends Error {
  constructor(message = "planning panel deselect input is invalid") {
    super(message);
    this.name = "PlanningPanelDeselectValidationError";
  }
}

export { PlanningPanelDeselectNotFoundError as NotFoundError };
export { PlanningPanelDeselectValidationError as ValidationError };

// Anker auf die zentral verwaltete Drizzle-Tabelle (legt der
// Koordinator an, Muster analog F3-04a/F3-05b). Queries laufen als
// Raw-SQL mit expliziten RLS-Praedikaten; der Import verankert den
// Schema-Pfad als Single-Source.
export type PlanningPanelDeselectTable = typeof planningPanelDeselect;
export type PlanningPanelDeselectTableRow =
  typeof planningPanelDeselect.$inferSelect;

const RESOURCE = "planning_panel_deselect";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

export type PlanningPanelDeselectDto = {
  id: string;
  groupId: string;
  row: number;
  col: number;
  reason: string | null;
  createdAt: string;
  permissions: { canWrite: boolean };
};

export type DeselectInput = {
  groupId: string;
  row: unknown;
  col: unknown;
  reason?: unknown;
};

export type ReselectInput = {
  groupId: string;
  row: unknown;
  col: unknown;
};

export type PlanningPanelDeselectEffectiveCount = {
  rows: number;
  cols: number;
  deselected: number;
  effective: number;
};

type DeselectRow = {
  id: string;
  group_id: string;
  row: number;
  col: number;
  reason: string | null;
  created_at: string | Date;
};

type PanelGroupScopeRow = {
  id: string;
  rows: number;
  cols: number;
};

function requireRead(ctx: ServiceCtx, resource: string): void {
  // F3-04b: External fail-closed (Planungsdaten sind sensitiv).
  if (isExternalOnly(ctx) || !can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", resource, undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx, resource: string): void {
  if (isExternalOnly(ctx) || !can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", resource, undefined, ctx.actor);
  }
}

function postgresErrorCode(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    if (candidate && typeof candidate === "object" && "code" in candidate) {
      const code = (candidate as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return null;
}

function parseContractDeselect(input: DeselectInput): {
  groupId: string;
  row: number;
  col: number;
  reason: string | undefined;
} {
  const candidate: Record<string, unknown> = {
    schemaVersion: PLANNING_PANEL_DESELECT_VERSION,
    groupId: input.groupId,
    row: input.row,
    col: input.col,
  };
  if (input.reason !== undefined) candidate.reason = input.reason;
  const parsed = planningPanelDeselectV1Schema.safeParse(candidate);
  if (!parsed.success) throw new PlanningPanelDeselectValidationError();
  const groupId = uuidSchema.safeParse(parsed.data.groupId);
  if (!groupId.success) {
    throw new PlanningPanelDeselectValidationError("panel group id is invalid");
  }
  return {
    groupId: groupId.data,
    row: parsed.data.row,
    col: parsed.data.col,
    reason: parsed.data.reason,
  };
}

function toDeselectDto(row: DeselectRow, canWrite: boolean): PlanningPanelDeselectDto {
  const base = z
    .strictObject({
      groupId: z.uuid(),
      row: z.number().int().min(1),
      col: z.number().int().min(1),
      reason: z.string().min(1).max(280).nullable(),
    })
    .safeParse({
      groupId: row.group_id,
      row: row.row,
      col: row.col,
      reason: row.reason,
    });
  if (!base.success) {
    throw new PlanningPanelDeselectValidationError(
      "planning panel deselect data is invalid",
    );
  }
  return {
    id: row.id,
    groupId: base.data.groupId,
    row: base.data.row,
    col: base.data.col,
    reason: base.data.reason,
    createdAt: new Date(row.created_at).toISOString(),
    permissions: { canWrite },
  };
}

async function requirePanelGroupInScope(
  tx: TenantTx,
  ctx: ServiceCtx,
  groupId: string,
): Promise<PanelGroupScopeRow> {
  // Gruppe mit Dach-Bindung (Gruppe -> Dach -> Quelle) fuer
  // Zugehoerigkeitspruefung und Raster-Range.
  const scope = await tx.execute<PanelGroupScopeRow>(sql`
    select g.id, g.rows, g.cols
      from planning_panel_group g
      join planning_roof_min r
        on r.workspace_id = g.workspace_id
       and r.id = g.roof_id
      join planning_source s
        on s.workspace_id = r.workspace_id
       and s.id = r.source_id
     where g.workspace_id = ${ctx.workspaceId}::uuid
       and g.id = ${groupId}::uuid
     limit 1
  `);
  const group = scope.rows[0];
  if (!group) throw new PlanningPanelDeselectNotFoundError(groupId);
  return group;
}

async function selectDeselectCell(
  tx: TenantTx,
  ctx: ServiceCtx,
  groupId: string,
  row: number,
  col: number,
): Promise<DeselectRow | undefined> {
  const found = await tx.execute<DeselectRow>(sql`
    select id, group_id, "row", "col", reason, created_at
      from planning_panel_deselect
     where workspace_id = ${ctx.workspaceId}::uuid
       and group_id = ${groupId}::uuid
       and "row" = ${row}
       and "col" = ${col}
     limit 1
  `);
  return found.rows[0];
}

export async function deselect(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: DeselectInput,
): Promise<PlanningPanelDeselectDto> {
  requireWrite(ctx, RESOURCE);
  const validated = parseContractDeselect(input);
  const group = await requirePanelGroupInScope(tx, ctx, validated.groupId);
  if (validated.row > group.rows || validated.col > group.cols) {
    throw new PlanningPanelDeselectValidationError(
      "deselect cell exceeds panel group raster",
    );
  }

  let inserted;
  try {
    // ON CONFLICT statt 23505-Catch: Ein geworfener Insert-Fehler
    // abortet die Transaktion — danach waere kein SELECT mehr
    // moeglich (Idempotenz braucht die existierende Zeile).
    inserted = await tx.execute<DeselectRow>(sql`
      insert into planning_panel_deselect (
        workspace_id, group_id, "row", "col", reason, created_by
      ) values (
        ${ctx.workspaceId}::uuid, ${group.id}::uuid,
        ${validated.row}, ${validated.col},
        ${validated.reason ?? null},
        ${ctx.actor}::uuid
      )
      on conflict (group_id, "row", "col") do nothing
      returning id, group_id, "row", "col", reason, created_at
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23503") {
      throw new PlanningPanelDeselectNotFoundError(validated.groupId);
    }
    if (code === "23514") throw new PlanningPanelDeselectValidationError();
    throw error;
  }
  const created = inserted.rows[0];
  if (!created) {
    // Doppel-Abwahl ist idempotent: existierende Zeile lesen und
    // zurueckgeben (kein Event/Audit — No-op).
    const existing = await selectDeselectCell(
      tx,
      ctx,
      group.id,
      validated.row,
      validated.col,
    );
    if (!existing) {
      throw new PlanningPanelDeselectValidationError(
        "planning panel deselect insert failed",
      );
    }
    return toDeselectDto(existing, true);
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: RESOURCE,
    aggregateId: created.id,
    eventType: "planning_panel_deselect.deselected",
    actor: ctx.actor,
    payload: { groupId: group.id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_panel_deselect.deselect",
    resource: RESOURCE,
    allowed: true,
    details: { deselectId: created.id, groupId: group.id },
  });

  return toDeselectDto(created, true);
}

export async function reselect(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: ReselectInput,
): Promise<{ id: string }> {
  requireWrite(ctx, RESOURCE);
  const validated = parseContractDeselect(input);
  const group = await requirePanelGroupInScope(tx, ctx, validated.groupId);
  const deleted = await tx.execute<{ id: string }>(sql`
    delete from planning_panel_deselect
     where workspace_id = ${ctx.workspaceId}::uuid
       and group_id = ${group.id}::uuid
       and "row" = ${validated.row}
       and "col" = ${validated.col}
     returning id
  `);
  const removed = deleted.rows[0];
  if (!removed) throw new PlanningPanelDeselectNotFoundError(validated.groupId);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: RESOURCE,
    aggregateId: removed.id,
    eventType: "planning_panel_deselect.reselected",
    actor: ctx.actor,
    payload: { groupId: group.id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_panel_deselect.reselect",
    resource: RESOURCE,
    allowed: true,
    details: { deselectId: removed.id, groupId: group.id },
  });

  return { id: removed.id };
}

export async function removeDeselect(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<{ id: string }> {
  requireWrite(ctx, RESOURCE);
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    throw new PlanningPanelDeselectValidationError(
      "planning panel deselect id is invalid",
    );
  }
  const deleted = await tx.execute<{ id: string; group_id: string }>(sql`
    delete from planning_panel_deselect
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data}::uuid
     returning id, group_id
  `);
  const removed = deleted.rows[0];
  if (!removed) throw new PlanningPanelDeselectNotFoundError(parsed.data);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: RESOURCE,
    aggregateId: removed.id,
    eventType: "planning_panel_deselect.removed",
    actor: ctx.actor,
    payload: { groupId: removed.group_id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_panel_deselect.remove",
    resource: RESOURCE,
    allowed: true,
    details: { deselectId: removed.id, groupId: removed.group_id },
  });

  return { id: removed.id };
}

export async function listDeselects(
  tx: TenantTx,
  ctx: ServiceCtx,
  groupId: string,
): Promise<PlanningPanelDeselectDto[]> {
  requireRead(ctx, RESOURCE);
  const parsed = uuidSchema.safeParse(groupId);
  if (!parsed.success) {
    throw new PlanningPanelDeselectValidationError("panel group id is invalid");
  }
  const group = await requirePanelGroupInScope(tx, ctx, parsed.data);
  const canWrite = can(ctx, "project.write");
  const rows = await tx.execute<DeselectRow>(sql`
    select id, group_id, "row", "col", reason, created_at
      from planning_panel_deselect
     where workspace_id = ${ctx.workspaceId}::uuid
       and group_id = ${group.id}::uuid
     order by "row", "col"
  `);
  return rows.rows.map((row) => toDeselectDto(row, canWrite));
}

export async function effectiveCount(
  tx: TenantTx,
  ctx: ServiceCtx,
  groupId: string,
): Promise<PlanningPanelDeselectEffectiveCount> {
  requireRead(ctx, RESOURCE);
  const parsed = uuidSchema.safeParse(groupId);
  if (!parsed.success) {
    throw new PlanningPanelDeselectValidationError("panel group id is invalid");
  }
  const group = await requirePanelGroupInScope(tx, ctx, parsed.data);
  const counted = await tx.execute<{ n: string }>(sql`
    select count(*)::text as n
      from planning_panel_deselect
     where workspace_id = ${ctx.workspaceId}::uuid
       and group_id = ${group.id}::uuid
  `);
  const deselected = Number(counted.rows[0]?.n ?? 0);
  return {
    rows: group.rows,
    cols: group.cols,
    deselected,
    effective: deselectedEffectiveCount({
      rows: group.rows,
      cols: group.cols,
      deselected,
    }),
  };
}
