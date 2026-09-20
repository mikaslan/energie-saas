// F3-03b Dach-Sperrzonen: eigene Server-Actions (Rechteck anlegen/loeschen).
// Muster: planning-roof-actions.ts (Gates, Scope-Checks, Revalidate) —
// Rechte project.read/write, KEINE neuen Permission-Keys (F3-BATCH-1-vertrag).
// Validierung ueber den Batch-Contract, Rechteck-in-Polygon serverseitig
// (Dach-Polygon laden + rectInsidePolygon), DB-CHECKs als zweite Linie.
"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { can, PermissionDeniedError } from "@/lib/permissions";
import {
  PLANNING_ROOF_RESTRICTION_VERSION,
  planningRoofRestrictionCreateV1Schema,
  rectInsidePolygon,
} from "@/lib/integrations/planning/contracts";
import {
  toPlanningRoofRestrictionDto,
  type PlanningRoofRestrictionDto,
  type PlanningRoofRestrictionRow,
} from "./planning-roof-restriction-model";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

const SAVED_MESSAGE = "Sperrzone gespeichert.";
const REMOVED_MESSAGE = "Sperrzone gelöscht.";
const RECT_MESSAGE = "Das Rechteck ist ungültig (endliche Zahlen, Breite/Höhe > 0).";
const OUTSIDE_MESSAGE = "Das Rechteck liegt außerhalb des Dachpolygons.";
const HEIGHT_MESSAGE = "Die Höhe muss zwischen 0–50 m liegen (oder leer).";
const LABEL_MESSAGE = "Bitte eine Bezeichnung angeben.";
const KIND_MESSAGE = "Bitte eine gültige Art wählen.";
const ROOF_MESSAGE = "Bitte zuerst ein Dach für das Projekt anlegen.";

export type PlanningRoofRestrictionActionState =
  | { status: "idle" }
  | { status: "success"; message: string; restriction: PlanningRoofRestrictionDto | null }
  | { status: "invalid"; message: string }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

class PlanningRoofRestrictionNotFoundError extends Error {
  constructor() {
    super("planning roof restriction scope not found");
    this.name = "PlanningRoofRestrictionNotFoundError";
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

function parseDecimal(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return Number.NaN;
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

function mapError(error: unknown): PlanningRoofRestrictionActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof PlanningRoofRestrictionNotFoundError) return { status: "not_found" };
  const code = postgresErrorCode(error);
  if (code === "23514") return { status: "invalid", message: RECT_MESSAGE };
  if (code === "23503") return { status: "not_found" };
  throw error;
}

const roofPointSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() });

// Sperrzone anlegen: Contract-Gates (kind/Bezeichnung/Rechteck/Hoehe) →
// Scope (Dach gehoert zum Projekt) → Rechteck-in-Polygon → Insert.
export async function savePlanningRoofRestrictionAction(
  _previous: PlanningRoofRestrictionActionState,
  formData: FormData,
): Promise<PlanningRoofRestrictionActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: RECT_MESSAGE };
  const roofId = uuidSchema.safeParse(formData.get("roofId"));
  if (!roofId.success) return { status: "invalid", message: ROOF_MESSAGE };
  const heightRaw = formData.get("heightM");
  const candidate: Record<string, unknown> = {
    schemaVersion: PLANNING_ROOF_RESTRICTION_VERSION,
    kind: formData.get("kind"),
    label: formData.get("label"),
    rect: {
      x: parseDecimal(formData.get("rectX")),
      y: parseDecimal(formData.get("rectY")),
      width: parseDecimal(formData.get("rectWidth")),
      height: parseDecimal(formData.get("rectHeight")),
    },
  };
  if (typeof heightRaw === "string" && heightRaw.trim() !== "") {
    candidate.heightM = parseDecimal(heightRaw);
  }
  const createCheck = planningRoofRestrictionCreateV1Schema.safeParse(candidate);
  if (!createCheck.success) {
    const paths = createCheck.error.issues.map((issue) => String(issue.path[0] ?? ""));
    if (paths.includes("kind")) return { status: "invalid", message: KIND_MESSAGE };
    if (paths.includes("label")) return { status: "invalid", message: LABEL_MESSAGE };
    if (paths.includes("heightM")) return { status: "invalid", message: HEIGHT_MESSAGE };
    return { status: "invalid", message: RECT_MESSAGE };
  }
  const validated = createCheck.data;

  try {
    const row = await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_roof_restriction",
      async (tx, ctx) => {
        if (!can(ctx, "project.write")) {
          throw new PermissionDeniedError(
            "project.write",
            "planning_roof_restriction",
            ids.projectId,
            ctx.actor,
          );
        }
        const scope = await tx.execute<{ id: string; polygon_json: unknown }>(sql`
          select roof.id as id, roof.polygon_json as polygon_json
            from planning_roof_min as roof
            join planning_source as source
              on source.workspace_id = roof.workspace_id
             and source.id = roof.source_id
           where roof.workspace_id = ${ctx.workspaceId}::uuid
             and roof.id = ${roofId.data}::uuid
             and source.project_id = ${ids.projectId}::uuid
           limit 1
        `);
        const roof = scope.rows[0];
        if (!roof) throw new PlanningRoofRestrictionNotFoundError();
        const polygon = z
          .array(roofPointSchema)
          .min(3)
          .max(64)
          .safeParse(
            typeof roof.polygon_json === "string"
              ? (() => {
                  try {
                    return JSON.parse(roof.polygon_json) as unknown;
                  } catch {
                    return null;
                  }
                })()
              : roof.polygon_json,
          );
        if (!polygon.success || !rectInsidePolygon(validated.rect, polygon.data)) {
          return null;
        }
        const inserted = await tx.execute<PlanningRoofRestrictionRow>(sql`
          insert into planning_roof_restriction (
            workspace_id, roof_id, kind, label, rect_json, height_m, created_by
          ) values (
            ${ctx.workspaceId}::uuid,
            ${roofId.data}::uuid,
            ${validated.kind},
            ${validated.label},
            ${JSON.stringify(validated.rect)}::jsonb,
            ${validated.heightM ?? null},
            ${ctx.actor}::uuid
          )
          returning id, roof_id, kind, label, rect_json, height_m, created_at
        `);
        const created = inserted.rows[0];
        if (!created) throw new PlanningRoofRestrictionNotFoundError();
        return created;
      },
    );
    if (!row) return { status: "invalid", message: OUTSIDE_MESSAGE };
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: SAVED_MESSAGE, restriction: toPlanningRoofRestrictionDto(row) };
  } catch (error) {
    return mapError(error);
  }
}

// Sperrzone loeschen: Scope (Sperrzone ueber Dach+Quelle im Projekt) →
// Delete (DELETE-Grant analog project_assignment).
export async function removePlanningRoofRestrictionAction(
  _previous: PlanningRoofRestrictionActionState,
  formData: FormData,
): Promise<PlanningRoofRestrictionActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: RECT_MESSAGE };
  const restrictionId = uuidSchema.safeParse(formData.get("restrictionId"));
  if (!restrictionId.success) return { status: "not_found" };

  try {
    await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_roof_restriction",
      async (tx, ctx) => {
        if (!can(ctx, "project.write")) {
          throw new PermissionDeniedError(
            "project.write",
            "planning_roof_restriction",
            ids.projectId,
            ctx.actor,
          );
        }
        const deleted = await tx.execute<{ id: string }>(sql`
          delete from planning_roof_restriction as restriction
           using planning_roof_min as roof, planning_source as source
           where restriction.workspace_id = ${ctx.workspaceId}::uuid
             and restriction.id = ${restrictionId.data}::uuid
             and roof.workspace_id = restriction.workspace_id
             and roof.id = restriction.roof_id
             and source.workspace_id = roof.workspace_id
             and source.id = roof.source_id
             and source.project_id = ${ids.projectId}::uuid
           returning restriction.id as id
        `);
        if (!deleted.rows[0]) throw new PlanningRoofRestrictionNotFoundError();
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: REMOVED_MESSAGE, restriction: null };
  } catch (error) {
    return mapError(error);
  }
}
