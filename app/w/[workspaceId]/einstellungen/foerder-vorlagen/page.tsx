import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { SubsidyTemplateDto } from "@/lib/integrations/subsidies/contract";
import { listSubsidyTemplates } from "@/modules/subsidies";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { SubsidyTemplateManager } from "./template-manager";

export const metadata: Metadata = {
  title: "Förder-Vorlagen | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function SubsidyTemplatesPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/foerder-vorlagen">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result:
    | { templates: SubsidyTemplateDto[]; canWrite: boolean }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "subsidy_template.read",
      "subsidy_template",
      async (tx, ctx) => ({
        templates: await listSubsidyTemplates(tx, ctx, { includeArchived: true }),
        canWrite: can(ctx, "subsidy_template.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/foerder-vorlagen`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Förder-Vorlagen sind für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Vorlagen konnten nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Förder-Vorlagen</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Feste Beträge oder Prozentsätze mit Deckel — das Anwenden im
          Angebot folgt in einem eigenen Schritt.
        </p>
      </div>

      <SubsidyTemplateManager
        workspaceId={workspaceId}
        templates={result.templates}
        canWrite={result.canWrite}
      />
    </main>
  );
}
