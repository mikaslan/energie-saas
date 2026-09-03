import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import type { EconomicsSettingsV1 } from "@/lib/integrations/economics/contract";
import { getEconomicsSettings } from "@/modules/economics";
import { PermissionDeniedError } from "@/lib/permissions";
import { DeniedState } from "../../_ui";
import { EconomicsSettingsForm } from "./economics-settings-form";

export const metadata: Metadata = {
  title: "Wirtschaftlichkeit | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

export default async function EconomicsSettingsPage(
  props: PageProps<"/w/[workspaceId]/einstellungen/wirtschaftlichkeit">,
) {
  const parsedWorkspace = workspaceSchema.safeParse((await props.params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let settings: EconomicsSettingsV1 | undefined;
  try {
    settings = await authorizedQuery(
      workspaceId,
      "economics.read",
      "workspace_economics_settings",
      (tx, ctx) => getEconomicsSettings(tx, ctx),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) {
      redirect(`/login?${new URLSearchParams({
        next: `/w/${workspaceId}/einstellungen/wirtschaftlichkeit`,
      }).toString()}`);
    }
    if (error instanceof PermissionDeniedError) {
      return <DeniedState title="Die Wirtschaftlichkeits-Einstellungen sind für dich nicht freigegeben." />;
    }
    throw error;
  }
  if (!settings) throw new Error("Einstellungen konnten nicht geladen werden");

  return (
    <main className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">
          Einstellungen
        </p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight">Wirtschaftlichkeit</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
          Standardwerte für die Wirtschaftlichkeitsrechnung im gesamten Workspace.
        </p>
      </div>

      {!settings.hasAnyDefaults ? (
        <p className="mb-6 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
          Noch keine Defaults hinterlegt. Ohne eigene Werte nutzt die
          Berechnung später die Länderreferenz.
        </p>
      ) : null}

      <EconomicsSettingsForm workspaceId={workspaceId} settings={settings} />

      <div className="mt-6">
        <Link
          href={`/w/${workspaceId}/einstellungen/rechnungsstellung`}
          className="text-sm font-semibold text-blue-700 underline-offset-2 hover:underline"
        >
          Zur Rechnungsstellung
        </Link>
      </div>
    </main>
  );
}
