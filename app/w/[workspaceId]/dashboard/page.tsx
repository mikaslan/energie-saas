import Link from "next/link";
import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { authorizedQuery, NotAuthenticatedError } from "@/lib/action";
import { PermissionDeniedError } from "@/lib/permissions";
import { SignOutButton } from "@/app/_components/sign-out-button";
import { getDefaultRequestBoard } from "@/modules/boards";
import { getProjectOfferValues } from "@/modules/offers";
import {
  getLeadSourcePipelineStats,
  type LeadSourcePipelineSlice,
} from "@/modules/lead-sources";
import {
  getGlobalTaskInboxPage,
  type GlobalTaskInboxPageV1,
} from "@/modules/tasks";
import {
  getClosureTrendStats,
  listClosedRequests,
  type ClosureTrendStats,
  type ProjectClosedRequestPage,
} from "@/modules/projects";
import {
  getInvoicingReport,
  type InvoicingReportV1,
} from "@/modules/invoicing";
import {
  getSignatureLeadTimeStats,
  type SignatureLeadTimeStats,
} from "@/modules/signatures";
import {
  getOfferLeadTimeStats,
  type OfferLeadTimeStats,
} from "@/modules/offers";
import {
  listUpcomingAppointments,
  type UpcomingAppointmentV1,
} from "@/modules/calendar";
import { monthLabel } from "@/lib/integrations/dashboard/closure-trend-v1";
import { INVOICING_REPORT_COMMAND_VERSION } from "@/lib/integrations/invoicing/contract";
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

const euroFormatter = new Intl.NumberFormat("de-DE", {
  style: "currency",
  currency: "EUR",
});

const percentFormatter = new Intl.NumberFormat("de-DE", {
  style: "percent",
  maximumFractionDigits: 1,
});

function euroFromCents(cents: number): string {
  return euroFormatter.format(cents / 100);
}

function outcomeLabel(outcome: string): string {
  if (outcome === "won") return "Gewonnen";
  if (outcome === "lost") return "Verloren";
  return "Nicht erfüllbar";
}

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

/**
 * DASH-05 Phasengewichte fuer die gewichtete Pipeline [ESTIMATE: keine
 * Reonic-Referenz, Q-DASHBOARD-REFERENZ offen; won/lost stehen nicht auf
 * dem offenen Board und sind nur der Vollstaendigkeit halber gefuehrt].
 */
const PIPELINE_STAGE_WEIGHTS: Record<string, number> = {
  lead: 0.1,
  offer: 0.5,
  won: 1,
  lost: 0,
};

async function loadPipeline(workspaceId: string): Promise<
  | {
    kind: "loaded";
    columns: Array<{ name: string; count: number }>;
    total: number;
    openValueCents: number;
    weightedValueCents: number;
    valuesCapped: boolean;
    projectIds: string[];
  }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
> {
  try {
    return await authorizedQuery(
      workspaceId,
      "project.read",
      "kanban_board",
      async (tx, ctx) => {
        const board = await getDefaultRequestBoard(tx, ctx);
        const columns = board.columns.map((column) => ({
          name: column.name,
          count: column.cards.length,
        }));
        const projectIds = board.columns.flatMap((column) => column.cards.map((card) => card.id));
        const capped = projectIds.length > 200;
        const values = await getProjectOfferValues(tx, ctx, projectIds.slice(0, 200));
        let openValueCents = 0;
        let weightedValueCents = 0;
        for (const column of board.columns) {
          const weight = PIPELINE_STAGE_WEIGHTS[column.type] ?? 0;
          for (const card of column.cards) {
            const cents = values[card.id] ?? null;
            if (cents === null) continue;
            openValueCents += cents;
            weightedValueCents += Math.round(cents * weight);
          }
        }
        return {
          kind: "loaded" as const,
          columns,
          total: columns.reduce((sum, column) => sum + column.count, 0),
          openValueCents,
          weightedValueCents,
          valuesCapped: capped,
          projectIds,
        };
      },
    );
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

/** Zaehlung per Cursor-Pagination, gedeckelt (ehrliches „+"). */
const CLOSURE_COUNT_PAGE_CAP = 10;

async function loadClosures(workspaceId: string): Promise<
  | {
    kind: "loaded";
    won: number;
    lost: number;
    capped: boolean;
    latest: ProjectClosedRequestPage["records"];
  }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
> {
  try {
    return await authorizedQuery(
      workspaceId,
      "project.read",
      "closed_request_list",
      async (tx, ctx) => {
        const latest = await listClosedRequests(tx, ctx, { filter: "all" });
        let won = 0;
        let lost = 0;
        let capped = false;
        for (const filter of ["won", "lost"] as const) {
          let cursor: string | null = null;
          for (let page = 0; page < CLOSURE_COUNT_PAGE_CAP; page += 1) {
            const result = await listClosedRequests(tx, ctx, { filter, cursor });
            const count = result.records.filter(
              (record) => record.outcome === filter,
            ).length;
            if (filter === "won") won += count;
            else lost += count;
            cursor = result.nextCursor;
            if (cursor === null) break;
            if (page === CLOSURE_COUNT_PAGE_CAP - 1) capped = true;
          }
        }
        return { kind: "loaded" as const, won, lost, capped, latest: latest.records.slice(0, 5) };
      },
    );
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

function currentBerlinMonth(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "2026";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  return `${year}-${month}`;
}

async function loadInvoiceKpis(workspaceId: string): Promise<
  | { kind: "loaded"; report: InvoicingReportV1 }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
> {
  try {
    const report = await authorizedQuery(
      workspaceId,
      "invoicing.read",
      "invoicing_report",
      (tx, ctx) => getInvoicingReport(tx, ctx, {
        schemaVersion: INVOICING_REPORT_COMMAND_VERSION,
        month: currentBerlinMonth(),
      }),
    );
    return { kind: "loaded", report };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

async function loadLeadTime(workspaceId: string): Promise<
  | { kind: "loaded"; stats: SignatureLeadTimeStats }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
> {
  try {
    const stats = await authorizedQuery(
      workspaceId,
      "offer.signature.read",
      "signature_request",
      (tx, ctx) => getSignatureLeadTimeStats(tx, ctx),
    );
    return { kind: "loaded", stats };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

async function loadOfferLeadTime(workspaceId: string): Promise<
  | { kind: "loaded"; stats: OfferLeadTimeStats }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
> {
  try {
    const stats = await authorizedQuery(
      workspaceId,
      "project.read",
      "offer_lead_time",
      (tx, ctx) => getOfferLeadTimeStats(tx, ctx),
    );
    return { kind: "loaded", stats };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

async function loadSourceBreakdown(
  workspaceId: string,
  projectIds: string[],
): Promise<
  | { kind: "loaded"; slices: LeadSourcePipelineSlice[] }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
> {
  try {
    const slices = await authorizedQuery(
      workspaceId,
      "lead_source.read",
      "lead_source_pipeline",
      (tx, ctx) => getLeadSourcePipelineStats(tx, ctx, projectIds),
    );
    return { kind: "loaded", slices };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

async function loadClosureTrend(workspaceId: string): Promise<
  | { kind: "loaded"; stats: ClosureTrendStats }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
> {
  try {
    const stats = await authorizedQuery(
      workspaceId,
      "project.read",
      "closure_trend",
      (tx, ctx) => getClosureTrendStats(tx, ctx),
    );
    return { kind: "loaded", stats };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

async function loadAppointments(workspaceId: string): Promise<
  | { kind: "loaded"; items: UpcomingAppointmentV1[] }
  | { kind: "unauthenticated" }
  | { kind: "denied" }
> {
  try {
    const items = await authorizedQuery(
      workspaceId,
      "appointment.read",
      "project_appointment",
      (tx, ctx) => listUpcomingAppointments(tx, ctx, { limit: 5 }),
    );
    return { kind: "loaded", items };
  } catch (error) {
    if (error instanceof NotAuthenticatedError) return { kind: "unauthenticated" };
    if (error instanceof PermissionDeniedError) return { kind: "denied" };
    throw error;
  }
}

/** Berlin-Wandzeit „YYYY-MM-DDTHH:MM:…" -> „10.09.2026, 14:00" (ohne TZ-Raten). */
function formatBerlinWall(wall: string): { date: string; time: string } {
  const date = wall.slice(0, 10).split("-");
  return {
    date: `${date[2]}.${date[1]}.${date[0]}`,
    time: wall.slice(11, 16),
  };
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

  const [pipeline, overdue, today, closures, trend, invoices, leadTime, offerLeadTime, appointments] = await Promise.all([
    loadPipeline(validWorkspaceId),
    loadTasks(validWorkspaceId, "overdue"),
    loadTasks(validWorkspaceId, "today"),
    loadClosures(validWorkspaceId),
    loadClosureTrend(validWorkspaceId),
    loadInvoiceKpis(validWorkspaceId),
    loadLeadTime(validWorkspaceId),
    loadOfferLeadTime(validWorkspaceId),
    loadAppointments(validWorkspaceId),
  ]);
  if (
    pipeline.kind === "unauthenticated"
    || overdue.kind === "unauthenticated"
    || today.kind === "unauthenticated"
    || closures.kind === "unauthenticated"
    || trend.kind === "unauthenticated"
    || invoices.kind === "unauthenticated"
    || leadTime.kind === "unauthenticated"
    || offerLeadTime.kind === "unauthenticated"
    || appointments.kind === "unauthenticated"
  ) {
    const nextPath = `/w/${validWorkspaceId}/dashboard`;
    redirect(`/login?${new URLSearchParams({ next: nextPath }).toString()}`);
  }
  // Quellen-Breakdown entkoppelt nachladen (eigene Sichtbarkeit,
  // blockiert die Pipeline-Karte bei fehlendem lead_source.read nicht).
  const sources = pipeline.kind === "loaded"
    ? await loadSourceBreakdown(validWorkspaceId, pipeline.projectIds)
    : { kind: "denied" } as const;
  if (sources.kind === "unauthenticated") {
    const nextPath = `/w/${validWorkspaceId}/dashboard`;
    redirect(`/login?${new URLSearchParams({ next: nextPath }).toString()}`);
  }
  if (
    pipeline.kind === "denied"
    && overdue.kind === "denied"
    && today.kind === "denied"
    && closures.kind === "denied"
    && trend.kind === "denied"
    && invoices.kind === "denied"
    && leadTime.kind === "denied"
    && offerLeadTime.kind === "denied"
    && appointments.kind === "denied"
  ) {
    return <AccessDenied />;
  }

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
              ) : null}
              {(
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
                  <div className="flex items-baseline justify-between gap-4 text-sm">
                    <dt className="text-slate-600">Offen (Angebotswert)</dt>
                    <dd className="font-semibold tabular-nums">
                      {`${euroFromCents(pipeline.openValueCents)}${pipeline.valuesCapped ? "+" : ""}`}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-4 text-sm">
                    <dt className="text-slate-600">Gewichtet (ESTIMATE)</dt>
                    <dd className="font-semibold tabular-nums">
                      {`${euroFromCents(pipeline.weightedValueCents)}${pipeline.valuesCapped ? "+" : ""}`}
                    </dd>
                  </div>
                </dl>
              )}
              <p className="mt-2 text-xs leading-5 text-slate-500">
                Gewichte lead 10 %, offer 50 % (ESTIMATE, Referenzfrage offen).
              </p>
              <Link
                href={`/w/${validWorkspaceId}/anfragen`}
                className="mt-4 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Zum Board
              </Link>
            </section>
          ) : null}

          {sources.kind === "loaded" && sources.slices.length > 0 ? (
            <section
              aria-label="Pipeline nach Quelle"
              data-dashboard-sources="true"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2 className="text-base font-semibold">Pipeline nach Quelle (ESTIMATE)</h2>
              <dl className="mt-3 space-y-2 text-sm">
                {sources.slices.map((slice) => (
                  <div key={slice.sourceName} className="flex items-baseline justify-between gap-4">
                    <dt className="text-slate-600">{slice.sourceName}</dt>
                    <dd className="font-semibold tabular-nums">
                      {countFormatter.format(slice.count)}
                    </dd>
                  </div>
                ))}
              </dl>
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

          {closures.kind === "loaded" ? (
            <section
              aria-label="Abschlüsse"
              data-dashboard-closures="true"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2 className="text-base font-semibold">Abschlüsse</h2>
              {(() => {
                const total = closures.won + closures.lost;
                const capped = closures.capped ? "+" : "";
                return (
                  <>
                    <dl className="mt-3 space-y-2 text-sm">
                      <div className="flex items-baseline justify-between gap-4">
                        <dt className="text-slate-600">Gewonnen</dt>
                        <dd className="font-semibold tabular-nums">
                          {`${countFormatter.format(closures.won)}${capped}`}
                        </dd>
                      </div>
                      <div className="flex items-baseline justify-between gap-4">
                        <dt className="text-slate-600">Conversion (gewonnen / entschieden)</dt>
                        <dd className="font-semibold tabular-nums">
                          {total === 0 ? "—" : percentFormatter.format(closures.won / total)}
                        </dd>
                      </div>
                    </dl>
                    {closures.latest.length === 0 ? (
                      <p className="mt-2 text-sm leading-6 text-slate-600">Noch keine Abschlüsse.</p>
                    ) : (
                      <ul className="mt-3 divide-y divide-slate-200">
                        {closures.latest.map((record) => (
                          <li key={record.projectId} className="py-2 text-sm leading-6">
                            <span className="font-medium text-slate-900">{record.projectName}</span>
                            <span className="text-slate-500">
                              {` — ${outcomeLabel(record.outcome)}, ${berlinDateFormatter.format(new Date(record.closedAt))}`}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                );
              })()}
              <Link
                href={`/w/${validWorkspaceId}/anfragen/abgeschlossen`}
                className="mt-4 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Zu den Abschlüssen
              </Link>
            </section>
          ) : null}

          {trend.kind === "loaded" ? (
            <section
              aria-label="Abschlusstrend"
              data-dashboard-trend="true"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2 className="text-base font-semibold">Abschlusstrend (12 Monate, ESTIMATE)</h2>
              {trend.stats.wonTotal + trend.stats.lostTotal === 0 ? (
                <p className="mt-2 text-sm leading-6 text-slate-600">Noch keine Abschlüsse im Zeitraum.</p>
              ) : (
                <ul className="mt-3 space-y-1.5">
                  {trend.stats.months.map((item) => {
                    const max = Math.max(1, ...trend.stats.months.map((entry) => entry.total));
                    return (
                      <li key={item.month} className="flex items-center gap-2 text-xs">
                        <span className="w-16 shrink-0 tabular-nums text-slate-500">
                          {monthLabel(item.month)}
                        </span>
                        <span
                          className="h-3 rounded-sm bg-emerald-500"
                          style={{ width: `${Math.max(item.won > 0 ? 4 : 0, (item.won / max) * 100)}%` }}
                          title={`${item.won} gewonnen`}
                        />
                        <span
                          className="h-3 rounded-sm bg-slate-300"
                          style={{ width: `${Math.max(item.lost > 0 ? 4 : 0, (item.lost / max) * 100)}%` }}
                          title={`${item.lost} verloren`}
                        />
                        <span className="shrink-0 tabular-nums text-slate-600">
                          {`${item.won} / ${item.lost}`}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ) : null}

          {invoices.kind === "loaded" ? (
            <section
              aria-label="Rechnungen"
              data-dashboard-invoices="true"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2 className="text-base font-semibold">Rechnungen (Monat)</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-slate-600">Einnahmen</dt>
                  <dd className="font-semibold tabular-nums">
                    {euroFromCents(invoices.report.revenueThisMonthCents)}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-slate-600">Ausstehend</dt>
                  <dd className="font-semibold tabular-nums">
                    {euroFromCents(invoices.report.outstandingCents)}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-slate-600">Überfällig</dt>
                  <dd className="font-semibold tabular-nums">
                    {euroFromCents(invoices.report.overdueCents)}
                  </dd>
                </div>
              </dl>
              <Link
                href={`/w/${validWorkspaceId}/rechnungen/berichte`}
                className="mt-4 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Zu den Berichten
              </Link>
            </section>
          ) : null}

          {leadTime.kind === "loaded" ? (
            <section
              aria-label="Unterschriftsdauer"
              data-dashboard-leadtime="true"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2 className="text-base font-semibold">Unterschriftsdauer</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-slate-600">Median Erzeugung → Unterschrift</dt>
                  <dd className="font-semibold tabular-nums">
                    {leadTime.stats.medianDays === null
                      ? "—"
                      : `${countFormatter.format(leadTime.stats.medianDays)} Tage`}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-slate-600">Signierte Vorgänge</dt>
                  <dd className="font-semibold tabular-nums">
                    {`${countFormatter.format(leadTime.stats.signedCount)}${leadTime.stats.capped ? "+" : ""}`}
                  </dd>
                </div>
              </dl>
              {leadTime.stats.medianDays === null ? (
                <p className="mt-2 text-sm leading-6 text-slate-600">Noch keine Unterschriften.</p>
              ) : null}
            </section>
          ) : null}

          {offerLeadTime.kind === "loaded" ? (
            <section
              aria-label="Angebotsdauer"
              data-dashboard-offer-leadtime="true"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2 className="text-base font-semibold">Angebotsdauer</h2>
              <dl className="mt-3 space-y-2 text-sm">
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-slate-600">Median Anlage → erstes Angebot</dt>
                  <dd className="font-semibold tabular-nums">
                    {offerLeadTime.stats.medianDays === null
                      ? "—"
                      : `${countFormatter.format(offerLeadTime.stats.medianDays)} Tage`}
                  </dd>
                </div>
                <div className="flex items-baseline justify-between gap-4">
                  <dt className="text-slate-600">Projekte mit Angebot</dt>
                  <dd className="font-semibold tabular-nums">
                    {`${countFormatter.format(offerLeadTime.stats.projectCount)}${offerLeadTime.stats.capped ? "+" : ""}`}
                  </dd>
                </div>
              </dl>
              {offerLeadTime.stats.medianDays === null ? (
                <p className="mt-2 text-sm leading-6 text-slate-600">Noch keine Angebote.</p>
              ) : null}
            </section>
          ) : null}

          {appointments.kind === "loaded" ? (
            <section
              aria-label="Nächste Termine"
              data-dashboard-appointments="true"
              className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
            >
              <h2 className="text-base font-semibold">Nächste Termine</h2>
              {appointments.items.length === 0 ? (
                <p className="mt-2 text-sm leading-6 text-slate-600">Keine anstehenden Termine.</p>
              ) : (
                <ul className="mt-3 divide-y divide-slate-200">
                  {appointments.items.map((item) => {
                    const start = formatBerlinWall(item.start);
                    return (
                      <li key={item.id} className="py-2 text-sm leading-6">
                        <Link
                          href={`/w/${validWorkspaceId}/anfragen/${item.projectId}`}
                          className="font-medium text-blue-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                        >
                          {item.title}
                        </Link>
                        <span className="text-slate-500">
                          {` — ${start.date}, ${item.allDay ? "ganztägig" : `${start.time} Uhr`}`}
                          {item.calendarName ? ` (${item.calendarName})` : ""}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <Link
                href={`/w/${validWorkspaceId}/kalender`}
                className="mt-4 inline-flex min-h-11 items-center rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Zum Kalender
              </Link>
            </section>
          ) : null}
        </div>
      </div>
    </main>
  );
}
