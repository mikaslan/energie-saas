"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import { requestDraftPdfAction } from "../../draft-actions";
import { REQUEST_DRAFT_PDF_INITIAL_STATE, type RequestDraftPdfActionState } from "../../pdf-action-state";
import type { InvoicePdfState } from "@/modules/invoicing";

export type DraftPdfSurfaceView = {
  jobId: string;
  state: InvoicePdfState;
  attemptCount: number;
  nextAttemptAt: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  errorCode: string | null;
  canDownload: boolean;
};

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : "Zeitpunkt nicht verfügbar";
}

function stateLabel(state: InvoicePdfState): string {
  if (state === "requested") return "Angefordert";
  if (state === "queued") return "In Warteschlange";
  if (state === "running") return "Entwurf wird erzeugt";
  if (state === "retry_wait") return "Neuer Erstellungsversuch ist vorgesehen";
  if (state === "succeeded") return "Entwurfsvorschau ist bereit";
  if (state === "failed_final") return "Erstellung endgültig fehlgeschlagen";
  return "Vorschau-Status ist nicht verfügbar";
}

function errorLabel(code: string | null): string | null {
  if (code === null) return null;
  const safeLabels: Readonly<Record<string, string>> = {
    browser_unavailable: "Der PDF-Dienst war nicht verfügbar.",
    render_timeout: "Das Zeitlimit der PDF-Erstellung wurde erreicht.",
    storage_unavailable: "Der Dokumentenspeicher war nicht verfügbar.",
    invalid_input: "Die gespeicherten Entwurfsdaten bestanden die Prüfung nicht.",
    invalid_pdf: "Das erzeugte Dokument bestand die Integritätsprüfung nicht.",
    lease_expired: "Die Erstellung wurde unterbrochen.",
  };
  return safeLabels[code] ?? "Die Erstellung konnte nicht abgeschlossen werden.";
}

function actionFeedback(state: RequestDraftPdfActionState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return "Der Vorschau-Auftrag für den Entwurf wurde angenommen.";
  }
  if (state.status === "invalid") return "Die Anforderung war ungültig. Lade die Seite neu und versuche es erneut.";
  if (state.status === "unauthenticated") return "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  if (state.status === "denied") return "Du darfst für diesen Entwurf keine Vorschau erzeugen.";
  if (state.status === "not_found") return "Der gespeicherte Entwurf ist nicht mehr verfügbar.";
  return "Die Erstellung ist vorübergehend nicht verfügbar. Versuche es später erneut.";
}

function GenerateButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
      className={`inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 ${pending ? "cursor-wait bg-slate-700" : "bg-slate-950 hover:bg-slate-800"}`}
    >
      {pending ? "Auftrag wird geprüft …" : "Entwurfsvorschau erzeugen"}
    </button>
  );
}

export function DraftPdfPanel({
  workspaceId,
  type,
  documentId,
  canGenerate,
  jobs,
}: {
  workspaceId: string;
  type: string;
  documentId: string;
  canGenerate: boolean;
  jobs: readonly DraftPdfSurfaceView[];
}) {
  const [actionState, formAction] = useActionState(
    requestDraftPdfAction,
    REQUEST_DRAFT_PDF_INITIAL_STATE,
  );
  const feedback = actionFeedback(actionState);
  const feedbackIsError = actionState.status !== "idle" && actionState.status !== "success";
  const refreshHref = `/w/${workspaceId}/rechnungen/${type}/${documentId}`;

  return (
    <aside
      id="draft-pdf"
      data-testid="draft-pdf-panel"
      tabIndex={-1}
      aria-labelledby="draft-pdf-title"
      className="mt-4 rounded-lg border border-slate-300 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-800">
            Entwurfsvorschau
          </p>
          <h2 id="draft-pdf-title" className="mt-1 text-lg font-semibold text-slate-950">
            ENTWURF-Vorschau
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">
            Erzeugt wird ausschließlich der aktuelle Stand dieses Entwurfs — unverbindliche
            Vorschau mit ENTWURF-Wasserzeichen, ohne Nummer und ohne Siegel.
          </p>
        </div>
        <a
          href={refreshHref}
          className="inline-flex min-h-11 shrink-0 items-center text-sm font-semibold text-brand-800 underline decoration-2 underline-offset-4 outline-none hover:text-brand-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
        >
          Status aktualisieren
        </a>
      </div>

      {canGenerate ? (
        <form action={formAction} className="mt-4">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="type" value={type} />
          <input type="hidden" name="documentId" value={documentId} />
          <GenerateButton />
        </form>
      ) : (
        <p className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          Nur Lesezugriff: Vorhandene fertige Entwurfsvorschauen können geladen, neue Aufträge aber
          nicht erzeugt werden.
        </p>
      )}

      <div
        role={feedbackIsError ? "alert" : "status"}
        aria-live={feedbackIsError ? "assertive" : "polite"}
        aria-atomic="true"
        data-testid={actionState.status === "success" ? "draft-pdf-success" : undefined}
        className="mt-3 min-h-6 text-sm font-semibold text-slate-800"
      >
        {feedback}
      </div>

      <div className="mt-5 border-t border-slate-200 pt-5">
        <h3 className="text-base font-semibold text-slate-950">Bisherige Erstellungsaufträge</h3>
        {jobs.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">Noch keine Entwurfsvorschau vorhanden.</p>
        ) : (
          <ol className="mt-3 grid list-none gap-3">
            {jobs.map((job) => {
              const jobId = job.jobId;
              const downloadHref = `/w/${workspaceId}/rechnungen/${type}/${documentId}/pdf/${jobId}`;
              const failure = errorLabel(job.errorCode);
              return (
                <li key={job.jobId} className="rounded-md border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="font-semibold text-slate-950">
                        {stateLabel(job.state)}
                      </p>
                      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm text-slate-700 sm:grid-cols-2">
                        <div>
                          <dt className="inline">Gestartet: </dt>
                          <dd className="inline"><time dateTime={job.createdAt}>{formatDate(job.createdAt)}</time></dd>
                        </div>
                        <div>
                          <dt className="inline">Versuche: </dt>
                          <dd className="inline tabular-nums">{job.attemptCount}</dd>
                        </div>
                        {job.state === "retry_wait" ? (
                          <div className="sm:col-span-2">
                            <dt className="inline">Nächster Versuch: </dt>
                            <dd className="inline"><time dateTime={job.nextAttemptAt}>{formatDate(job.nextAttemptAt)}</time></dd>
                          </div>
                        ) : null}
                      </dl>
                      {failure ? <p className="mt-2 text-sm font-semibold text-rose-800">{failure}</p> : null}
                    </div>
                    {job.state === "succeeded" && job.canDownload ? (
                      <a
                        href={downloadHref}
                        className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-slate-400 bg-white px-4 py-2 text-sm font-semibold text-slate-900 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                      >
                        Entwurf laden
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
