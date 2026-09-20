// F3-03 Dach-Minimal: Server-Panel (Quelle + Dach + Schreib-Gate laden,
// Client-Sektion rendern). Jüngste Quelle des Projekts + deren jüngstes
// Dach; ohne Quelle rendert die Sektion den Anlege-Hinweis (sourceId null).
// Wiring: `<PlanningRoofsPanel workspaceId={workspaceId} projectId={projectId} />`.
// Rechte: project.read liest, project.write schreibt (Batch-Vertrag).
import { sql } from "drizzle-orm";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import {
  toPlanningRoofDto,
  type PlanningRoofDto,
  type PlanningRoofRow,
} from "./planning-roof-model";
import { PlanningRoofSection } from "./planning-roof-section";

export async function PlanningRoofsPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  let sourceId: string | null;
  let initialRoof: PlanningRoofDto | null;
  let canWrite: boolean;
  try {
    const loaded = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_roof_min",
      async (tx, ctx) => {
        // F3-BATCH-1: External fail-closed (Panel rendert null via Catch).
        if (isExternalOnly(ctx)) {
          throw new PermissionDeniedError("project.read", "planning_roof_min", undefined, ctx.actor);
        }
        const foundSource = await tx.execute<{ id: string }>(sql`
          select id from planning_source
           where workspace_id = ${ctx.workspaceId}::uuid
             and project_id = ${projectId}::uuid
           order by created_at desc, id desc
           limit 1
        `);
        const resolvedSourceId = foundSource.rows[0]?.id ?? null;
        if (resolvedSourceId === null) return { sourceId: null, roof: null };
        const foundRoof = await tx.execute<PlanningRoofRow>(sql`
          select id, source_id, polygon_json, tilt_per_edge_json,
                 flat_single_tilt, created_at
            from planning_roof_min
           where workspace_id = ${ctx.workspaceId}::uuid
             and source_id = ${resolvedSourceId}::uuid
           order by created_at desc, id desc
           limit 1
        `);
        const row = foundRoof.rows[0] ?? null;
        return { sourceId: resolvedSourceId, roof: row ? toPlanningRoofDto(row) : null };
      },
    );
    sourceId = loaded.sourceId;
    initialRoof = loaded.roof;
    canWrite = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_roof_min_write_gate",
      async (_tx, ctx) => !isExternalOnly(ctx) && can(ctx, "project.write"),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return null;
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  }
  return (
    <PlanningRoofSection
      workspaceId={workspaceId}
      projectId={projectId}
      sourceId={sourceId}
      initialRoof={initialRoof}
      canWrite={canWrite}
    />
  );
}
