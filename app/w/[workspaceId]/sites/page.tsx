import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../_ui";
import { createSiteAction } from "./actions";

const workspaceIdSchema = z.uuid();

export default async function SitesPage({ params }: PageProps<"/w/[workspaceId]/sites">) {
  const { workspaceId } = await params;
  const validWorkspaceId = workspaceIdSchema.safeParse(workspaceId);
  if (!validWorkspaceId.success) notFound();
  const parsedWorkspaceId = validWorkspaceId.data;

  // Render-Gate (Muster rechnungen/aufgaben): Seite war ohne Auth lesbar
  // (P1-Fund DASH-VG-14). Schreiben bleibt in der Action enforced.
  try {
    await authorizedQuery(parsedWorkspaceId, "project.read", "site_form", async () => null);
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({ next: `/w/${parsedWorkspaceId}/sites` }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Standorte sind für dich nicht freigegeben." />;
    }
    throw error;
  }

  async function action(formData: FormData): Promise<void> {
    "use server";

    await createSiteAction(parsedWorkspaceId, formData);
  }

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold text-zinc-950">Standorte</h1>
        <p className="text-sm text-zinc-600">Workspace {parsedWorkspaceId}</p>
      </header>

      <form action={action} className="grid gap-4">
        <label className="grid gap-1 text-sm font-medium text-zinc-900">
          Bezeichnung
          <input
            name="label"
            className="h-10 rounded border border-zinc-300 px-3 text-sm font-normal"
            autoComplete="organization"
          />
        </label>
        <label className="grid gap-1 text-sm font-medium text-zinc-900">
          Ort
          <input
            name="city"
            className="h-10 rounded border border-zinc-300 px-3 text-sm font-normal"
            autoComplete="address-level2"
          />
        </label>
        <button
          type="submit"
          className="h-10 w-fit rounded bg-zinc-950 px-4 text-sm font-medium text-white"
        >
          Anlegen
        </button>
      </form>
    </main>
  );
}
