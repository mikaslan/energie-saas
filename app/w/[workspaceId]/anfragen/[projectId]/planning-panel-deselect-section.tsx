// F3-04b Einzelmodul-Abwahl: Projekt-Sektion (Client). UI-Vertrag aus der
// E2E-Spec tests/e2e/f3-04b-deselect.spec.ts — Testids exakt einhalten.
// Abwahl-Formular (Gruppe + Zeile/Spalte + optionale Begruendung) +
// Liste + Effektiv-Count je Dach-Scope der Panelgruppen-Sektion.
// Viewer read-only (Muster: planning-string-equipment-section.tsx).
"use client";

import { useActionState, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  removePlanningPanelDeselectAction,
  savePlanningPanelDeselectAction,
  type PlanningPanelDeselectActionState,
} from "./planning-panel-deselect-actions";
import {
  type PlanningPanelDeselectGroupOption,
  type PlanningPanelDeselectListItem,
} from "./planning-panel-deselect-model";

const initialDeselectAction: PlanningPanelDeselectActionState = { status: "idle" };

const DESELECT_GROUP_MESSAGE = "Bitte eine Panel-Gruppe wählen.";
const DESELECT_RANGE_MESSAGE = "Zeile und Spalte müssen ganze Zahlen ab 1 sein.";
const DESELECT_REASON_MESSAGE = "Die Begründung darf höchstens 280 Zeichen lang sein.";

function parseInteger(raw: string): number {
  if (raw.trim() === "") return Number.NaN;
  return Number.parseInt(raw.trim(), 10);
}

function actionFallbackMessage(state: PlanningPanelDeselectActionState): string | null {
  if (state.status === "not_found") return "Der Eintrag wurde nicht gefunden.";
  if (state.status === "denied") return "Dir fehlt die Berechtigung für diese Aktion.";
  if (state.status === "unauthenticated") return "Deine Sitzung ist abgelaufen.";
  return null;
}

function FormFeedback({
  state,
  clientError,
}: {
  state: PlanningPanelDeselectActionState;
  clientError: string | null;
}) {
  if (clientError) {
    return (
      <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
        {clientError}
      </p>
    );
  }
  if (state.status === "idle") return null;
  if (state.status === "success" || state.status === "invalid") {
    return (
      <p
        role={state.status === "invalid" ? "alert" : "status"}
        className={
          state.status === "invalid"
            ? "mt-3 text-sm font-semibold text-red-700"
            : "mt-3 text-sm font-semibold text-emerald-700"
        }
      >
        {state.message}
      </p>
    );
  }
  return (
    <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
      {actionFallbackMessage(state)}
    </p>
  );
}

export function PlanningPanelDeselectSection({
  workspaceId,
  projectId,
  groups,
  deselects,
  effectiveCount,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  groups: PlanningPanelDeselectGroupOption[];
  deselects: PlanningPanelDeselectListItem[];
  effectiveCount: number;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [saveState, saveDispatch] = useActionState(
    savePlanningPanelDeselectAction,
    initialDeselectAction,
  );
  const [removeState, removeDispatch] = useActionState(
    removePlanningPanelDeselectAction,
    initialDeselectAction,
  );
  const [deselectError, setDeselectError] = useState<string | null>(null);

  useEffect(() => {
    if (saveState.status === "success" || removeState.status === "success") {
      router.refresh();
    }
  }, [saveState, removeState, router]);

  function handleDeselectSubmit(event: FormEvent<HTMLFormElement>): void {
    const form = new FormData(event.currentTarget);
    const groupId = form.get("groupId");
    if (typeof groupId !== "string" || groupId === "") {
      event.preventDefault();
      setDeselectError(DESELECT_GROUP_MESSAGE);
      return;
    }
    const row = form.get("row");
    const col = form.get("col");
    const parsedRow = typeof row === "string" ? parseInteger(row) : Number.NaN;
    const parsedCol = typeof col === "string" ? parseInteger(col) : Number.NaN;
    if (
      !Number.isInteger(parsedRow)
      || parsedRow < 1
      || !Number.isInteger(parsedCol)
      || parsedCol < 1
    ) {
      event.preventDefault();
      setDeselectError(DESELECT_RANGE_MESSAGE);
      return;
    }
    const reason = form.get("reason");
    if (typeof reason === "string" && reason.trim().length > 280) {
      event.preventDefault();
      setDeselectError(DESELECT_REASON_MESSAGE);
      return;
    }
    setDeselectError(null);
  }

  return (
    <section
      data-testid="planning-panel-deselect-section"
      aria-label="Einzelmodul-Abwahl"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-900">Einzelmodul-Abwahl</h2>
      <p className="mt-1 text-sm text-slate-600">
        Stufe-0 ohne String-/Equipment-Wirkung — einzelne Zellen je Panel-Gruppe abwählen,
        Doppel-Abwahl ist ein No-op.
      </p>
      <p data-testid="planning-panel-deselect-count" className="mt-2 text-sm text-slate-900">
        {`Effektive Module: ${effectiveCount}`}
      </p>

      {deselects.length === 0 ? (
        <p data-testid="planning-panel-deselect-empty" className="mt-2 text-sm text-slate-600">
          Noch keine Abwahl angelegt.
        </p>
      ) : null}
      <ul data-testid="planning-panel-deselect-list" className="mt-2 grid gap-2">
        {deselects.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-3 py-2"
          >
            <span className="text-sm font-semibold text-slate-900">
              {`Gruppe ${entry.groupLabel}, Zeile ${entry.row}, Spalte ${entry.col}`}
            </span>
            {entry.reason ? (
              <span className="text-sm text-slate-500">{entry.reason}</span>
            ) : null}
            {canWrite ? (
              <form action={removeDispatch} className="ml-auto">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="deselectId" value={entry.id} />
                <button
                  type="submit"
                  data-testid="planning-panel-deselect-delete"
                  className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                >
                  Entfernen
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {removeState.status !== "idle" ? (
        <FormFeedback state={removeState} clientError={null} />
      ) : null}
      {canWrite ? (
        <form
          data-testid="planning-panel-deselect-form"
          action={saveDispatch}
          onSubmit={handleDeselectSubmit}
          className="mt-3 border-t border-slate-100 pt-3"
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-sm text-slate-600">
              Panel-Gruppe
              <select
                name="groupId"
                data-testid="planning-panel-deselect-group"
                defaultValue=""
                onChange={() => setDeselectError(null)}
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              >
                <option value="">Bitte wählen</option>
                {groups.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-slate-600">
              Zeile
              <input
                type="text"
                name="row"
                data-testid="planning-panel-deselect-row"
                inputMode="numeric"
                autoComplete="off"
                onChange={() => setDeselectError(null)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Spalte
              <input
                type="text"
                name="col"
                data-testid="planning-panel-deselect-col"
                inputMode="numeric"
                autoComplete="off"
                onChange={() => setDeselectError(null)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Begründung (optional)
              <input
                type="text"
                name="reason"
                data-testid="planning-panel-deselect-reason"
                maxLength={280}
                autoComplete="off"
                onChange={() => setDeselectError(null)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
          </div>
          <button
            type="submit"
            data-testid="planning-panel-deselect-create"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Abwahl speichern
          </button>
          <FormFeedback state={saveState} clientError={deselectError} />
        </form>
      ) : null}
    </section>
  );
}
