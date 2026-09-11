import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { TaskTemplateDto } from "@/lib/integrations/tasks/template-contract";
import { listTaskTemplates } from "@/modules/tasks";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { TaskTemplateManager } from "./template-manager";

export const metadata: Metadata = {
  title: "Aufgaben-Vorlagen | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function TaskTemplatesPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/aufgaben-vorlagen">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result:
    | { templates: TaskTemplateDto[]; canWrite: boolean }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "task.read",
      "task_template",
      async (tx, ctx) => ({
        templates: await listTaskTemplates(tx, ctx, { includeArchived: true }),
        canWrite: can(ctx, "task.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/aufgaben-vorlagen`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Aufgaben-Vorlagen sind für dich nicht freigegeben." />;
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
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Aufgaben-Vorlagen</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Titel-Preset plus Fälligkeits-Offset — das Anwenden im Projekt
          legt eine Aufgabe mit dir als Bearbeiter an.
        </p>
      </div>

      <TaskTemplateManager
        workspaceId={workspaceId}
        templates={result.templates}
        canWrite={result.canWrite}
      />
    </main>
  );
}
