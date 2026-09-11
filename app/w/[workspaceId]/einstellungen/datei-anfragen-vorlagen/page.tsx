import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { FileRequestTemplateDto } from "@/lib/file-request-template";
import { listFileRequestTemplates } from "@/modules/file-requests";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { FileRequestTemplateManager } from "./template-manager";

export const metadata: Metadata = {
  title: "Datei-Anfragen-Vorlagen | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function FileRequestTemplatesPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/datei-anfragen-vorlagen">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result:
    | { templates: FileRequestTemplateDto[]; canWrite: boolean }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "project.read",
      "file_request_template",
      async (tx, ctx) => ({
        templates: await listFileRequestTemplates(tx, ctx, { includeArchived: true }),
        canWrite: can(ctx, "project.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/datei-anfragen-vorlagen`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Datei-Anfragen-Vorlagen sind für dich nicht freigegeben." />;
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
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Datei-Anfragen-Vorlagen</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Titel-Preset plus optionale Beschreibung — das Anwenden im Projekt
          legt eine offene Datei-Anfrage an (ohne Akten-Verknüpfung).
        </p>
      </div>

      <FileRequestTemplateManager
        workspaceId={workspaceId}
        templates={result.templates}
        canWrite={result.canWrite}
      />
    </main>
  );
}
