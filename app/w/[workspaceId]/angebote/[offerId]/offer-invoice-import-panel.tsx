"use client";

import { useActionState } from "react";
import {
  importOfferAsInvoiceAction,
  type OfferInvoiceImportActionState,
} from "../actions";

const INITIAL_STATE: OfferInvoiceImportActionState = { status: "idle" };

// F8-06: signierte Angebotsvariante als Rechnungs-Entwurf übernehmen.
// Das Panel entscheidet nur die Sichtbarkeit (signiert, kein Override,
// Schreibrecht); alle harten Gates (Signaturbindung, Revision, Zeilen)
// setzt der Service — Konflikte erscheinen als ehrliche Meldung.
export function OfferInvoiceImportPanel({
  workspaceId,
  offerId,
  variantId,
  signed,
  overrideActive,
  canImport,
}: {
  workspaceId: string;
  offerId: string;
  variantId: string | null;
  signed: boolean;
  overrideActive: boolean;
  canImport: boolean;
}) {
  const [state, dispatch, pending] = useActionState(importOfferAsInvoiceAction, INITIAL_STATE);
  if (!variantId || !canImport || !signed) return null;

  return (
    <section
      aria-label="Als Rechnung übernehmen"
      data-testid="offer-invoice-import-panel"
      className="rounded-md border border-slate-300 bg-white px-4 py-3"
    >
      <h2 className="text-base font-semibold text-slate-950">Als Rechnung übernehmen</h2>
      {overrideActive ? (
        <p data-testid="offer-invoice-import-blocked" className="mt-1 text-sm leading-6 text-slate-700">
          Deal-Override aktiv — die pauschale Angebotssumme ist pro Position nicht darstellbar,
          deshalb ist keine Übernahme möglich.
        </p>
      ) : (
        <>
          <p className="mt-1 text-sm leading-6 text-slate-700">
            Übernimmt die Positionen der signierten Variante als Rechnungs-Entwurf
            (Gruppenlos, Fälligkeit + 14 Tage, ohne Skonto).
          </p>
          <form data-testid="offer-invoice-import-form" action={dispatch} className="mt-2 flex flex-wrap items-center gap-2">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="offerId" value={offerId} />
            <input type="hidden" name="variantId" value={variantId} />
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {pending ? "Wird übernommen …" : "Als Rechnung übernehmen"}
            </button>
          </form>
        </>
      )}
      {state.status === "success" ? (
        <p data-testid="offer-invoice-import-success" className="mt-2 text-sm leading-6 text-slate-700">
          Rechnungs-Entwurf mit {state.linesCopied} {state.linesCopied === 1 ? "Position" : "Positionen"} angelegt:{" "}
          <a
            className="font-medium text-slate-950 underline"
            href={`/w/${workspaceId}/rechnungen/invoice/${state.invoiceId}`}
          >
            Rechnung öffnen
          </a>
        </p>
      ) : null}
      {state.status === "conflict" ? (
        <p role="alert" className="mt-2 text-sm leading-6 text-amber-950">
          Variante wurde nach der Signatur geändert oder Signatur widerrufen — bitte Seite neu laden.
        </p>
      ) : null}
      {state.status === "precondition" ? (
        <p role="alert" className="mt-2 text-sm leading-6 text-amber-950">
          Ausstellungsdaten unvollständig — bitte zuerst unter{" "}
          <a
            className="font-medium text-slate-950 underline"
            href={`/w/${workspaceId}/einstellungen/rechnungsstellung`}
          >
            Einstellungen / Rechnungsstellung
          </a>{" "}
          IBAN und Firmendaten hinterlegen.
        </p>
      ) : null}
      {state.status === "invalid" || state.status === "not_found" ? (
        <p role="alert" className="mt-2 text-sm leading-6 text-amber-950">
          Variante ist nicht mehr übernehmbar — bitte Seite neu laden.
        </p>
      ) : null}
      {state.status === "denied" || state.status === "unauthenticated" ? (
        <p role="alert" className="mt-2 text-sm leading-6 text-amber-950">
          Keine Berechtigung für die Rechnungsanlage.
        </p>
      ) : null}
      {state.status === "error" ? (
        <p role="alert" className="mt-2 text-sm leading-6 text-amber-950">
          Technischer Fehler beim Übernehmen — bitte erneut versuchen.
        </p>
      ) : null}
    </section>
  );
}
