// F3-04a manuelle Panel-Gruppe Stufe-0 (Katalog F3.4): Rechteck-Raster
// je Dach (Art H/V, Ursprung, Zeilen/Spalten, Modulmass explizit,
// uniforme Luecke, Gruppen-Neigung). Kein Auto-Fill, keine KI, kein
// Katalog-Join (Folge). Gruppen-Rechteck-Ableitung via Contract
// groupRect; Rechteck-in-Polygon auf App-Ebene (rectInsidePolygon aus
// dem F3-03b-Contract). Rechte analog F3-03b ueber project.read/write
// (keine neuen Permission-Keys). DELETE-Grant analog
// planning_roof_restriction (Gruppen sind frei revidierbare
// Skizzen-Objekte). Events/Audit enthalten nur IDs.
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import {
  groupRect,
  PLANNING_PANEL_GROUP_VERSION,
  planningPanelGroupCreateV1Schema,
  type PlanningPanelGroupKind,
  type PlanningPanelGroupOriginV1,
} from "@/lib/integrations/planning/contracts/panel-group";
import { rectInsidePolygon } from "@/lib/integrations/planning/contracts/roof-restriction";
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import type { planningPanelGroup } from "@/lib/db/schema/planning-panel-group";

export class PlanningPanelGroupNotFoundError extends Error {
  constructor(public readonly id?: string) {
    super(
      id
        ? `planning panel group not found: ${id}`
        : "planning panel group not found",
    );
    this.name = "PlanningPanelGroupNotFoundError";
  }
}

export class PlanningPanelGroupValidationError extends Error {
  constructor(message = "planning panel group input is invalid") {
    super(message);
    this.name = "PlanningPanelGroupValidationError";
  }
}

export { PlanningPanelGroupNotFoundError as NotFoundError };
export { PlanningPanelGroupNotFoundError as PanelGroupNotFoundError };
export { PlanningPanelGroupValidationError as ValidationError };
export { PlanningPanelGroupValidationError as PanelGroupValidationError };

// Anker auf die zentral verwaltete Drizzle-Tabelle (legt der
// Koordinator an, Musterpfad analog F3-03b). Queries laufen analog
// F3-03b als Raw-SQL mit expliziten RLS-Praedikaten; der Import
// verankert den Schema-Pfad als Single-Source.
export type PlanningPanelGroupTable = typeof planningPanelGroup;
export type PlanningPanelGroupTableRow = typeof planningPanelGroup.$inferSelect;

const RESOURCE = "planning_panel_group";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

export type PanelGroupOriginDto = PlanningPanelGroupOriginV1;

export type PlanningPanelGroupDto = {
  id: string;
  roofId: string;
  kind: PlanningPanelGroupKind;
  label: string;
  origin: PanelGroupOriginDto;
  rows: number;
  cols: number;
  moduleWM: number;
  moduleHM: number;
  gapM: number;
  tiltDeg: number | null;
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

export type CreatePanelGroupInput = {
  roofId: string;
  kind: unknown;
  label: unknown;
  origin: unknown;
  rows: unknown;
  cols: unknown;
  moduleWM: unknown;
  moduleHM: unknown;
  gapM: unknown;
  tiltDeg?: unknown;
};

type PanelGroupRow = {
  id: string;
  roof_id: string;
  kind: string;
  label: string;
  origin_json: unknown;
  rows: number;
  cols: number;
  module_w_m: number;
  module_h_m: number;
  gap_m: number;
  tilt_deg: number | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type RoofScopeRow = {
  id: string;
  polygon_json: unknown;
};

const roofPointDtoSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});

function requireRead(ctx: ServiceCtx): void {
  // F3-04a: External fail-closed (Dach-/Belegungsdaten sind sensitiv).
  if (isExternalOnly(ctx) || !can(ctx, "project.read")) {
    throw new PermissionDeniedError("project.read", RESOURCE, undefined, ctx.actor);
  }
}

function requireWrite(ctx: ServiceCtx): void {
  if (isExternalOnly(ctx) || !can(ctx, "project.write")) {
    throw new PermissionDeniedError("project.write", RESOURCE, undefined, ctx.actor);
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

function parseContractCreate(input: CreatePanelGroupInput): {
  kind: PlanningPanelGroupKind;
  label: string;
  origin: PlanningPanelGroupOriginV1;
  rows: number;
  cols: number;
  moduleWM: number;
  moduleHM: number;
  gapM: number;
  tiltDeg: number | null;
} {
  const candidate: Record<string, unknown> = {
    schemaVersion: PLANNING_PANEL_GROUP_VERSION,
    kind: input.kind,
    label: input.label,
    origin: input.origin,
    rows: input.rows,
    cols: input.cols,
    moduleWM: input.moduleWM,
    moduleHM: input.moduleHM,
    gapM: input.gapM,
  };
  if (input.tiltDeg !== undefined && input.tiltDeg !== null) {
    candidate.tiltDeg = input.tiltDeg;
  }
  const parsed = planningPanelGroupCreateV1Schema.safeParse(candidate);
  if (!parsed.success) throw new PlanningPanelGroupValidationError();
  return {
    kind: parsed.data.kind,
    label: parsed.data.label,
    origin: parsed.data.origin,
    rows: parsed.data.rows,
    cols: parsed.data.cols,
    moduleWM: parsed.data.moduleWM,
    moduleHM: parsed.data.moduleHM,
    gapM: parsed.data.gapM,
    tiltDeg: parsed.data.tiltDeg ?? null,
  };
}

function toDto(row: PanelGroupRow, canWrite: boolean): PlanningPanelGroupDto {
  const kind = z.enum(["h", "v"]).safeParse(row.kind);
  const origin = z
    .strictObject({
      x: z.number().finite(),
      y: z.number().finite(),
    })
    .safeParse(row.origin_json);
  const measures = z
    .strictObject({
      rows: z.number().int(),
      cols: z.number().int(),
      moduleWM: z.number().finite(),
      moduleHM: z.number().finite(),
      gapM: z.number().finite(),
      tiltDeg: z.number().finite().min(0).max(90).nullable(),
    })
    .safeParse({
      rows: row.rows,
      cols: row.cols,
      moduleWM: row.module_w_m,
      moduleHM: row.module_h_m,
      gapM: row.gap_m,
      tiltDeg: row.tilt_deg,
    });
  if (!kind.success || !origin.success || !measures.success || typeof row.label !== "string") {
    throw new PlanningPanelGroupValidationError(
      "planning panel group data is invalid",
    );
  }
  return {
    id: row.id,
    roofId: row.roof_id,
    kind: kind.data,
    label: row.label,
    origin: origin.data,
    rows: measures.data.rows,
    cols: measures.data.cols,
    moduleWM: measures.data.moduleWM,
    moduleHM: measures.data.moduleHM,
    gapM: measures.data.gapM,
    tiltDeg: measures.data.tiltDeg,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    permissions: { canWrite },
  };
}

async function requireRoofInScope(
  tx: TenantTx,
  ctx: ServiceCtx,
  roofId: string,
): Promise<RoofScopeRow> {
  // Dach muss workspace-eigen sein; RLS blendet Fremddaecher aus,
  // der Service mappt das auf NotFound.
  const scope = await tx.execute<RoofScopeRow>(sql`
    select id, polygon_json
      from planning_roof_min
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${roofId}::uuid
     limit 1
  `);
  const roof = scope.rows[0];
  if (!roof) throw new PlanningPanelGroupNotFoundError(roofId);
  return roof;
}

export async function createPanelGroup(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreatePanelGroupInput,
): Promise<PlanningPanelGroupDto> {
  requireWrite(ctx);
  const roofId = uuidSchema.safeParse(input.roofId);
  if (!roofId.success) {
    throw new PlanningPanelGroupValidationError("roof id is invalid");
  }
  const validated = parseContractCreate(input);
  const roof = await requireRoofInScope(tx, ctx, roofId.data);

  // App-Ebene (Spec F3-04a): Gruppen-Rechteck muss im Dach-Polygon
  // liegen (Ecken-Test, Kante = drin). DB-CHECKs sichern nur
  // kind/Ranges.
  const polygon = z
    .array(roofPointDtoSchema)
    .min(3)
    .max(64)
    .safeParse(roof.polygon_json);
  if (!polygon.success) {
    throw new PlanningPanelGroupValidationError(
      "roof polygon data is invalid",
    );
  }
  const rect = groupRect({
    origin: validated.origin,
    rows: validated.rows,
    cols: validated.cols,
    moduleWM: validated.moduleWM,
    moduleHM: validated.moduleHM,
    gapM: validated.gapM,
  });
  if (!rectInsidePolygon(rect, polygon.data)) {
    throw new PlanningPanelGroupValidationError(
      "panel group rect must lie within the roof polygon",
    );
  }

  let inserted;
  try {
    inserted = await tx.execute<PanelGroupRow>(sql`
      insert into planning_panel_group (
        workspace_id, roof_id, kind, label, origin_json,
        rows, cols, module_w_m, module_h_m, gap_m, tilt_deg, created_by
      ) values (
        ${ctx.workspaceId}::uuid, ${roofId.data}::uuid,
        ${validated.kind}, ${validated.label},
        ${JSON.stringify(validated.origin)}::jsonb,
        ${validated.rows}, ${validated.cols},
        ${validated.moduleWM}, ${validated.moduleHM}, ${validated.gapM},
        ${validated.tiltDeg},
        ${ctx.actor}::uuid
      )
      returning id, roof_id, kind, label, origin_json, rows, cols,
                module_w_m, module_h_m, gap_m, tilt_deg,
                created_at, updated_at
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23503") {
      throw new PlanningPanelGroupNotFoundError(roofId.data);
    }
    if (code === "23514") throw new PlanningPanelGroupValidationError();
    throw error;
  }
  const row = inserted.rows[0];
  if (!row) {
    throw new PlanningPanelGroupValidationError(
      "planning panel group insert failed",
    );
  }

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: RESOURCE,
    aggregateId: row.id,
    eventType: "planning_panel_group.created",
    actor: ctx.actor,
    payload: { roofId: roof.id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_panel_group.create",
    resource: RESOURCE,
    allowed: true,
    details: { panelGroupId: row.id, roofId: roof.id },
  });

  return toDto(row, true);
}

export async function removePanelGroup(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<{ id: string }> {
  requireWrite(ctx);
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    throw new PlanningPanelGroupValidationError("panel group id is invalid");
  }
  const deleted = await tx.execute<{ id: string; roof_id: string }>(sql`
    delete from planning_panel_group
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data}::uuid
     returning id, roof_id
  `);
  const row = deleted.rows[0];
  if (!row) throw new PlanningPanelGroupNotFoundError(parsed.data);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: RESOURCE,
    aggregateId: row.id,
    eventType: "planning_panel_group.removed",
    actor: ctx.actor,
    payload: { roofId: row.roof_id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_panel_group.remove",
    resource: RESOURCE,
    allowed: true,
    details: { panelGroupId: row.id, roofId: row.roof_id },
  });

  return { id: row.id };
}

export async function getPanelGroup(
  tx: TenantTx,
  ctx: ServiceCtx,
  id: string,
): Promise<PlanningPanelGroupDto> {
  requireRead(ctx);
  const parsed = uuidSchema.safeParse(id);
  if (!parsed.success) {
    throw new PlanningPanelGroupValidationError("panel group id is invalid");
  }
  const found = await tx.execute<PanelGroupRow>(sql`
    select id, roof_id, kind, label, origin_json, rows, cols,
           module_w_m, module_h_m, gap_m, tilt_deg, created_at, updated_at
      from planning_panel_group
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${parsed.data}::uuid
     limit 1
  `);
  const row = found.rows[0];
  if (!row) throw new PlanningPanelGroupNotFoundError(parsed.data);
  return toDto(row, can(ctx, "project.write"));
}

export async function listPanelGroups(
  tx: TenantTx,
  ctx: ServiceCtx,
  roofId: string,
): Promise<PlanningPanelGroupDto[]> {
  requireRead(ctx);
  const parsed = uuidSchema.safeParse(roofId);
  if (!parsed.success) {
    throw new PlanningPanelGroupValidationError("roof id is invalid");
  }
  await requireRoofInScope(tx, ctx, parsed.data);
  const canWrite = can(ctx, "project.write");
  const rows = await tx.execute<PanelGroupRow>(sql`
    select id, roof_id, kind, label, origin_json, rows, cols,
           module_w_m, module_h_m, gap_m, tilt_deg, created_at, updated_at
      from planning_panel_group
     where workspace_id = ${ctx.workspaceId}::uuid
       and roof_id = ${parsed.data}::uuid
     order by created_at, id
  `);
  return rows.rows.map((row) => toDto(row, canWrite));
}
