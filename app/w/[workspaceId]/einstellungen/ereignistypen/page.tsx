import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { TimeEventTypeDto } from "@/lib/integrations/time-tracking/contract";
import { listTimeEventTypes } from "@/modules/time-tracking";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { TimeEventTypeManager } from "./time-event-type-manager";

export const metadata: Metadata = {
  title: "Ereignistypen | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function TimeEventTypesPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/ereignistypen">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result: { types: TimeEventTypeDto[]; canWrite: boolean } | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "time.read",
      "time_tracking",
      async (tx, ctx) => ({
        types: await listTimeEventTypes(tx, ctx, { includeArchived: true }),
        canWrite: can(ctx, "time.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/ereignistypen`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Ereignistypen sind für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Ereignistypen konnten nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Ereignistypen</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Ereignistypen für die Zeiterfassung im gesamten Workspace.
        </p>
      </div>

      <TimeEventTypeManager workspaceId={workspaceId} types={result.types} canWrite={result.canWrite} />

      <div className="mt-6">
        <Link
          href={`/w/${workspaceId}/einstellungen/lead-quellen`}
          className="text-sm font-semibold text-blue-700 underline-offset-2 hover:underline"
        >
          Zu den Lead-Quellen
        </Link>
      </div>
    </main>
  );
}
