"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  duplicateDocumentAction,
  type DuplicateDocumentActionState,
} from "../../actions";

const initialState: DuplicateDocumentActionState = { status: "idle" };

function Feedback({
  state,
  workspaceId,
}: {
  state: DuplicateDocumentActionState;
  workspaceId: string;
}) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" data-testid="duplicate-document-success" className="mt-3 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        Rechnungs-Entwurf angelegt —{" "}
        <Link
          href={`/w/${workspaceId}/rechnungen/invoice/${state.invoiceId}`}
          className="font-semibold underline underline-offset-2"
        >
          Rechnung öffnen
        </Link>
      </p>
    );
  }
  const message =
    state.status === "invalid"
      ? "Übernahme nicht möglich (nur Auftragsbestätigungen)."
      : state.status === "not_found"
        ? "Beleg nicht gefunden."
        : state.status === "conflict"
          ? "Stornierte Belege können nicht übernommen werden."
          : state.status === "denied"
            ? "Keine Berechtigung."
            : "Bitte erneut anmelden.";
  return (
    <p role="alert" className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {message}
    </p>
  );
}

/**
 * F8-04b · Auftragsbestätigung als Rechnung übernehmen (nur Positionen,
 * Fälligkeit +14 Tage, Entwurf editierbar).
 */
export function DuplicateDocumentPanel({
  workspaceId,
  documentId,
}: {
  workspaceId: string;
  documentId: string;
}) {
  const [state, dispatch] = useActionState(duplicateDocumentAction, initialState);
  return (
    <section
      aria-label="Als Rechnung übernehmen"
      data-invoice-detail="duplicate"
      className="mt-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 className="text-base font-semibold text-slate-950">Als Rechnung übernehmen</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        Legt einen Rechnungs-Entwurf mit denselben Positionen an
        (Fälligkeit +14 Tage, Skonto setzt du an der Rechnung neu).
      </p>
      <form action={dispatch} data-testid="duplicate-document-panel" className="mt-3">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="documentId" value={documentId} />
        <button
          type="submit"
          className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
        >
          Als Rechnung übernehmen
        </button>
      </form>
      <Feedback state={state} workspaceId={workspaceId} />
    </section>
  );
}
