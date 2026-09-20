// F3-04a Panel-Gruppen: Server-Panel (juengstes Dach des Projekts +
// dessen Panel-Gruppen + Schreib-Gate laden, Client-Sektion rendern). Ohne
// Dach rendert die Sektion den Anlege-Hinweis (roofId null).
// Wiring: `<PlanningPanelGroupsPanel workspaceId={workspaceId} projectId={projectId} />`.
// Rechte: project.read liest, project.write schreibt (Batch-Vertrag).
// Muster: planning-roof-restriction-panel.tsx.
import { sql } from "drizzle-orm";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import {
  toPlanningPanelGroupDto,
  type PlanningPanelGroupDto,
  type PlanningPanelGroupRow,
} from "./planning-panel-group-model";
import { PlanningPanelGroupSection } from "./planning-panel-group-section";

export async function PlanningPanelGroupsPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  let roofId: string | null;
  let initialGroups: PlanningPanelGroupDto[];
  let canWrite: boolean;
  try {
    const loaded = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_panel_group",
      async (tx, ctx) => {
        // F3-04a: External fail-closed (Panel rendert null via Catch).
        if (isExternalOnly(ctx)) {
          throw new PermissionDeniedError("project.read", "planning_panel_group", undefined, ctx.actor);
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
        if (resolvedRoofId === null) return { roofId: null, groups: [] };
        const found = await tx.execute<PlanningPanelGroupRow>(sql`
          select id, roof_id, kind, label, origin_json,
                 rows, cols, module_w_m, module_h_m, gap_m, tilt_deg, created_at
            from planning_panel_group
           where workspace_id = ${ctx.workspaceId}::uuid
             and roof_id = ${resolvedRoofId}::uuid
           order by created_at, id
        `);
        const groups: PlanningPanelGroupDto[] = [];
        for (const row of found.rows) {
          const dto = toPlanningPanelGroupDto(row);
          if (dto) groups.push(dto);
        }
        return { roofId: resolvedRoofId, groups };
      },
    );
    roofId = loaded.roofId;
    initialGroups = loaded.groups;
    canWrite = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_panel_group_write_gate",
      async (_tx, ctx) => !isExternalOnly(ctx) && can(ctx, "project.write"),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return null;
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  }
  return (
    <PlanningPanelGroupSection
      workspaceId={workspaceId}
      projectId={projectId}
      roofId={roofId}
      initialGroups={initialGroups}
      canWrite={canWrite}
    />
  );
}
