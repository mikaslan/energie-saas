"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { PaymentOptionDto } from "@/lib/integrations/offers/contract";
import {
  archivePaymentOptionAction,
  createPaymentOptionAction,
  restorePaymentOptionAction,
  updatePaymentOptionAction,
  type PaymentOptionActionState,
} from "./actions";

const initialState: PaymentOptionActionState = { status: "idle" };

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30";

const KEY_LABELS: Record<PaymentOptionDto["key"], string> = {
  purchase: "Kauf",
  financing_classic: "Finanzierung (Classic, Anzeige)",
  leasing: "Leasing",
};

function message(state: PaymentOptionActionState): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success": return { text: state.message, isError: false };
    case "invalid": return {
      text: state.message ?? "Die Eingabe ist ungültig.",
      isError: true,
    };
    case "conflict": return {
      text: "Eine aktive Zahlart mit diesem Schlüssel existiert bereits.",
      isError: true,
    };
    case "not_found": return { text: "Die Zahlart wurde nicht gefunden.", isError: true };
    case "denied": return { text: "Dir fehlt die Berechtigung für diese Aktion.", isError: true };
    case "unauthenticated": return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    default: return null;
  }
}

function Feedback({ state }: { state: PaymentOptionActionState }) {
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const feedback = message(state);
  useEffect(() => {
    if (feedback?.isError) feedbackRef.current?.focus();
  }, [feedback?.isError, state]);
  return (
    <p
      ref={feedbackRef}
      tabIndex={-1}
      role={feedback?.isError ? "alert" : "status"}
      aria-live="polite"
      className={`mt-4 text-sm font-semibold ${
        feedback === null ? "hidden" : feedback.isError ? "text-red-700" : "text-green-700"
      }`}
    >
      {feedback?.text}
    </p>
  );
}

export function PaymentOptionManager({
  workspaceId,
  options,
  canWrite,
}: {
  workspaceId: string;
  options: PaymentOptionDto[];
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createPaymentOptionAction, initialState);
  const [updateState, updateDispatch] = useActionState(updatePaymentOptionAction, initialState);
  const [archiveState, archiveDispatch] = useActionState(archivePaymentOptionAction, initialState);
  const [restoreState, restoreDispatch] = useActionState(restorePaymentOptionAction, initialState);

  const active = options.filter((option) => option.archivedAt === null);
  const archived = options.filter((option) => option.archivedAt !== null);

  return (
    <div className="space-y-6">
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-950">Neue Zahlart</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Genau ein Eintrag je Schlüssel. Die Auswahl wirkt als reine
            Anzeige an der Angebotsvariante.
          </p>
        </div>

        {!canWrite ? (
          <p className="text-sm leading-6 text-slate-500">
            Du hast Lesezugriff. Zum Anlegen brauchst du Editor-Rechte.
          </p>
        ) : (
          <form action={createDispatch}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Schlüssel</span>
                <select name="key" className={inputClass} defaultValue="purchase">
                  <option value="purchase">Kauf</option>
                  <option value="financing_classic">Finanzierung (Classic, Anzeige)</option>
                  <option value="leasing">Leasing</option>
                </select>
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Bezeichnung</span>
                <input type="text" name="label" required maxLength={120} placeholder="Kauf" className={inputClass} />
              </label>
            </div>

            <Feedback state={createState} />

            <div className="mt-5">
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Anlegen
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Aktive Zahlarten</h2>
        {active.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Noch keine aktiven Zahlarten angelegt.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {active.map((option) => (
              <li key={option.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-900">{option.label}</span>
                  <span className="block text-xs text-slate-500">
                    {KEY_LABELS[option.key]}
                  </span>
                </span>
                {canWrite ? (
                  <>
                    <EditForm
                      key={`edit-${option.id}`}
                      workspaceId={workspaceId}
                      option={option}
                      state={updateState}
                      dispatch={updateDispatch}
                    />
                    <form action={archiveDispatch}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="id" value={option.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
                      >
                        Archivieren
                      </button>
                    </form>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Feedback state={archiveState} />
      </section>

      {archived.length > 0 || restoreState.status !== "idle" ? (
        <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-950">Archivierte Zahlarten</h2>
          {archived.length === 0 ? (
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Keine archivierten Zahlarten.
            </p>
          ) : null}
          <ul className="mt-3 divide-y divide-slate-100">
            {archived.map((option) => (
              <li key={option.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1 text-sm text-slate-500">
                  {option.label} · {KEY_LABELS[option.key]}
                </span>
                {canWrite ? (
                  <form action={restoreDispatch}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="id" value={option.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
                    >
                      Reaktivieren
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          <Feedback state={restoreState} />
        </section>
      ) : null}
    </div>
  );
}

function EditForm({
  workspaceId,
  option,
  state,
  dispatch,
}: {
  workspaceId: string;
  option: PaymentOptionDto;
  state: PaymentOptionActionState;
  dispatch: (formData: FormData) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  void state;
  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        Bearbeiten
      </button>
    );
  }
  return (
    <form action={dispatch} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="id" value={option.id} />
      <input
        type="text"
        name="label"
        required
        maxLength={120}
        defaultValue={option.label}
        aria-label="Bezeichnung"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
      />
      <button
        type="submit"
        className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        Speichern
      </button>
      <button
        type="button"
        onClick={() => setIsOpen(false)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        Abbrechen
      </button>
    </form>
  );
}
