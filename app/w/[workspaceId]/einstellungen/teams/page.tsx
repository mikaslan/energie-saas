import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  listTeamMemberOptions,
  listTeams,
  type TeamDto,
} from "@/modules/teams";
import { TeamManager } from "./team-manager";

export const metadata: Metadata = {
  title: "Teams | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

function AccessDenied() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <section className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-950">Kein Zugriff</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">Nur interne Admins können Teams verwalten.</p>
        <Link href="/" className="mt-5 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2">Zur Startseite</Link>
      </section>
    </main>
  );
}

export default async function TeamsPage({
  params,
}: PageProps<"/w/[workspaceId]/einstellungen/teams">) {
  const parsedWorkspace = workspaceSchema.safeParse((await params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let data: { teams: TeamDto[]; members: { membershipId: string; label: string }[] } | undefined;
  let unauthenticated = false;
  let denied = false;
  try {
    data = await authorizedQuery(
      workspaceId,
      "settings.manage",
      "team",
      async (tx, ctx) => ({
        teams: await listTeams(tx, ctx),
        members: await listTeamMemberOptions(tx, ctx),
      }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) unauthenticated = true;
    else if (error instanceof PermissionDeniedError) denied = true;
    else throw error;
  }
  if (unauthenticated) {
    const next = `/w/${workspaceId}/einstellungen/teams`;
    redirect(`/login?${new URLSearchParams({ next }).toString()}`);
  }
  if (denied) return <AccessDenied />;
  if (!data) throw new Error("Teams konnten nicht geladen werden");

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md bg-brand-700 text-sm font-bold text-white" aria-hidden="true">W</span>
            <div><p className="text-sm font-semibold">WMEE Einstellungen</p><p className="text-xs text-slate-500">Geschützter Arbeitsbereich</p></div>
          </div>
          <SignOutButton />
        </div>
      </header>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <Link href={`/w/${workspaceId}/anfragen`} className="inline-flex min-h-11 items-center text-sm font-semibold text-brand-700 outline-none hover:text-brand-900 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"><span aria-hidden="true" className="mr-2">←</span>Zu den Anfragen</Link>
        <div className="mb-6 mt-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-brand-700">Administration</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Teams</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Monteure- und Vertriebsteams mit Mitgliedern. Termine lassen sich einem Team zuordnen; Archivieren ersetzt bewusst kein Löschen.</p>
        </div>
        <TeamManager workspaceId={workspaceId} teams={data.teams} members={data.members} />
      </div>
    </main>
  );
}
