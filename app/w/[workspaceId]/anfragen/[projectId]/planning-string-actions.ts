// F3-05a manuelle Strings: eigene Server-Actions (String anlegen/
// loeschen). Muster: planning-panel-group-actions.ts (Gates,
// Scope-Checks, Revalidate) — Rechte project.read/write, KEINE neuen
// Permission-Keys (F3-BATCH-1-Vertrag). Validierung ueber den
// Stringplan-Contract; Slot ≤ Tracker und Doppelbelegung nur
// App-Level (Spec ESTIMATE); Advisories stehen in der Response, nie
// Reject. Die Service-Fläche (modules/planning/strings) nutzt
// dieselbe Ableitung.
"use server";

import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { authorizedAction, NotAuthenticatedError } from "@/lib/action";
import { can, PermissionDeniedError } from "@/lib/permissions";
import {
  PLANNING_STRING_VERSION,
  planningStringCreateV1Schema,
  stringAdvisories,
  type PlanningStringAdvisory,
} from "@/lib/integrations/planning/contracts/string-plan";
import {
  toPlanningStringDto,
  type PlanningStringDto,
  type PlanningStringRow,
} from "./planning-string-model";

const uuidSchema = z.uuid();
const workspaceIdSchema = z.uuid().transform((value) => value.toLowerCase());

const SAVED_MESSAGE = "String gespeichert.";
const REMOVED_MESSAGE = "String gelöscht.";
const INVERTER_MESSAGE = "Bitte einen Wechselrichter wählen.";
const SLOT_MESSAGE = "Der Tracker-Slot muss eine ganze Zahl ab 1 sein.";
const SLOT_RANGE_MESSAGE = "Der Tracker-Slot liegt über der Tracker-Zahl des Wechselrichters.";
const LABEL_MESSAGE = "Bitte eine Bezeichnung angeben.";
const GROUPS_MESSAGE = "Bitte mindestens eine Panel-Gruppe wählen.";
const DOUBLE_MESSAGE =
  "Diese Gruppe ist auf diesem Wechselrichter bereits verstringt.";
const GENERIC_MESSAGE = "Die String-Angaben sind ungültig.";

export type PlanningStringActionState =
  | {
      status: "success";
      message: string;
      string: PlanningStringDto | null;
      advisories: PlanningStringAdvisory[];
    }
  | { status: "idle" }
  | { status: "invalid"; message: string }
  | { status: "not_found" }
  | { status: "denied" }
  | { status: "unauthenticated" };

class PlanningStringNotFoundError extends Error {
  constructor() {
    super("planning string scope not found");
    this.name = "PlanningStringNotFoundError";
  }
}

class PlanningStringSlotRangeError extends Error {
  constructor() {
    super("planning string slot above tracker count");
    this.name = "PlanningStringSlotRangeError";
  }
}

class PlanningStringDoubleUseError extends Error {
  constructor() {
    super("planning string group already used on inverter");
    this.name = "PlanningStringDoubleUseError";
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

function mapError(error: unknown): PlanningStringActionState {
  if (error instanceof NotAuthenticatedError) return { status: "unauthenticated" };
  if (error instanceof PermissionDeniedError) return { status: "denied" };
  if (error instanceof PlanningStringNotFoundError) return { status: "not_found" };
  if (error instanceof PlanningStringSlotRangeError) {
    return { status: "invalid", message: SLOT_RANGE_MESSAGE };
  }
  if (error instanceof PlanningStringDoubleUseError) {
    return { status: "invalid", message: DOUBLE_MESSAGE };
  }
  const code = postgresErrorCode(error);
  if (code === "23514") return { status: "invalid", message: GENERIC_MESSAGE };
  if (code === "23503") return { status: "not_found" };
  throw error;
}

type InverterScopeRow = {
  id: string;
  mpp_trackers: number;
  max_string_modules: number | null;
};

type MemberGroupRow = {
  id: string;
  kind: string;
  rows: number;
  cols: number;
};

// String anlegen: Contract-Gates (WR-Ref/Slot/Label/Member) → Scope
// (WR→Projekt, Gruppen→Dächer desselben Projekts) → Slot-Range und
// Doppelbelegung (hart, invalid) → Insert → Advisories in der Response.
export async function savePlanningStringAction(
  _previous: PlanningStringActionState,
  formData: FormData,
): Promise<PlanningStringActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: GENERIC_MESSAGE };
  const groupIds = [
    ...new Set(
      formData
        .getAll("groupIds")
        .filter((entry): entry is string => typeof entry === "string"),
    ),
  ];
  const createCheck = planningStringCreateV1Schema.safeParse({
    schemaVersion: PLANNING_STRING_VERSION,
    inverterId: formData.get("inverterId"),
    trackerSlot: parseInteger(formData.get("trackerSlot")),
    label: formData.get("label"),
    members: groupIds.map((groupId) => ({ groupId })),
  });
  if (!createCheck.success) {
    const paths = createCheck.error.issues.map((issue) => String(issue.path[0] ?? ""));
    if (paths.includes("inverterId")) return { status: "invalid", message: INVERTER_MESSAGE };
    if (paths.includes("trackerSlot")) return { status: "invalid", message: SLOT_MESSAGE };
    if (paths.includes("label")) return { status: "invalid", message: LABEL_MESSAGE };
    return { status: "invalid", message: GROUPS_MESSAGE };
  }
  const validated = createCheck.data;

  try {
    const created = await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_string",
      async (tx, ctx) => {
        if (!can(ctx, "project.write")) {
          throw new PermissionDeniedError(
            "project.write",
            "planning_string",
            ids.projectId,
            ctx.actor,
          );
        }
        const scope = await tx.execute<InverterScopeRow>(sql`
          select id, mpp_trackers, max_string_modules
            from planning_inverter
           where workspace_id = ${ctx.workspaceId}::uuid
             and id = ${validated.inverterId}::uuid
             and project_id = ${ids.projectId}::uuid
           limit 1
        `);
        const inverter = scope.rows[0];
        if (!inverter) throw new PlanningStringNotFoundError();
        if (validated.trackerSlot > inverter.mpp_trackers) {
          throw new PlanningStringSlotRangeError();
        }
        const memberIdList = sql.join(
          validated.members.map((member) => sql`${member.groupId}::uuid`),
          sql`, `,
        );
        const groups = await tx.execute<MemberGroupRow>(sql`
          select panel_group.id as id, panel_group.kind as kind,
                 panel_group.rows as rows, panel_group.cols as cols
            from planning_panel_group as panel_group
            join planning_roof_min as roof
              on roof.workspace_id = panel_group.workspace_id
             and roof.id = panel_group.roof_id
            join planning_source as source
              on source.workspace_id = roof.workspace_id
             and source.id = roof.source_id
           where panel_group.workspace_id = ${ctx.workspaceId}::uuid
             and source.project_id = ${ids.projectId}::uuid
             and panel_group.id in (${memberIdList})
        `);
        if (groups.rows.length !== validated.members.length) {
          throw new PlanningStringNotFoundError();
        }
        for (const member of validated.members) {
          const clash = await tx.execute<{ id: string }>(sql`
            select id from planning_string
             where workspace_id = ${ctx.workspaceId}::uuid
               and inverter_id = ${validated.inverterId}::uuid
               and member_json @> ${JSON.stringify([{ group_id: member.groupId }])}::jsonb
             limit 1
          `);
          if (clash.rows[0]) throw new PlanningStringDoubleUseError();
        }
        const inserted = await tx.execute<PlanningStringRow>(sql`
          insert into planning_string (
            workspace_id, inverter_id, tracker_slot, label, member_json, created_by
          ) values (
            ${ctx.workspaceId}::uuid,
            ${validated.inverterId}::uuid,
            ${validated.trackerSlot},
            ${validated.label},
            ${JSON.stringify(validated.members.map((member) => ({ group_id: member.groupId })))}::jsonb,
            ${ctx.actor}::uuid
          )
          returning id, inverter_id, tracker_slot, label, member_json, created_at
        `);
        const row = inserted.rows[0];
        if (!row) throw new PlanningStringNotFoundError();
        return { row, groups: groups.rows, maxStringModules: inverter.max_string_modules };
      },
    );
    const advisories = stringAdvisories({
      groups: created.groups.map((group) => ({
        id: group.id,
        kind: group.kind,
        moduleCount: group.rows * group.cols,
      })),
      maxStringModules: created.maxStringModules,
    });
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return {
      status: "success",
      message: SAVED_MESSAGE,
      string: toPlanningStringDto(created.row),
      advisories,
    };
  } catch (error) {
    return mapError(error);
  }
}

// String loeschen: Scope (String→WR→Projekt) → Delete (DELETE-Grant
// analog planning_panel_group — Strings sind frei revidierbar).
export async function removePlanningStringAction(
  _previous: PlanningStringActionState,
  formData: FormData,
): Promise<PlanningStringActionState> {
  const ids = parseIds(formData);
  if (!ids) return { status: "invalid", message: GENERIC_MESSAGE };
  const stringId = uuidSchema.safeParse(formData.get("stringId"));
  if (!stringId.success) return { status: "not_found" };

  try {
    await authorizedAction(
      ids.workspaceId,
      "project.write",
      "planning_string",
      async (tx, ctx) => {
        if (!can(ctx, "project.write")) {
          throw new PermissionDeniedError(
            "project.write",
            "planning_string",
            ids.projectId,
            ctx.actor,
          );
        }
        const deleted = await tx.execute<{ id: string }>(sql`
          delete from planning_string as str
           using planning_inverter as inverter
           where str.workspace_id = ${ctx.workspaceId}::uuid
             and str.id = ${stringId.data}::uuid
             and inverter.workspace_id = str.workspace_id
             and inverter.id = str.inverter_id
             and inverter.project_id = ${ids.projectId}::uuid
           returning str.id as id
        `);
        if (!deleted.rows[0]) throw new PlanningStringNotFoundError();
      },
    );
    revalidatePath(detailPath(ids.workspaceId, ids.projectId));
    return { status: "success", message: REMOVED_MESSAGE, string: null, advisories: [] };
  } catch (error) {
    return mapError(error);
  }
}
