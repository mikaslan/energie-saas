"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { applyOfferTemplateEditorAction } from "../variant-actions";
import {
  APPLY_OFFER_TEMPLATE_INITIAL_STATE,
  type ApplyOfferTemplateEditorState,
} from "../variant-action-state";

export interface OfferTemplateEntry {
  id: string;
  name: string;
  hasPaymentOption: boolean;
  hasDiscount: boolean;
}

function feedback(state: ApplyOfferTemplateEditorState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    const parts: string[] = [];
    if (state.paymentOptionApplied) parts.push("Zahlart gesetzt");
    if (state.discountApplied) parts.push("Global-Rabatt gesetzt");
    return parts.length > 0
      ? `Vorlage angewendet: ${parts.join(" + ")}.`
      : "Vorlage angewendet (keine Änderung).";
  }
  if (state.status === "invalid") return "Die Auswahl ist ungültig. Lade die Seite neu und versuche es erneut.";
  if (state.status === "unauthenticated") return "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  if (state.status === "denied") return "Du darfst keine Vorlagen anwenden.";
  if (state.status === "not_found") return "Die Vorlage oder Variante ist nicht mehr verfügbar.";
  if (state.status === "conflict") return "Die Variante wurde zwischenzeitlich geändert. Lade die Seite neu und versuche es erneut.";
  return "Das Anwenden ist vorübergehend nicht möglich. Versuche es später erneut.";
}

function ApplyButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-11 items-center justify-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-500"
    >
      {pending ? "Wird angewendet …" : "Vorlage anwenden"}
    </button>
  );
}

// F16-06: Angebots-Vorlage (Zahlart-Preset + Rabatt-Preset) in einem Schritt
// an der aktiven Variante anwenden. Direkte Servermutation (kein Entwurf):
// Zahlart setzen + Global-Rabatt via bestehende Commands.
export function OfferTemplateApplyPanel({ workspaceId, offerId, variantId, variantName, variantRevision, templates, canApply }: {
  workspaceId: string;
  offerId: string;
  variantId: string;
  variantName: string;
  variantRevision: number;
  templates: readonly OfferTemplateEntry[];
  canApply: boolean;
}) {
  const [actionState, formAction] = useActionState(
    applyOfferTemplateEditorAction,
    APPLY_OFFER_TEMPLATE_INITIAL_STATE,
  );
  const [successCount, setSuccessCount] = useState(0);
  const [prevStatus, setPrevStatus] = useState(actionState.status);
  if (prevStatus !== actionState.status) {
    setPrevStatus(actionState.status);
    if (actionState.status === "success") setSuccessCount((count) => count + 1);
  }
  const message = feedback(actionState);
  const isError = actionState.status !== "idle" && actionState.status !== "success";

  return (
    <section aria-labelledby="offer-template-apply-title" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">F16.6 Angebots-Vorlage</p>
      <h2 id="offer-template-apply-title" className="mt-1 text-lg font-semibold text-slate-950">
        Vorlage anwenden · {variantName}
      </h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        Setzt die Zahlart und den Global-Rabatt der Vorlage direkt an dieser Variante (Rev. {variantRevision}).
      </p>

      {canApply && templates.length > 0 ? (
        <form action={formAction} key={`${variantId}:${variantRevision}:${successCount}`} className="mt-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <div>
            <label htmlFor="offer-template-apply" className="text-sm font-semibold text-slate-800">
              Vorlage wählen
            </label>
            <select
              id="offer-template-apply"
              name="templateId"
              defaultValue=""
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
            >
              <option value="">Vorlage wählen …</option>
              {templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                  {template.hasPaymentOption && template.hasDiscount
                    ? " (Zahlart + Rabatt)"
                    : template.hasPaymentOption
                      ? " (Zahlart)"
                      : " (Rabatt)"}
                </option>
              ))}
            </select>
          </div>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="offerId" value={offerId} />
          <input type="hidden" name="variantId" value={variantId} />
          <input type="hidden" name="expectedRevision" value={String(variantRevision)} />
          <ApplyButton />
        </form>
      ) : (
        <p className="mt-3 text-sm text-slate-600">
          {templates.length === 0
            ? "Keine aktive Angebots-Vorlage vorhanden (Einstellungen → Angebots-Vorlagen)."
            : "Nur Lesezugriff: Vorlagen können nicht angewendet werden."}
        </p>
      )}
      {message ? (
        <p role={isError ? "alert" : "status"} className={isError ? "mt-2 text-sm font-semibold text-rose-800" : "mt-2 text-sm text-slate-700"}>
          {message}
        </p>
      ) : null}
    </section>
  );
}
