// F3-05a Stringplanung: Server-Panel (WR-Registry + Strings +
// Projekt-Gruppen laden, Advisories ableiten, Client-Sektion rendern).
// Wiring: `<PlanningStringsPanel workspaceId={workspaceId} projectId={projectId} />`.
// Rechte: project.read liest, project.write schreibt (Batch-Vertrag).
// Muster: planning-panel-group-panel.tsx.
import { sql } from "drizzle-orm";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import { stringAdvisories } from "@/lib/integrations/planning/contracts/string-plan";
import {
  toPlanningInverterDto,
  type PlanningInverterDto,
  type PlanningInverterRow,
} from "./planning-inverter-model";
import {
  planningStringMemberGroupIds,
  type PlanningStringGroupOption,
  type PlanningStringListItem,
} from "./planning-string-model";
import { PlanningStringsSection } from "./planning-string-section";

type StringListRow = {
  id: string;
  inverter_id: string;
  tracker_slot: number;
  label: string;
  member_json: unknown;
  inverter_label: string;
  max_string_modules: number | null;
};

type ProjectGroupRow = {
  id: string;
  label: string;
  kind: string;
  rows: number;
  cols: number;
};

export async function PlanningStringsPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  let inverters: PlanningInverterDto[];
  let strings: PlanningStringListItem[];
  let groups: PlanningStringGroupOption[];
  let canWrite: boolean;
  try {
    const loaded = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_string",
      async (tx, ctx) => {
        // F3-05a: External fail-closed (Panel rendert null via Catch).
        if (isExternalOnly(ctx)) {
          throw new PermissionDeniedError("project.read", "planning_string", undefined, ctx.actor);
        }
        const foundInverters = await tx.execute<PlanningInverterRow>(sql`
          select id, project_id, label, mpp_trackers, max_string_modules, created_at
            from planning_inverter
           where workspace_id = ${ctx.workspaceId}::uuid
             and project_id = ${projectId}::uuid
           order by created_at, id
        `);
        const inverterDtos: PlanningInverterDto[] = [];
        for (const row of foundInverters.rows) {
          const dto = toPlanningInverterDto(row);
          if (dto) inverterDtos.push(dto);
        }
        const foundStrings = await tx.execute<StringListRow>(sql`
          select str.id as id, str.inverter_id as inverter_id,
                 str.tracker_slot as tracker_slot, str.label as label,
                 str.member_json as member_json,
                 inverter.label as inverter_label,
                 inverter.max_string_modules as max_string_modules
            from planning_string as str
            join planning_inverter as inverter
              on inverter.workspace_id = str.workspace_id
             and inverter.id = str.inverter_id
           where str.workspace_id = ${ctx.workspaceId}::uuid
             and inverter.project_id = ${projectId}::uuid
           order by str.created_at, str.id
        `);
        const foundGroups = await tx.execute<ProjectGroupRow>(sql`
          select panel_group.id as id, panel_group.label as label,
                 panel_group.kind as kind, panel_group.rows as rows,
                 panel_group.cols as cols
            from planning_panel_group as panel_group
            join planning_roof_min as roof
              on roof.workspace_id = panel_group.workspace_id
             and roof.id = panel_group.roof_id
            join planning_source as source
              on source.workspace_id = roof.workspace_id
             and source.id = roof.source_id
           where panel_group.workspace_id = ${ctx.workspaceId}::uuid
             and source.project_id = ${projectId}::uuid
           order by panel_group.created_at, panel_group.id
        `);
        const byId = new Map(foundGroups.rows.map((group) => [group.id.toLowerCase(), group]));
        const items: PlanningStringListItem[] = [];
        for (const row of foundStrings.rows) {
          const memberIds = planningStringMemberGroupIds(row.member_json);
          if (typeof row.label !== "string" || row.label.length < 1) continue;
          if (!Number.isInteger(row.tracker_slot) || row.tracker_slot < 1) continue;
          if (!memberIds) continue;
          const resolved = memberIds.flatMap((id) => {
            const group = byId.get(id);
            return group ? [group] : [];
          });
          items.push({
            id: row.id,
            inverterId: row.inverter_id,
            inverterLabel: row.inverter_label,
            trackerSlot: row.tracker_slot,
            label: row.label,
            memberLabels: resolved.map((group) => group.label),
            advisories: stringAdvisories({
              groups: resolved.map((group) => ({
                id: group.id,
                kind: group.kind,
                moduleCount: group.rows * group.cols,
              })),
              maxStringModules: row.max_string_modules,
            }),
          });
        }
        return {
          inverters: inverterDtos,
          strings: items,
          groups: foundGroups.rows.map((group) => ({ id: group.id, label: group.label })),
        };
      },
    );
    inverters = loaded.inverters;
    strings = loaded.strings;
    groups = loaded.groups;
    canWrite = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_string_write_gate",
      async (_tx, ctx) => !isExternalOnly(ctx) && can(ctx, "project.write"),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return null;
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  }
  return (
    <PlanningStringsSection
      workspaceId={workspaceId}
      projectId={projectId}
      inverters={inverters}
      strings={strings}
      groups={groups}
      canWrite={canWrite}
    />
  );
}
