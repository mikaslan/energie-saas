// F3-05b String-Equipment: Server-Panel (Strings + Projekt-Gruppen +
// Equipment laden, Advisory ableiten, Client-Sektion rendern).
// Wiring: `<PlanningStringEquipmentPanel workspaceId={workspaceId} projectId={projectId} />`.
// Rechte: project.read liest, project.write schreibt (Batch-Vertrag).
// Muster: planning-string-panel.tsx.
import { sql } from "drizzle-orm";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import { stringEquipmentAdvisories } from "@/lib/integrations/planning/contracts/string-equipment";
import { planningStringMemberGroupIds } from "./planning-string-model";
import {
  toPlanningStringEquipmentDto,
  type PlanningStringEquipmentListItem,
  type PlanningStringEquipmentRow,
  type PlanningStringEquipmentStringOption,
} from "./planning-string-equipment-model";
import { PlanningStringEquipmentSection } from "./planning-string-equipment-section";

type EquipmentStringRow = {
  id: string;
  label: string;
  member_json: unknown;
};

type ProjectGroupRow = {
  id: string;
  label: string;
  rows: number;
  cols: number;
};

type EquipmentListRow = PlanningStringEquipmentRow & {
  string_label: string;
};

export async function PlanningStringEquipmentPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  let strings: PlanningStringEquipmentStringOption[];
  let equipment: PlanningStringEquipmentListItem[];
  let advisories: { code: "partial-coverage"; message: string }[];
  let canWrite: boolean;
  try {
    const loaded = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_string_equipment",
      async (tx, ctx) => {
        // F3-05b: External fail-closed (Panel rendert null via Catch).
        if (isExternalOnly(ctx)) {
          throw new PermissionDeniedError(
            "project.read",
            "planning_string_equipment",
            undefined,
            ctx.actor,
          );
        }
        const foundStrings = await tx.execute<EquipmentStringRow>(sql`
          select str.id as id, str.label as label, str.member_json as member_json
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
        const foundEquipment = await tx.execute<EquipmentListRow>(sql`
          select equipment.id as id, equipment.string_id as string_id,
                 equipment.scope as scope,
                 equipment.panel_ref_json as panel_ref_json,
                 equipment.equipment as equipment,
                 equipment.created_at as created_at,
                 str.label as string_label
            from planning_string_equipment as equipment
            join planning_string as str
              on str.workspace_id = equipment.workspace_id
             and str.id = equipment.string_id
            join planning_inverter as inverter
              on inverter.workspace_id = str.workspace_id
             and inverter.id = str.inverter_id
           where equipment.workspace_id = ${ctx.workspaceId}::uuid
             and inverter.project_id = ${projectId}::uuid
           order by equipment.created_at, equipment.id
        `);
        const byId = new Map(foundGroups.rows.map((group) => [group.id.toLowerCase(), group]));
        const options: PlanningStringEquipmentStringOption[] = [];
        for (const row of foundStrings.rows) {
          if (typeof row.label !== "string" || row.label.length < 1) continue;
          const memberIds = planningStringMemberGroupIds(row.member_json);
          if (!memberIds) continue;
          options.push({
            id: row.id,
            label: row.label,
            memberGroups: memberIds.flatMap((id) => {
              const group = byId.get(id);
              return group ? [{ id: group.id, label: group.label }] : [];
            }),
          });
        }
        const items: PlanningStringEquipmentListItem[] = [];
        for (const row of foundEquipment.rows) {
          const dto = toPlanningStringEquipmentDto(row);
          if (!dto || typeof row.string_label !== "string" || row.string_label.length < 1) {
            continue;
          }
          const groupLabel = dto.panelRef
            ? (byId.get(dto.panelRef.groupId)?.label ?? null)
            : null;
          items.push({
            id: dto.id,
            stringId: dto.stringId,
            stringLabel: row.string_label,
            scope: dto.scope,
            equipment: dto.equipment,
            groupLabel,
            row: dto.panelRef ? dto.panelRef.row : null,
            col: dto.panelRef ? dto.panelRef.col : null,
          });
        }
        // Advisory-Bezugsgröße: Module aller verstringten Gruppen
        // (dedupliziert); Mikro-Teilabdeckung → Warnung, nie Reject.
        const memberIds = new Set<string>();
        for (const row of foundStrings.rows) {
          const parsed = planningStringMemberGroupIds(row.member_json);
          if (parsed) for (const id of parsed) memberIds.add(id);
        }
        let moduleCount = 0;
        for (const id of memberIds) {
          const group = byId.get(id);
          if (group) moduleCount += group.rows * group.cols;
        }
        const microCount = items.filter((item) => item.equipment === "micro_inverter").length;
        return {
          strings: options,
          equipment: items,
          advisories: stringEquipmentAdvisories({ microCount, moduleCount }),
        };
      },
    );
    strings = loaded.strings;
    equipment = loaded.equipment;
    advisories = loaded.advisories;
    canWrite = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_string_equipment_write_gate",
      async (_tx, ctx) => !isExternalOnly(ctx) && can(ctx, "project.write"),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return null;
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  }
  return (
    <PlanningStringEquipmentSection
      workspaceId={workspaceId}
      projectId={projectId}
      strings={strings}
      equipment={equipment}
      advisories={advisories}
      canWrite={canWrite}
    />
  );
}
