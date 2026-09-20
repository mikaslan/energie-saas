// F3-04a Panel-Gruppen: eigene Server-Actions (Rastergruppe
// anlegen/loeschen). Muster: planning-roof-restriction-actions.ts (Gates,
// Scope-Checks, Revalidate) — Rechte project.read/write, KEINE neuen
// Permission-Keys (F3-BATCH-1-vertrag). Validierung ueber den
// Panel-Group-Contract, Gruppen-Rechteck (groupRect) und
// Rechteck-in-Polygon serverseitig (Dach-Polygon laden +
// rectInsidePolygon), DB-CHECKs als zweite Linie.
"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { can, PermissionDeniedError } from "@/lib/permissions";
import {
  groupRect,
  PLANNING_PANEL_GROUP_VERSION,
  planningPanelGroupCreateV1Schema,
  rectInsidePolygon,
} from "@/lib/integrations/planning/contracts";
import {
  toPlanningPanelGroupDto,
  type PlanningPanelGroupDto,
  type PlanningPanelGroupRow,
} from "./planning-panel-group-model";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

const SAVED_MESSAGE = "Panel-Gruppe gespeichert.";
const REMOVED_MESSAGE = "Panel-Gruppe gelöscht.";
const GRID_MESSAGE = "Zeilen/Spalten müssen ganze Zahlen von 1–200 sein.";
const MODULE_MESSAGE = "Die Modulmaße müssen zwischen 0,1–5 m liegen.";
const GAP_MESSAGE = "Die Lücke muss zwischen 0–2 m liegen.";
const TILT_MESSAGE = "Die Neigung muss zwischen 0–90° liegen (oder leer).";
const ORIGIN_MESSAGE = "Der Ursprung ist ungültig (endliche Zahlen erwartet).";
const OUTSIDE_MESSAGE = "Die Gruppe liegt außerhalb des Dachpolygons.";
const LABEL_MESSAGE = "Bitte eine Bezeichnung angeben.";
const KIND_MESSAGE = "Bitte eine gültige Ausrichtung wählen (H/V).";
const ROOF_MESSAGE = "Bitte zuerst ein Dach für das Projekt anlegen.";

export type PlanningPanelGroupActionState =
  | { status: "idle" }
  | { status: "success"; message: string; group: PlanningPanelGroupDto | null }
  | { status: "invalid"; message: string }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

class PlanningPanelGroupNotFoundError extends Error {
  constructor() {
    super("planning panel group scope not found");
    this.name = "PlanningPanelGroupNotFoundError";
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

function parseInteger(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return Number.NaN;
  return Number.parseInt(raw.trim(), 10);
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

function mapError(error: unknown): PlanningPanelGroupActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof PlanningPanelGroupNotFoundError) return { status: "not_found" };
  const code = postgresErrorCode(error);
  if (code === "23514") return { status: "invalid", message: GRID_MESSAGE };
  if (code === "23503") return { status: "not_found" };
  throw error;
}

const roofPointSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite() });

// Gruppe anlegen: Contract-Gates (kind/Bezeichnung/Ursprung/Raster/
// Modulmass/Luecke/Neigung) → Scope (Dach gehoert zum Projekt) →
// Gruppen-Rechteck-in-Polygon → Insert.
export async function savePlanningPanelGroupAction(
  _previous: PlanningPanelGroupActionState,
  formData: FormData,
): Promise<PlanningPanelGroupActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: GRID_MESSAGE };
  const roofId = uuidSchema.safeParse(formData.get("roofId"));
  if (!roofId.success) return { status: "invalid", message: ROOF_MESSAGE };
  const tiltRaw = formData.get("tiltDeg");
  const candidate: Record<string, unknown> = {
    schemaVersion: PLANNING_PANEL_GROUP_VERSION,
    kind: formData.get("kind"),
    label: formData.get("label"),
    origin: {
      x: parseDecimal(formData.get("originX")),
      y: parseDecimal(formData.get("originY")),
    },
    rows: parseInteger(formData.get("rows")),
    cols: parseInteger(formData.get("cols")),
    moduleWM: parseDecimal(formData.get("moduleWM")),
    moduleHM: parseDecimal(formData.get("moduleHM")),
    gapM: parseDecimal(formData.get("gapM")),
  };
  if (typeof tiltRaw === "string" && tiltRaw.trim() !== "") {
    candidate.tiltDeg = parseDecimal(tiltRaw);
  }
  const createCheck = planningPanelGroupCreateV1Schema.safeParse(candidate);
  if (!createCheck.success) {
    const paths = createCheck.error.issues.map((issue) => String(issue.path[0] ?? ""));
    if (paths.includes("kind")) return { status: "invalid", message: KIND_MESSAGE };
    if (paths.includes("label")) return { status: "invalid", message: LABEL_MESSAGE };
    if (paths.includes("origin")) return { status: "invalid", message: ORIGIN_MESSAGE };
    if (paths.includes("rows") || paths.includes("cols")) {
      return { status: "invalid", message: GRID_MESSAGE };
    }
    if (paths.includes("moduleWM") || paths.includes("moduleHM")) {
      return { status: "invalid", message: MODULE_MESSAGE };
    }
    if (paths.includes("gapM")) return { status: "invalid", message: GAP_MESSAGE };
    if (paths.includes("tiltDeg")) return { status: "invalid", message: TILT_MESSAGE };
    return { status: "invalid", message: GRID_MESSAGE };
  }
  const validated = createCheck.data;

  try {
    const row = await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_panel_group",
      async (tx, ctx) => {
        if (!can(ctx, "project.write")) {
          throw new PermissionDeniedError(
            "project.write",
            "planning_panel_group",
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
        if (!roof) throw new PlanningPanelGroupNotFoundError();
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
        const rect = groupRect(validated);
        if (!polygon.success || !rectInsidePolygon(rect, polygon.data)) {
          return null;
        }
        const inserted = await tx.execute<PlanningPanelGroupRow>(sql`
          insert into planning_panel_group (
            workspace_id, roof_id, kind, label, origin_json,
            rows, cols, module_w_m, module_h_m, gap_m, tilt_deg, created_by
          ) values (
            ${ctx.workspaceId}::uuid,
            ${roofId.data}::uuid,
            ${validated.kind},
            ${validated.label},
            ${JSON.stringify(validated.origin)}::jsonb,
            ${validated.rows},
            ${validated.cols},
            ${validated.moduleWM},
            ${validated.moduleHM},
            ${validated.gapM},
            ${validated.tiltDeg ?? null},
            ${ctx.actor}::uuid
          )
          returning id, roof_id, kind, label, origin_json,
            rows, cols, module_w_m, module_h_m, gap_m, tilt_deg, created_at
        `);
        const created = inserted.rows[0];
        if (!created) throw new PlanningPanelGroupNotFoundError();
        return created;
      },
    );
    if (!row) return { status: "invalid", message: OUTSIDE_MESSAGE };
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: SAVED_MESSAGE, group: toPlanningPanelGroupDto(row) };
  } catch (error) {
    return mapError(error);
  }
}

// Gruppe loeschen: Scope (Gruppe ueber Dach+Quelle im Projekt) →
// Delete (DELETE-Grant analog project_assignment).
export async function removePlanningPanelGroupAction(
  _previous: PlanningPanelGroupActionState,
  formData: FormData,
): Promise<PlanningPanelGroupActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: GRID_MESSAGE };
  const groupId = uuidSchema.safeParse(formData.get("groupId"));
  if (!groupId.success) return { status: "not_found" };

  try {
    await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_panel_group",
      async (tx, ctx) => {
        if (!can(ctx, "project.write")) {
          throw new PermissionDeniedError(
            "project.write",
            "planning_panel_group",
            ids.projectId,
            ctx.actor,
          );
        }
        const deleted = await tx.execute<{ id: string }>(sql`
          delete from planning_panel_group as panel_group
           using planning_roof_min as roof, planning_source as source
           where panel_group.workspace_id = ${ctx.workspaceId}::uuid
             and panel_group.id = ${groupId.data}::uuid
             and roof.workspace_id = panel_group.workspace_id
             and roof.id = panel_group.roof_id
             and source.workspace_id = roof.workspace_id
             and source.id = roof.source_id
             and source.project_id = ${ids.projectId}::uuid
           returning panel_group.id as id
        `);
        if (!deleted.rows[0]) throw new PlanningPanelGroupNotFoundError();
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: REMOVED_MESSAGE, group: null };
  } catch (error) {
    return mapError(error);
  }
}
