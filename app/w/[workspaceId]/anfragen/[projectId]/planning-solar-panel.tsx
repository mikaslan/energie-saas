// F3-06a Sonnenstands-Anzeige: Server-Panel (Standort-Koordinaten aus
// der Projekt-Site laden, Client-Sektion rendern). Kein Schreib-Gate
// nötig (reine Anzeige); External fail-closed wie Batch-1.
// Wiring: `<PlanningSolarPanel workspaceId={workspaceId} projectId={projectId} />`.
import { sql } from "drizzle-orm";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { isExternalOnly, PermissionDeniedError } from "@/lib/permissions";
import { PlanningSolarSection } from "./planning-solar-section";

export async function PlanningSolarPanel({
  workspaceId,
  projectId,
}: {
  workspaceId: string;
  projectId: string;
}) {
  let coords: { latitude: number | null; longitude: number | null };
  try {
    coords = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_solar",
      async (tx, ctx) => {
        if (isExternalOnly(ctx)) {
          throw new PermissionDeniedError("project.read", "planning_solar", undefined, ctx.actor);
        }
        const found = await tx.execute<{ lat: number | null; lng: number | null }>(sql`
          select site_record.lat as lat, site_record.lng as lng
            from project as project_record
            join site as site_record
              on site_record.workspace_id = project_record.workspace_id
             and site_record.id = project_record.site_id
           where project_record.workspace_id = ${ctx.workspaceId}::uuid
             and project_record.id = ${projectId}::uuid
        `);
        const row = found.rows[0] ?? null;
        const latitude = row?.lat ?? null;
        const longitude = row?.lng ?? null;
        return {
          latitude: typeof latitude === "number" && Number.isFinite(latitude) ? latitude : null,
          longitude:
            typeof longitude === "number" && Number.isFinite(longitude) ? longitude : null,
        };
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return null;
    if (error instanceof PermissionDeniedError) return null;
    throw error;
  }
  return <PlanningSolarSection latitude={coords.latitude} longitude={coords.longitude} />;
}
