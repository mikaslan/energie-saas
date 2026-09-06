"use client";

import { useActionState, useEffect, useRef } from "react";

import {
  WORKSPACE_PLANNING_SETTINGS_COMMAND_VERSION,
  type PlanningMode,
  type PlanningSettingsV1,
} from "@/lib/integrations/planning/contract";
import {
  upsertPlanningSettingsAction,
  type PlanningSettingsActionState,
} from "./actions";

const INITIAL_STATE: PlanningSettingsActionState = { status: "idle" };
const MODES: ReadonlyArray<{
  value: PlanningMode;
  title: string;
  description: string;
}> = [
  {
    value: "quick",
    title: "Quick",
    description: "Komponenten und Preise ohne Dach- und Modulplanung.",
  },
  {
    value: "2d",
    title: "2D",
    description: "Flächenbasierte Planung in der zweidimensionalen Ansicht.",
  },
  {
    value: "3d",
    title: "3D",
    description: "Detaillierte Gebäude- und Dachplanung in drei Dimensionen.",
  },
];

function actionMessage(
  state: PlanningSettingsActionState,
): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success":
      return { text: "Planungsstandard gespeichert.", isError: false };
    case "invalid":
      return { text: "Die Eingabe ist ungültig.", isError: true };
    case "conflict":
      return {
        text: state.currentRevision === undefined
          ? "Die Einstellung wurde zwischenzeitlich geändert. Bitte neu laden."
          : `Die Einstellung liegt inzwischen in Revision ${state.currentRevision} vor. Bitte neu laden.`,
        isError: true,
      };
    case "denied":
      return { text: "Dir fehlt die Berechtigung zum Speichern.", isError: true };
    case "unauthenticated":
      return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    case "unavailable":
      return { text: "Die Einstellung konnte nicht verlässlich gelesen werden.", isError: true };
    default:
      return null;
  }
}

function ReadOnlyPlanningSettings({ settings }: { settings: PlanningSettingsV1 }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-950">Planungsstandard</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Du kannst den aktuellen Standard sehen, aber nicht verändern.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {MODES.map((mode) => {
          const selected = mode.value === settings.defaultPlanningMode;
          return (
            <article
              key={mode.value}
              className={`rounded-md border p-4 ${
                selected
                  ? "border-blue-600 bg-blue-50"
                  : "border-slate-200 bg-slate-50"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-semibold text-slate-950">{mode.title}</h3>
                {selected ? (
                  <span className="rounded-full bg-blue-700 px-2 py-0.5 text-xs font-semibold text-white">
                    Aktuell
                  </span>
                ) : null}
              </div>
              <p className="mt-2 text-sm leading-5 text-slate-600">{mode.description}</p>
            </article>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-slate-500">Revision {settings.revision}</p>
    </section>
  );
}

export function PlanningSettingsForm({
  workspaceId,
  settings,
}: {
  workspaceId: string;
  settings: PlanningSettingsV1;
}) {
  const [state, dispatch, isPending] = useActionState(
    upsertPlanningSettingsAction,
    INITIAL_STATE,
  );
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const feedback = actionMessage(state);

  useEffect(() => {
    if (feedback?.isError) feedbackRef.current?.focus();
  }, [feedback?.isError, state]);

  if (!settings.permissions.canWrite) {
    return <ReadOnlyPlanningSettings settings={settings} />;
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <form
        key={`${settings.revision}:${settings.defaultPlanningMode}`}
        action={dispatch}
      >
        <input
          type="hidden"
          name="schemaVersion"
          value={WORKSPACE_PLANNING_SETTINGS_COMMAND_VERSION}
        />
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="baseRevision" value={settings.revision} />

        <fieldset>
          <legend className="text-base font-semibold text-slate-950">
            Planungsstandard
          </legend>
          <p id="planning-mode-help" className="mt-1 text-sm leading-6 text-slate-600">
            Dieser Wert wird nur für neu angelegte Angebotsvarianten übernommen.
            Bestehende Varianten bleiben unverändert.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {MODES.map((mode) => (
              <label
                key={mode.value}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-slate-300 p-4 outline-none has-[:checked]:border-blue-600 has-[:checked]:bg-blue-50 focus-within:ring-2 focus-within:ring-blue-600 focus-within:ring-offset-2"
              >
                <input
                  type="radio"
                  name="defaultPlanningMode"
                  value={mode.value}
                  defaultChecked={mode.value === settings.defaultPlanningMode}
                  aria-describedby="planning-mode-help"
                  className="mt-1 size-4 shrink-0 accent-blue-700"
                />
                <span className="min-w-0">
                  <span className="block font-semibold text-slate-950">{mode.title}</span>
                  <span className="mt-1 block text-sm leading-5 text-slate-600">
                    {mode.description}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <p
          ref={feedbackRef}
          tabIndex={-1}
          role={feedback?.isError ? "alert" : "status"}
          aria-live="polite"
          className={`mt-4 text-sm font-semibold ${
            feedback === null
              ? "hidden"
              : feedback.isError
                ? "text-red-700"
                : "text-green-700"
          }`}
        >
          {feedback?.text}
        </p>

        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={isPending}
            className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
          >
            {isPending ? "Speichert …" : "Speichern"}
          </button>
          <span className="text-xs text-slate-500">
            {settings.revision === 0
              ? "Noch nicht gespeichert"
              : `Revision ${settings.revision}`}
          </span>
        </div>
      </form>
    </section>
  );
}
