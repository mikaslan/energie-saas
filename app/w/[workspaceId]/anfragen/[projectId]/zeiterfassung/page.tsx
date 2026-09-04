import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type {
  TimeEntryListDto,
  TimeEventTypeDto,
} from "@/lib/integrations/time-tracking/contract";
import { listTimeEntries, listTimeEventTypes } from "@/modules/time-tracking";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { sql } from "drizzle-orm";
import { DeniedState } from "../_ui";
import { TimeEntryManager } from "./time-entry-manager";

export const metadata: Metadata = {
  title: "Zeiterfassung | Energie-SaaS",
};

const routeParamsSchema = z.object({
  workspaceId: z.uuid(),
  projectId: z.uuid(),
});

export default async function ProjectTimeTrackingPage(
  props: PageProps<"/w/[workspaceId]/anfragen/[projectId]/zeiterfassung">,
) {
  const params = routeParamsSchema.safeParse(await props.params);
  if (!params.success) notFound();
  const { workspaceId, projectId } = params.data;

  let result:
    | { projectName: string; list: TimeEntryListDto; types: TimeEventTypeDto[]; canWrite: boolean }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "time.read",
      "time_tracking",
      async (tx, ctx) => {
        // Permission-Gate ZUERST: listTimeEntries wirft fuer externe Nutzer
        // (time.read ist internalOnly) PermissionDeniedError — der rohe
        // Projekt-Lookup wuerde zuvor durch die restriktive M1-09-Policy
        // (project_external_select_scope) leer laufen und faelschlich die
        // 404-Projektseite rendern.
        const list = await listTimeEntries(tx, ctx, { projectId });
        const projectRow = await tx.execute<{ name: string }>(sql`
          select name from project
           where workspace_id = ${ctx.workspaceId}::uuid
             and id = ${projectId}::uuid
           limit 1
        `);
        if (!projectRow.rows[0]) {
          throw new ProjectNotFound();
        }
        return {
          projectName: projectRow.rows[0].name,
          list,
          types: await listTimeEventTypes(tx, ctx, { includeArchived: true }),
          canWrite: can(ctx, "time.write"),
        };
      },
    );
  } catch (error) {
    if (error instanceof ProjectNotFound) notFound();
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/anfragen/${projectId}/zeiterfassung`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Zeiterfassung ist für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Zeiterfassung konnte nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          Projektakte
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Zeiterfassung</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Arbeitszeiten am Projekt „{result.projectName}“.
        </p>
      </div>

      <TimeEntryManager
        workspaceId={workspaceId}
        projectId={projectId}
        list={result.list}
        types={result.types}
        canWrite={result.canWrite}
      />

      <div className="mt-6">
        <Link
          href={`/w/${workspaceId}/anfragen/${projectId}`}
          className="text-sm font-semibold text-blue-700 underline-offset-2 hover:underline"
        >
          Zurück zur Projektakte
        </Link>
      </div>
    </main>
  );
}

class ProjectNotFound extends Error {
  constructor() {
    super("project not found");
    this.name = "ProjectNotFound";
  }
}
