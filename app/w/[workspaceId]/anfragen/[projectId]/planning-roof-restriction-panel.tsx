// F3-03b Dach-Sperrzonen: Server-Panel (juengstes Dach des Projekts +
// dessen Sperrzonen + Schreib-Gate laden, Client-Sektion rendern). Ohne
// Dach rendert die Sektion den Anlege-Hinweis (roofId null).
// Wiring: `<PlanningRoofRestrictionsPanel workspaceId={workspaceId} projectId={projectId} />`.
// Rechte: project.read liest, project.write schreibt (Batch-Vertrag).
// F3-04c: reichert je Sperrzone collidingGroups (Panel-Gruppen desselben
// Dachs, Rechteck-Ebene via panel-collision-Contract) symmetrisch an.
import { sql } from "drizzle-orm";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import {
  groupRect,
  groupRestrictionCollisions,
} from "@/lib/integrations/planning/contracts";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import {
  toPlanningPanelGroupDto,
  type PlanningPanelGroupDto,
  type PlanningPanelGroupRow,
} from "./planning-panel-group-model";
import {
  toPlanningRoofRestrictionDto,
  type PlanningRoofRestrictionCollidingGroup,
  type PlanningRoofRestrictionDto,
  type PlanningRoofRestrictionRow,
} from "./planning-roof-restriction-model";
import { PlanningRoofRestrictionSection } from "./planning-roof-restriction-section";

// F3-04c: je Gruppe Contract-Ableitung (groupRect +
// groupRestrictionCollisions), invertiert auf Sperrzonen-Ebene — kein
// eigenes Rechteck-Duplikat. Fail-open: ungueltige Geometrie meldet
// keine Kollision (advisory-only).
function collidingGroupsByRestriction(
  groups: PlanningPanelGroupDto[],
  restrictions: PlanningRoofRestrictionDto[],
): Map<string, PlanningRoofRestrictionCollidingGroup[]> {
  const byRestriction = new Map<string, PlanningRoofRestrictionCollidingGroup[]>();
  if (restrictions.length === 0) return byRestriction;
  const inputs = restrictions.map((restriction) => ({
    id: restriction.id,
    kind: restriction.kind,
    label: restriction.label,
    rect: restriction.rect,
  }));
  for (const group of groups) {
    try {
      const hits = groupRestrictionCollisions({
        group: {
          id: group.id,
          rect: groupRect({
            origin: group.origin,
            rows: group.rows,
            cols: group.cols,
            moduleWM: group.moduleWM,
            moduleHM: group.moduleHM,
            gapM: group.gapM,
          }),
        },
        restrictions: inputs,
      });
      for (const hit of hits) {
        const key = hit.restrictionId.toLowerCase();
        const list = byRestriction.get(key) ?? [];
        list.push({ groupId: group.id, label: group.label });
        byRestriction.set(key, list);
      }
    } catch {
      continue;
    }
  }
  return byRestriction;
}

export async function PlanningRoofRestrictionsPanel({
  workspaceId,
  projectId,
  planningMode,
}: {
  workspaceId: string;
  projectId: string;
  planningMode?: "quick" | "2d" | "3d";
}) {
  let roofId: string | null;
  let initialRestrictions: PlanningRoofRestrictionDto[];
  let canWrite: boolean;
  try {
    const loaded = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_roof_restriction",
      async (tx, ctx) => {
        // F3-03b: External fail-closed (Panel rendert null via Catch).
        if (isExternalOnly(ctx)) {
          throw new PermissionDeniedError("project.read", "planning_roof_restriction", undefined, ctx.actor);
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
        if (resolvedRoofId === null) return { roofId: null, restrictions: [] };
        const found = await tx.execute<PlanningRoofRestrictionRow>(sql`
          select id, roof_id, kind, label, rect_json, height_m, created_at
            from planning_roof_restriction
           where workspace_id = ${ctx.workspaceId}::uuid
             and roof_id = ${resolvedRoofId}::uuid
           order by created_at, id
        `);
        const restrictions: PlanningRoofRestrictionDto[] = [];
        for (const row of found.rows) {
          const dto = toPlanningRoofRestrictionDto(row);
          if (dto) restrictions.push(dto);
        }
        // F3-04c: Panel-Gruppen desselben Dachs (Kollisions-Gegenueber).
        const foundGroups = await tx.execute<PlanningPanelGroupRow>(sql`
          select id, roof_id, kind, label, origin_json,
                 rows, cols, module_w_m, module_h_m, gap_m, tilt_deg, created_at
            from planning_panel_group
           where workspace_id = ${ctx.workspaceId}::uuid
             and roof_id = ${resolvedRoofId}::uuid
           order by created_at, id
        `);
        const groups: PlanningPanelGroupDto[] = [];
        for (const row of foundGroups.rows) {
          const dto = toPlanningPanelGroupDto(row);
          if (dto) groups.push(dto);
        }
        const colliding = collidingGroupsByRestriction(groups, restrictions);
        for (const restriction of restrictions) {
          restriction.collidingGroups =
            colliding.get(restriction.id.toLowerCase()) ?? [];
        }
        return { roofId: resolvedRoofId, restrictions };
      },
    );
    roofId = loaded.roofId;
    initialRestrictions = loaded.restrictions;
    canWrite = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_roof_restriction_write_gate",
      async (_tx, ctx) => !isExternalOnly(ctx) && can(ctx, "project.write"),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return null;
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  }
  return (
    <PlanningRoofRestrictionSection
      workspaceId={workspaceId}
      projectId={projectId}
      roofId={roofId}
      initialRestrictions={initialRestrictions}
      canWrite={canWrite}
      planningMode={planningMode}
    />
  );
}
