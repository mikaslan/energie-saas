// F3-02 Dachquellen-Registry: Server-Panel (Liste + Schreib-Gate laden,
// Client-Sektion rendern). Wiring-Hinweis fuer page.tsx:
// `<PlanningSourcesPanel workspaceId={workspaceId} projectId={projectId} />`.
// Rechte: project.read liest, project.write schreibt (Batch-Vertrag:
// keine neuen Permission-Keys).
import { sql } from "drizzle-orm";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { can, isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import {
  toPlanningSourceDto,
  type PlanningSourceDto,
  type PlanningSourceRow,
} from "./planning-source-model";
import { PlanningSourceSection } from "./planning-source-section";

export async function PlanningSourcesPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  let sources: PlanningSourceDto[];
  let canWrite: boolean;
  try {
    sources = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_source",
      async (tx, ctx) => {
        // F3-BATCH-1: External fail-closed (Panel rendert null via Catch).
        if (isExternalOnly(ctx)) {
          throw new PermissionDeniedError("project.read", "planning_source", undefined, ctx.actor);
        }
        const found = await tx.execute<PlanningSourceRow>(sql`
          select id, kind, storage_key, scale_ref_json, created_at
            from planning_source
           where workspace_id = ${ctx.workspaceId}::uuid
             and project_id = ${projectId}::uuid
           order by created_at, id
        `);
        const mapped: PlanningSourceDto[] = [];
        for (const row of found.rows) {
          const dto = toPlanningSourceDto(row);
          if (dto) mapped.push(dto);
        }
        return mapped;
      },
    );
    canWrite = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_source_write_gate",
      async (_tx, ctx) => !isExternalOnly(ctx) && can(ctx, "project.write"),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return null;
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  }
  return (
    <PlanningSourceSection
      workspaceId={workspaceId}
      projectId={projectId}
      sources={sources}
      canWrite={canWrite}
    />
  );
}
