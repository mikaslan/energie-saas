"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";

import {
  MARK_SENT_WITH_DELIVERY_INITIAL_STATE,
  markSentWithDeliveryAction,
  type MarkSentWithDeliveryActionState,
} from "../../delivery-actions";

export type DeliverySurfaceView = {
  sentAt: string;
  channel: "manual";
  invoiceJobId: string;
  invoiceArtifactSha256: string;
  paymentJobId: string | null;
  paymentArtifactSha256: string | null;
};

export type DeliveryDownloadView = {
  jobId: string;
  kind: "invoice" | "payment";
  href: string;
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

function shortSha(value: string): string {
  return value.length === 64 ? `${value.slice(0, 12)}…` : "Prüfsumme nicht verfügbar";
}

function channelLabel(channel: DeliverySurfaceView["channel"]): string {
  if (channel === "manual") return "Manuell (externer Versand)";
  return "Versandart ist nicht verfügbar";
}

function actionFeedback(state: MarkSentWithDeliveryActionState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return "Das Dokument wurde als versendet markiert.";
  }
  if (state.status === "conflict") {
    return "Das Dokument wurde bereits versendet oder ist dafür nicht mehr freigegeben. Ein erneuter Versand ist nicht möglich.";
  }
  if (state.status === "invalid") return "Die Anforderung war ungültig. Lade die Seite neu und versuche es erneut.";
  if (state.status === "unauthenticated") return "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  if (state.status === "denied") return "Du darfst dieses Dokument nicht als versendet markieren.";
  if (state.status === "not_found") return "Das gespeicherte Dokument ist nicht mehr verfügbar.";
  return "Der Versand ist vorübergehend nicht verfügbar. Versuche es später erneut.";
}

function SendButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  const inactive = pending || disabled;
  return (
    <button
      type="submit"
      disabled={disabled || undefined}
      aria-disabled={inactive || undefined}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
      className={`inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 ${inactive ? "cursor-not-allowed bg-slate-400" : "bg-slate-950 hover:bg-slate-800"}`}
    >
      {pending ? "Versand wird geprüft …" : disabled ? "Bereits versendet" : "Als versendet markieren"}
    </button>
  );
}

export function VersandPanel({
  workspaceId,
  type,
  documentId,
  canSend,
  delivery,
  downloads,
}: {
  workspaceId: string;
  type: string;
  documentId: string;
  canSend: boolean;
  delivery: DeliverySurfaceView | null;
  downloads: readonly DeliveryDownloadView[];
}) {
  const [actionState, formAction] = useActionState(
    markSentWithDeliveryAction,
    MARK_SENT_WITH_DELIVERY_INITIAL_STATE,
  );
  const feedback = actionFeedback(actionState);
  const feedbackIsError = actionState.status !== "idle" && actionState.status !== "success";
  const refreshHref = `/w/${workspaceId}/rechnungen/${type}/${documentId}`;
  const delivered = delivery !== null;

  return (
    <aside
      id="versand"
      tabIndex={-1}
      aria-labelledby="versand-title"
      className="rounded-lg border border-slate-300 bg-white p-5 shadow-sm"
    >
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-800">
            Zustellung
          </p>
          <h2 id="versand-title" className="mt-1 text-lg font-semibold text-slate-950">
            Versand
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">
            Der Versand hält fest, welche versiegelten PDF-Bytes zugestellt wurden.
            E-Mails werden nicht versendet: Lade die Belege und stelle sie selbst zu.
          </p>
        </div>
        <a
          href={refreshHref}
          className="inline-flex min-h-11 shrink-0 items-center text-sm font-semibold text-brand-800 underline decoration-2 underline-offset-4 outline-none hover:text-brand-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
        >
          Status aktualisieren
        </a>
      </div>

      {delivered ? (
        <p
          data-testid="delivery-sent-badge"
          className="mt-4 inline-flex items-center rounded-full bg-emerald-100 px-3 py-1 text-sm font-semibold text-emerald-900"
        >
          Versendet
        </p>
      ) : null}

      {delivered || !canSend ? (
        <p className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {delivered
            ? "Dieses Dokument ist versendet. Der Nachweis unten ist unveränderlich; ein erneuter Versand ist ausgeschlossen."
            : "Nur Lesezugriff: Der Versandnachweis ist sichtbar, das Dokument kann aber nicht als versendet markiert werden."}
        </p>
      ) : (
        <form action={formAction} className="mt-4">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="documentId" value={documentId} />
          <input type="hidden" name="channel" value="manual" />
          <SendButton disabled={false} />
        </form>
      )}

      {delivered ? (
        <div className="mt-4">
          <SendButton disabled />
        </div>
      ) : null}

      <div
        role={feedbackIsError ? "alert" : "status"}
        aria-live={feedbackIsError ? "assertive" : "polite"}
        aria-atomic="true"
        className="mt-3 min-h-6 text-sm font-semibold text-slate-800"
      >
        {feedback}
      </div>

      {delivered ? (
        <div className="mt-5 border-t border-slate-200 pt-5">
          <h3 className="text-base font-semibold text-slate-950">Versandnachweis</h3>
          <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm text-slate-700 sm:grid-cols-2">
            <div>
              <dt className="inline">Versendet am: </dt>
              <dd className="inline"><time dateTime={delivery.sentAt}>{formatDate(delivery.sentAt)}</time></dd>
            </div>
            <div>
              <dt className="inline">Kanal: </dt>
              <dd className="inline">{channelLabel(delivery.channel)}</dd>
            </div>
            <div className="sm:col-span-2">
              <dt className="inline">Rechnungs-PDF: </dt>
              <dd className="inline font-mono text-[13px]" title={delivery.invoiceArtifactSha256}>
                {shortSha(delivery.invoiceArtifactSha256)}
              </dd>
            </div>
            {delivery.paymentJobId !== null && delivery.paymentArtifactSha256 !== null ? (
              <div className="sm:col-span-2">
                <dt className="inline">Zahlungsbeleg: </dt>
                <dd className="inline font-mono text-[13px]" title={delivery.paymentArtifactSha256}>
                  {shortSha(delivery.paymentArtifactSha256)}
                </dd>
              </div>
            ) : (
              <div className="sm:col-span-2">
                <dt className="inline">Zahlungsbeleg: </dt>
                <dd className="inline">Kein Zahlungsbeleg beigefügt.</dd>
              </div>
            )}
          </dl>
          {downloads.length > 0 ? (
            <ul className="mt-3 grid list-none gap-2">
              {downloads.map((download) => (
                <li key={download.jobId}>
                  <a
                    href={download.href}
                    className="inline-flex min-h-11 items-center justify-center rounded-md border border-slate-400 bg-white px-4 py-2 text-sm font-semibold text-slate-900 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                  >
                    {download.kind === "payment" ? "Zahlungsbeleg laden" : "Rechnungs-PDF laden"}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </aside>
  );
}
