import Link from "next/link";
import { SignOutButton } from "@/app/_components/sign-out-button";
import {
  GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH,
  globalTaskInboxBerlinDayBounds,
  type GlobalTaskInboxItemV1,
  type GlobalTaskInboxPageV1,
} from "@/lib/integrations/tasks/inbox-contract";
import { globalTaskInboxHref } from "./query";

const dueDateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeZone: "Europe/Berlin",
});

const filterLabels = {
  mine: "Meine Aufgaben",
  assigned_by_me: "Von mir erstellt",
  all: "Alle Aufgaben",
} as const;
const stateLabels = { open: "Offen", done: "Erledigt" } as const;
const dueBucketLabels = {
  any: "Alle Fälligkeiten",
  overdue: "Überfällig",
  today: "Heute fällig",
  upcoming: "Später fällig",
  no_due: "Ohne Fälligkeitsdatum",
} as const;
const outcomeLabels = {
  open: "Projekt offen",
  won: "Projekt gewonnen",
  lost: "Projekt verloren",
  cannot_fulfill: "Projekt nicht erfüllbar",
} as const;

type DayBounds = ReturnType<typeof globalTaskInboxBerlinDayBounds>;

function dueLabel(
  task: GlobalTaskInboxItemV1,
  bounds: DayBounds,
): { text: string; overdue: boolean; today: boolean } {
  if (task.dueAt === null) {
    return { text: "Kein Fälligkeitsdatum", overdue: false, today: false };
  }
  const formatted = dueDateFormatter.format(new Date(task.dueAt));
  if (task.status === "done") {
    return { text: `Fällig am ${formatted}`, overdue: false, today: false };
  }
  if (task.dueAt < bounds.dayStart) {
    return { text: `Überfällig · ${formatted}`, overdue: true, today: false };
  }
  if (task.dueAt < bounds.nextDayStart) {
    return { text: `Heute fällig · ${formatted}`, overdue: false, today: true };
  }
  return { text: `Fällig am ${formatted}`, overdue: false, today: false };
}

function taskRelationship(task: GlobalTaskInboxItemV1): string | null {
  if (task.assignedToCurrentActor && task.createdByCurrentActor) {
    return "Dir zugewiesen · Von dir erstellt";
  }
  if (task.assignedToCurrentActor) return "Dir zugewiesen";
  if (task.createdByCurrentActor) return "Von dir erstellt";
  return null;
}

function assigneeLabel(count: number): string {
  if (count === 0) return "Nicht zugewiesen";
  if (count === 1) return "1 zuständige Person";
  return `${count} zuständige Personen`;
}

function InboxTaskCard({
  workspaceId,
  task,
  bounds,
}: {
  workspaceId: string;
  task: GlobalTaskInboxItemV1;
  bounds: DayBounds;
}) {
  const due = dueLabel(task, bounds);
  const relationship = taskRelationship(task);
  return (
    <article
      aria-labelledby={`global-task-${task.id}`}
      className="min-w-0 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5"
    >
      <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${task.status === "done"
              ? "bg-emerald-100 text-emerald-950"
              : "bg-blue-100 text-blue-950"}`}>
              {stateLabels[task.status]}
            </span>
            <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-700">
              {outcomeLabels[task.project.outcome]}
            </span>
            <span className="text-xs tabular-nums text-slate-500">Stand {task.revision}</span>
          </div>
          <h2 id={`global-task-${task.id}`} className="mt-3 break-words text-lg font-semibold text-slate-950">
            {task.title}
          </h2>
          <p className="mt-1 break-words text-sm font-medium text-slate-700">
            Projekt: {task.project.name}
          </p>
          <dl className="mt-4 grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
            <div>
              <dt className="sr-only">Fälligkeit</dt>
              <dd className={due.overdue
                ? "font-semibold text-rose-800"
                : due.today ? "font-semibold text-amber-900" : ""}>
                {task.dueAt === null ? due.text : <time dateTime={task.dueAt}>{due.text}</time>}
              </dd>
            </div>
            <div>
              <dt className="sr-only">Zuständigkeiten</dt>
              <dd>{assigneeLabel(task.assigneeCount)}</dd>
            </div>
            <div>
              <dt className="sr-only">Checkliste</dt>
              <dd>
                Checkliste: {task.counts.checklistDone} von {task.counts.checklistTotal} erledigt
              </dd>
            </div>
            <div>
              <dt className="sr-only">Labels</dt>
              <dd>{task.counts.labels} {task.counts.labels === 1 ? "Label" : "Labels"}</dd>
            </div>
          </dl>
          {relationship ? (
            <p className="mt-3 text-xs font-semibold text-blue-800">{relationship}</p>
          ) : null}
        </div>
        <Link
          href={`/w/${workspaceId}/anfragen/${task.project.id}#project-tasks`}
          className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Projektakte öffnen
        </Link>
      </div>
    </article>
  );
}

export function GlobalTaskInboxView({
  workspaceId,
  page,
  continuation,
}: {
  workspaceId: string;
  page: GlobalTaskInboxPageV1;
  continuation: boolean;
}) {
  const bounds = globalTaskInboxBerlinDayBounds(page.asOf);
  const firstHref = continuation
    ? globalTaskInboxHref(workspaceId, { ...page, asOf: null, cursor: null })
    : null;
  const nextHref = page.nextCursor === null
    ? null
    : globalTaskInboxHref(workspaceId, {
        ...page,
        asOf: page.asOf,
        cursor: page.nextCursor,
      });
  const filtersActive = page.filter !== "mine"
    || page.state !== "open"
    || page.dueBucket !== "any"
    || page.query !== null;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-950">
      <a href="#global-task-inbox-main" className="sr-only rounded-md bg-white px-3 py-2 font-semibold focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:ring-2 focus:ring-blue-600">
        Zur Aufgabenliste springen
      </a>
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="grid size-9 place-items-center rounded-md bg-blue-700 text-sm font-bold text-white">W</span>
            <div>
              <p className="text-sm font-semibold leading-5">WMEE Vertrieb</p>
              <p className="text-xs text-slate-500">Aufgaben-Inbox</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <nav aria-label="Bereichsnavigation" className="flex flex-wrap items-center gap-2">
              <Link href={`/w/${workspaceId}/anfragen`} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Anfragen</Link>
              <Link aria-current="page" href={`/w/${workspaceId}/aufgaben`} className="inline-flex min-h-11 items-center rounded-md border border-blue-700 bg-blue-50 px-3 text-sm font-semibold text-blue-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Aufgaben</Link>
              <Link href={`/w/${workspaceId}/angebote`} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Angebote</Link>
              <Link href={`/w/${workspaceId}/katalog`} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Produktkatalog</Link>
            </nav>
            <SignOutButton />
          </div>
        </div>
      </header>

      {/* tabIndex={-1} macht das Sprungziel programmatisch fokussierbar. Ohne
          das springt der Browser zwar visuell, der Tastaturfokus bliebe aber
          auf dem Skip-Link und die naechste Tabulatortaste liefe erneut in die
          Kopfnavigation. */}
      <div
        id="global-task-inbox-main"
        tabIndex={-1}
        className="mx-auto w-full max-w-6xl px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8"
      >
        <header className="flex flex-wrap items-end justify-between gap-4 border-b border-slate-200 pb-6">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-700">Projektübergreifend</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">Aufgaben</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
              Offene und erledigte Projektaufgaben zentral finden. Änderungen erfolgen weiterhin revisionssicher in der jeweiligen Projektakte.
            </p>
          </div>
          <span className="rounded-full border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700">
            Read-only Übersicht
          </span>
        </header>

        <section aria-labelledby="task-filter-title" className="mt-6 rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <h2 id="task-filter-title" className="text-base font-semibold">Aufgaben filtern</h2>
          {/* Die vier Felder sind unkontrolliert. Next keyt das Seitensegment
              ohne Suchparameter, eine reine Parameternavigation — etwa "Filter
              zurücksetzen" — rekonziliert also dieselben DOM-Knoten, und React
              schreibt ein geändertes defaultValue nicht auf einen bestehenden
              unkontrollierten Knoten. Ohne diesen key zeigte das Formular nach
              dem Zurücksetzen weiter die alten Werte, während die Ergebnisliste
              schon die Standardansicht zeigt. */}
          <form
            key={`${page.filter}|${page.state}|${page.dueBucket}|${page.query ?? ""}`}
            method="get"
            role="search"
            className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-[1.2fr_1fr_1fr_1.5fr_auto] lg:items-end"
          >
            <div>
              <label htmlFor="task-filter" className="text-sm font-medium text-slate-800">Ansicht</label>
              <select id="task-filter" name="filter" defaultValue={page.filter} className="mt-1.5 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-200">
                {Object.entries(filterLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="task-state" className="text-sm font-medium text-slate-800">Status</label>
              <select id="task-state" name="state" defaultValue={page.state} className="mt-1.5 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-200">
                {Object.entries(stateLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="task-due-bucket" className="text-sm font-medium text-slate-800">Fälligkeit</label>
              <select id="task-due-bucket" name="dueBucket" defaultValue={page.dueBucket} className="mt-1.5 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-200">
                {Object.entries(dueBucketLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <div>
              <label htmlFor="task-query" className="text-sm font-medium text-slate-800">Suche</label>
              <input id="task-query" name="query" type="search" defaultValue={page.query ?? ""} maxLength={GLOBAL_TASK_INBOX_QUERY_MAX_LENGTH} aria-describedby="task-query-help" className="mt-1.5 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-base outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-200" />
              <p id="task-query-help" className="mt-1 text-xs leading-5 text-slate-500">Sucht im Titel und im sicheren Beschreibungstext.</p>
            </div>
            <button type="submit" className="min-h-11 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Anzeigen</button>
          </form>
          {filtersActive ? (
            <Link href={`/w/${workspaceId}/aufgaben`} className="mt-4 inline-flex min-h-11 items-center text-sm font-semibold text-blue-700 outline-none hover:underline focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Filter zurücksetzen</Link>
          ) : null}
        </section>

        <section aria-labelledby="task-results-title" className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 id="task-results-title" className="text-xl font-semibold">Ergebnisse</h2>
            <p className="text-sm tabular-nums text-slate-600">{page.items.length} auf dieser Seite</p>
          </div>
          {page.items.length === 0 ? (
            <div className="mt-4 rounded-lg border border-dashed border-slate-300 bg-white px-5 py-12 text-center">
              <h3 className="text-lg font-semibold">Keine passenden Aufgaben</h3>
              <p className="mt-2 text-sm leading-6 text-slate-600">Passe Suche oder Filter an. Archivierte Aufgaben bleiben ausschließlich in der jeweiligen Projektakte verfügbar.</p>
            </div>
          ) : (
            <ul className="mt-4 grid list-none gap-3" aria-label="Gefilterte Aufgaben">
              {page.items.map((task) => (
                <li key={task.id}>
                  <InboxTaskCard workspaceId={workspaceId} task={task} bounds={bounds} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {firstHref !== null || nextHref !== null ? (
          <nav aria-label="Aufgabenseiten" className="mt-6 flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-4">
            {firstHref !== null ? <Link href={firstHref} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Erste Seite</Link> : null}
            {nextHref !== null ? <Link href={nextHref} className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Weitere Aufgaben</Link> : null}
          </nav>
        ) : null}
      </div>
    </main>
  );
}
