"use client";

import { useActionState, useEffect, useMemo, useRef } from "react";
import type { ProjectLossReasonRecord } from "@/modules/projects";
import {
  changeProjectLossReasonAction,
  type ProjectLossReasonActionState,
} from "./actions";

const INITIAL_STATE: ProjectLossReasonActionState = { status: "idle" };

function message(state: ProjectLossReasonActionState): string {
  switch (state.status) {
    case "success":
      return state.operation === "create"
        ? "Der Verlustgrund wurde angelegt."
        : state.operation === "archive"
          ? "Der Verlustgrund wurde archiviert."
          : "Der Verlustgrund wurde reaktiviert.";
    case "invalid": return "Die Eingabe ist unvollständig oder ungültig.";
    case "not_found": return "Der Verlustgrund ist nicht mehr verfügbar.";
    case "conflict": return "Der Verlustgrund wurde zwischenzeitlich geändert. Die Liste wurde aktualisiert.";
    case "denied": return "Für diese Änderung fehlt dir die Berechtigung.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu.";
    default: return "";
  }
}

function CommandFields({
  commandVersion,
  kind,
  reason,
}: {
  commandVersion: string;
  kind: "archive" | "reactivate";
  reason: ProjectLossReasonRecord;
}) {
  return (
    <>
      <input type="hidden" name="schemaVersion" value={commandVersion} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="reasonId" value={reason.id} />
      <input type="hidden" name="expectedRevision" value={reason.revision} />
      {kind === "archive" ? <input type="hidden" name="archiveConfirmation" value="archive" /> : null}
    </>
  );
}

export function LossReasonManager({
  workspaceId,
  commandVersion,
  reasons,
}: {
  workspaceId: string;
  commandVersion: string;
  reasons: ProjectLossReasonRecord[];
}) {
  const boundAction = useMemo(
    () => changeProjectLossReasonAction.bind(null, workspaceId),
    [workspaceId],
  );
  const [state, action, pending] = useActionState(boundAction, INITIAL_STATE);
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const feedback = message(state);
  const error = state.status !== "idle" && state.status !== "success";

  useEffect(() => {
    if (state.status !== "idle") feedbackRef.current?.focus();
  }, [state]);

  return (
    <div className="grid min-w-0 gap-6">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-950">Neuen Verlustgrund anlegen</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Labels sind im gesamten Arbeitsbereich eindeutig und bleiben auch nach der Archivierung reserviert.
        </p>
        <form action={action} className="mt-4 grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <input type="hidden" name="schemaVersion" value={commandVersion} />
          <input type="hidden" name="kind" value="create" />
          <label className="grid min-w-0 gap-1.5 text-sm font-medium text-slate-900">
            Bezeichnung
            <input name="label" required minLength={1} maxLength={80} disabled={pending} autoComplete="off" className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-base outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 disabled:bg-slate-100 sm:text-sm" />
          </label>
          <button type="submit" disabled={pending} className="min-h-11 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400">
            Anlegen
          </button>
        </form>
      </section>

      <p ref={feedbackRef} tabIndex={-1} role={error ? "alert" : "status"} aria-live={error ? "assertive" : "polite"} aria-atomic="true" className={feedback ? `rounded-md border px-4 py-3 text-sm outline-none focus-visible:ring-2 ${error ? "border-amber-200 bg-amber-50 text-amber-950 focus-visible:ring-amber-600" : "border-emerald-200 bg-emerald-50 text-emerald-950 focus-visible:ring-emerald-600"}` : "sr-only"}>
        {feedback}
      </p>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-950">Verlustgründe</h2>
            <p className="mt-1 text-sm text-slate-600">Aktive Gründe stehen beim Lost-Abschluss zur Auswahl.</p>
          </div>
          <span className="text-xs font-semibold tabular-nums text-slate-500">{reasons.length} insgesamt</span>
        </div>
        {reasons.length === 0 ? (
          <p className="mt-5 rounded-md border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-600">Noch keine Verlustgründe angelegt.</p>
        ) : (
          <ul className="mt-5 grid list-none gap-3">
            {reasons.map((reason) => {
              const archived = reason.archivedAt !== null;
              return (
                <li key={reason.id} className="flex min-w-0 flex-col gap-3 rounded-md border border-slate-200 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-words text-sm font-semibold text-slate-950">{reason.label}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${archived ? "bg-slate-200 text-slate-700" : "bg-emerald-100 text-emerald-900"}`}>{archived ? "Archiviert" : "Aktiv"}</span>
                    </div>
                    <p className="mt-1 text-xs tabular-nums text-slate-500">Position {reason.position} · Stand {reason.revision}</p>
                  </div>
                  {archived ? (
                    <form action={action}>
                      <CommandFields commandVersion={commandVersion} kind="reactivate" reason={reason} />
                      <button type="submit" disabled={pending} className="min-h-11 rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-slate-400">Reaktivieren</button>
                    </form>
                  ) : (
                    <details className="min-w-0 sm:text-right">
                      <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-md px-3 text-sm font-semibold text-red-700 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2">Archivieren</summary>
                      <form action={action} className="mt-2 grid justify-items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3 text-left sm:justify-items-end">
                        <CommandFields commandVersion={commandVersion} kind="archive" reason={reason} />
                        <p className="max-w-xs text-xs leading-5 text-red-900">Der Grund verschwindet aus neuen Lost-Abschlüssen; bestehende Projektakten behalten ihr Label.</p>
                        <button type="submit" disabled={pending} className="min-h-11 rounded-md bg-red-700 px-4 text-sm font-semibold text-white outline-none hover:bg-red-800 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400">Archivierung bestätigen</button>
                      </form>
                    </details>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
