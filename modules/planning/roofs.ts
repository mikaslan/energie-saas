// F3-03 Dach-Minimal (Katalog F3.3, Batch-1 F3-BATCH-1-vertrag): genau
// 1 Polygon je Dach (3..64 Punkte), Neigung pro Kante ODER
// Flachdach-Einzelneigung (XOR), Randabstaende mit Uniform-Fallback.
// Geometrie-/Neigungsvalidierung (inkl. Selbstschnitt) laeuft ueber
// ./contracts; Rechte analog F3-02-Quellen ueber project.read/write
// (keine neuen Permission-Keys). Events/Audit enthalten nur IDs.
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { writeAudit } from "@/lib/audit";
import type { TenantTx } from "@/lib/db/types";
import { emitEvent } from "@/lib/events";
import { can, isExternalOnly, PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  PLANNING_ROOF_CONTRACT_VERSION,
  planningRoofCreateV1Schema,
} from "@/lib/integrations/planning/contracts";
import { NotFoundError, ValidationError } from "./roofs-errors";

export { NotFoundError, ValidationError } from "./roofs-errors";

const RESOURCE = "planning_roof";

const uuidSchema = z.uuid().transform((value) => value.toLowerCase());

const roofPointDtoSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
});

export type RoofPointDto = {
  x: number;
  y: number;
};

export type PlanningRoofDto = {
  id: string;
  sourceId: string;
  projectId: string;
  polygon: RoofPointDto[];
  tiltPerEdge: number[] | null;
  flatSingleTilt: number | null;
  edgeMargins: unknown;
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};

export type CreateRoofInput = {
  sourceId: string;
  polygon: unknown;
  tiltPerEdge?: unknown;
  flatSingleTilt?: unknown;
  edgeMargins?: unknown;
};

export type UpdateRoofInput = {
  id: string;
  polygon: unknown;
  tiltPerEdge?: unknown;
  flatSingleTilt?: unknown;
  edgeMargins?: unknown;
};

type RoofRow = {
  id: string;
  source_id: string;
  project_id: string;
  polygon_json: unknown;
  tilt_per_edge_json: unknown;
  flat_single_tilt: number | null;
  edge_margins_json: unknown;
  created_at: string | Date;
  updated_at: string | Date;
};

function requireRead(ctx: ServiceCtx): void {
  // F3-BATCH-1: External fail-closed (Dach-/Upload-Daten sind sensitiv).
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

function parseContractTilt(input: {
  polygon: unknown;
  tiltPerEdge?: unknown;
  flatSingleTilt?: unknown;
}): { polygon: RoofPointDto[]; tiltPerEdge: number[] | null; flatSingleTilt: number | null } {
  const candidate: Record<string, unknown> = {
    schemaVersion: PLANNING_ROOF_CONTRACT_VERSION,
    polygon: input.polygon,
  };
  // Explizites null zaehlt als "nicht gesetzt" (XOR bleibt eindeutig).
  if (input.tiltPerEdge !== undefined && input.tiltPerEdge !== null) {
    candidate.tiltPerEdge = input.tiltPerEdge;
  }
  if (input.flatSingleTilt !== undefined && input.flatSingleTilt !== null) {
    candidate.flatSingleTilt = input.flatSingleTilt;
  }
  const parsed = planningRoofCreateV1Schema.safeParse(candidate);
  if (!parsed.success) throw new ValidationError();
  const data = parsed.data as {
    polygon: RoofPointDto[];
    tiltPerEdge?: number[] | null;
    flatSingleTilt?: number | null;
  };
  return {
    polygon: data.polygon,
    tiltPerEdge: data.tiltPerEdge ?? null,
    flatSingleTilt: data.flatSingleTilt ?? null,
  };
}

// MARGIN_UNIFORM_FALLBACK (Batch-Vertrag): fehlende Kantenabstaende
// bedeuten Default (NULL); gesetzt entweder uniform (eine Zahl) oder
// je Kante (Array). Nur Plausibilitaet (>= 0, endlich) — kein CHECK.
function parseEdgeMargins(value: unknown): number | number[] | null {
  if (value === undefined || value === null) return null;
  const nonNegative = z.number().finite().min(0);
  if (typeof value === "number") {
    const single = nonNegative.safeParse(value);
    if (!single.success) throw new ValidationError("edge margins must be >= 0");
    return single.data;
  }
  if (Array.isArray(value)) {
    if (value.length < 1 || value.length > 64) {
      throw new ValidationError("edge margins must hold 1..64 values");
    }
    const parsed = z.array(nonNegative).safeParse(value);
    if (!parsed.success) throw new ValidationError("edge margins must be >= 0");
    return parsed.data;
  }
  throw new ValidationError("edge margins must be a number or an array of numbers");
}

function toDto(row: RoofRow, canWrite: boolean): PlanningRoofDto {
  const polygon = z.array(roofPointDtoSchema).min(3).max(64).safeParse(row.polygon_json);
  if (!polygon.success) throw new ValidationError("planning roof data is invalid");
  let tiltPerEdge: number[] | null = null;
  if (row.tilt_per_edge_json !== null && row.tilt_per_edge_json !== undefined) {
    const parsed = z.array(z.number()).safeParse(row.tilt_per_edge_json);
    if (!parsed.success) throw new ValidationError("planning roof data is invalid");
    tiltPerEdge = parsed.data;
  }
  const flat = row.flat_single_tilt;
  if (flat !== null && flat !== undefined && (typeof flat !== "number" || !Number.isFinite(flat))) {
    throw new ValidationError("planning roof data is invalid");
  }
  return {
    id: row.id,
    sourceId: row.source_id,
    projectId: row.project_id,
    polygon: polygon.data,
    tiltPerEdge,
    flatSingleTilt: flat ?? null,
    edgeMargins: row.edge_margins_json ?? null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    permissions: { canWrite },
  };
}

export async function createRoof(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: CreateRoofInput,
): Promise<PlanningRoofDto> {
  requireWrite(ctx);
  const sourceId = uuidSchema.safeParse(input.sourceId);
  if (!sourceId.success) throw new ValidationError("source id is invalid");
  const validated = parseContractTilt(input);
  const edgeMargins = parseEdgeMargins(input.edgeMargins);

  // Quelle muss projekteigen sein (dieser Workspace); RLS blendet
  // Fremdquellen aus, der Service mappt das auf NotFound.
  const scope = await tx.execute<{ id: string; project_id: string }>(sql`
    select id, project_id
      from planning_source
     where workspace_id = ${ctx.workspaceId}::uuid
       and id = ${sourceId.data}::uuid
     limit 1
  `);
  const source = scope.rows[0];
  if (!source) throw new NotFoundError(sourceId.data);

  let inserted;
  try {
    inserted = await tx.execute<RoofRow>(sql`
      insert into planning_roof_min (
        workspace_id, source_id, polygon_json,
        tilt_per_edge_json, flat_single_tilt, edge_margins_json, created_by
      ) values (
        ${ctx.workspaceId}::uuid, ${sourceId.data}::uuid,
        ${JSON.stringify(validated.polygon)}::jsonb,
        ${validated.tiltPerEdge === null ? null : JSON.stringify(validated.tiltPerEdge)}::jsonb,
        ${validated.flatSingleTilt},
        ${edgeMargins === null ? null : JSON.stringify(edgeMargins)}::jsonb,
        ${ctx.actor}::uuid
      )
      returning id, source_id, polygon_json, tilt_per_edge_json,
                flat_single_tilt, edge_margins_json, created_at, updated_at
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23503") throw new NotFoundError(sourceId.data);
    if (code === "23514") throw new ValidationError();
    throw error;
  }
  const row = inserted.rows[0];
  if (!row) throw new ValidationError("planning roof insert failed");

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: RESOURCE,
    aggregateId: row.id,
    eventType: "planning_roof.created",
    actor: ctx.actor,
    payload: { sourceId: source.id, projectId: source.project_id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_roof.create",
    resource: RESOURCE,
    allowed: true,
    details: { roofId: row.id, sourceId: source.id, projectId: source.project_id },
  });

  return toDto({ ...row, project_id: source.project_id }, true);
}

export async function updateRoof(
  tx: TenantTx,
  ctx: ServiceCtx,
  input: UpdateRoofInput,
): Promise<PlanningRoofDto> {
  requireWrite(ctx);
  const id = uuidSchema.safeParse(input.id);
  if (!id.success) throw new ValidationError("roof id is invalid");
  const validated = parseContractTilt(input);
  const edgeMargins = parseEdgeMargins(input.edgeMargins);

  let updated;
  try {
    updated = await tx.execute<RoofRow>(sql`
      update planning_roof_min as roof
         set polygon_json = ${JSON.stringify(validated.polygon)}::jsonb,
             tilt_per_edge_json = ${validated.tiltPerEdge === null ? null : JSON.stringify(validated.tiltPerEdge)}::jsonb,
             flat_single_tilt = ${validated.flatSingleTilt},
             edge_margins_json = ${edgeMargins === null ? null : JSON.stringify(edgeMargins)}::jsonb,
             updated_at = statement_timestamp()
        from planning_source as source
       where roof.workspace_id = ${ctx.workspaceId}::uuid
         and roof.id = ${id.data}::uuid
         and source.workspace_id = roof.workspace_id
         and source.id = roof.source_id
      returning roof.id as id, roof.source_id as source_id,
                source.project_id as project_id,
                roof.polygon_json as polygon_json,
                roof.tilt_per_edge_json as tilt_per_edge_json,
                roof.flat_single_tilt as flat_single_tilt,
                roof.edge_margins_json as edge_margins_json,
                roof.created_at as created_at, roof.updated_at as updated_at
    `);
  } catch (error) {
    const code = postgresErrorCode(error);
    if (code === "23503") throw new NotFoundError(id.data);
    if (code === "23514") throw new ValidationError();
    throw error;
  }
  const row = updated.rows[0];
  if (!row) throw new NotFoundError(id.data);

  await emitEvent(tx, {
    workspaceId: ctx.workspaceId,
    aggregateType: RESOURCE,
    aggregateId: row.id,
    eventType: "planning_roof.updated",
    actor: ctx.actor,
    payload: { sourceId: row.source_id, projectId: row.project_id },
  });
  await writeAudit(tx, {
    workspaceId: ctx.workspaceId,
    actor: ctx.actor,
    action: "planning_roof.update",
    resource: RESOURCE,
    allowed: true,
    details: { roofId: row.id, sourceId: row.source_id, projectId: row.project_id },
  });

  return toDto(row, true);
}

export async function getRoof(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { id: string },
): Promise<PlanningRoofDto> {
  requireRead(ctx);
  const id = uuidSchema.safeParse(query.id);
  if (!id.success) throw new ValidationError("roof id is invalid");
  const found = await tx.execute<RoofRow>(sql`
    select roof.id as id, roof.source_id as source_id,
           source.project_id as project_id,
           roof.polygon_json as polygon_json,
           roof.tilt_per_edge_json as tilt_per_edge_json,
           roof.flat_single_tilt as flat_single_tilt,
           roof.edge_margins_json as edge_margins_json,
           roof.created_at as created_at, roof.updated_at as updated_at
      from planning_roof_min as roof
      join planning_source as source
        on source.workspace_id = roof.workspace_id
       and source.id = roof.source_id
     where roof.workspace_id = ${ctx.workspaceId}::uuid
       and roof.id = ${id.data}::uuid
     limit 1
  `);
  const row = found.rows[0];
  if (!row) throw new NotFoundError(id.data);
  return toDto(row, can(ctx, "project.write"));
}

export async function listRoofs(
  tx: TenantTx,
  ctx: ServiceCtx,
  query: { projectId: string },
): Promise<PlanningRoofDto[]> {
  requireRead(ctx);
  const projectId = uuidSchema.safeParse(query.projectId);
  if (!projectId.success) throw new ValidationError("project id is invalid");
  const canWrite = can(ctx, "project.write");
  const rows = await tx.execute<RoofRow>(sql`
    select roof.id as id, roof.source_id as source_id,
           source.project_id as project_id,
           roof.polygon_json as polygon_json,
           roof.tilt_per_edge_json as tilt_per_edge_json,
           roof.flat_single_tilt as flat_single_tilt,
           roof.edge_margins_json as edge_margins_json,
           roof.created_at as created_at, roof.updated_at as updated_at
      from planning_roof_min as roof
      join planning_source as source
        on source.workspace_id = roof.workspace_id
       and source.id = roof.source_id
     where roof.workspace_id = ${ctx.workspaceId}::uuid
       and source.project_id = ${projectId.data}::uuid
     order by roof.created_at, roof.id
  `);
  return rows.rows.map((row) => toDto(row, canWrite));
}
