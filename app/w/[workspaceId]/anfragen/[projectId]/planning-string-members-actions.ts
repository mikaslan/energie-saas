// F3-05c String-Member: eigene Server-Actions (Member anlegen/
// loeschen). Muster: planning-string-equipment-actions.ts (Gates,
// Scope-Checks, Revalidate) — Rechte project.read/write, KEINE neuen
// Permission-Keys (F3-BATCH-1-Vertrag). Validierung ueber den
// String-Member-Contract; Range gegen Gruppen-Raster, Voll-Deselect-,
// Ueberlapp- und WR-Doppelbelegungs-Rejects hart (invalid).
"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { can, PermissionDeniedError } from "@/lib/permissions";
import {
  PLANNING_STRING_MEMBER_VERSION,
  planningStringMemberAddV1Schema,
  rangesOverlap,
} from "@/lib/integrations/planning/contracts/string-member";
import {
  toPlanningStringMemberDto,
  type PlanningStringMemberDto,
  type PlanningStringMemberRow,
} from "./planning-string-members-model";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

const SAVED_MESSAGE = "Member gespeichert.";
const REMOVED_MESSAGE = "Member entfernt.";
const GROUP_MESSAGE = "Bitte eine Panel-Gruppe wählen.";
const FOREIGN_GROUP_MESSAGE = "Die Panel-Gruppe gehört nicht zu diesem Projekt.";
const WINDOW_MESSAGE =
  "Zeilen-/Spalten-Fenster sind ungültig (ganze Zahlen ab 1, von ≤ bis).";
const RASTER_MESSAGE = "Die Range liegt außerhalb der Panel-Gruppe.";
const OVERLAP_MESSAGE = "Die Range überschneidet sich mit einem Member desselben Strings.";
const FULL_DESELECT_MESSAGE = "Die Range enthält nur abgewählte Zellen.";
const DOUBLE_MESSAGE = "Diese Zellen sind auf diesem Wechselrichter bereits verstringt.";
const GENERIC_MESSAGE = "Die Member-Angaben sind ungültig.";

export type PlanningStringMemberActionState =
  | {
      status: "success";
      message: string;
      member: PlanningStringMemberDto | null;
      stringId: string | null;
    }
  | { status: "idle" }
  | { status: "invalid"; message: string }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

class PlanningStringMemberNotFoundError extends Error {
  constructor() {
    super("planning string member scope not found");
    this.name = "PlanningStringMemberNotFoundError";
  }
}

class PlanningStringMemberInvalidError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super("planning string member invalid");
    this.name = "PlanningStringMemberInvalidError";
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

function mapError(error: unknown): PlanningStringMemberActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof PlanningStringMemberNotFoundError) return { status: "not_found" };
  if (error instanceof PlanningStringMemberInvalidError) {
    return { status: "invalid", message: error.detail };
  }
  const code = postgresErrorCode(error);
  if (code === "23514") return { status: "invalid", message: GENERIC_MESSAGE };
  if (code === "23503") return { status: "not_found" };
  throw error;
}

type StringScopeRow = {
  id: string;
  inverter_id: string;
};

type GroupRasterRow = {
  id: string;
  rows: number;
  cols: number;
};

type MemberRangeRow = {
  group_id: string;
  row_from: number;
  row_to: number;
  col_from: number;
  col_to: number;
};

type DeselectCellRow = {
  row: number;
  col: number;
};

function checkWrite(ctx: { actor: string }, projectId: string, canWrite: boolean): void {
  if (!canWrite) {
    throw new PermissionDeniedError(
      "project.write",
      "planning_string_member",
      projectId,
      ctx.actor,
    );
  }
}

// Member anlegen: Contract-Gates (String-/Gruppen-Ref, Fenster,
// from≤to) → Scope (String→WR→Projekt, Gruppe→Dach→Quelle→Projekt) →
// Fenster gegen Gruppen-Raster → Ueberlapp im selben String,
// Voll-Deselect-Range und Zell-Doppelbelegung in anderem String
// desselben WR hart (invalid) → Insert.
export async function savePlanningStringMemberAction(
  _previous: PlanningStringMemberActionState,
  formData: FormData,
): Promise<PlanningStringMemberActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: GENERIC_MESSAGE };
  const stringId = uuidSchema.safeParse(formData.get("stringId"));
  if (!stringId.success) return { status: "not_found" };
  const addCheck = planningStringMemberAddV1Schema.safeParse({
    schemaVersion: PLANNING_STRING_MEMBER_VERSION,
    stringId: stringId.data,
    groupId: formData.get("groupId"),
    rowFrom: parseInteger(formData.get("rowFrom")),
    rowTo: parseInteger(formData.get("rowTo")),
    colFrom: parseInteger(formData.get("colFrom")),
    colTo: parseInteger(formData.get("colTo")),
  });
  if (!addCheck.success) {
    const paths = addCheck.error.issues.map((issue) => String(issue.path[0] ?? ""));
    if (paths.includes("stringId")) return { status: "not_found" };
    if (paths.includes("groupId")) return { status: "invalid", message: GROUP_MESSAGE };
    return { status: "invalid", message: WINDOW_MESSAGE };
  }
  const validated = addCheck.data;

  try {
    const created = await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_string_member",
      async (tx, ctx) => {
        checkWrite(ctx, ids.projectId, can(ctx, "project.write"));
        const scope = await tx.execute<StringScopeRow>(sql`
          select str.id as id, str.inverter_id as inverter_id
            from planning_string as str
            join planning_inverter as inverter
              on inverter.workspace_id = str.workspace_id
             and inverter.id = str.inverter_id
           where str.workspace_id = ${ctx.workspaceId}::uuid
             and str.id = ${validated.stringId}::uuid
             and inverter.project_id = ${ids.projectId}::uuid
           limit 1
        `);
        const stringScope = scope.rows[0];
        if (!stringScope) throw new PlanningStringMemberNotFoundError();
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
        if (!group) throw new PlanningStringMemberInvalidError(FOREIGN_GROUP_MESSAGE);
        if (validated.rowTo > group.rows || validated.colTo > group.cols) {
          throw new PlanningStringMemberInvalidError(RASTER_MESSAGE);
        }
        const candidate = {
          groupId: validated.groupId.toLowerCase(),
          rowFrom: validated.rowFrom,
          rowTo: validated.rowTo,
          colFrom: validated.colFrom,
          colTo: validated.colTo,
        };
        const sameString = await tx.execute<MemberRangeRow>(sql`
          select group_id, row_from, row_to, col_from, col_to
            from planning_string_member
           where workspace_id = ${ctx.workspaceId}::uuid
             and string_id = ${validated.stringId}::uuid
        `);
        for (const row of sameString.rows) {
          if (
            rangesOverlap(candidate, {
              groupId: row.group_id.toLowerCase(),
              rowFrom: row.row_from,
              rowTo: row.row_to,
              colFrom: row.col_from,
              colTo: row.col_to,
            })
          ) {
            throw new PlanningStringMemberInvalidError(OVERLAP_MESSAGE);
          }
        }
        const deselects = await tx.execute<DeselectCellRow>(sql`
          select "row" as row, "col" as col
            from planning_panel_deselect
           where workspace_id = ${ctx.workspaceId}::uuid
             and group_id = ${validated.groupId}::uuid
        `);
        const rangeCells =
          (validated.rowTo - validated.rowFrom + 1)
          * (validated.colTo - validated.colFrom + 1);
        let inside = 0;
        for (const cell of deselects.rows) {
          if (
            cell.row >= validated.rowFrom
            && cell.row <= validated.rowTo
            && cell.col >= validated.colFrom
            && cell.col <= validated.colTo
          ) {
            inside += 1;
          }
        }
        if (inside >= rangeCells) {
          throw new PlanningStringMemberInvalidError(FULL_DESELECT_MESSAGE);
        }
        const inverterMembers = await tx.execute<MemberRangeRow>(sql`
          select member.group_id as group_id, member.row_from as row_from,
                 member.row_to as row_to, member.col_from as col_from,
                 member.col_to as col_to
            from planning_string_member as member
            join planning_string as str
              on str.workspace_id = member.workspace_id
             and str.id = member.string_id
           where member.workspace_id = ${ctx.workspaceId}::uuid
             and str.inverter_id = ${stringScope.inverter_id}::uuid
             and member.string_id <> ${validated.stringId}::uuid
        `);
        for (const row of inverterMembers.rows) {
          if (
            rangesOverlap(candidate, {
              groupId: row.group_id.toLowerCase(),
              rowFrom: row.row_from,
              rowTo: row.row_to,
              colFrom: row.col_from,
              colTo: row.col_to,
            })
          ) {
            throw new PlanningStringMemberInvalidError(DOUBLE_MESSAGE);
          }
        }
        const inserted = await tx.execute<PlanningStringMemberRow>(sql`
          insert into planning_string_member (
            workspace_id, string_id, group_id,
            row_from, row_to, col_from, col_to, created_by
          ) values (
            ${ctx.workspaceId}::uuid,
            ${validated.stringId}::uuid,
            ${validated.groupId}::uuid,
            ${validated.rowFrom},
            ${validated.rowTo},
            ${validated.colFrom},
            ${validated.colTo},
            ${ctx.actor}::uuid
          )
          returning id, string_id, group_id,
                    row_from, row_to, col_from, col_to, created_at
        `);
        const row = inserted.rows[0];
        if (!row) throw new PlanningStringMemberNotFoundError();
        return row;
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return {
      status: "success",
      message: SAVED_MESSAGE,
      member: toPlanningStringMemberDto(created),
      stringId: stringId.data.toLowerCase(),
    };
  } catch (error) {
    return mapError(error);
  }
}

// Member loeschen: Scope (Member→String→WR→Projekt) → Delete (frei
// revidierbar wie Strings).
export async function removePlanningStringMemberAction(
  _previous: PlanningStringMemberActionState,
  formData: FormData,
): Promise<PlanningStringMemberActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: GENERIC_MESSAGE };
  const memberId = uuidSchema.safeParse(formData.get("memberId"));
  if (!memberId.success) return { status: "not_found" };

  try {
    const deleted = await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_string_member",
      async (tx, ctx) => {
        checkWrite(ctx, ids.projectId, can(ctx, "project.write"));
        const removed = await tx.execute<{ id: string; string_id: string }>(sql`
          delete from planning_string_member as member
           using planning_string as str, planning_inverter as inverter
           where member.workspace_id = ${ctx.workspaceId}::uuid
             and member.id = ${memberId.data}::uuid
             and str.workspace_id = member.workspace_id
             and str.id = member.string_id
             and inverter.workspace_id = str.workspace_id
             and inverter.id = str.inverter_id
             and inverter.project_id = ${ids.projectId}::uuid
           returning member.id as id, member.string_id as string_id
        `);
        const row = removed.rows[0];
        if (!row) throw new PlanningStringMemberNotFoundError();
        return row;
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return {
      status: "success",
      message: REMOVED_MESSAGE,
      member: null,
      stringId: deleted.string_id.toLowerCase(),
    };
  } catch (error) {
    return mapError(error);
  }
}
