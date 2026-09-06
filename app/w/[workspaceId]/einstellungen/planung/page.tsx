import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { PlanningSettingsV1 } from "@/lib/integrations/planning/contract";
import { PermissionDeniedError } from "@/lib/permissions";
import { getPlanningSettings } from "@/modules/planning";
import { DeniedState } from "../../_ui";
import { PlanningSettingsForm } from "./planning-settings-form";

export const metadata: Metadata = {
  title: "Planung | Energie-SaaS",
};

const WORKSPACE_ID_SCHEMA = z.uuid().transform((value) => value.toLowerCase());

export default async function PlanningSettingsPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/planung">,
) {
  const parsedWorkspace = WORKSPACE_ID_SCHEMA.safeParse(
    (await props.params).workspaceId,
  );
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let settings: PlanningSettingsV1 | undefined;
  try {
    settings = await authorizedQuery(
      workspaceId,
      "planning.settings.read",
      "workspace_planning_settings",
      (tx, ctx) => getPlanningSettings(tx, ctx),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/planung`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return (
        <DeniedState title="Die Planungs-Einstellungen sind für dich nicht freigegeben." />
      );
    }
    throw error;
  }
  if (!settings) throw new Error("Planungs-Einstellungen konnten nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Planung</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Lege fest, mit welchem Planungsmodus neue Angebotsvarianten starten.
        </p>
      </div>

      <PlanningSettingsForm workspaceId={workspaceId} settings={settings} />

      <div className="mt-6">
        <Link
          href={`/w/${workspaceId}/einstellungen/wirtschaftlichkeit`}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Zur Wirtschaftlichkeit
        </Link>
      </div>
    </main>
  );
}
