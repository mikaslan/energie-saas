// F3-05b String-Equipment Stufe-0 (Katalog F3.5): Optimierer pro
// String/Panel + Mikro-WR je Panel (Panel-Ref {group_id, row, col} nur
// range-validiert, kein Vorgriff auf F3-04b). Kein Auto-Fill, kein
// Optimierer-String-Algorithmus, keine Ertragsrechnung, kein Katalog-Join.
// Optimierer scope=string genau 1 je String; Mikro-Doppelbelegung
// desselben Panels in beliebigem Equipment desselben Strings ist hart.
// Rechte analog F3-05a ueber project.read/write (keine neuen
// Permission-Keys). DELETE-Grants analog planning_string (Equipment sind
// frei revidierbare Skizzen-Objekte). Events/Audit enthalten nur IDs.
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { planningStringEquipment } from "@/lib/db/schema/planning-string-equipment";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  PLANNING_STRING_EQUIPMENT_VERSION,
  planningStringEquipmentAttachV1Schema,
} from "@/lib/integrations/planning/contracts/string-equipment";
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";

export class PlanningStringEquipmentNotFoundError extends Error {
  constructor(public readonly id?: string) {
    super(
      id
        ? `planning string equipment resource not found: ${id}`
        : "planning string equipment resource not found",
    );
    this.name = "PlanningStringEquipmentNotFoundError";
  }
}

export class PlanningStringEquipmentValidationError extends Error {
  constructor(message = "planning string equipment input is invalid") {
    super(message);
    this.name = "PlanningStringEquipmentValidationError";
  }
}

export { PlanningStringEquipmentNotFoundError as NotFoundError };
export { PlanningStringEquipmentValidationError as ValidationError };

// Anker auf die zentral verwaltete Drizzle-Tabelle (legt der Koordinator
// an, Muster analog F3-05a). Queries laufen als Raw-SQL mit expliziten
// RLS-Praedikaten; der Import verankert den Schema-Pfad als Single-Source.
export type PlanningStringEquipmentTable = typeof planningStringEquipment;
export type PlanningStringEquipmentTableRow =
  typeof planningStringEquipment.$inferSelect;

const EQUIPMENT_RESOURCE = "planning_string_equipment";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const attachV1Schema = planningStringEquipmentAttachV1Schema;

const panelRefJsonSchema = z.strictObject({
  group_id: z.uuid(),
  row: z.number().int(),
  col: z.number().int(),
});

const panelRefJsonLenientSchema = z.object({
  group_id: z.string(),
  row: z.number(),
  col: z.number(),
});

export type PlanningStringEquipmentScope = "string" | "panel";
export type PlanningStringEquipmentType = "optimizer" | "micro_inverter";

export type PlanningStringEquipmentPanelRefDto = {
  groupId: string;
  row: number;
  col: number;
};

export type PlanningStringEquipmentAdvisory = {
  code: "equipment-on-deselected";
  message: string;
};

export type PlanningStringEquipmentDto = {
  id: string;
  stringId: string;
  scope: PlanningStringEquipmentScope;
  panelRef: PlanningStringEquipmentPanelRefDto | null;
  equipment: PlanningStringEquipmentType;
  advisories: PlanningStringEquipmentAdvisory[];
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

export type AttachEquipmentInput = {
  stringId: string;
  scope: unknown;
  panelRef?: unknown;
  equipment: unknown;
};

type EquipmentRow = {
  id: string;
  string_id: string;
  scope: string;
  panel_ref_json: unknown;
  equipment: string;
  created_at: string | Date;
  updated_at: string | Date;
};

type StringScopeRow = {
  id: string;
  inverter_id: string;
};

type InverterScopeRow = {
  id: string;
  project_id: string;
};

type PanelGroupScopeRow = {
  id: string;
  rows: number;
  cols: number;
  project_id: string;
};

function requireRead(ctx: ServiceCtx, resource: string): void {
  // F3-05b: External fail-closed (Belegungsdaten sind sensitiv).
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

function parseContractAttach(input: AttachEquipmentInput): {
  stringId: string;
  scope: PlanningStringEquipmentScope;
  panelRef: PlanningStringEquipmentPanelRefDto | null;
  equipment: PlanningStringEquipmentType;
} {
  const candidate: Record<string, unknown> = {
    schemaVersion: PLANNING_STRING_EQUIPMENT_VERSION,
    stringId: input.stringId,
    scope: input.scope,
    equipment: input.equipment,
  };
  if (input.panelRef !== undefined && input.panelRef !== null) {
    candidate.panelRef = input.panelRef;
  }
  const parsed = attachV1Schema.safeParse(candidate);
  if (!parsed.success) throw new PlanningStringEquipmentValidationError();
  const stringId = uuidSchema.safeParse(parsed.data.stringId);
  if (!stringId.success) {
    throw new PlanningStringEquipmentValidationError("string id is invalid");
  }
  let panelRef: PlanningStringEquipmentPanelRefDto | null = null;
  if (parsed.data.panelRef) {
    const groupId = uuidSchema.safeParse(parsed.data.panelRef.groupId);
    if (!groupId.success) {
      throw new PlanningStringEquipmentValidationError("panel group id is invalid");
    }
    panelRef = {
      groupId: groupId.data,
      row: parsed.data.panelRef.row,
      col: parsed.data.panelRef.col,
    };
  }
  return {
    stringId: stringId.data,
    scope: parsed.data.scope,
    panelRef,
    equipment: parsed.data.equipment,
  };
}

function deselectedAdvisories(
  deselected: boolean,
): PlanningStringEquipmentAdvisory[] {
  // F3-05d: Warnung statt Reject (EQUIP_DESELECT_ADVISORY).
  if (!deselected) return [];
  return [
    {
      code: "equipment-on-deselected",
      message: "Equipment liegt auf abgewahlter Zelle.",
    },
  ];
}

async function selectDeselectedCells(
  tx: TenantTx,
  ctx: ServiceCtx,
  cells: PlanningStringEquipmentPanelRefDto[],
): Promise<Set<string>> {
  // Deselect-Schnitt fuer Panel-Refs (workspace+group+row+col).
  const keys = new Set<string>();
  const groupIds = [...new Set(cells.map((cell) => cell.groupId))];
  if (groupIds.length === 0) return keys;
  const idList = sql.join(
    groupIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const found = await tx.execute<{
    group_id: string;
    row: number;
    col: number;
  }>(sql`
    select group_id, "row", "col"
      from planning_panel_deselect
     where workspace_id = ${ctx.workspaceId}::uuid
       and group_id in (${idList})
  `);
  for (const cell of found.rows) {
    keys.add(
      `${cell.group_id.toLowerCase()}:${cell.row}:${cell.col}`,
    );
  }
  return keys;
}

function toEquipmentDto(
  row: EquipmentRow,
  canWrite: boolean,
  deselected = false,
): PlanningStringEquipmentDto {
  const base = z
    .strictObject({
      stringId: z.uuid(),
      scope: z.enum(["string", "panel"]),
      equipment: z.enum(["optimizer", "micro_inverter"]),
    })
    .safeParse({
      stringId: row.string_id,
      scope: row.scope,
      equipment: row.equipment,
    });
  if (!base.success) {
    throw new PlanningStringEquipmentValidationError(
      "planning string equipment data is invalid",
    );
  }
  let panelRef: PlanningStringEquipmentPanelRefDto | null = null;
  if (base.data.scope === "panel") {
    const ref = panelRefJsonSchema.safeParse(row.panel_ref_json);
    if (!ref.success) {
      throw new PlanningStringEquipmentValidationError(
        "planning string equipment data is invalid",
      );
    }
    panelRef = {
      groupId: ref.data.group_id.toLowerCase(),
      row: ref.data.row,
      col: ref.data.col,
    };
  }
  return {
    id: row.id,
    stringId: base.data.stringId,
    scope: base.data.scope,
    panelRef,
    equipment: base.data.equipment,
    advisories: deselectedAdvisories(panelRef !== null && deselected),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    permissions: { canWrite },
  };
}

async function requireStringInScope(
  tx: TenantTx,
  ctx: ServiceCtx,
  stringId: string,
): Promise<StringScopeRow> {
  const scope = await tx.execute<StringScopeRow>(sql`
    select id, inverter_id
      from planning_string
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${stringId}::uuid
     limit 1
  `);
  const found = scope.rows[0];
  if (!found) throw new PlanningStringEquipmentNotFoundError(stringId);
  return found;
}

async function requireInverterInScope(
  tx: TenantTx,
  ctx: ServiceCtx,
  inverterId: string,
): Promise<InverterScopeRow> {
  const scope = await tx.execute<InverterScopeRow>(sql`
    select id, project_id
      from planning_inverter
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${inverterId}::uuid
     limit 1
  `);
  const inverter = scope.rows[0];
  if (!inverter) throw new PlanningStringEquipmentNotFoundError(inverterId);
  return inverter;
}

async function requirePanelGroupInScope(
  tx: TenantTx,
  ctx: ServiceCtx,
  groupId: string,
): Promise<PanelGroupScopeRow> {
  // Gruppe mit Dach-Projekt (Gruppe -> Dach -> Quelle -> Projekt) fuer
  // Zugehoerigkeitspruefung und Raster-Range.
  const scope = await tx.execute<PanelGroupScopeRow>(sql`
    select g.id, g.rows, g.cols, s.project_id
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
  if (!group) throw new PlanningStringEquipmentNotFoundError(groupId);
  return group;
}

export async function attachEquipment(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: AttachEquipmentInput,
): Promise<PlanningStringEquipmentDto> {
  requireWrite(ctx, EQUIPMENT_RESOURCE);
  const validated = parseContractAttach(input);
  const planned = await requireStringInScope(tx, ctx, validated.stringId);
  const inverter = await requireInverterInScope(tx, ctx, planned.inverter_id);

  // scope=panel: Gruppe muss existieren und zu einem Dach desselben
  // Projekts gehoeren, sonst NotFound; row/col im Gruppen-Raster,
  // sonst ValidationError.
  if (validated.scope === "panel" && validated.panelRef) {
    const group = await requirePanelGroupInScope(tx, ctx, validated.panelRef.groupId);
    if (group.project_id.toLowerCase() !== inverter.project_id.toLowerCase()) {
      throw new PlanningStringEquipmentNotFoundError(validated.panelRef.groupId);
    }
    if (validated.panelRef.row > group.rows || validated.panelRef.col > group.cols) {
      throw new PlanningStringEquipmentValidationError(
        "panel ref exceeds panel group raster",
      );
    }
  }

  // Optimierer scope=string genau 1 je String; Doppelbelegung desselben
  // Panels (group,row,col) in beliebigem Equipment desselben Strings
  // ist hart (App-Level, panel_ref_json ist schemaloses jsonb).
  const existing = await tx.execute<{
    id: string;
    scope: string;
    panel_ref_json: unknown;
    equipment: string;
  }>(sql`
    select id, scope, panel_ref_json, equipment
      from planning_string_equipment
     where workspace_id = ${ctx.workspaceId}::uuid
       and string_id = ${planned.id}::uuid
  `);
  if (validated.equipment === "optimizer" && validated.scope === "string") {
    const hasStringOptimizer = existing.rows.some(
      (row) => row.scope === "string" && row.equipment === "optimizer",
    );
    if (hasStringOptimizer) {
      throw new PlanningStringEquipmentValidationError(
        "string already has a string-scope optimizer",
      );
    }
  }
  if (validated.scope === "panel" && validated.panelRef) {
    const cell = `${validated.panelRef.groupId}:${validated.panelRef.row}:${validated.panelRef.col}`;
    for (const row of existing.rows) {
      if (row.scope !== "panel") continue;
      const ref = panelRefJsonLenientSchema.safeParse(row.panel_ref_json);
      if (!ref.success) continue;
      const used =
        `${ref.data.group_id.toLowerCase()}:${ref.data.row}:${ref.data.col}`;
      if (used === cell) {
        throw new PlanningStringEquipmentValidationError(
          "panel is already equipped on this string",
        );
      }
    }
  }

  const panelRefJson =
    validated.scope === "panel" && validated.panelRef
      ? JSON.stringify({
          group_id: validated.panelRef.groupId,
          row: validated.panelRef.row,
          col: validated.panelRef.col,
        })
      : null;
  let inserted;
  try {
    inserted = await tx.execute<EquipmentRow>(sql`
      insert into planning_string_equipment (
        workspace_id, string_id, scope, panel_ref_json, equipment, created_by
      ) values (
        ${ctx.workspaceId}::uuid, ${planned.id}::uuid,
        ${validated.scope}, ${panelRefJson}::jsonb,
        ${validated.equipment},
        ${ctx.actor}::uuid
      )
      returning id, string_id, scope, panel_ref_json, equipment,
                created_at, updated_at
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23503") {
      throw new PlanningStringEquipmentNotFoundError(validated.stringId);
    }
    if (code === "23514") throw new PlanningStringEquipmentValidationError();
    throw error;
  }
  const row = inserted.rows[0];
  if (!row) {
    throw new PlanningStringEquipmentValidationError(
      "planning string equipment insert failed",
    );
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: EQUIPMENT_RESOURCE,
    aggregateId: row.id,
    eventType: "planning_string_equipment.attached",
    actor: ctx.actor,
    payload: { stringId: planned.id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_string_equipment.attach",
    resource: EQUIPMENT_RESOURCE,
    allowed: true,
    details: { equipmentId: row.id, stringId: planned.id },
  });

  // F3-05d: Deselect-Schnitt als Advisory (Warnung, nie Reject).
  let deselected = false;
  if (validated.scope === "panel" && validated.panelRef) {
    const off = await selectDeselectedCells(tx, ctx, [validated.panelRef]);
    deselected = off.has(
      `${validated.panelRef.groupId}:${validated.panelRef.row}:${validated.panelRef.col}`,
    );
  }
  return toEquipmentDto(row, true, deselected);
}

export async function detachEquipment(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<{ id: string }> {
  requireWrite(ctx, EQUIPMENT_RESOURCE);
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    throw new PlanningStringEquipmentValidationError(
      "planning string equipment id is invalid",
    );
  }
  const deleted = await tx.execute<{ id: string; string_id: string }>(sql`
    delete from planning_string_equipment
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data}::uuid
     returning id, string_id
  `);
  const row = deleted.rows[0];
  if (!row) throw new PlanningStringEquipmentNotFoundError(parsed.data);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: EQUIPMENT_RESOURCE,
    aggregateId: row.id,
    eventType: "planning_string_equipment.detached",
    actor: ctx.actor,
    payload: { stringId: row.string_id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_string_equipment.detach",
    resource: EQUIPMENT_RESOURCE,
    allowed: true,
    details: { equipmentId: row.id, stringId: row.string_id },
  });

  return { id: row.id };
}

export async function listEquipment(
  tx: TenantTx,
  ctx: ServiceCtx,
  stringId: string,
): Promise<PlanningStringEquipmentDto[]> {
  requireRead(ctx, EQUIPMENT_RESOURCE);
  const parsed = uuidSchema.safeParse(stringId);
  if (!parsed.success) {
    throw new PlanningStringEquipmentValidationError("string id is invalid");
  }
  const planned = await requireStringInScope(tx, ctx, parsed.data);
  const canWrite = can(ctx, "project.write");
  const rows = await tx.execute<EquipmentRow>(sql`
    select id, string_id, scope, panel_ref_json, equipment,
           created_at, updated_at
      from planning_string_equipment
     where workspace_id = ${ctx.workspaceId}::uuid
       and string_id = ${planned.id}::uuid
     order by created_at, id
  `);
  // F3-05d: Deselect-Schnitt je Panel-Ref als Advisory.
  const refs: PlanningStringEquipmentPanelRefDto[] = [];
  for (const row of rows.rows) {
    if (row.scope !== "panel") continue;
    const ref = panelRefJsonLenientSchema.safeParse(row.panel_ref_json);
    if (!ref.success) continue;
    refs.push({
      groupId: ref.data.group_id.toLowerCase(),
      row: ref.data.row,
      col: ref.data.col,
    });
  }
  const off = await selectDeselectedCells(tx, ctx, refs);
  return rows.rows.map((row) => {
    let deselected = false;
    if (row.scope === "panel") {
      const ref = panelRefJsonLenientSchema.safeParse(row.panel_ref_json);
      if (ref.success) {
        deselected = off.has(
          `${ref.data.group_id.toLowerCase()}:${ref.data.row}:${ref.data.col}`,
        );
      }
    }
    return toEquipmentDto(row, canWrite, deselected);
  });
}
