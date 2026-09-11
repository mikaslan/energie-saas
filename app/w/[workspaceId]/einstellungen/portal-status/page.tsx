import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { listInstallationStatusLabels } from "@/modules/installations";
import type { InstallationStatusLabels } from "@/modules/installations";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { StatusLabelManager } from "./status-label-manager";

export const metadata: Metadata = {
  title: "Portal-Status | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function PortalStatusPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/portal-status">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result:
    | { labels: InstallationStatusLabels; canWrite: boolean }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "installation.read",
      "portal_status_label",
      async (tx, ctx) => ({
        labels: await listInstallationStatusLabels(tx, ctx),
        canWrite: can(ctx, "installation.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/portal-status`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Der Portal-Status ist für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Portal-Status konnte nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Portal-Status</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Kundenlesbare Bezeichnungen für den Installationsstand im
          Kundenportal — das Zurücksetzen stellt den Standardtext wieder her.
        </p>
      </div>

      <StatusLabelManager
        workspaceId={workspaceId}
        labels={result.labels}
        canWrite={result.canWrite}
      />
    </main>
  );
}
