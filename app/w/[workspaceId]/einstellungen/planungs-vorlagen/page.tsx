import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { PlanningTemplateDto } from "@/lib/integrations/planning/template-contract";
import { listPlanningTemplates } from "@/modules/planning";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { PlanningTemplateManager } from "./template-manager";

export const metadata: Metadata = {
  title: "Planungs-Vorlagen | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function PlanningTemplatesPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/planungs-vorlagen">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result:
    | { templates: PlanningTemplateDto[]; canWrite: boolean }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "project.read",
      "planning_template",
      async (tx, ctx) => ({
        templates: await listPlanningTemplates(tx, ctx, { includeArchived: true }),
        canWrite: can(ctx, "project.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/planungs-vorlagen`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Planungs-Vorlagen sind für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Vorlagen konnten nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-800">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Planungs-Vorlagen</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Planungsmodus-Preset (Quick, 2D oder 3D) — das Anwenden an einer
          Angebotsvariante setzt deren Planungsmodus in einem Schritt.
        </p>
      </div>

      <PlanningTemplateManager
        workspaceId={workspaceId}
        templates={result.templates}
        canWrite={result.canWrite}
      />
    </main>
  );
}
