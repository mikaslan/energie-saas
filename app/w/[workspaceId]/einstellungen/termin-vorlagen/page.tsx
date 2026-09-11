import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { AppointmentTemplateDto } from "@/lib/integrations/calendar/template-contract";
import { listAppointmentTemplates } from "@/modules/calendar";
import { can, PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { AppointmentTemplateManager } from "./template-manager";

export const metadata: Metadata = {
  title: "Termin-Vorlagen | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function AppointmentTemplatesPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/termin-vorlagen">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let result:
    | { templates: AppointmentTemplateDto[]; canWrite: boolean }
    | undefined;
  try {
    result = await authorizedQuery(
      workspaceId,
      "appointment.read",
      "appointment_template",
      async (tx, ctx) => ({
        templates: await listAppointmentTemplates(tx, ctx, { includeArchived: true }),
        canWrite: can(ctx, "appointment.write"),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/termin-vorlagen`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Termin-Vorlagen sind für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!result) throw new Error("Vorlagen konnten nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Termin-Vorlagen</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Titel-Preset plus Standarddauer — das Anwenden im Projekt
          legt einen Termin mit Beginn und Kalender an (ohne Teilnehmer).
        </p>
      </div>

      <AppointmentTemplateManager
        workspaceId={workspaceId}
        templates={result.templates}
        canWrite={result.canWrite}
      />
    </main>
  );
}
