// F3-05c String-Member: Server-Panel (Strings + Projekt-Gruppen +
// Member + Deselects laden, Effektiv-Count je String ableiten,
// Client-Sektion rendern).
// Wiring: `<PlanningStringMembersPanel workspaceId={workspaceId} projectId={projectId} />`.
// Rechte: project.read liest, project.write schreibt (Batch-Vertrag).
// Muster: planning-string-equipment-panel.tsx.
import { sql } from "drizzle-orm";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import { effectiveMemberCount } from "@/lib/integrations/planning/contracts/string-member";
import { planningStringMemberGroupIds } from "./planning-string-model";
import {
  planningStringMemberCellCount,
  toPlanningStringMemberDto,
  type PlanningStringMemberGroupOption,
  type PlanningStringMemberListItem,
  type PlanningStringMemberRow,
  type PlanningStringMemberStringSection,
} from "./planning-string-members-model";
import { PlanningStringMembersSection } from "./planning-string-members-section";

type MemberStringRow = {
  id: string;
  tracker_slot: number;
  label: string;
  member_json: unknown;
  inverter_label: string;
};

type ProjectGroupRow = {
  id: string;
  label: string;
  rows: number;
  cols: number;
};

type MemberListRow = PlanningStringMemberRow;

type DeselectCellRow = {
  group_id: string;
  row: number;
  col: number;
};

export async function PlanningStringMembersPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  let strings: PlanningStringMemberStringSection[];
  let groups: PlanningStringMemberGroupOption[];
  let canWrite: boolean;
  try {
    const loaded = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_string_member",
      async (tx, ctx) => {
        // F3-05c: External fail-closed (Panel rendert null via Catch).
        if (isExternalOnly(ctx)) {
          throw new PermissionDeniedError(
            "project.read",
            "planning_string_member",
            undefined,
            ctx.actor,
          );
        }
        // String-Reihenfolge = String-Listenreihenfolge des Strings-Panels
        // (created_at, id), damit die E2E-nth-Adressierung je String greift.
        const foundStrings = await tx.execute<MemberStringRow>(sql`
          select str.id as id, str.tracker_slot as tracker_slot,
                 str.label as label, str.member_json as member_json,
                 inverter.label as inverter_label
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
                 panel_group.rows as rows, panel_group.cols as cols
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
        const foundMembers = await tx.execute<MemberListRow>(sql`
          select member.id as id, member.string_id as string_id,
                 member.group_id as group_id, member.row_from as row_from,
                 member.row_to as row_to, member.col_from as col_from,
                 member.col_to as col_to, member.created_at as created_at
            from planning_string_member as member
            join planning_string as str
              on str.workspace_id = member.workspace_id
             and str.id = member.string_id
            join planning_inverter as inverter
              on inverter.workspace_id = str.workspace_id
             and inverter.id = str.inverter_id
           where member.workspace_id = ${ctx.workspaceId}::uuid
             and inverter.project_id = ${projectId}::uuid
           order by member.created_at, member.id
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
        const options: PlanningStringMemberGroupOption[] = [];
        for (const row of foundGroups.rows) {
          if (typeof row.label !== "string" || row.label.length < 1) continue;
          if (!Number.isInteger(row.rows) || row.rows < 1) continue;
          if (!Number.isInteger(row.cols) || row.cols < 1) continue;
          options.push({ id: row.id, label: row.label, rows: row.rows, cols: row.cols });
        }
        const byId = new Map(options.map((group) => [group.id.toLowerCase(), group]));
        const deselected = foundDeselects.rows.flatMap((cell) => {
          if (!Number.isInteger(cell.row) || cell.row < 1) return [];
          if (!Number.isInteger(cell.col) || cell.col < 1) return [];
          return [{ groupId: cell.group_id.toLowerCase(), row: cell.row, col: cell.col }];
        });
        const itemsByString = new Map<string, PlanningStringMemberListItem[]>();
        for (const row of foundMembers.rows) {
          const dto = toPlanningStringMemberDto(row);
          if (!dto) continue;
          const group = byId.get(dto.groupId);
          if (!group) continue;
          const list = itemsByString.get(dto.stringId) ?? [];
          list.push({
            id: dto.id,
            stringId: dto.stringId,
            groupId: dto.groupId,
            groupLabel: group.label,
            rowFrom: dto.rowFrom,
            rowTo: dto.rowTo,
            colFrom: dto.colFrom,
            colTo: dto.colTo,
          });
          itemsByString.set(dto.stringId, list);
        }
        const sections: PlanningStringMemberStringSection[] = [];
        for (const row of foundStrings.rows) {
          // Gleicher Gueltigkeits-Filter wie das Strings-Panel, damit jede
          // Member-Sektion genau einer sichtbaren String-Zeile entspricht.
          if (typeof row.label !== "string" || row.label.length < 1) continue;
          if (!Number.isInteger(row.tracker_slot) || row.tracker_slot < 1) continue;
          if (!planningStringMemberGroupIds(row.member_json)) continue;
          if (typeof row.inverter_label !== "string" || row.inverter_label.length < 1) {
            continue;
          }
          const members = itemsByString.get(row.id.toLowerCase()) ?? [];
          const rawCount = members.reduce(
            (sum, member) => sum + planningStringMemberCellCount(member),
            0,
          );
          const effectiveCount = effectiveMemberCount({
            ranges: members.map((member) => ({
              groupId: member.groupId,
              rowFrom: member.rowFrom,
              rowTo: member.rowTo,
              colFrom: member.colFrom,
              colTo: member.colTo,
            })),
            deselected,
          });
          sections.push({
            id: row.id,
            label: row.label,
            inverterLabel: row.inverter_label,
            members,
            effectiveCount,
            rawCount,
            deselectedInside: rawCount - effectiveCount,
          });
        }
        return { strings: sections, groups: options };
      },
    );
    strings = loaded.strings;
    groups = loaded.groups;
    canWrite = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_string_member_write_gate",
      async (_tx, ctx) => !isExternalOnly(ctx) && can(ctx, "project.write"),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return null;
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  }
  if (strings.length === 0) return null;
  return (
    <PlanningStringMembersSection
      workspaceId={workspaceId}
      projectId={projectId}
      strings={strings}
      groups={groups}
      canWrite={canWrite}
    />
  );
}
