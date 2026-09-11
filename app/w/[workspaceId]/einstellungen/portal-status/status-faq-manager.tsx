"use client";

import { useActionState, useState } from "react";
import {
  INSTALLATION_STATUS_FAQ_KEYS,
  INSTALLATION_STATUS_FAQ_MAX,
  type InstallationStatusFaq,
  type InstallationStatusFaqKey,
} from "@/lib/integrations/installations/status-faq-contract";
import {
  resetStatusFaqAction,
  upsertStatusFaqAction,
  type StatusFaqActionState,
} from "./actions";

const initialState: StatusFaqActionState = { status: "idle" };

const ROW_TITLES: Record<InstallationStatusFaqKey, string> = {
  active: "Laufende Installation",
  completed: "Abgeschlossene Installation",
  handover: "Abgenommene Installation",
};

function Feedback({ state }: { state: StatusFaqActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return <p role="status" className="mt-2 text-sm font-medium text-green-700">{state.message}</p>;
  }
  const message =
    state.status === "denied"
      ? "Dafür fehlt dir die Installations-Freigabe."
      : state.status === "unauthenticated"
        ? "Bitte erneut anmelden."
        : `Eingaben prüfen (FAQ 1–${INSTALLATION_STATUS_FAQ_MAX} Zeichen, kein Leertext).`;
  return <p role="alert" className="mt-2 text-sm font-medium text-red-700">{message}</p>;
}

// F10-09: eine FAQ-Zeile je Anzeigestand (Speichern + Entfernen).
// Remount bei Erfolg (stale-DOM, Muster Aufgaben-Vorlagen).
function StatusFaqRow({
  workspaceId,
  stateKey,
  current,
  canWrite,
}: {
  workspaceId: string;
  stateKey: InstallationStatusFaqKey;
  current: string | null;
  canWrite: boolean;
}) {
  const [upsertState, upsertDispatch] = useActionState(upsertStatusFaqAction, initialState);
  const [resetState, resetDispatch] = useActionState(resetStatusFaqAction, initialState);
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
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-semibold text-slate-950">{ROW_TITLES[stateKey]}</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        {current === null
          ? "Keine FAQ hinterlegt — im Portal erscheint kein FAQ-Block."
          : `Aktuell: „${current}“`}
      </p>
      {canWrite ? (
        <div className="mt-3 grid gap-3">
          <form action={upsertDispatch} key={`set:${stateKey}:${current ?? ""}:${successCount}`} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="key" value={stateKey} />
            <label className="grid min-w-52 flex-1 gap-1 text-sm font-semibold text-slate-800">
              FAQ für {ROW_TITLES[stateKey].toLowerCase()}
              <textarea
                name="faq"
                defaultValue={current ?? ""}
                required
                maxLength={INSTALLATION_STATUS_FAQ_MAX}
                rows={3}
                placeholder="z. B. Die Anlage läuft, die Abnahme folgt in Kürze."
                className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <button
              type="submit"
              className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600"
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
                className="min-h-11 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
              >
                FAQ entfernen
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

export function StatusFaqManager({
  workspaceId,
  faqs,
  canWrite,
}: {
  workspaceId: string;
  faqs: InstallationStatusFaq;
  canWrite: boolean;
}) {
  return (
    <div className="grid gap-4" data-testid="portal-status-faqs">
      {INSTALLATION_STATUS_FAQ_KEYS.map((stateKey) => (
        <StatusFaqRow
          key={stateKey}
          workspaceId={workspaceId}
          stateKey={stateKey}
          current={faqs[stateKey]}
          canWrite={canWrite}
        />
      ))}
    </div>
  );
}
