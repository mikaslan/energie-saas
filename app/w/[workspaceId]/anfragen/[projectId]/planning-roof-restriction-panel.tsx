// F3-03b Dach-Sperrzonen: Server-Panel (juengstes Dach des Projekts +
// dessen Sperrzonen + Schreib-Gate laden, Client-Sektion rendern). Ohne
// Dach rendert die Sektion den Anlege-Hinweis (roofId null).
// Wiring: `<PlanningRoofRestrictionsPanel workspaceId={workspaceId} projectId={projectId} />`.
// Rechte: project.read liest, project.write schreibt (Batch-Vertrag).
import { sql } from "drizzle-orm";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import {
  toPlanningRoofRestrictionDto,
  type PlanningRoofRestrictionDto,
  type PlanningRoofRestrictionRow,
} from "./planning-roof-restriction-model";
import { PlanningRoofRestrictionSection } from "./planning-roof-restriction-section";

export async function PlanningRoofRestrictionsPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
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
    />
  );
}
