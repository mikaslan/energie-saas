"use client";

import { useActionState } from "react";
import {
  createServiceCaseAction,
  setServiceCaseStatusAction,
  type ServiceCaseActionState,
} from "./service-case-actions";
import type { ServiceCaseDto, ServiceCaseStatus } from "@/modules/service-cases";

const initialState: ServiceCaseActionState = { status: "idle" };

const STATUS_LABELS: Record<ServiceCaseStatus, string> = {
  open: "Offen",
  in_progress: "In Arbeit",
  done: "Erledigt",
  cancelled: "Abgebrochen",
};

const NEXT_ACTIONS: Record<ServiceCaseStatus, readonly ServiceCaseStatus[]> = {
  open: ["in_progress", "cancelled"],
  in_progress: ["done", "cancelled"],
  done: [],
  cancelled: [],
};

function Feedback({ state }: { state: ServiceCaseActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" className="mt-3 text-sm font-semibold text-emerald-700">
        {state.message}
      </p>
    );
  }
  const message =
    state.status === "invalid"
      ? "Die Eingabe ist ungültig."
      : state.status === "conflict"
        ? "Dieser Statuswechsel ist nicht möglich."
        : state.status === "not_found"
          ? "Der Vorgang wurde nicht gefunden."
          : state.status === "denied"
            ? "Dir fehlt die Berechtigung für diese Aktion."
            : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

// F13-01 Serviceauftrag: Liste + Anlegeformular + Statuswechsel.
// Reine Darstellung gespeicherter Vorgänge; keine Ableitungen.
export function ServiceCaseSection({
  workspaceId,
  projectId,
  cases,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  cases: ServiceCaseDto[];
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createServiceCaseAction, initialState);
  const [statusState, statusDispatch] = useActionState(setServiceCaseStatusAction, initialState);

  return (
    <section
      aria-label="Service und Wartung"
      data-service-cases="true"
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 className="text-base font-semibold text-slate-950">Service und Wartung</h2>
      {cases.length === 0 ? (
        <p className="mt-2 text-sm leading-6 text-slate-600">Keine Servicevorgänge erfasst.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {cases.map((serviceCase) => (
            <li key={serviceCase.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span className="text-sm text-slate-800">
                <span className="font-semibold">{serviceCase.title}</span>
                <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                  {STATUS_LABELS[serviceCase.status]}
                </span>
                {serviceCase.status === "done" && serviceCase.confirmedAt !== null ? (
                  <span
                    className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800"
                    data-testid={`service-case-confirmed-${serviceCase.id}`}
                  >
                    Kunde bestätigt
                  </span>
                ) : null}
                {serviceCase.dueDate ? (
                  <span className="block text-xs text-slate-500">Fällig: {serviceCase.dueDate}</span>
                ) : null}
                {serviceCase.description ? (
                  <span className="block text-xs text-slate-500">{serviceCase.description}</span>
                ) : null}
              </span>
              {canWrite && NEXT_ACTIONS[serviceCase.status].length > 0 ? (
                <span className="flex gap-2">
                  {NEXT_ACTIONS[serviceCase.status].map((next) => (
                    <form key={next} action={statusDispatch} className="inline">
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="id" value={serviceCase.id} />
                      <input type="hidden" name="status" value={next} />
                      <button
                        type="submit"
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
                      >
                        {next === "in_progress" ? "Starten" : next === "done" ? "Erledigen" : "Abbrechen"}
                      </button>
                    </form>
                  ))}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form action={createDispatch} className="mt-4 border-t border-slate-100 pt-4">
          <h3 className="text-sm font-semibold text-slate-950">Neuer Servicevorgang</h3>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Titel</span>
            <input
              type="text"
              name="title"
              required
              maxLength={160}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
            />
          </label>
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Beschreibung (optional)</span>
            <input
              type="text"
              name="description"
              maxLength={2000}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
            />
          </label>
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Fällig am (optional)</span>
            <input
              type="date"
              name="dueDate"
              className="mt-1 min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
            />
          </label>
          <button
            type="submit"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Vorgang anlegen
          </button>
        </form>
      ) : null}
      <Feedback state={createState} />
      <Feedback state={statusState} />
    </section>
  );
}
