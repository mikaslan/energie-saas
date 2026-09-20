// F3-04b Einzelmodul-Abwahl: Server-Panel (juengstes Dach des Projekts
// + dessen Panel-Gruppen + Abwahlen laden, Effektiv-Count ableiten,
// Client-Sektion rendern). Scope folgt der Panelgruppen-Sektion
// (juengstes Dach), damit Count und Liste zur selben Gruppe gehoeren.
// Wiring: `<PlanningPanelDeselectPanel workspaceId={workspaceId} projectId={projectId} />`.
// Rechte: project.read liest, project.write schreibt (Batch-Vertrag).
// Muster: planning-string-equipment-panel.tsx.
import { sql } from "drizzle-orm";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import { deselectedEffectiveCount } from "@/lib/integrations/planning/contracts/panel-deselect";
import {
  toPlanningPanelDeselectDto,
  type PlanningPanelDeselectGroupOption,
  type PlanningPanelDeselectListItem,
  type PlanningPanelDeselectRow,
} from "./planning-panel-deselect-model";
import { PlanningPanelDeselectSection } from "./planning-panel-deselect-section";

type ProjectGroupRow = {
  id: string;
  label: string;
  rows: number;
  cols: number;
};

export async function PlanningPanelDeselectPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  let groups: PlanningPanelDeselectGroupOption[];
  let deselects: PlanningPanelDeselectListItem[];
  let effectiveCount: number;
  let canWrite: boolean;
  try {
    const loaded = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_panel_deselect",
      async (tx, ctx) => {
        // F3-04b: External fail-closed (Panel rendert null via Catch).
        if (isExternalOnly(ctx)) {
          throw new PermissionDeniedError(
            "project.read",
            "planning_panel_deselect",
            undefined,
            ctx.actor,
          );
        }
        const foundRoof = await tx.execute<{ id: string }>(sql`
          select roof.id as id
            from planning_roof_min as roof
            join planning_source as source
              on source.workspace_id = roof.workspace_id
             and source.id = roof.source_id
           where roof.workspace_id = ${ctx.workspaceId}::uuid
             and source.project_id = ${projectId}::uuid
           order by roof.created_at desc, roof.id desc
           limit 1
        `);
        const resolvedRoofId = foundRoof.rows[0]?.id ?? null;
        if (resolvedRoofId === null) {
          return {
            groups: [],
            deselects: [],
            effectiveCount: 0,
          };
        }
        const foundGroups = await tx.execute<ProjectGroupRow>(sql`
          select panel_group.id as id, panel_group.label as label,
                 panel_group.rows as rows, panel_group.cols as cols
            from planning_panel_group as panel_group
           where panel_group.workspace_id = ${ctx.workspaceId}::uuid
             and panel_group.roof_id = ${resolvedRoofId}::uuid
           order by panel_group.created_at, panel_group.id
        `);
        const foundDeselects = await tx.execute<PlanningPanelDeselectRow>(sql`
          select deselect.id as id, deselect.group_id as group_id,
                 deselect."row" as "row", deselect."col" as "col",
                 deselect.reason as reason, deselect.created_at as created_at
            from planning_panel_deselect as deselect
            join planning_panel_group as panel_group
              on panel_group.workspace_id = deselect.workspace_id
             and panel_group.id = deselect.group_id
           where deselect.workspace_id = ${ctx.workspaceId}::uuid
             and panel_group.roof_id = ${resolvedRoofId}::uuid
           order by deselect.created_at, deselect.id
        `);
        const options: PlanningPanelDeselectGroupOption[] = [];
        for (const row of foundGroups.rows) {
          if (typeof row.label !== "string" || row.label.length < 1) continue;
          if (!Number.isInteger(row.rows) || row.rows < 1) continue;
          if (!Number.isInteger(row.cols) || row.cols < 1) continue;
          options.push({ id: row.id, label: row.label, rows: row.rows, cols: row.cols });
        }
        const byId = new Map(options.map((group) => [group.id.toLowerCase(), group]));
        const items: PlanningPanelDeselectListItem[] = [];
        const deselectedByGroup = new Map<string, number>();
        for (const row of foundDeselects.rows) {
          const dto = toPlanningPanelDeselectDto(row);
          if (!dto) continue;
          const group = byId.get(dto.groupId);
          if (!group) continue;
          deselectedByGroup.set(
            dto.groupId,
            (deselectedByGroup.get(dto.groupId) ?? 0) + 1,
          );
          items.push({
            id: dto.id,
            groupId: dto.groupId,
            groupLabel: group.label,
            row: dto.row,
            col: dto.col,
            reason: dto.reason,
          });
        }
        let total = 0;
        for (const group of options) {
          total += deselectedEffectiveCount({
            rows: group.rows,
            cols: group.cols,
            deselected: deselectedByGroup.get(group.id.toLowerCase()) ?? 0,
          });
        }
        return { groups: options, deselects: items, effectiveCount: total };
      },
    );
    groups = loaded.groups;
    deselects = loaded.deselects;
    effectiveCount = loaded.effectiveCount;
    canWrite = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_panel_deselect_write_gate",
      async (_tx, ctx) => !isExternalOnly(ctx) && can(ctx, "project.write"),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return null;
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  }
  return (
    <PlanningPanelDeselectSection
      workspaceId={workspaceId}
      projectId={projectId}
      groups={groups}
      deselects={deselects}
      effectiveCount={effectiveCount}
      canWrite={canWrite}
    />
  );
}
