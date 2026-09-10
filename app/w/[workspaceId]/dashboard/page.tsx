import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { getDefaultRequestBoard } from "@/modules/boards";
import {
  getGlobalTaskInboxPage,
  type GlobalTaskInboxPageV1,
} from "@/modules/tasks";
import { parseGlobalTaskInboxRouteQuery } from "../aufgaben/query";

export const metadata: Metadata = {
  title: "Übersicht",
};

const workspaceIdSchema = z.uuid();

const berlinDateFormatter = new Intl.DateTimeFormat("de-DE", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "Europe/Berlin",
});

const countFormatter = new Intl.NumberFormat("de-DE");

function AccessDenied() {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-6 py-16">
      <section className="w-full rounded-lg border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">WMEE Vertrieb</p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">Kein Zugriff</h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Für diesen Arbeitsbereich liegt keine passende Mitgliedschaft vor.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          Zur Startseite
        </Link>
      </section>
    </main>
  );
}

async function loadPipeline(workspaceId: string): Promise<
  | { kind: "loaded"; columns: Array<{ name: string; count: number }>; total: number }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
> {
  try {
    const board = await authorizedQuery(
      workspaceId,
      "project.read",
      "kanban_board",
      (tx, ctx) => getDefaultRequestBoard(tx, ctx),
    );
    const columns = board.columns.map((column) => ({
      name: column.name,
      count: column.cards.length,
    }));
    return {
      kind: "loaded",
      columns,
      total: columns.reduce((sum, column) => sum + column.count, 0),
    };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

async function loadTasks(
  workspaceId: string,
  dueBucket: "overdue" | "today",
): Promise<
  | { kind: "loaded"; page: GlobalTaskInboxPageV1 }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
> {
  const query = parseGlobalTaskInboxRouteQuery({
    filter: "mine",
    state: "open",
    dueBucket,
  });
  if (!query) throw new Error("Dashboard-Posteingangsfrage ist ungueltig");
  try {
    const page = await authorizedQuery(
      workspaceId,
      "task.read",
      "global_task_inbox",
      (tx, ctx) => getGlobalTaskInboxPage(tx, ctx, query),
    );
    return { kind: "loaded", page };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

function TaskList({ page }: { page: GlobalTaskInboxPageV1 }) {
  const items = page.items.slice(0, 5);
  if (items.length === 0) return null;
  return (
    <ul className="mt-3 divide-y divide-slate-200">
      {items.map((item) => (
        <li key={item.id} className="py-2 text-sm leading-6">
          <span className="font-medium text-slate-900">{item.title}</span>
          <span className="text-slate-500">
            {` — ${item.project.name}`}
            {item.dueAt ? `, fällig ${berlinDateFormatter.format(new Date(item.dueAt))}` : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default async function DashboardPage({
  params,
}: PageProps<"/w/[workspaceId]/dashboard">) {
  const { workspaceId } = await params;
  const parsedWorkspaceId = workspaceIdSchema.safeParse(workspaceId);
  if (!parsedWorkspaceId.success) notFound();
  const validWorkspaceId = parsedWorkspaceId.data;

  const [pipeline, overdue, today] = await Promise.all([
    loadPipeline(validWorkspaceId),
    loadTasks(validWorkspaceId, "overdue"),
    loadTasks(validWorkspaceId, "today"),
  ]);
  if (
    pipeline.kind === "unauthenticated"
    || overdue.kind === "unauthenticated"
    || today.kind === "unauthenticated"
  ) {
    const nextPath = `/w/${validWorkspaceId}/dashboard`;
    redirect(`/login?${new URLSearchParams({ next: nextPath }).toString()}`);
  }
  const pipelineDenied = pipeline.kind === "denied";
  const tasksDenied = overdue.kind === "denied" || today.kind === "denied";
  if (pipelineDenied && tasksDenied) return <AccessDenied />;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-[1480px] flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-3">
            <span className="grid size-9 place-items-center rounded-md bg-blue-700 text-sm font-bold text-white" aria-hidden="true">
              W
            </span>
            <div>
              <p className="text-sm font-semibold leading-5">WMEE Vertrieb</p>
              <p className="text-xs text-slate-500">Geschützter Arbeitsbereich</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href={`/w/${validWorkspaceId}/anfragen`}
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Anfragen
            </Link>
            <Link
              href={`/w/${validWorkspaceId}/aufgaben`}
              className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Aufgaben
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="mx-auto w-full max-w-[1480px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8" data-dashboard="true">
        <h1 className="text-2xl font-semibold tracking-tight">Übersicht</h1>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
          Eigene Workspace-Näherung aus verifizierten Moduldaten
          (ESTIMATE-Layout; Reonic-Referenzfrage Q-DASHBOARD-REFERENZ offen).
        </p>

        <div className="mt-6 grid min-w-0 gap-6 lg:grid-cols-3">
          {pipeline.kind === "loaded" ? (
            <section
              aria-label="Anfrage-Pipeline"
              data-dashboard-pipeline="true"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2 className="text-base font-semibold">Anfragen je Phase</h2>
              {pipeline.total === 0 ? (
                <p className="mt-2 text-sm leading-6 text-slate-600">Keine offenen Anfragen.</p>
              ) : (
                <dl className="mt-3 space-y-2">
                  {pipeline.columns.map((column) => (
                    <div key={column.name} className="flex items-baseline justify-between gap-4 text-sm">
                      <dt className="text-slate-600">{column.name}</dt>
                      <dd className="font-semibold tabular-nums">{countFormatter.format(column.count)}</dd>
                    </div>
                  ))}
                  <div className="flex items-baseline justify-between gap-4 border-t border-slate-200 pt-2 text-sm">
                    <dt className="font-semibold">Gesamt</dt>
                    <dd className="font-semibold tabular-nums">{countFormatter.format(pipeline.total)}</dd>
                  </div>
                </dl>
              )}
              <Link
                href={`/w/${validWorkspaceId}/anfragen`}
                className="mt-4 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Zum Board
              </Link>
            </section>
          ) : null}

          {overdue.kind === "loaded" ? (
            <section
              aria-label="Überfällige Aufgaben"
              data-dashboard-overdue="true"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2 className="text-base font-semibold">Meine überfälligen Aufgaben</h2>
              {overdue.page.items.length === 0 ? (
                <p className="mt-2 text-sm leading-6 text-slate-600">Nichts überfällig.</p>
              ) : (
                <>
                  <TaskList page={overdue.page} />
                  {overdue.page.nextCursor !== null ? (
                    <p className="mt-2 text-sm text-slate-500">Weitere überfällige im Posteingang.</p>
                  ) : null}
                </>
              )}
              <Link
                href={`/w/${validWorkspaceId}/aufgaben`}
                className="mt-4 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Zum Posteingang
              </Link>
            </section>
          ) : null}

          {today.kind === "loaded" ? (
            <section
              aria-label="Heute fällige Aufgaben"
              data-dashboard-today="true"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2 className="text-base font-semibold">Heute fällig</h2>
              {today.page.items.length === 0 ? (
                <p className="mt-2 text-sm leading-6 text-slate-600">Heute nichts fällig.</p>
              ) : (
                <>
                  <TaskList page={today.page} />
                  {today.page.nextCursor !== null ? (
                    <p className="mt-2 text-sm text-slate-500">Weitere heute fällige im Posteingang.</p>
                  ) : null}
                </>
              )}
              <Link
                href={`/w/${validWorkspaceId}/aufgaben`}
                className="mt-4 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Zum Posteingang
              </Link>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
