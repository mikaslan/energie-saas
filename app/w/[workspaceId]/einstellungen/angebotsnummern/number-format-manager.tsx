"use client";

import { useActionState, useEffect, useRef } from "react";
import type { OfferNumberFormatDto } from "@/lib/integrations/offers/contract";
import {
  setOfferNumberFormatAction,
  type NumberFormatActionState,
} from "./actions";

const initialState: NumberFormatActionState = { status: "idle" };

const inputClass =
  "mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30";

function message(state: NumberFormatActionState): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success": return { text: state.message, isError: false };
    case "invalid": return {
      text: state.message ?? "Die Eingabe ist ungültig (Prefix 2–8 Zeichen A–Z/0–9/-, Stellen 4–8).",
      isError: true,
    };
    case "conflict": return {
      text: "Das Format wurde zwischenzeitlich geändert. Seite neu laden und erneut speichern.",
      isError: true,
    };
    case "denied": return { text: "Dir fehlt die Berechtigung für diese Aktion.", isError: true };
    case "unauthenticated": return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    default: return null;
  }
}

function Feedback({ state }: { state: NumberFormatActionState }) {
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const feedback = message(state);
  useEffect(() => {
    if (feedback !== null) feedbackRef.current?.focus();
  }, [feedback, state]);
  return (
    <p
      ref={feedbackRef}
      tabIndex={-1}
      role={feedback?.isError ? "alert" : "status"}
      aria-live="polite"
      data-testid="number-format-feedback"
      className={`mt-4 text-sm font-semibold ${
        feedback === null ? "hidden" : feedback.isError ? "text-red-700" : "text-green-700"
      }`}
    >
      {feedback?.text}
    </p>
  );
}

export function NumberFormatManager({
  workspaceId,
  format,
  canWrite,
}: {
  workspaceId: string;
  format: OfferNumberFormatDto;
  canWrite: boolean;
}) {
  const [state, dispatch] = useActionState(setOfferNumberFormatAction, initialState);

  return (
    <div className="space-y-6">
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-950">Nummernformat</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Aktuelle Vorschau:{" "}
            <span className="font-mono font-semibold text-slate-900" data-testid="number-format-preview">
              {format.preview}
            </span>{" "}
            {format.isDefault ? "(Standard)" : `(Revision ${format.revision})`}
          </p>
        </div>

        {!canWrite ? (
          <p className="text-sm leading-6 text-slate-500">
            Du hast Lesezugriff. Zum Ändern brauchst du Editor-Rechte.
          </p>
        ) : (
          <form action={dispatch}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="isDefault" value={format.isDefault ? "true" : "false"} />
            <input type="hidden" name="revision" value={format.isDefault ? "" : String(format.revision)} />
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Prefix</span>
                <input
                  type="text"
                  name="prefix"
                  required
                  minLength={2}
                  maxLength={8}
                  autoComplete="off"
                  spellCheck={false}
                  defaultValue={format.prefix}
                  data-testid="number-format-prefix"
                  className={`${inputClass} font-mono uppercase`}
                />
                <span className="mt-1 block text-xs leading-5 text-slate-500">
                  2–8 Zeichen: Großbuchstaben, Ziffern, Bindestrich.
                </span>
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Stellen (Zähler)</span>
                <input
                  type="number"
                  name="padding"
                  required
                  min={4}
                  max={8}
                  step={1}
                  defaultValue={format.padding}
                  data-testid="number-format-padding"
                  className={inputClass}
                />
                <span className="mt-1 block text-xs leading-5 text-slate-500">
                  4–8 Stellen, mit Nullen aufgefüllt.
                </span>
              </label>
            </div>
            <div className="mt-4">
              <button
                type="submit"
                data-testid="number-format-submit"
                className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
              >
                Format speichern
              </button>
            </div>
            <Feedback state={state} />
          </form>
        )}
      </section>

      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Gültigkeit</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Das Format gilt für neu angelegte Serien-Jahre. Bereits vergebene
          Nummern — auch im Standardformat ANG-Jahr-Nummer — behalten
          dauerhaft ihre Gültigkeit.
        </p>
      </section>
    </div>
  );
}
