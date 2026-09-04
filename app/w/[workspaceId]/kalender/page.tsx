import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { CalendarItemV1 } from "@/lib/integrations/calendar/contract";
import { listVisibleCalendars } from "@/modules/calendar";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../_ui";
import { CalendarManager } from "./calendar-manager";

export const metadata: Metadata = {
  title: "Kalender | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function WorkspaceCalendarsPage(
  props: PageProps<"/w/[workspaceId]/kalender">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result: { calendars: CalendarItemV1[]; canWrite: boolean } | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "calendar.read",
      "calendar",
      async (tx, ctx) => ({
        calendars: await listVisibleCalendars(tx, ctx),
        canWrite: can(ctx, "calendar.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/kalender`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Kalender sind für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Kalender konnten nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          Workspace
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Kalender</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Unternehmens- und persönliche Kalender dieses Workspace.
        </p>
      </div>

      <CalendarManager
        workspaceId={workspaceId}
        calendars={result.calendars}
        canWrite={result.canWrite}
      />
    </main>
  );
}
