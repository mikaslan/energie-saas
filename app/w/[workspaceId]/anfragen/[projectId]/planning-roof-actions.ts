// F3-03 Dach-Minimal: eigene Server-Actions (Dach anlegen/aktualisieren).
// Muster: planning-source-actions.ts (Gates, Scope-Checks, Revalidate) —
// Rechte project.read/write, KEINE neuen Permission-Keys (F3-BATCH-1-vertrag).
// Validierung über den Batch-Contract, DB-CHECKs als zweite Linie.
"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { can, PermissionDeniedError } from "@/lib/permissions";
import {
  PLANNING_ROOF_CONTRACT_VERSION,
  planningRoofCreateV1Schema,
  planningRoofPolygonV1Schema,
} from "@/lib/integrations/planning/contracts";
import { toPlanningRoofDto, type PlanningRoofDto, type PlanningRoofRow } from "./planning-roof-model";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

const SAVED_MESSAGE = "Dach gespeichert.";
const POLYGON_MESSAGE = "Das Polygon ist ungültig (3–64 Punkte, kein Selbstschnitt).";
const SELF_INTERSECTION_MESSAGE =
  "Das Dachpolygon enthält einen Selbstschnitt – bitte Punkte neu setzen.";
const TILT_MESSAGE = "Neigung muss zwischen 0–90° liegen.";
const SOURCE_MESSAGE = "Bitte zuerst eine Dachquelle für das Projekt anlegen.";

export type PlanningRoofActionState =
  | { status: "idle" }
  | { status: "success"; message: string; roof: PlanningRoofDto | null }
  | { status: "invalid"; message: string }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

class PlanningRoofNotFoundError extends Error {
  constructor() {
    super("planning roof scope not found");
    this.name = "PlanningRoofNotFoundError";
  }
}

function parseIds(formData: FormData): { workspaceId: string; projectId: string } | null {
  const workspaceId = workspaceIdSchema.safeParse(formData.get("workspaceId"));
  const projectId = uuidSchema.safeParse(formData.get("projectId"));
  if (!workspaceId.success || !projectId.success) return null;
  return { workspaceId: workspaceId.data, projectId: projectId.data };
}

function detailPath(workspaceId: string, projectId: string): string {
  return `/w/${workspaceId}/anfragen/${projectId}`;
}

function parseDegrees(raw: unknown): number {
  if (typeof raw !== "string") return Number.NaN;
  return Number.parseFloat(raw.replace(",", "."));
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

function mapError(error: unknown): PlanningRoofActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof PlanningRoofNotFoundError) return { status: "not_found" };
  const code = postgresErrorCode(error);
  if (code === "23514") return { status: "invalid", message: TILT_MESSAGE };
  if (code === "23503") return { status: "not_found" };
  throw error;
}

// Dach speichern: Contract-Gates (Polygon 3..64, kein Selbstschnitt, tilt
// 0–90, flat XOR per-edge) → Scope (Quelle gehört zum Projekt) → Insert
// oder Vollersatz-Update (Update nur im selben Projekt, sonst NotFound).
export async function savePlanningRoofAction(
  _previous: PlanningRoofActionState,
  formData: FormData,
): Promise<PlanningRoofActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: POLYGON_MESSAGE };
  const sourceId = uuidSchema.safeParse(formData.get("sourceId"));
  if (!sourceId.success) return { status: "invalid", message: SOURCE_MESSAGE };
  const roofIdRaw = formData.get("roofId");
  const roofId =
    typeof roofIdRaw === "string" && roofIdRaw !== "" ? uuidSchema.safeParse(roofIdRaw) : null;
  if (roofId && !roofId.success) return { status: "invalid", message: POLYGON_MESSAGE };
  const tiltMode = z.enum(["flat", "per_edge"]).safeParse(formData.get("tiltMode"));
  if (!tiltMode.success) return { status: "invalid", message: TILT_MESSAGE };
  let polygon: unknown;
  let tiltsRaw: unknown;
  try {
    polygon = JSON.parse(String(formData.get("polygon"))) as unknown;
    tiltsRaw = JSON.parse(String(formData.get("tilts"))) as unknown;
  } catch {
    return { status: "invalid", message: POLYGON_MESSAGE };
  }
  const polygonCheck = planningRoofPolygonV1Schema.safeParse(polygon);
  if (!polygonCheck.success) {
    const count = Array.isArray(polygon) ? polygon.length : 0;
    return { status: "invalid", message: count >= 3 ? SELF_INTERSECTION_MESSAGE : POLYGON_MESSAGE };
  }
  const createCheck = planningRoofCreateV1Schema.safeParse(
    tiltMode.data === "flat"
      ? {
        schemaVersion: PLANNING_ROOF_CONTRACT_VERSION,
        polygon: polygonCheck.data,
        flatSingleTilt: parseDegrees(formData.get("flatTilt")),
      }
      : {
        schemaVersion: PLANNING_ROOF_CONTRACT_VERSION,
        polygon: polygonCheck.data,
        tiltPerEdge: (Array.isArray(tiltsRaw) ? tiltsRaw : []).map(parseDegrees),
      },
  );
  if (!createCheck.success) return { status: "invalid", message: TILT_MESSAGE };
  const validated = createCheck.data;

  try {
    const row = await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_roof_min",
      async (tx, ctx) => {
        if (!can(ctx, "project.write")) {
          throw new PermissionDeniedError(
            "project.write",
            "planning_roof_min",
            ids.projectId,
            ctx.actor,
          );
        }
        const scope = await tx.execute<{ id: string }>(sql`
          select id from planning_source
           where workspace_id = ${ctx.workspaceId}::uuid
             and id = ${sourceId.data}::uuid
             and project_id = ${ids.projectId}::uuid
           limit 1
        `);
        if (!scope.rows[0]) throw new PlanningRoofNotFoundError();
        const polygonJson = JSON.stringify(validated.polygon);
        const tiltPerEdgeJson = validated.tiltPerEdge
          ? JSON.stringify(validated.tiltPerEdge)
          : null;
        const flatSingleTilt = validated.flatSingleTilt ?? null;
        if (roofId?.success) {
          const updated = await tx.execute<PlanningRoofRow>(sql`
            update planning_roof_min as roof
               set source_id = ${sourceId.data}::uuid,
                   polygon_json = ${polygonJson}::jsonb,
                   tilt_per_edge_json = ${tiltPerEdgeJson}::jsonb,
                   flat_single_tilt = ${flatSingleTilt},
                   edge_margins_json = null,
                   updated_at = statement_timestamp()
              from planning_source as source
             where roof.workspace_id = ${ctx.workspaceId}::uuid
               and roof.id = ${roofId.data}::uuid
               and source.workspace_id = roof.workspace_id
               and source.id = roof.source_id
               and source.project_id = ${ids.projectId}::uuid
            returning roof.id, roof.source_id, roof.polygon_json,
                      roof.tilt_per_edge_json, roof.flat_single_tilt, roof.created_at
          `);
          const next = updated.rows[0];
          if (!next) throw new PlanningRoofNotFoundError();
          return next;
        }
        const inserted = await tx.execute<PlanningRoofRow>(sql`
          insert into planning_roof_min (
            workspace_id, source_id, polygon_json, tilt_per_edge_json,
            flat_single_tilt, edge_margins_json, created_by
          ) values (
            ${ctx.workspaceId}::uuid,
            ${sourceId.data}::uuid,
            ${polygonJson}::jsonb,
            ${tiltPerEdgeJson}::jsonb,
            ${flatSingleTilt},
            null,
            ${ctx.actor}::uuid
          )
          returning id, source_id, polygon_json, tilt_per_edge_json,
                    flat_single_tilt, created_at
        `);
        const created = inserted.rows[0];
        if (!created) throw new PlanningRoofNotFoundError();
        return created;
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: SAVED_MESSAGE, roof: toPlanningRoofDto(row) };
  } catch (error) {
    return mapError(error);
  }
}
