// F3-05a Stringplanung: Projekt-Sektion (Client). UI-Vertrag aus der
// E2E-Spec tests/e2e/f3-05a-strings.spec.ts — Testids exakt einhalten.
// WR-Anlage (Label + Tracker-Zahl) und String-Anlage (WR-Select + Slot +
// Gruppen-Multi-Select) in einer Sektion; Advisories je String inline
// (Warnliste, nie Reject). Viewer read-only (Muster:
// planning-panel-group-section.tsx).
"use client";

import { useActionState, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  savePlanningInverterAction,
  type PlanningInverterActionState,
} from "./planning-inverter-actions";
import {
  removePlanningStringAction,
  savePlanningStringAction,
  type PlanningStringActionState,
} from "./planning-string-actions";
import type { PlanningInverterDto } from "./planning-inverter-model";
import {
  planningStringAdvisoryText,
  type PlanningStringGroupOption,
  type PlanningStringListItem,
} from "./planning-string-model";

const initialInverterAction: PlanningInverterActionState = { status: "idle" };
const initialStringAction: PlanningStringActionState = { status: "idle" };

const INVERTER_LABEL_MESSAGE = "Bitte eine Bezeichnung angeben.";
const INVERTER_TRACKERS_MESSAGE = "Die Tracker-Zahl muss eine ganze Zahl von 1–12 sein.";
const STRING_INVERTER_MESSAGE = "Bitte einen Wechselrichter wählen.";
const STRING_SLOT_MESSAGE = "Der Tracker-Slot muss eine ganze Zahl ab 1 sein.";
const STRING_LABEL_MESSAGE = "Bitte eine Bezeichnung angeben.";
const STRING_GROUPS_MESSAGE = "Bitte mindestens eine Panel-Gruppe wählen.";

function parseInteger(raw: string): number {
  if (raw.trim() === "") return Number.NaN;
  return Number.parseInt(raw.trim(), 10);
}

function actionFallbackMessage(
  state:
    | PlanningInverterActionState
    | PlanningStringActionState,
): string | null {
  if (state.status === "not_found") return "Der Eintrag wurde nicht gefunden.";
  if (state.status === "denied") return "Dir fehlt die Berechtigung für diese Aktion.";
  if (state.status === "unauthenticated") return "Deine Sitzung ist abgelaufen.";
  return null;
}

function FormFeedback({
  state,
  clientError,
}: {
  state: PlanningInverterActionState | PlanningStringActionState;
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

export function PlanningStringsSection({
  workspaceId,
  projectId,
  inverters,
  strings,
  groups,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  inverters: PlanningInverterDto[];
  strings: PlanningStringListItem[];
  groups: PlanningStringGroupOption[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [inverterState, inverterDispatch] = useActionState(
    savePlanningInverterAction,
    initialInverterAction,
  );
  const [saveState, saveDispatch] = useActionState(savePlanningStringAction, initialStringAction);
  const [removeState, removeDispatch] = useActionState(
    removePlanningStringAction,
    initialStringAction,
  );
  const [inverterError, setInverterError] = useState<string | null>(null);
  const [stringError, setStringError] = useState<string | null>(null);

  useEffect(() => {
    if (
      inverterState.status === "success"
      || saveState.status === "success"
      || removeState.status === "success"
    ) {
      router.refresh();
    }
  }, [inverterState, saveState, removeState, router]);

  function handleInverterSubmit(event: FormEvent<HTMLFormElement>): void {
    const form = new FormData(event.currentTarget);
    const label = form.get("label");
    if (typeof label !== "string" || label.length < 1) {
      event.preventDefault();
      setInverterError(INVERTER_LABEL_MESSAGE);
      return;
    }
    const trackers = form.get("mppTrackers");
    const parsed = typeof trackers === "string" ? parseInteger(trackers) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 12) {
      event.preventDefault();
      setInverterError(INVERTER_TRACKERS_MESSAGE);
      return;
    }
    setInverterError(null);
  }

  function handleStringSubmit(event: FormEvent<HTMLFormElement>): void {
    const form = new FormData(event.currentTarget);
    const inverterId = form.get("inverterId");
    if (typeof inverterId !== "string" || inverterId === "") {
      event.preventDefault();
      setStringError(STRING_INVERTER_MESSAGE);
      return;
    }
    const slot = form.get("trackerSlot");
    const parsed = typeof slot === "string" ? parseInteger(slot) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < 1) {
      event.preventDefault();
      setStringError(STRING_SLOT_MESSAGE);
      return;
    }
    const label = form.get("label");
    if (typeof label !== "string" || label.length < 1) {
      event.preventDefault();
      setStringError(STRING_LABEL_MESSAGE);
      return;
    }
    if (form.getAll("groupIds").length < 1) {
      event.preventDefault();
      setStringError(STRING_GROUPS_MESSAGE);
      return;
    }
    setStringError(null);
  }

  // Advisories aus der Create-Response rendern, bis der Refresh den
  // String in die Liste spiegelt (danach Single-Source aus dem Panel,
  // damit der Testid je String genau einmal vorkommt).
  const pendingAdvisories =
    saveState.status === "success" && saveState.string
      ? strings.some((entry) => entry.id === saveState.string?.id)
        ? []
        : saveState.advisories
      : [];

  return (
    <section
      data-testid="planning-strings-section"
      aria-label="Wechselrichter und Strings"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-900">Wechselrichter und Strings</h2>
      <p className="mt-1 text-sm text-slate-600">
        Stufe-0 ohne Auto-Fill und Optimierer — Strings aus ganzen Panel-Gruppen, Hinweise sind
        Warnungen.
      </p>

      <h3 className="mt-3 text-sm font-semibold text-slate-900">Wechselrichter</h3>
      <ul data-testid="planning-inverters-list" className="mt-2 grid gap-2">
        {inverters.map((inverter) => (
          <li
            key={inverter.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-3 py-2"
          >
            <span className="text-sm font-semibold text-slate-900">{inverter.label}</span>
            <span className="text-sm text-slate-500">
              {`${inverter.mppTrackers} MPP-Tracker`}
            </span>
          </li>
        ))}
      </ul>
      {canWrite ? (
        <form
          data-testid="planning-inverters-form"
          action={inverterDispatch}
          onSubmit={handleInverterSubmit}
          className="mt-3 border-t border-slate-100 pt-3"
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-sm text-slate-600">
              Bezeichnung
              <input
                type="text"
                name="label"
                data-testid="planning-inverters-label"
                autoComplete="off"
                maxLength={120}
                onChange={() => setInverterError(null)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              MPP-Tracker
              <input
                type="text"
                name="mppTrackers"
                data-testid="planning-inverters-trackers"
                inputMode="numeric"
                autoComplete="off"
                onChange={() => setInverterError(null)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
          </div>
          <button
            type="submit"
            data-testid="planning-inverters-create"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Wechselrichter speichern
          </button>
          <FormFeedback state={inverterState} clientError={inverterError} />
        </form>
      ) : null}

      <h3 className="mt-4 text-sm font-semibold text-slate-900">Strings</h3>
      {strings.length === 0 ? (
        <p data-testid="planning-strings-empty" className="mt-2 text-sm text-slate-600">
          Noch keine Strings angelegt.
        </p>
      ) : null}
      <ul data-testid="planning-strings-list" className="mt-2 grid gap-2">
        {strings.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-3 py-2"
          >
            <span className="text-sm font-semibold text-slate-900">{entry.label}</span>
            <span className="text-sm text-slate-600">
              {`${entry.inverterLabel} · Slot ${entry.trackerSlot}`}
            </span>
            <span className="text-sm text-slate-500">
              {entry.memberLabels.length > 0
                ? `Gruppen: ${entry.memberLabels.join(", ")}`
                : "Gruppen: –"}
            </span>
            {entry.advisories.map((advisory, index) => (
              <p
                key={`${advisory.code}-${index}`}
                data-testid="planning-strings-advisory"
                className="w-full text-sm font-semibold text-amber-700"
              >
                {planningStringAdvisoryText(advisory)}
              </p>
            ))}
            {canWrite ? (
              <form action={removeDispatch} className="ml-auto">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="stringId" value={entry.id} />
                <button
                  type="submit"
                  data-testid="planning-strings-delete"
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
          data-testid="planning-strings-form"
          action={saveDispatch}
          onSubmit={handleStringSubmit}
          className="mt-3 border-t border-slate-100 pt-3"
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-sm text-slate-600">
              Wechselrichter
              <select
                name="inverterId"
                defaultValue=""
                onChange={() => setStringError(null)}
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              >
                <option value="">Bitte wählen</option>
                {inverters.map((inverter) => (
                  <option key={inverter.id} value={inverter.id}>
                    {inverter.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-slate-600">
              Tracker-Slot
              <input
                type="text"
                name="trackerSlot"
                inputMode="numeric"
                autoComplete="off"
                onChange={() => setStringError(null)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              String-Label
              <input
                type="text"
                name="label"
                autoComplete="off"
                maxLength={120}
                onChange={() => setStringError(null)}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
          </div>
          <fieldset className="mt-2">
            <legend className="text-sm text-slate-600">Panel-Gruppen</legend>
            <div className="mt-1 grid gap-1">
              {groups.map((group) => (
                <label key={group.id} className="flex items-center gap-2 text-sm text-slate-800">
                  <input
                    type="checkbox"
                    name="groupIds"
                    value={group.id}
                    onChange={() => setStringError(null)}
                    className="h-4 w-4 accent-slate-900"
                  />
                  {group.label}
                </label>
              ))}
            </div>
          </fieldset>
          {pendingAdvisories.map((advisory, index) => (
            <p
              key={`${advisory.code}-${index}`}
              data-testid="planning-strings-advisory"
              className="mt-3 text-sm font-semibold text-amber-700"
            >
              {planningStringAdvisoryText(advisory)}
            </p>
          ))}
          <button
            type="submit"
            data-testid="planning-strings-create"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            String speichern
          </button>
          <FormFeedback state={saveState} clientError={stringError} />
        </form>
      ) : null}
    </section>
  );
}
