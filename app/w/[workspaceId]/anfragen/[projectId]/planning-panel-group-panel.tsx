// F3-04a Panel-Gruppen: Server-Panel (juengstes Dach des Projekts +
// dessen Panel-Gruppen + Schreib-Gate laden, Client-Sektion rendern). Ohne
// Dach rendert die Sektion den Anlege-Hinweis (roofId null).
// Wiring: `<PlanningPanelGroupsPanel workspaceId={workspaceId} projectId={projectId} />`.
// Rechte: project.read liest, project.write schreibt (Batch-Vertrag).
// Muster: planning-roof-restriction-panel.tsx.
// F3-04c: reichert je Gruppe collisions (Sperrzonen desselben Dachs,
// Rechteck-Ebene via panel-collision-Contract) + deselectedCount an.
import { sql } from "drizzle-orm";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import {
  groupRect,
  groupRestrictionCollisions,
} from "@/lib/integrations/planning/contracts";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import {
  toPlanningPanelGroupDto,
  type PlanningPanelGroupCollision,
  type PlanningPanelGroupDto,
  type PlanningPanelGroupRow,
} from "./planning-panel-group-model";
import {
  planningRoofRestrictionRect,
  type PlanningRoofRestrictionRect,
} from "./planning-roof-restriction-model";
import { PlanningPanelGroupSection } from "./planning-panel-group-section";

type CollisionRestrictionInput = {
  id: string;
  kind: string;
  label: string;
  rect: PlanningRoofRestrictionRect;
};

// F3-04c: Gruppen-Rechteck (Contract groupRect) vs. Restriction-Rechtecke
// desselben Dachs (Contract groupRestrictionCollisions) — reine
// Contract-Ableitung, kein eigenes Rechteck-Duplikat. Fail-open fuer die
// Anzeige: ungueltige Geometrie meldet keine Kollision (advisory-only).
function groupCollisions(
  group: PlanningPanelGroupDto,
  restrictions: CollisionRestrictionInput[],
): PlanningPanelGroupCollision[] {
  if (restrictions.length === 0) return [];
  try {
    const rect = groupRect({
      origin: group.origin,
      rows: group.rows,
      cols: group.cols,
      moduleWM: group.moduleWM,
      moduleHM: group.moduleHM,
      gapM: group.gapM,
    });
    const hits = groupRestrictionCollisions({
      group: { id: group.id, rect },
      restrictions,
    });
    return hits.map((hit) => ({
      restrictionId: hit.restrictionId,
      kind: hit.kind,
      label: hit.label,
    }));
  } catch {
    return [];
  }
}

export async function PlanningPanelGroupsPanel({
  workspaceId,
  projectId,
  planningMode,
}: {
  workspaceId: string;
  projectId: string;
  planningMode?: "quick" | "2d" | "3d";
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
        // F3-04c: Sperrzonen desselben Dachs (Kollisions-Gegenueber) +
        // Abwahl-Counts je Gruppe (Deselect-Hinweis).
        const foundRestrictions = await tx.execute<{
          id: string;
          kind: string;
          label: string;
          rect_json: unknown;
        }>(sql`
          select id, kind, label, rect_json
            from planning_roof_restriction
           where workspace_id = ${ctx.workspaceId}::uuid
             and roof_id = ${resolvedRoofId}::uuid
        `);
        const restrictions: CollisionRestrictionInput[] = [];
        for (const row of foundRestrictions.rows) {
          const rect = planningRoofRestrictionRect(row.rect_json);
          if (!rect) continue;
          if (typeof row.kind !== "string" || typeof row.label !== "string") continue;
          if (row.label.length < 1) continue;
          restrictions.push({ id: row.id, kind: row.kind, label: row.label, rect });
        }
        const foundDeselects = await tx.execute<{ group_id: string; count: string }>(sql`
          select deselect.group_id as group_id, count(*) as count
            from planning_panel_deselect as deselect
            join planning_panel_group as panel_group
              on panel_group.workspace_id = deselect.workspace_id
             and panel_group.id = deselect.group_id
           where deselect.workspace_id = ${ctx.workspaceId}::uuid
             and panel_group.roof_id = ${resolvedRoofId}::uuid
           group by deselect.group_id
        `);
        const deselectedByGroup = new Map<string, number>();
        for (const row of foundDeselects.rows) {
          const parsed = Number.parseInt(row.count, 10);
          if (Number.isFinite(parsed)) {
            deselectedByGroup.set(row.group_id.toLowerCase(), parsed);
          }
        }
        const groups: PlanningPanelGroupDto[] = [];
        for (const row of found.rows) {
          const dto = toPlanningPanelGroupDto(row);
          if (!dto) continue;
          dto.collisions = groupCollisions(dto, restrictions);
          dto.deselectedCount = deselectedByGroup.get(dto.id.toLowerCase()) ?? 0;
          groups.push(dto);
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
      planningMode={planningMode}
    />
  );
}
