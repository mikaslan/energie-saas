import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type {
  TimeEntryListDto,
  TimeEventTypeDto,
} from "@/lib/integrations/time-tracking/contract";
import {
  listProjectlessTimeEntries,
  listTimeEventTypes,
} from "@/modules/time-tracking";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../_ui";
import { ProjectlessTimeManager } from "./projectless-time-manager";

export const metadata: Metadata = {
  title: "Zeiterfassung ohne Projekt | Energie-SaaS",
};

const routeParamsSchema = z.object({
  workspaceId: z.uuid(),
});

// F9-14: Workspace-Heimat projektloser Einträge (strikte Trennung von den
// Projektseiten) — Liste + Anlage + Stoppuhr, online. Muster: Projekt-
// Zeiterfassungsseite (gleiche Reads, gleiche Permission-Schranken).
export default async function ProjectlessTimeTrackingPage(
  props: PageProps<"/w/[workspaceId]/zeiterfassung-ohne-projekt">,
) {
  const params = routeParamsSchema.safeParse(await props.params);
  if (!params.success) notFound();
  const { workspaceId } = params.data;

  let result:
    | { list: TimeEntryListDto; types: TimeEventTypeDto[]; canWrite: boolean }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "time.read",
      "time_tracking",
      async (tx, ctx) => {
        const list = await listProjectlessTimeEntries(tx, ctx, {});
        const types = await listTimeEventTypes(tx, ctx);
        return { list, types, canWrite: can(ctx, "time.write") };
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/zeiterfassung-ohne-projekt`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Zeiterfassung ist für dich nicht freigegeben." />;
    }
    throw error;
  }
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <h1 className="text-2xl font-semibold tracking-tight text-slate-950">
        Zeiterfassung ohne Projekt
      </h1>
      <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
        Zeiten ohne Projektbezug — strikt getrennt von den Projektseiten.
      </p>
      <div className="mt-6">
        <ProjectlessTimeManager
          workspaceId={workspaceId}
          list={result.list}
          types={result.types}
          canWrite={result.canWrite}
        />
      </div>
    </main>
  );
}
