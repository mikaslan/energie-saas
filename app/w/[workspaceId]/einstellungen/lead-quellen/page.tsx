import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { LeadSourceDto } from "@/lib/integrations/lead-sources/contract";
import { listLeadSources } from "@/modules/lead-sources";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { LeadSourceManager } from "./lead-source-manager";

export const metadata: Metadata = {
  title: "Lead-Quellen | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function LeadSourcesPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/lead-quellen">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result: { sources: LeadSourceDto[]; canWrite: boolean } | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "lead_source.read",
      "lead_source",
      async (tx, ctx) => ({
        sources: await listLeadSources(tx, ctx, { includeArchived: true }),
        // Explizit vom Server: eine leere Liste trägt sonst keine
        // Schreibrechts-Auskunft in sich.
        canWrite: can(ctx, "lead_source.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/lead-quellen`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Lead-Quellen sind für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Lead-Quellen konnten nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Lead-Quellen</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Herkunft deiner Anfragen — Quellen mit passendem Namen werden
          eingehenden Leads automatisch zugeordnet.
        </p>
      </div>

      <LeadSourceManager
        workspaceId={workspaceId}
        sources={result.sources}
        canWrite={result.canWrite}
      />

      <div className="mt-6">
        <Link
          href={`/w/${workspaceId}/einstellungen/wirtschaftlichkeit`}
          className="text-sm font-semibold text-blue-700 underline-offset-2 hover:underline"
        >
          Zur Wirtschaftlichkeit
        </Link>
      </div>
    </main>
  );
}
