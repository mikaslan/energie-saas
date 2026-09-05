"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { setVariantPaymentOptionEditorAction } from "../variant-actions";
import {
  SET_VARIANT_PAYMENT_OPTION_INITIAL_STATE,
  type SetVariantPaymentOptionEditorState,
} from "../variant-action-state";

export interface PaymentOptionEntry {
  id: string;
  key: "purchase" | "financing_classic" | "leasing";
  label: string;
}

const KEY_LABELS: Record<PaymentOptionEntry["key"], string> = {
  purchase: "Kauf",
  financing_classic: "Finanzierung (Classic, Anzeige)",
  leasing: "Leasing",
};

function feedback(state: SetVariantPaymentOptionEditorState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return state.changed
      ? "Die Zahlart wurde gespeichert."
      : "Die Zahlart war bereits aktuell.";
  }
  if (state.status === "invalid") return "Die Auswahl ist ungültig. Lade die Seite neu und versuche es erneut.";
  if (state.status === "unauthenticated") return "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  if (state.status === "denied") return "Du darfst die Zahlart nicht ändern.";
  if (state.status === "not_found") return "Die Variante oder Zahlart ist nicht mehr verfügbar.";
  return "Das Speichern ist vorübergehend nicht möglich. Versuche es später erneut.";
}

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-11 items-center justify-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-500"
    >
      {pending ? "Wird gespeichert …" : "Zahlart speichern"}
    </button>
  );
}

export function OfferPaymentOptionPanel({ workspaceId, offerId, variantId, variantName, currentOptionId, options, canEdit }: {
  workspaceId: string;
  offerId: string;
  variantId: string;
  variantName: string;
  currentOptionId: string | null;
  options: readonly PaymentOptionEntry[];
  canEdit: boolean;
}) {
  const [actionState, formAction] = useActionState(
    setVariantPaymentOptionEditorAction,
    SET_VARIANT_PAYMENT_OPTION_INITIAL_STATE,
  );
  const message = feedback(actionState);
  const isError = actionState.status !== "idle" && actionState.status !== "success";
  const current = options.find((option) => option.id === currentOptionId) ?? null;

  return (
    <section aria-labelledby="offer-payment-option-title" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">F2.5 Zahlart</p>
      <h2 id="offer-payment-option-title" className="mt-1 text-lg font-semibold text-slate-950">
        Zahlart · {variantName}
      </h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        {current ? (
          <>Aktuell: <strong>{current.label}</strong> ({KEY_LABELS[current.key]}). </>
        ) : (
          <>Keine Angabe. </>
        )}
        Reine Anzeige — keine Ratenberechnung, keine Provider-Anbindung.
      </p>

      {canEdit ? (
        <form action={formAction} className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div>
            <label htmlFor="variant-payment-option" className="text-sm font-semibold text-slate-800">
              Zahlart wählen
            </label>
            <select
              id="variant-payment-option"
              name="paymentOptionId"
              defaultValue={currentOptionId ?? ""}
              key={currentOptionId ?? ""}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
            >
              <option value="">Keine Angabe</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} ({KEY_LABELS[option.key]})
                </option>
              ))}
            </select>
          </div>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="offerId" value={offerId} />
          <input type="hidden" name="variantId" value={variantId} />
          <SaveButton />
        </form>
      ) : (
        <p className="mt-3 text-sm text-slate-600">Nur Lesezugriff: Die Zahlart kann nicht geändert werden.</p>
      )}
      {message ? (
        <p role={isError ? "alert" : "status"} className={isError ? "mt-2 text-sm font-semibold text-rose-800" : "mt-2 text-sm text-slate-700"}>
          {message}
        </p>
      ) : null}
    </section>
  );
}
