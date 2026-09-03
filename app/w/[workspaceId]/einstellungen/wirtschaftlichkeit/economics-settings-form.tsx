"use client";

import { useActionState, useEffect, useRef } from "react";
import { upsertEconomicsSettingsAction, type EconomicsSettingsActionState } from "./actions";
import type { EconomicsSettingsV1 } from "@/lib/integrations/economics/contract";

const initialState: EconomicsSettingsActionState = { status: "idle" };

function message(state: EconomicsSettingsActionState): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success": return { text: "Gespeichert.", isError: false };
    case "invalid": return { text: "Die Eingabe ist ungültig.", isError: true };
    case "conflict": return {
      text: "Die Einstellungen wurden zwischenzeitlich geändert. Bitte neu laden und erneut speichern.",
      isError: true,
    };
    case "not_found": return { text: "Die Einstellungen wurden nicht gefunden.", isError: true };
    case "denied": return { text: "Dir fehlt die Berechtigung für diese Aktion.", isError: true };
    case "unauthenticated": return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    default: return null;
  }
}

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30";

export function EconomicsSettingsForm({
  workspaceId,
  settings,
}: {
  workspaceId: string;
  settings: EconomicsSettingsV1;
}) {
  const [state, dispatch] = useActionState(upsertEconomicsSettingsAction, initialState);
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const feedback = message(state);

  useEffect(() => {
    if (feedback?.isError) feedbackRef.current?.focus();
  }, [feedback?.isError, state]);

  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-950">Simulations-Defaults</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Vorgabewerte für die Wirtschaftlichkeitsrechnung. Leere Preisfelder
          nutzen später die Länderreferenz.
        </p>
      </div>

      <form action={dispatch}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="baseRevision" value={settings.revision} />

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block">
            <span className="block text-sm font-semibold text-slate-800">Strompreis (Cent/kWh)</span>
            <input
              type="number"
              name="electricityPriceNetCentsPerKwh"
              min={0}
              max={1000000}
              step={1}
              defaultValue={settings.electricityPriceNetCentsPerKwh ?? ""}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="block text-sm font-semibold text-slate-800">Eskalation (% pro Jahr)</span>
            <input
              type="number"
              name="escalationRateBps"
              min={0}
              max={20}
              step={0.01}
              defaultValue={
                settings.escalationRateBps === null
                  ? ""
                  : (settings.escalationRateBps / 100).toFixed(2)
              }
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-slate-500">
              Wird als Basispunkte gespeichert (1,00 % = 100 bps).
            </span>
          </label>
          <label className="block">
            <span className="block text-sm font-semibold text-slate-800">Ölpreis (Cent/Liter)</span>
            <input
              type="number"
              name="oilPriceNetCentsPerLiter"
              min={0}
              max={1000000}
              step={1}
              defaultValue={settings.oilPriceNetCentsPerLiter ?? ""}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="block text-sm font-semibold text-slate-800">Gaspreis (Cent/kWh)</span>
            <input
              type="number"
              name="gasPriceNetCentsPerKwh"
              min={0}
              max={1000000}
              step={1}
              defaultValue={settings.gasPriceNetCentsPerKwh ?? ""}
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="block text-sm font-semibold text-slate-800">Cashflow-Horizont (Jahre)</span>
            <input
              type="number"
              name="cashflowHorizonYears"
              min={1}
              max={50}
              step={1}
              required
              defaultValue={settings.cashflowHorizonYears}
              className={inputClass}
            />
          </label>
        </div>

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

        <div className="mt-5">
          <button
            type="submit"
            disabled={!settings.permissions.canWrite}
            className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Speichern
          </button>
        </div>
      </form>
    </section>
  );
}
