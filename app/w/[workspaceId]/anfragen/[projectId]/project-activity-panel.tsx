import Link from "next/link";
import type {
  ProjectActivityKind,
  ProjectActivityPageV1,
} from "@/modules/tasks";

const ACTIVITY_LABELS = {
  task_created: "Aufgabe erstellt",
  task_updated: "Aufgabe aktualisiert",
  task_checklist_changed: "Checkliste aktualisiert",
  task_completed: "Aufgabe abgeschlossen",
  task_reopened: "Aufgabe wieder geöffnet",
  task_archived: "Aufgabe archiviert",
} as const satisfies Record<ProjectActivityKind, string>;

const activityDateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function formatActivityDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Zeitpunkt nicht verfügbar" : activityDateFormatter.format(date);
}

export function ProjectActivityPanel({
  activity,
  nextHref,
  latestHref,
}: {
  activity: ProjectActivityPageV1;
  nextHref: string | null;
  latestHref: string | null;
}) {
  return (
    <section
      id="project-activity"
      aria-labelledby="project-activity-title"
      className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
        Verlauf
      </p>
      <h2 id="project-activity-title" className="mt-1 text-lg font-semibold text-slate-950">
        Interne Aktivität
      </h2>

      {activity.items.length === 0 ? (
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Für dieses Projekt gibt es noch keine Aufgabenaktivität.
        </p>
      ) : (
        <ol role="list" className="mt-4 grid list-none gap-3">
          {activity.items.map((item) => (
            <li key={item.id} className="min-w-0 border-l-2 border-blue-200 pl-3">
              <p className="break-words text-sm font-semibold text-slate-900">
                {ACTIVITY_LABELS[item.kind]}
              </p>
              <p className="mt-1 break-words text-xs font-semibold leading-5 text-slate-700">
                Aufgabe: {item.taskTitle ?? "Nicht mehr verfügbar"}
              </p>
              <p className="mt-1 break-all text-xs leading-5 text-slate-600">
                {item.actorLabel}
                <span aria-hidden="true"> · </span>
                <time dateTime={item.occurredAt}>{formatActivityDate(item.occurredAt)}</time>
              </p>
            </li>
          ))}
        </ol>
      )}

      {latestHref !== null || (activity.nextCursor !== null && nextHref !== null) ? (
        <nav aria-label="Aktivitätsseiten" className="mt-5 flex flex-wrap gap-2 border-t border-slate-200 pt-4">
          {latestHref !== null ? (
            <Link href={latestHref} className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
              Neueste Aktivität
            </Link>
          ) : null}
          {activity.nextCursor !== null && nextHref !== null ? (
            <Link href={nextHref} className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-3 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">
              Ältere Aktivität
            </Link>
          ) : null}
        </nav>
      ) : null}
    </section>
  );
}
