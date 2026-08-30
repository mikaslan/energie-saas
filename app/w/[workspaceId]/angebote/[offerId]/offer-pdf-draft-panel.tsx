"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { generateOfferPdfDraftAction } from "../pdf-actions";
import {
  GENERATE_OFFER_PDF_DRAFT_INITIAL_STATE,
  type GenerateOfferPdfDraftActionState,
} from "../pdf-action-state";
import { OfferDirtyNavigationLink } from "./dirty-navigation-guard";
import type { OfferPdfDraftSurfaceView } from "./offer-detail-view";

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : "Zeitpunkt nicht verfügbar";
}

function stateLabel(state: OfferPdfDraftSurfaceView["state"]): string {
  if (state === "queued") return "In Warteschlange";
  if (state === "running") return "PDF wird erzeugt";
  if (state === "retry_wait") return "Neuer Erstellungsversuch ist vorgesehen";
  if (state === "succeeded") return "PDF-Entwurf ist bereit";
  if (state === "failed_final") return "PDF-Erstellung endgültig fehlgeschlagen";
  return "PDF-Status ist nicht verfügbar";
}

function errorLabel(code: string | null): string | null {
  if (code === null) return null;
  const safeLabels: Readonly<Record<string, string>> = {
    render_timeout: "Das Zeitlimit der PDF-Erstellung wurde erreicht.",
    render_failed: "Der PDF-Inhalt konnte nicht erzeugt werden.",
    invalid_render_output: "Das erzeugte Dokument bestand die Integritätsprüfung nicht.",
    storage_unavailable: "Der Dokumentenspeicher war nicht verfügbar.",
    worker_shutdown: "Die Erstellung wurde unterbrochen.",
  };
  return safeLabels[code] ?? "Die Erstellung konnte nicht abgeschlossen werden.";
}

function actionFeedback(state: GenerateOfferPdfDraftActionState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return state.replayed
      ? `Der vorhandene Auftrag für Revision ${state.variantRevision} wird angezeigt.`
      : `Der PDF-Auftrag für Revision ${state.variantRevision} wurde angenommen.`;
  }
  if (state.status === "invalid") return "Die Anforderung war ungültig. Lade die Seite neu und versuche es erneut.";
  if (state.status === "unauthenticated") return "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  if (state.status === "denied") return "Du darfst für dieses Angebot keinen PDF-Entwurf erzeugen.";
  if (state.status === "not_found") return "Der gespeicherte Angebotsstand ist nicht mehr verfügbar.";
  if (state.status === "conflict") {
    return state.currentRevision
      ? `Die gespeicherte Variante ist inzwischen Revision ${state.currentRevision}. Lade den aktuellen Stand.`
      : "Die gespeicherte Variante wurde zwischenzeitlich geändert. Lade den aktuellen Stand.";
  }
  return state.retryAfter
    ? `Die Erstellung ist vorübergehend nicht verfügbar. Neuer Versuch frühestens ${formatDate(state.retryAfter)}.`
    : "Die Erstellung ist vorübergehend nicht verfügbar. Versuche es später erneut.";
}

function GenerateButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      aria-describedby="offer-pdf-source-warning"
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
      className={`inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${pending ? "cursor-wait bg-slate-700" : "bg-slate-950 hover:bg-slate-800"}`}
    >
      {pending ? "Auftrag wird geprüft …" : "Internen PDF-Entwurf erzeugen"}
    </button>
  );
}

export function OfferPdfDraftPanel({
  workspaceId,
  offerId,
  variantId,
  variantRevision,
  canGenerate,
  drafts,
}: {
  workspaceId: string;
  offerId: string;
  variantId: string;
  variantRevision: number;
  canGenerate: boolean;
  drafts: readonly OfferPdfDraftSurfaceView[];
}) {
  const [actionState, formAction] = useActionState(
    generateOfferPdfDraftAction,
    GENERATE_OFFER_PDF_DRAFT_INITIAL_STATE,
  );
  const feedback = actionFeedback(actionState);
  const feedbackIsError = actionState.status !== "idle" && actionState.status !== "success";
  const refreshHref = `/w/${workspaceId}/angebote/${offerId}?variante=${variantId}`;

  return (
    <aside
      id="offer-pdf-draft"
      tabIndex={-1}
      aria-labelledby="offer-pdf-draft-title"
      className="rounded-lg border border-slate-300 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
            Dokumentausgabe
          </p>
          <h2 id="offer-pdf-draft-title" className="mt-1 text-lg font-semibold text-slate-950">
            Interner, nicht verbindlicher PDF-Entwurf
          </h2>
          <p id="offer-pdf-source-warning" className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">
            Erzeugt wird ausschließlich die gespeicherte Revision {variantRevision}. Ungespeicherte Änderungen
            zuerst speichern; sie gehören nicht zu diesem Dokument.
          </p>
        </div>
        <OfferDirtyNavigationLink
          href={refreshHref}
          label="PDF-Status aktualisieren"
          kind="refresh"
          className="inline-flex min-h-11 shrink-0 items-center text-sm font-semibold text-blue-700 underline decoration-2 underline-offset-4 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Status aktualisieren
        </OfferDirtyNavigationLink>
      </div>

      {canGenerate ? (
        <form action={formAction} className="mt-4">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="offerId" value={offerId} />
          <input type="hidden" name="variantId" value={variantId} />
          <input
            type="hidden"
            name="expectedVariantRevision"
            value={String(variantRevision)}
          />
          <GenerateButton />
        </form>
      ) : (
        <p className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          Nur Lesezugriff: Vorhandene fertige Entwürfe können geladen, neue Aufträge aber nicht
          erzeugt werden.
        </p>
      )}

      <div
        role={feedbackIsError ? "alert" : "status"}
        aria-live={feedbackIsError ? "assertive" : "polite"}
        aria-atomic="true"
        className="mt-3 min-h-6 text-sm font-semibold text-slate-800"
      >
        {feedback}
      </div>

      <div className="mt-5 border-t border-slate-200 pt-5">
        <h3 className="text-base font-semibold text-slate-950">Bisherige Erstellungsaufträge</h3>
        {drafts.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">Noch kein interner PDF-Entwurf vorhanden.</p>
        ) : (
          <ol className="mt-3 grid list-none gap-3">
            {drafts.map((draft) => {
              const pdfDraftId = draft.jobId;
              const downloadHref = `/w/${workspaceId}/angebote/${offerId}/pdf/${pdfDraftId}`;
              const failure = errorLabel(draft.errorCode);
              return (
                <li key={draft.jobId} className="rounded-md border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-semibold text-slate-950">
                        Revision {draft.variantRevision} · {stateLabel(draft.state)}
                      </p>
                      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm text-slate-700 sm:grid-cols-2">
                        <div>
                          <dt className="inline">Gestartet: </dt>
                          <dd className="inline"><time dateTime={draft.createdAt}>{formatDate(draft.createdAt)}</time></dd>
                        </div>
                        <div>
                          <dt className="inline">Versuche: </dt>
                          <dd className="inline tabular-nums">{draft.attemptCount}</dd>
                        </div>
                        {draft.state === "retry_wait" ? (
                          <div className="sm:col-span-2">
                            <dt className="inline">Nächster Versuch: </dt>
                            <dd className="inline"><time dateTime={draft.nextAttemptAt}>{formatDate(draft.nextAttemptAt)}</time></dd>
                          </div>
                        ) : null}
                      </dl>
                      {failure ? <p className="mt-2 text-sm font-semibold text-rose-800">{failure}</p> : null}
                    </div>
                    {draft.state === "succeeded" && draft.canDownload ? (
                      <a
                        href={downloadHref}
                        className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-slate-400 bg-white px-4 py-2 text-sm font-semibold text-slate-900 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                      >
                        PDF-Entwurf der Revision {draft.variantRevision} laden
                      </a>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </aside>
  );
}
