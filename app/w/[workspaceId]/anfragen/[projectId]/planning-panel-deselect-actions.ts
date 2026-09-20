// F3-04b Einzelmodul-Abwahl: eigene Server-Actions (Abwahl anlegen/
// reselecten/loeschen). Muster: planning-string-equipment-actions.ts
// (Gates, Scope-Checks, Revalidate) — Rechte project.read/write, KEINE
// neuen Permission-Keys (F3-BATCH-1-Vertrag). Validierung ueber den
// Panel-Deselect-Contract; Doppel-Abwahl idempotent (success, kein
// neuer Eintrag); Out-of-Range hart (invalid).
"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { can, PermissionDeniedError } from "@/lib/permissions";
import {
  PLANNING_PANEL_DESELECT_VERSION,
  planningPanelDeselectV1Schema,
} from "@/lib/integrations/planning/contracts/panel-deselect";
import {
  toPlanningPanelDeselectDto,
  type PlanningPanelDeselectDto,
  type PlanningPanelDeselectRow,
} from "./planning-panel-deselect-model";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

const SAVED_MESSAGE = "Abwahl gespeichert.";
const REMOVED_MESSAGE = "Abwahl entfernt.";
const GROUP_MESSAGE = "Bitte eine Panel-Gruppe wählen.";
const FOREIGN_GROUP_MESSAGE = "Die Panel-Gruppe gehört nicht zu diesem Projekt.";
const RANGE_MESSAGE = "Zeile oder Spalte liegt außerhalb der Panel-Gruppe.";
const REASON_MESSAGE = "Die Begründung darf höchstens 280 Zeichen lang sein.";
const GENERIC_MESSAGE = "Die Abwahl-Angaben sind ungültig.";

export type PlanningPanelDeselectActionState =
  | {
      status: "success";
      message: string;
      deselect: PlanningPanelDeselectDto | null;
    }
  | { status: "idle" }
  | { status: "invalid"; message: string }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

class PlanningPanelDeselectNotFoundError extends Error {
  constructor() {
    super("planning panel deselect scope not found");
    this.name = "PlanningPanelDeselectNotFoundError";
  }
}

class PlanningPanelDeselectInvalidError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super("planning panel deselect invalid");
    this.name = "PlanningPanelDeselectInvalidError";
    this.detail = detail;
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

function parseInteger(raw: unknown): number {
  if (typeof raw !== "string" || raw.trim() === "") return Number.NaN;
  return Number.parseInt(raw.trim(), 10);
}

function parseReason(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
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

function mapError(error: unknown): PlanningPanelDeselectActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof PlanningPanelDeselectNotFoundError) return { status: "not_found" };
  if (error instanceof PlanningPanelDeselectInvalidError) {
    return { status: "invalid", message: error.detail };
  }
  const code = postgresErrorCode(error);
  // 23505-Race (parallele Doppel-Abwahl): idempotent-success, der
  // Refresh zeigt die bestehende Zeile.
  if (code === "23505") {
    return { status: "success", message: SAVED_MESSAGE, deselect: null };
  }
  if (code === "23514") return { status: "invalid", message: GENERIC_MESSAGE };
  if (code === "23503") return { status: "not_found" };
  throw error;
}

type GroupRasterRow = {
  id: string;
  rows: number;
  cols: number;
};

function contractErrorState(
  paths: string[],
): PlanningPanelDeselectActionState {
  if (paths.includes("groupId")) return { status: "invalid", message: GROUP_MESSAGE };
  if (paths.includes("row") || paths.includes("col")) {
    return { status: "invalid", message: RANGE_MESSAGE };
  }
  if (paths.includes("reason")) return { status: "invalid", message: REASON_MESSAGE };
  return { status: "invalid", message: GENERIC_MESSAGE };
}

function checkWrite(
  ctx: { actor: string },
  projectId: string,
  canWrite: boolean,
): void {
  if (!canWrite) {
    throw new PermissionDeniedError(
      "project.write",
      "planning_panel_deselect",
      projectId,
      ctx.actor,
    );
  }
}

// Abwahl anlegen: Contract-Gates (Gruppen-Ref/row/col/reason) → Scope
// (Gruppe→Dach→Quelle→Projekt) → row/col gegen Gruppen-Raster (hart,
// invalid) → Doppel-Abwahl idempotent (success, kein neuer Eintrag).
export async function savePlanningPanelDeselectAction(
  _previous: PlanningPanelDeselectActionState,
  formData: FormData,
): Promise<PlanningPanelDeselectActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: GENERIC_MESSAGE };
  const reason = parseReason(formData.get("reason"));
  const attachCheck = planningPanelDeselectV1Schema.safeParse({
    schemaVersion: PLANNING_PANEL_DESELECT_VERSION,
    groupId: formData.get("groupId"),
    row: parseInteger(formData.get("row")),
    col: parseInteger(formData.get("col")),
    ...(reason === undefined ? {} : { reason }),
  });
  if (!attachCheck.success) {
    return contractErrorState(
      attachCheck.error.issues.map((issue) => String(issue.path[0] ?? "")),
    );
  }
  const validated = attachCheck.data;

  try {
    const created = await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_panel_deselect",
      async (tx, ctx) => {
        checkWrite(ctx, ids.projectId, can(ctx, "project.write"));
        const groups = await tx.execute<GroupRasterRow>(sql`
          select panel_group.id as id, panel_group.rows as rows, panel_group.cols as cols
            from planning_panel_group as panel_group
            join planning_roof_min as roof
              on roof.workspace_id = panel_group.workspace_id
             and roof.id = panel_group.roof_id
            join planning_source as source
              on source.workspace_id = roof.workspace_id
             and source.id = roof.source_id
           where panel_group.workspace_id = ${ctx.workspaceId}::uuid
             and panel_group.id = ${validated.groupId}::uuid
             and source.project_id = ${ids.projectId}::uuid
           limit 1
        `);
        const group = groups.rows[0];
        if (!group) throw new PlanningPanelDeselectInvalidError(FOREIGN_GROUP_MESSAGE);
        if (validated.row > group.rows || validated.col > group.cols) {
          throw new PlanningPanelDeselectInvalidError(RANGE_MESSAGE);
        }
        const existing = await tx.execute<PlanningPanelDeselectRow>(sql`
          select id, group_id, "row", "col", reason, created_at
            from planning_panel_deselect
           where workspace_id = ${ctx.workspaceId}::uuid
             and group_id = ${validated.groupId}::uuid
             and "row" = ${validated.row}
             and "col" = ${validated.col}
           limit 1
        `);
        if (existing.rows[0]) return existing.rows[0];
        const inserted = await tx.execute<PlanningPanelDeselectRow>(sql`
          insert into planning_panel_deselect (
            workspace_id, group_id, "row", "col", reason, created_by
          ) values (
            ${ctx.workspaceId}::uuid,
            ${validated.groupId}::uuid,
            ${validated.row},
            ${validated.col},
            ${validated.reason ?? null},
            ${ctx.actor}::uuid
          )
          returning id, group_id, "row", "col", reason, created_at
        `);
        const row = inserted.rows[0];
        if (!row) throw new PlanningPanelDeselectNotFoundError();
        return row;
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return {
      status: "success",
      message: SAVED_MESSAGE,
      deselect: toPlanningPanelDeselectDto(created),
    };
  } catch (error) {
    return mapError(error);
  }
}

// Re-Select per Koordinate: Scope (Gruppe→Dach→Quelle→Projekt) →
// Delete der Zelle (No-op ohne Zeile → not_found).
export async function reselectPlanningPanelDeselectAction(
  _previous: PlanningPanelDeselectActionState,
  formData: FormData,
): Promise<PlanningPanelDeselectActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: GENERIC_MESSAGE };
  const groupId = uuidSchema.safeParse(formData.get("groupId"));
  const row = parseInteger(formData.get("row"));
  const col = parseInteger(formData.get("col"));
  if (!groupId.success) return { status: "invalid", message: GROUP_MESSAGE };
  if (!Number.isInteger(row) || row < 1 || !Number.isInteger(col) || col < 1) {
    return { status: "invalid", message: RANGE_MESSAGE };
  }

  try {
    await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_panel_deselect",
      async (tx, ctx) => {
        checkWrite(ctx, ids.projectId, can(ctx, "project.write"));
        const deleted = await tx.execute<{ id: string }>(sql`
          delete from planning_panel_deselect as deselect
           using planning_panel_group as panel_group,
                 planning_roof_min as roof,
                 planning_source as source
           where deselect.workspace_id = ${ctx.workspaceId}::uuid
             and deselect.group_id = ${groupId.data}::uuid
             and deselect."row" = ${row}
             and deselect."col" = ${col}
             and panel_group.workspace_id = deselect.workspace_id
             and panel_group.id = deselect.group_id
             and roof.workspace_id = panel_group.workspace_id
             and roof.id = panel_group.roof_id
             and source.workspace_id = roof.workspace_id
             and source.id = roof.source_id
             and source.project_id = ${ids.projectId}::uuid
           returning deselect.id as id
        `);
        if (!deleted.rows[0]) throw new PlanningPanelDeselectNotFoundError();
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: REMOVED_MESSAGE, deselect: null };
  } catch (error) {
    return mapError(error);
  }
}

// Abwahl loeschen: Scope (Abwahl→Gruppe→Dach→Quelle→Projekt) → Delete
// (frei revidierbar wie Gruppen).
export async function removePlanningPanelDeselectAction(
  _previous: PlanningPanelDeselectActionState,
  formData: FormData,
): Promise<PlanningPanelDeselectActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: GENERIC_MESSAGE };
  const deselectId = uuidSchema.safeParse(formData.get("deselectId"));
  if (!deselectId.success) return { status: "not_found" };

  try {
    await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_panel_deselect",
      async (tx, ctx) => {
        checkWrite(ctx, ids.projectId, can(ctx, "project.write"));
        const deleted = await tx.execute<{ id: string }>(sql`
          delete from planning_panel_deselect as deselect
           using planning_panel_group as panel_group,
                 planning_roof_min as roof,
                 planning_source as source
           where deselect.workspace_id = ${ctx.workspaceId}::uuid
             and deselect.id = ${deselectId.data}::uuid
             and panel_group.workspace_id = deselect.workspace_id
             and panel_group.id = deselect.group_id
             and roof.workspace_id = panel_group.workspace_id
             and roof.id = panel_group.roof_id
             and source.workspace_id = roof.workspace_id
             and source.id = roof.source_id
             and source.project_id = ${ids.projectId}::uuid
           returning deselect.id as id
        `);
        if (!deleted.rows[0]) throw new PlanningPanelDeselectNotFoundError();
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: REMOVED_MESSAGE, deselect: null };
  } catch (error) {
    return mapError(error);
  }
}
