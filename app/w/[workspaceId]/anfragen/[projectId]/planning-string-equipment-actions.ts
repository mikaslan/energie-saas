// F3-05b String-Equipment: eigene Server-Actions (Equipment anlegen/
// loeschen). Muster: planning-string-actions.ts (Gates, Scope-Checks,
// Revalidate) — Rechte project.read/write, KEINE neuen Permission-Keys
// (F3-BATCH-1-Vertrag). Validierung ueber den String-Equipment-Contract;
// Optimierer scope=string genau 1 je String und Mikro-Doppelbelegung
// desselben Panels hart (invalid); Advisory-Ableitung steht im Panel,
// nie Reject.
"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { can, PermissionDeniedError } from "@/lib/permissions";
import {
  PLANNING_STRING_EQUIPMENT_VERSION,
  planningStringEquipmentAttachV1Schema,
} from "@/lib/integrations/planning/contracts/string-equipment";
import {
  toPlanningStringEquipmentDto,
  type PlanningStringEquipmentDto,
  type PlanningStringEquipmentRow,
} from "./planning-string-equipment-model";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

const SAVED_MESSAGE = "Equipment gespeichert.";
const REMOVED_MESSAGE = "Equipment gelöscht.";
const STRING_MESSAGE = "Bitte einen String wählen.";
const PANEL_MESSAGE = "Bitte Gruppe, Zeile und Spalte für das Panel angeben.";
const MICRO_SCOPE_MESSAGE = "Mikro-Wechselrichter sind nur je Panel möglich.";
const GROUP_MESSAGE = "Die Panel-Gruppe gehört nicht zu diesem Projekt.";
const RANGE_MESSAGE = "Zeile oder Spalte liegt außerhalb der Panel-Gruppe.";
const OPTIMIZER_DUP_MESSAGE = "Für diesen String ist bereits ein Optimierer angelegt.";
const MICRO_DOUBLE_MESSAGE = "Dieses Panel hat bereits einen Mikro-Wechselrichter.";
const GENERIC_MESSAGE = "Die Equipment-Angaben sind ungültig.";

export type PlanningStringEquipmentActionState =
  | {
      status: "success";
      message: string;
      equipment: PlanningStringEquipmentDto | null;
    }
  | { status: "idle" }
  | { status: "invalid"; message: string }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

class PlanningStringEquipmentNotFoundError extends Error {
  constructor() {
    super("planning string equipment scope not found");
    this.name = "PlanningStringEquipmentNotFoundError";
  }
}

class PlanningStringEquipmentInvalidError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super("planning string equipment invalid");
    this.name = "PlanningStringEquipmentInvalidError";
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

function postgresErrorCode(error: unknown): string | null {
  for (const candidate of [error, (error as { cause?: unknown })?.cause]) {
    if (candidate && typeof candidate === "object" && "code" in candidate) {
      const code = (candidate as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return null;
}

function mapError(error: unknown): PlanningStringEquipmentActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof PlanningStringEquipmentNotFoundError) return { status: "not_found" };
  if (error instanceof PlanningStringEquipmentInvalidError) {
    return { status: "invalid", message: error.detail };
  }
  const code = postgresErrorCode(error);
  if (code === "23514") return { status: "invalid", message: GENERIC_MESSAGE };
  if (code === "23503") return { status: "not_found" };
  throw error;
}

type GroupRasterRow = {
  id: string;
  rows: number;
  cols: number;
};

// Equipment anlegen: Contract-Gates (String-Ref/Scope/Panel-Ref/Typ,
// Kreuzregeln scope/panelRef/Mikro) → Scope (String→WR→Projekt) →
// Panel-Ref gegen Gruppen-Raster (hart, invalid) → Optimierer
// scope=string genau 1 je String und Mikro-Doppelbelegung hart
// (invalid) → Insert.
export async function savePlanningStringEquipmentAction(
  _previous: PlanningStringEquipmentActionState,
  formData: FormData,
): Promise<PlanningStringEquipmentActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: GENERIC_MESSAGE };
  const rawScope = formData.get("scope");
  const rawEquipment = formData.get("equipment");
  const attachCheck = planningStringEquipmentAttachV1Schema.safeParse({
    schemaVersion: PLANNING_STRING_EQUIPMENT_VERSION,
    stringId: formData.get("stringId"),
    scope: rawScope,
    panelRef:
      rawScope === "panel"
        ? {
            groupId: formData.get("groupId"),
            row: parseInteger(formData.get("row")),
            col: parseInteger(formData.get("col")),
          }
        : undefined,
    equipment: rawEquipment,
  });
  if (!attachCheck.success) {
    const paths = attachCheck.error.issues.map((issue) => String(issue.path[0] ?? ""));
    if (paths.includes("stringId")) return { status: "invalid", message: STRING_MESSAGE };
    if (paths.includes("panelRef")) return { status: "invalid", message: PANEL_MESSAGE };
    if (paths.includes("equipment") && rawEquipment === "micro_inverter") {
      return { status: "invalid", message: MICRO_SCOPE_MESSAGE };
    }
    return { status: "invalid", message: GENERIC_MESSAGE };
  }
  const validated = attachCheck.data;

  try {
    const created = await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_string_equipment",
      async (tx, ctx) => {
        if (!can(ctx, "project.write")) {
          throw new PermissionDeniedError(
            "project.write",
            "planning_string_equipment",
            ids.projectId,
            ctx.actor,
          );
        }
        const scope = await tx.execute<{ id: string }>(sql`
          select str.id as id
            from planning_string as str
            join planning_inverter as inverter
              on inverter.workspace_id = str.workspace_id
             and inverter.id = str.inverter_id
           where str.workspace_id = ${ctx.workspaceId}::uuid
             and str.id = ${validated.stringId}::uuid
             and inverter.project_id = ${ids.projectId}::uuid
           limit 1
        `);
        if (!scope.rows[0]) throw new PlanningStringEquipmentNotFoundError();
        if (validated.scope === "panel" && validated.panelRef) {
          const panelRef = validated.panelRef;
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
               and panel_group.id = ${panelRef.groupId}::uuid
               and source.project_id = ${ids.projectId}::uuid
             limit 1
          `);
          const group = groups.rows[0];
          if (!group) throw new PlanningStringEquipmentInvalidError(GROUP_MESSAGE);
          if (panelRef.row > group.rows || panelRef.col > group.cols) {
            throw new PlanningStringEquipmentInvalidError(RANGE_MESSAGE);
          }
        }
        if (validated.equipment === "optimizer" && validated.scope === "string") {
          const clash = await tx.execute<{ id: string }>(sql`
            select id from planning_string_equipment
             where workspace_id = ${ctx.workspaceId}::uuid
               and string_id = ${validated.stringId}::uuid
               and scope = 'string'
               and equipment = 'optimizer'
             limit 1
          `);
          if (clash.rows[0]) {
            throw new PlanningStringEquipmentInvalidError(OPTIMIZER_DUP_MESSAGE);
          }
        }
        // Zell-Doppelbelegung hart wie Service (beliebiges Equipment
        // derselben Zelle blockt, nicht nur Mikro-vs-Mikro).
        if (validated.scope === "panel" && validated.panelRef) {
          const panelRef = validated.panelRef;
          const clash = await tx.execute<{ id: string }>(sql`
            select id from planning_string_equipment
             where workspace_id = ${ctx.workspaceId}::uuid
               and string_id = ${validated.stringId}::uuid
               and scope = 'panel'
               and panel_ref_json->>'group_id' = ${panelRef.groupId.toLowerCase()}
               and (panel_ref_json->>'row')::integer = ${panelRef.row}
               and (panel_ref_json->>'col')::integer = ${panelRef.col}
             limit 1
          `);
          if (clash.rows[0]) {
            throw new PlanningStringEquipmentInvalidError(
              validated.equipment === "micro_inverter"
                ? MICRO_DOUBLE_MESSAGE
                : GENERIC_MESSAGE,
            );
          }
        }
        const panelJson =
          validated.scope === "panel" && validated.panelRef
            ? sql`${JSON.stringify({
                group_id: validated.panelRef.groupId.toLowerCase(),
                row: validated.panelRef.row,
                col: validated.panelRef.col,
              })}::jsonb`
            : sql`null`;
        const inserted = await tx.execute<PlanningStringEquipmentRow>(sql`
          insert into planning_string_equipment (
            workspace_id, string_id, scope, panel_ref_json, equipment, created_by
          ) values (
            ${ctx.workspaceId}::uuid,
            ${validated.stringId}::uuid,
            ${validated.scope},
            ${panelJson},
            ${validated.equipment},
            ${ctx.actor}::uuid
          )
          returning id, string_id, scope, panel_ref_json, equipment, created_at
        `);
        const row = inserted.rows[0];
        if (!row) throw new PlanningStringEquipmentNotFoundError();
        return row;
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return {
      status: "success",
      message: SAVED_MESSAGE,
      equipment: toPlanningStringEquipmentDto(created),
    };
  } catch (error) {
    return mapError(error);
  }
}

// Equipment loeschen: Scope (Equipment→String→WR→Projekt) → Delete
// (DELETE-Grant analog planning_string — Equipment ist frei
// revidierbar).
export async function removePlanningStringEquipmentAction(
  _previous: PlanningStringEquipmentActionState,
  formData: FormData,
): Promise<PlanningStringEquipmentActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: GENERIC_MESSAGE };
  const equipmentId = uuidSchema.safeParse(formData.get("equipmentId"));
  if (!equipmentId.success) return { status: "not_found" };

  try {
    await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_string_equipment",
      async (tx, ctx) => {
        if (!can(ctx, "project.write")) {
          throw new PermissionDeniedError(
            "project.write",
            "planning_string_equipment",
            ids.projectId,
            ctx.actor,
          );
        }
        const deleted = await tx.execute<{ id: string }>(sql`
          delete from planning_string_equipment as equipment
           using planning_string as str, planning_inverter as inverter
           where equipment.workspace_id = ${ctx.workspaceId}::uuid
             and equipment.id = ${equipmentId.data}::uuid
             and str.workspace_id = equipment.workspace_id
             and str.id = equipment.string_id
             and inverter.workspace_id = str.workspace_id
             and inverter.id = str.inverter_id
             and inverter.project_id = ${ids.projectId}::uuid
           returning equipment.id as id
        `);
        if (!deleted.rows[0]) throw new PlanningStringEquipmentNotFoundError();
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: REMOVED_MESSAGE, equipment: null };
  } catch (error) {
    return mapError(error);
  }
}
