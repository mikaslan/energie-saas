import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  PROJECT_LOSS_REASON_COMMAND_VERSION,
  listManagedProjectLossReasons,
  type ProjectLossReasonRecord,
} from "@/modules/projects";
import { LossReasonManager } from "./loss-reason-manager";

export const metadata: Metadata = {
  title: "Verlustgründe | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());

function AccessDenied() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <section className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-950">Kein Zugriff</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">Nur interne Admins können Verlustgründe verwalten.</p>
        <Link href="/" className="mt-5 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Zur Startseite</Link>
      </section>
    </main>
  );
}

export default async function LossReasonsPage({
  params,
}: PageProps<"/w/[workspaceId]/einstellungen/verlustgruende">) {
  const parsedWorkspace = workspaceSchema.safeParse((await params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;

  let reasons: ProjectLossReasonRecord[] | undefined;
  let unauthenticated = false;
  let denied = false;
  try {
    reasons = await authorizedQuery(
      workspaceId,
      "settings.manage",
      "project_loss_reason",
      (tx, ctx) => listManagedProjectLossReasons(tx, ctx),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) unauthenticated = true;
    else if (error instanceof PermissionDeniedError) denied = true;
    else throw error;
  }
  if (unauthenticated) {
    const next = `/w/${workspaceId}/einstellungen/verlustgruende`;
    redirect(`/login?${new URLSearchParams({ next }).toString()}`);
  }
  if (denied) return <AccessDenied />;
  if (!reasons) throw new Error("Verlustgründe konnten nicht geladen werden");

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-4xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md bg-blue-700 text-sm font-bold text-white" aria-hidden="true">W</span>
            <div><p className="text-sm font-semibold">WMEE Einstellungen</p><p className="text-xs text-slate-500">Geschützter Arbeitsbereich</p></div>
          </div>
          <SignOutButton />
        </div>
      </header>
      <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <Link href={`/w/${workspaceId}/anfragen`} className="inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:text-blue-900 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"><span aria-hidden="true" className="mr-2">←</span>Zu den Anfragen</Link>
        <div className="mb-6 mt-4">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Administration</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Verlustgründe</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">Kanonische Gründe für verlorene Anfragen verwalten. Archivieren ersetzt bewusst kein Löschen.</p>
        </div>
        <LossReasonManager workspaceId={workspaceId} commandVersion={PROJECT_LOSS_REASON_COMMAND_VERSION} reasons={reasons} />
      </div>
    </main>
  );
}
