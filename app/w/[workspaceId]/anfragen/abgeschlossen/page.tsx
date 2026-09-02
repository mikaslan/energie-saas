import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import {
  listClosedRequests,
  projectClosedRequestCursorSchema,
  projectClosedRequestFilterSchema,
  ProjectOutcomeValidationError,
  type ProjectClosedRequestPage,
} from "@/modules/projects";

export const metadata: Metadata = {
  title: "Abgeschlossene Anfragen | Energie-SaaS",
};

const workspaceSchema = z.uuid().transform((value) => value.toLowerCase());
type SearchValue = string | string[] | undefined;

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function single(value: SearchValue): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function AccessDenied() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <section className="w-full max-w-lg rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-slate-950">Kein Zugriff</h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Abgeschlossene Anfragen sind nur im internen Arbeitsbereich sichtbar.
        </p>
        <Link href="/" className="mt-5 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
          Zur Startseite
        </Link>
      </section>
    </main>
  );
}

function filterHref(workspaceId: string, filter: "all" | "won" | "lost" | "cannot_fulfill"): string {
  const base = `/w/${workspaceId}/anfragen/abgeschlossen`;
  return filter === "all" ? base : `${base}?${new URLSearchParams({ filter }).toString()}`;
}

export default async function ClosedRequestsPage({
  params,
  searchParams,
}: PageProps<"/w/[workspaceId]/anfragen/abgeschlossen">) {
  const parsedWorkspace = workspaceSchema.safeParse((await params).workspaceId);
  if (!parsedWorkspace.success) notFound();
  const workspaceId = parsedWorkspace.data;
  const rawSearch = await searchParams;
  const rawFilter = single(rawSearch.filter);
  if (rawSearch.filter !== undefined && rawFilter === undefined) notFound();
  const parsedFilter = projectClosedRequestFilterSchema.safeParse(rawFilter ?? "all");
  if (!parsedFilter.success) notFound();
  const filter = parsedFilter.data;
  const rawCursor = single(rawSearch.cursor);
  if (rawSearch.cursor !== undefined && rawCursor === undefined) notFound();
  const parsedCursor = rawCursor === undefined
    ? { success: true as const, data: null }
    : projectClosedRequestCursorSchema.safeParse(rawCursor);
  if (!parsedCursor.success) notFound();
  const cursor = parsedCursor.data;

  let page: ProjectClosedRequestPage | undefined;
  let unauthenticated = false;
  let denied = false;
  try {
    page = await authorizedQuery(
      workspaceId,
      "project.read",
      "closed_request_list",
      (tx, ctx) => listClosedRequests(tx, ctx, { filter, cursor }),
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) unauthenticated = true;
    else if (error instanceof PermissionDeniedError) denied = true;
    else if (error instanceof ProjectOutcomeValidationError) notFound();
    else throw error;
  }
  if (unauthenticated) {
    const next = `/w/${workspaceId}/anfragen/abgeschlossen`;
    redirect(`/login?${new URLSearchParams({ next }).toString()}`);
  }
  if (denied) return <AccessDenied />;
  if (!page) throw new Error("Abgeschlossene Anfragen konnten nicht geladen werden");

  const nextHref = page.nextCursor === null
    ? null
    : `${filterHref(workspaceId, filter)}${filter === "all" ? "?" : "&"}${new URLSearchParams({ cursor: page.nextCursor }).toString()}`;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md bg-blue-700 text-sm font-bold text-white" aria-hidden="true">W</span>
            <div>
              <p className="text-sm font-semibold">WMEE Vertrieb</p>
              <p className="text-xs text-slate-500">Geschützter Arbeitsbereich</p>
            </div>
          </div>
          <SignOutButton />
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        <nav aria-label="Anfrageansichten" className="mb-6 flex flex-wrap gap-2 border-b border-slate-300">
          <Link href={`/w/${workspaceId}/anfragen`} className="inline-flex min-h-11 items-center border-b-2 border-transparent px-3 text-sm font-semibold text-slate-600 outline-none hover:text-slate-950 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
            Offen
          </Link>
          <Link aria-current="page" href={`/w/${workspaceId}/anfragen/abgeschlossen`} className="inline-flex min-h-11 items-center border-b-2 border-blue-700 px-3 text-sm font-semibold text-blue-800 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
            Abgeschlossen
          </Link>
        </nav>

        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Anfragearchiv</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Abgeschlossene Anfragen</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Gewonnene und verlorene Anfragen bleiben revisionssicher auffindbar und können in ihrer Projektakte wieder geöffnet werden.
            </p>
          </div>
          <span className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm font-semibold tabular-nums shadow-sm">
            {page.records.length} auf dieser Seite
          </span>
        </div>

        <nav aria-label="Abschlussfilter" className="mt-6 flex flex-wrap gap-2">
          {(["all", "won", "lost", "cannot_fulfill"] as const).map((value) => {
            const active = filter === value;
            const label = value === "all" ? "Alle" : value === "won" ? "Gewonnen" : value === "lost" ? "Verloren" : "Nicht erfüllbar";
            return (
              <Link key={value} aria-current={active ? "page" : undefined} href={filterHref(workspaceId, value)} className={`inline-flex min-h-11 items-center rounded-md border px-4 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${active ? "border-blue-700 bg-blue-700 text-white" : "border-slate-300 bg-white text-slate-800 hover:bg-slate-50"}`}>
                {label}
              </Link>
            );
          })}
        </nav>

        {page.records.length === 0 ? (
          <section className="mt-6 rounded-lg border border-dashed border-slate-300 bg-white px-5 py-12 text-center">
            <h2 className="text-lg font-semibold">Keine abgeschlossenen Anfragen</h2>
            <p className="mt-2 text-sm text-slate-600">Für diesen Filter gibt es aktuell keine Einträge.</p>
          </section>
        ) : (
          <ul className="mt-6 grid list-none gap-3">
            {page.records.map((record) => (
              <li key={record.projectId} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
                <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
                        record.outcome === "won"
                          ? "bg-emerald-100 text-emerald-900"
                          : record.outcome === "lost"
                            ? "bg-amber-100 text-amber-950"
                            : "bg-rose-100 text-rose-950"
                      }`}>
                        {record.outcome === "won"
                          ? "Gewonnen"
                          : record.outcome === "lost" ? "Verloren" : "Nicht erfüllbar"}
                      </span>
                      <span className="text-xs tabular-nums text-slate-500">Stand {record.outcomeRevision}</span>
                    </div>
                    <h2 className="mt-2 break-words text-lg font-semibold text-slate-950">{record.contactName}</h2>
                    <p className="mt-1 break-words text-sm text-slate-600">{record.projectName}</p>
                    <p className="mt-2 break-words text-sm text-slate-700">{record.locationLabel}</p>
                    {record.lossReasonLabel ? (
                      <p className="mt-2 break-words text-sm text-slate-700"><span className="font-semibold">Verlustgrund:</span> {record.lossReasonLabel}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-col items-start gap-3 sm:items-end">
                    <time dateTime={record.closedAt} className="text-xs tabular-nums text-slate-500">{dateFormatter.format(new Date(record.closedAt))}</time>
                    <Link href={`/w/${workspaceId}/anfragen/${record.projectId}`} className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
                      Projektakte öffnen
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}

        {nextHref ? (
          <nav aria-label="Seitennavigation" className="mt-6 flex justify-end">
            <Link href={nextHref} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
              Ältere Abschlüsse
            </Link>
          </nav>
        ) : null}
      </div>
    </main>
  );
}
