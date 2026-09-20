// F3-05a Stringplanung: Server-Panel (WR-Registry + Strings +
// Projekt-Gruppen laden, Advisories ableiten, Client-Sektion rendern).
// F3-05d: Advisories rechnen effektiv (Ranges minus Deselect-Schnitt,
// Legacy-member_json = volle Range) plus Equipment×Deselect-Konsistenz
// via stringEffectiveAdvisoriesV1 — Warnliste, nie Reject.
// Wiring: `<PlanningStringsPanel workspaceId={workspaceId} projectId={projectId} />`.
// Rechte: project.read liest, project.write schreibt (Batch-Vertrag).
// Muster: planning-panel-group-panel.tsx.
import { sql } from "drizzle-orm";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import {
  stringEffectiveAdvisoriesV1,
  type PlanningStringEffectiveEquipmentInput,
  type PlanningStringEffectiveMemberInput,
} from "@/lib/integrations/planning/contracts/string-plan";
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
import { planningStringEquipmentPanelRef } from "./planning-string-equipment-model";
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

type MemberRangeRow = {
  string_id: string;
  group_id: string;
  row_from: number;
  row_to: number;
  col_from: number;
  col_to: number;
};

type DeselectCellRow = {
  group_id: string;
  row: number;
  col: number;
};

type EquipmentCellRow = {
  string_id: string;
  scope: string;
  panel_ref_json: unknown;
};

type StringRange = {
  groupId: string;
  rowFrom: number;
  rowTo: number;
  colFrom: number;
  colTo: number;
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
        const foundMembers = await tx.execute<MemberRangeRow>(sql`
          select member.string_id as string_id, member.group_id as group_id,
                 member.row_from as row_from, member.row_to as row_to,
                 member.col_from as col_from, member.col_to as col_to
            from planning_string_member as member
            join planning_string as str
              on str.workspace_id = member.workspace_id
             and str.id = member.string_id
            join planning_inverter as inverter
              on inverter.workspace_id = str.workspace_id
             and inverter.id = str.inverter_id
           where member.workspace_id = ${ctx.workspaceId}::uuid
             and inverter.project_id = ${projectId}::uuid
        `);
        const foundDeselects = await tx.execute<DeselectCellRow>(sql`
          select deselect.group_id as group_id,
                 deselect."row" as "row", deselect."col" as "col"
            from planning_panel_deselect as deselect
            join planning_panel_group as panel_group
              on panel_group.workspace_id = deselect.workspace_id
             and panel_group.id = deselect.group_id
            join planning_roof_min as roof
              on roof.workspace_id = panel_group.workspace_id
             and roof.id = panel_group.roof_id
            join planning_source as source
              on source.workspace_id = roof.workspace_id
             and source.id = roof.source_id
           where deselect.workspace_id = ${ctx.workspaceId}::uuid
             and source.project_id = ${projectId}::uuid
        `);
        const foundEquipment = await tx.execute<EquipmentCellRow>(sql`
          select equipment.string_id as string_id, equipment.scope as scope,
                 equipment.panel_ref_json as panel_ref_json
            from planning_string_equipment as equipment
            join planning_string as str
              on str.workspace_id = equipment.workspace_id
             and str.id = equipment.string_id
            join planning_inverter as inverter
              on inverter.workspace_id = str.workspace_id
             and inverter.id = str.inverter_id
           where equipment.workspace_id = ${ctx.workspaceId}::uuid
             and inverter.project_id = ${projectId}::uuid
        `);
        const byId = new Map(foundGroups.rows.map((group) => [group.id.toLowerCase(), group]));
        // Deselects je Gruppe (dedupliziert, fail-closed) — Bezugsgröße
        // für Effektiv-Zahlen und Equipment×Deselect-Konsistenz.
        const deselectedByGroup = new Map<string, { row: number; col: number }[]>();
        const deselectedKeys = new Set<string>();
        for (const cell of foundDeselects.rows) {
          if (typeof cell.group_id !== "string") continue;
          if (!Number.isInteger(cell.row) || cell.row < 1) continue;
          if (!Number.isInteger(cell.col) || cell.col < 1) continue;
          const groupId = cell.group_id.toLowerCase();
          const key = `${groupId}:${cell.row}:${cell.col}`;
          if (deselectedKeys.has(key)) continue;
          deselectedKeys.add(key);
          const list = deselectedByGroup.get(groupId) ?? [];
          list.push({ row: cell.row, col: cell.col });
          deselectedByGroup.set(groupId, list);
        }
        const rangesByString = new Map<string, StringRange[]>();
        for (const range of foundMembers.rows) {
          if (typeof range.string_id !== "string" || typeof range.group_id !== "string") {
            continue;
          }
          if (!Number.isInteger(range.row_from) || range.row_from < 1) continue;
          if (!Number.isInteger(range.row_to) || range.row_to < range.row_from) continue;
          if (!Number.isInteger(range.col_from) || range.col_from < 1) continue;
          if (!Number.isInteger(range.col_to) || range.col_to < range.col_from) continue;
          const key = range.string_id.toLowerCase();
          const list = rangesByString.get(key) ?? [];
          list.push({
            groupId: range.group_id.toLowerCase(),
            rowFrom: range.row_from,
            rowTo: range.row_to,
            colFrom: range.col_from,
            colTo: range.col_to,
          });
          rangesByString.set(key, list);
        }
        const equipmentByString = new Map<string, { groupId: string; row: number; col: number }[]>();
        for (const entry of foundEquipment.rows) {
          if (typeof entry.string_id !== "string" || entry.scope !== "panel") continue;
          const ref = planningStringEquipmentPanelRef(entry.panel_ref_json);
          if (!ref) continue;
          const key = entry.string_id.toLowerCase();
          const list = equipmentByString.get(key) ?? [];
          list.push({ groupId: ref.groupId, row: ref.row, col: ref.col });
          equipmentByString.set(key, list);
        }
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
          // F3-05d: Ranges schlagen Legacy (member_json = volle Range nur
          // ohne Member-Zeilen); Deselect-Schnitt je Range bzw. Gruppe.
          const ranges = rangesByString.get(row.id.toLowerCase()) ?? [];
          let members: PlanningStringEffectiveMemberInput[];
          if (ranges.length > 0) {
            members = ranges.flatMap((range) => {
              const group = byId.get(range.groupId);
              if (!group || (group.kind !== "h" && group.kind !== "v")) return [];
              const cells = (range.rowTo - range.rowFrom + 1) * (range.colTo - range.colFrom + 1);
              const deselectedCells = (deselectedByGroup.get(range.groupId) ?? []).filter(
                (cell) => cell.row >= range.rowFrom && cell.row <= range.rowTo
                  && cell.col >= range.colFrom && cell.col <= range.colTo,
              ).length;
              return [{ groupId: range.groupId, kind: group.kind, cells, deselectedCells }];
            });
          } else {
            members = resolved.flatMap((group) => {
              if (group.kind !== "h" && group.kind !== "v") return [];
              return [{
                groupId: group.id,
                kind: group.kind,
                cells: group.rows * group.cols,
                deselectedCells: (deselectedByGroup.get(group.id.toLowerCase()) ?? []).length,
              }];
            });
          }
          const equipment: PlanningStringEffectiveEquipmentInput[] = (
            equipmentByString.get(row.id.toLowerCase()) ?? []
          ).map((cell) => ({
            cell,
            deselected: deselectedKeys.has(`${cell.groupId}:${cell.row}:${cell.col}`),
          }));
          items.push({
            id: row.id,
            inverterId: row.inverter_id,
            inverterLabel: row.inverter_label,
            trackerSlot: row.tracker_slot,
            label: row.label,
            memberLabels: resolved.map((group) => group.label),
            advisories: stringEffectiveAdvisoriesV1({
              members,
              maxStringModules: row.max_string_modules,
              equipment,
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
