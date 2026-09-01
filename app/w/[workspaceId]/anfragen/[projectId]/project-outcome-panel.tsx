"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useRef } from "react";
import type { ProjectOutcomeContext } from "@/modules/projects";
import {
  changeProjectOutcomeAction,
  type ProjectOutcomeActionState,
} from "./outcome-actions";

const INITIAL_STATE: ProjectOutcomeActionState = { status: "idle" };

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function outcomeLabel(outcome: ProjectOutcomeContext["outcome"]): string {
  switch (outcome) {
    case "open": return "Offen";
    case "won": return "Gewonnen";
    case "lost": return "Verloren";
    case "cannot_fulfill": return "Nicht erfüllbar";
  }
}

function feedback(state: ProjectOutcomeActionState): string {
  switch (state.status) {
    case "success":
      return state.outcome === "open"
        ? "Die Anfrage wurde wieder geöffnet."
        : state.outcome === "won"
          ? "Die Anfrage wurde als gewonnen abgeschlossen."
          : "Die Anfrage wurde als verloren abgeschlossen.";
    case "invalid":
      return "Die Eingabe ist unvollständig oder ungültig. Bitte prüfe die Angaben.";
    case "not_found":
      return "Die Anfrage ist nicht mehr verfügbar.";
    case "conflict":
      return "Der Status wurde zwischenzeitlich geändert. Die Projektakte wird aktualisiert; deine Eingabe bleibt erhalten.";
    case "illegal_transition":
      return "Diese Statusänderung ist aus dem aktuellen Zustand nicht mehr zulässig.";
    case "loss_reason_unavailable":
      return "Der gewählte Verlustgrund ist nicht mehr aktiv. Bitte wähle einen anderen Grund.";
    case "denied":
      return "Für diese Statusänderung fehlt dir die Berechtigung.";
    case "unauthenticated":
      return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu und melde dich erneut an.";
    default:
      return "";
  }
}

function CommonFields({
  commandVersion,
  kind,
  projectId,
  revision,
}: {
  commandVersion: string;
  kind: "mark_won" | "mark_lost" | "reopen";
  projectId: string;
  revision: number;
}) {
  return (
    <>
      <input type="hidden" name="schemaVersion" value={commandVersion} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="expectedOutcomeRevision" value={revision} />
      <input type="hidden" name="confirmation" value={kind} />
    </>
  );
}

export function ProjectOutcomePanel({
  workspaceId,
  commandVersion,
  context,
}: {
  workspaceId: string;
  commandVersion: string;
  context: ProjectOutcomeContext;
}) {
  const boundAction = useMemo(
    () => changeProjectOutcomeAction.bind(null, workspaceId),
    [workspaceId],
  );
  const [state, action, pending] = useActionState(boundAction, INITIAL_STATE);
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const message = feedback(state);
  const error = state.status !== "idle" && state.status !== "success";

  useEffect(() => {
    if (state.status !== "idle") feedbackRef.current?.focus();
  }, [state]);

  return (
    <section
      id="project-outcome"
      aria-labelledby="project-outcome-title"
      className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
            Geschäftsergebnis
          </p>
          <h2 id="project-outcome-title" className="mt-1 text-lg font-semibold text-slate-950">
            Anfrage-Status
          </h2>
        </div>
        <span className="rounded-full border border-slate-300 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-800">
          {outcomeLabel(context.outcome)} · Stand {context.outcomeRevision}
        </span>
      </div>

      <dl className="mt-4 grid gap-2 text-sm">
        <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
          <dt className="font-medium text-slate-500">Abgeschlossen</dt>
          <dd className="break-words text-slate-900">
            {context.closedAt === null
              ? "Nein"
              : dateFormatter.format(new Date(context.closedAt))}
          </dd>
        </div>
        {context.lossReason ? (
          <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="font-medium text-slate-500">Verlustgrund</dt>
            <dd className="break-words text-slate-900">
              {context.lossReason.label}{context.lossReason.archived ? " (archiviert)" : ""}
            </dd>
          </div>
        ) : null}
        {context.lossReasonText ? (
          <div className="grid gap-1 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <dt className="font-medium text-slate-500">Interner Hinweis</dt>
            <dd className="break-words whitespace-pre-wrap text-slate-900">
              {context.lossReasonText}
            </dd>
          </div>
        ) : null}
      </dl>

      <p
        ref={feedbackRef}
        tabIndex={-1}
        role={error ? "alert" : "status"}
        aria-live={error ? "assertive" : "polite"}
        aria-atomic="true"
        className={message
          ? `mt-4 rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 ${error
            ? "border-amber-200 bg-amber-50 text-amber-950 focus-visible:ring-amber-600"
            : "border-emerald-200 bg-emerald-50 text-emerald-950 focus-visible:ring-emerald-600"}`
          : "sr-only"}
      >
        {message}
      </p>

      {context.permissions.canChangeOutcome ? (
        <fieldset disabled={pending} className="mt-5 grid min-w-0 gap-4 disabled:opacity-70">
          <legend className="sr-only">Anfrage-Status ändern</legend>
          {context.outcome === "open" ? (
            <>
              <details className="rounded-md border border-emerald-200 bg-emerald-50 p-3">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-emerald-950 outline-none focus-visible:ring-2 focus-visible:ring-emerald-600">
                  Als gewonnen abschließen
                </summary>
                <p className="mt-2 text-sm leading-6 text-emerald-900">
                  Die Anfrage verschwindet aus dem offenen Board und bleibt unter Abgeschlossen auffindbar.
                </p>
                <form action={action} className="mt-3">
                  <CommonFields commandVersion={commandVersion} kind="mark_won" projectId={context.projectId} revision={context.outcomeRevision} />
                  <button type="submit" className="min-h-11 rounded-md bg-emerald-700 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-emerald-800 focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2 disabled:cursor-wait">
                    Gewonnen verbindlich bestätigen
                  </button>
                </form>
              </details>

              <details className="rounded-md border border-amber-200 bg-amber-50 p-3">
                <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-amber-950 outline-none focus-visible:ring-2 focus-visible:ring-amber-600">
                  Als verloren abschließen
                </summary>
                {context.activeLossReasons.length === 0 ? (
                  <div className="mt-2 text-sm leading-6 text-amber-950">
                    <p>Vor einem Lost-Abschluss muss ein Admin mindestens einen aktiven Verlustgrund anlegen.</p>
                    {context.permissions.canManageReasons ? (
                      <Link href={`/w/${workspaceId}/einstellungen/verlustgruende`} className="mt-2 inline-flex min-h-11 items-center font-semibold text-blue-800 underline outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                        Verlustgründe verwalten
                      </Link>
                    ) : null}
                  </div>
                ) : (
                  <form action={action} className="mt-3 grid min-w-0 gap-3">
                    <CommonFields commandVersion={commandVersion} kind="mark_lost" projectId={context.projectId} revision={context.outcomeRevision} />
                    <label className="grid min-w-0 gap-1.5 text-sm font-medium text-slate-900">
                      Verlustgrund
                      <select name="lossReasonId" required defaultValue="" className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-base outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 sm:text-sm">
                        <option value="" disabled>Bitte auswählen</option>
                        {context.activeLossReasons.map((reason) => (
                          <option key={reason.id} value={reason.id}>{reason.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="grid min-w-0 gap-1.5 text-sm font-medium text-slate-900">
                      Interner Hinweis (optional)
                      <textarea name="lossReasonText" maxLength={500} rows={4} className="min-h-24 min-w-0 resize-y rounded-md border border-slate-300 bg-white px-3 py-2 text-base outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 sm:text-sm" />
                    </label>
                    <button type="submit" className="min-h-11 justify-self-start rounded-md bg-amber-800 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-amber-900 focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2 disabled:cursor-wait">
                      Verloren verbindlich bestätigen
                    </button>
                  </form>
                )}
              </details>
            </>
          ) : context.outcome === "won" || context.outcome === "lost" ? (
            <details className="rounded-md border border-blue-200 bg-blue-50 p-3">
              <summary className="flex min-h-11 cursor-pointer items-center text-sm font-semibold text-blue-950 outline-none focus-visible:ring-2 focus-visible:ring-blue-600">
                Anfrage wieder öffnen
              </summary>
              <p className="mt-2 text-sm leading-6 text-blue-900">
                Die Anfrage kehrt in dieselbe Kanban-Spalte zurück. Ein aktiver Verlustgrund und der interne Hinweis werden vom Projekt entfernt.
              </p>
              <form action={action} className="mt-3">
                <CommonFields commandVersion={commandVersion} kind="reopen" projectId={context.projectId} revision={context.outcomeRevision} />
                <button type="submit" className="min-h-11 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait">
                  Wieder öffnen bestätigen
                </button>
              </form>
            </details>
          ) : (
            <p className="text-sm leading-6 text-slate-600">
              Dieser Status wird in diesem Arbeitsschritt nicht verändert.
            </p>
          )}
        </fieldset>
      ) : (
        <p className="mt-5 border-t border-slate-200 pt-4 text-sm leading-6 text-slate-600">
          Du kannst das Geschäftsergebnis sehen, aber nicht verändern.
        </p>
      )}
    </section>
  );
}
