"use client";

import { useActionState, useState } from "react";
import {
  INSTALLATION_STATUS_LABEL_DEFAULTS,
  INSTALLATION_STATUS_LABEL_KEYS,
  type InstallationStatusLabelKey,
  type InstallationStatusLabels,
} from "@/lib/integrations/installations/status-label-contract";
import {
  resetStatusLabelAction,
  upsertStatusLabelAction,
  type StatusLabelActionState,
} from "./actions";

const initialState: StatusLabelActionState = { status: "idle" };

const ROW_TITLES: Record<InstallationStatusLabelKey, string> = {
  active: "Laufende Installation",
  completed: "Abgeschlossene Installation",
  handover: "Abgenommene Installation",
};

function Feedback({ state }: { state: StatusLabelActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return <p role="status" className="mt-2 text-sm font-medium text-green-700">{state.message}</p>;
  }
  const message =
    state.status === "denied"
      ? "Dafür fehlt dir die Installations-Freigabe."
      : state.status === "unauthenticated"
        ? "Bitte erneut anmelden."
        : "Eingaben prüfen (Bezeichnung 1–80 Zeichen, kein Leertext).";
  return <p role="alert" className="mt-2 text-sm font-medium text-red-700">{message}</p>;
}

// F10-05: eine Zeile je Anzeigestand (Speichern + Zurücksetzen auf
// Standard). Remount bei Erfolg (stale-DOM, Muster Aufgaben-Vorlagen).
function StatusLabelRow({
  workspaceId,
  stateKey,
  current,
  canWrite,
}: {
  workspaceId: string;
  stateKey: InstallationStatusLabelKey;
  current: string | null;
  canWrite: boolean;
}) {
  const [upsertState, upsertDispatch] = useActionState(upsertStatusLabelAction, initialState);
  const [resetState, resetDispatch] = useActionState(resetStatusLabelAction, initialState);
  // Remount bei Erfolg/Datensatzwechsel (stale-DOM, Muster Aufgaben-Vorlagen).
  const [successCount, setSuccessCount] = useState(0);
  const [prevStatuses, setPrevStatuses] = useState(
    `${upsertState.status}/${resetState.status}`,
  );
  const combined = `${upsertState.status}/${resetState.status}`;
  if (prevStatuses !== combined) {
    setPrevStatuses(combined);
    if (upsertState.status === "success" || resetState.status === "success") {
      setSuccessCount((count) => count + 1);
    }
  }
  const standard = INSTALLATION_STATUS_LABEL_DEFAULTS[stateKey];
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-950">{ROW_TITLES[stateKey]}</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        Aktuell: {current ?? `Standard („${standard}“)`}
      </p>
      {canWrite ? (
        <div className="mt-3 grid gap-3">
          <form action={upsertDispatch} key={`set:${stateKey}:${current ?? ""}:${successCount}`} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="key" value={stateKey} />
            <label className="grid min-w-52 flex-1 gap-1 text-sm font-semibold text-slate-800">
              Bezeichnung für {ROW_TITLES[stateKey].toLowerCase()}
              <input
                type="text"
                name="label"
                defaultValue={current ?? ""}
                required
                maxLength={80}
                placeholder={standard}
                className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
              />
            </label>
            <button
              type="submit"
              className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              Speichern
            </button>
          </form>
          {current !== null ? (
            <form action={resetDispatch}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="key" value={stateKey} />
              <button
                type="submit"
                className="min-h-11 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                Auf Standard zurücksetzen
              </button>
            </form>
          ) : null}
          <Feedback state={upsertState} />
          <Feedback state={resetState} />
        </div>
      ) : (
        <p className="mt-1 text-sm leading-6 text-slate-500">
          Du hast Lesezugriff. Zum Ändern brauchst du Editor-Rechte.
        </p>
      )}
    </section>
  );
}

export function StatusLabelManager({
  workspaceId,
  labels,
  canWrite,
}: {
  workspaceId: string;
  labels: InstallationStatusLabels;
  canWrite: boolean;
}) {
  return (
    <div className="grid gap-4">
      {INSTALLATION_STATUS_LABEL_KEYS.map((stateKey) => (
        <StatusLabelRow
          key={stateKey}
          workspaceId={workspaceId}
          stateKey={stateKey}
          current={labels[stateKey]}
          canWrite={canWrite}
        />
      ))}
    </div>
  );
}
