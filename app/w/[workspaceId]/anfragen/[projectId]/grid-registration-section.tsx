"use client";

import { useActionState } from "react";
import {
  GRID_REGISTRATION_STATUS_LABEL,
  nextGridRegistrationStatuses,
  type GridRegistrationDto,
} from "@/modules/grid-registration";
import {
  ensureGridRegistrationAction,
  setGridRegistrationDetailsAction,
  transitionGridRegistrationAction,
  type GridRegistrationActionState,
} from "./grid-registration-actions";

const initialState: GridRegistrationActionState = { status: "idle" };

function Feedback({ state, testId }: { state: GridRegistrationActionState; testId: string }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" data-testid={testId} className="mt-3 text-sm font-semibold text-emerald-700">
        {state.message}
      </p>
    );
  }
  const message =
    state.status === "invalid"
      ? "Die Eingabe ist ungültig."
      : state.status === "conflict"
        ? "Dieser Übergang ist nicht zulässig."
        : state.status === "not_found"
          ? "Der Vorgang ist nicht mehr verfügbar."
          : state.status === "denied"
            ? "Dir fehlt die Berechtigung für diese Aktion."
            : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" data-testid={testId} className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

// F13-02 Netzanmeldung: Anlage (idempotent), Betreiber/Zähler pflegen,
// Statusmaschine per Folge-Buttons. Reine Darstellung gespeicherter Werte.
export function GridRegistrationSection({
  workspaceId,
  projectId,
  registration,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  registration: GridRegistrationDto | null;
  canWrite: boolean;
}) {
  const [ensureState, ensureDispatch] = useActionState(ensureGridRegistrationAction, initialState);
  const [detailsState, detailsDispatch] = useActionState(setGridRegistrationDetailsAction, initialState);
  const [transitionState, transitionDispatch] = useActionState(transitionGridRegistrationAction, initialState);
  const next = registration === null ? [] : nextGridRegistrationStatuses(registration.status);

  return (
    <section aria-label="Netzanmeldung" className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Netzanmeldung</h2>
      {registration === null ? (
        <div className="mt-2">
          <p className="text-sm text-slate-600" data-testid="grid-registration-current">
            Noch keine Netzanmeldung für dieses Projekt.
          </p>
          {canWrite ? (
            <form action={ensureDispatch} className="mt-3">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <button
                type="submit"
                data-testid="grid-registration-create"
                className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Netzanmeldung anlegen
              </button>
            </form>
          ) : null}
          <Feedback state={ensureState} testId="grid-registration-feedback" />
        </div>
      ) : (
        <div className="mt-2 grid gap-3">
          <p className="text-sm text-slate-700" data-testid="grid-registration-current">
            Status: <span className="font-semibold">{GRID_REGISTRATION_STATUS_LABEL[registration.status]}</span>
            {registration.operatorName ? ` · ${registration.operatorName}` : null}
            {registration.meterNumber ? ` · Zähler ${registration.meterNumber}` : null}
          </p>
          {canWrite ? (
            <>
              <form action={detailsDispatch} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="projectId" value={projectId} />
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Netzbetreiber
                  <input
                    type="text"
                    name="operatorName"
                    maxLength={160}
                    defaultValue={registration.operatorName ?? ""}
                    data-testid="grid-registration-operator"
                    className="min-h-11 min-w-44 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200"
                  />
                </label>
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Zählernummer
                  <input
                    type="text"
                    name="meterNumber"
                    maxLength={64}
                    defaultValue={registration.meterNumber ?? ""}
                    data-testid="grid-registration-meter"
                    className="min-h-11 min-w-36 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200"
                  />
                </label>
                <button
                  type="submit"
                  data-testid="grid-registration-save"
                  className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                >
                  Speichern
                </button>
              </form>
              <Feedback state={detailsState} testId="grid-registration-details-feedback" />
              {next.length > 0 ? (
                <form action={transitionDispatch} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="projectId" value={projectId} />
                  {next.map((status) => (
                    <button
                      key={status}
                      type="submit"
                      name="status"
                      value={status}
                      data-testid={`grid-registration-to-${status}`}
                      className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                    >
                      {GRID_REGISTRATION_STATUS_LABEL[status]}
                    </button>
                  ))}
                </form>
              ) : null}
              <Feedback state={transitionState} testId="grid-registration-transition-feedback" />
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}
