"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";

import {
  OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION,
  OFFER_ISSUANCE_REQUEST_VERSION,
  OFFER_ISSUANCE_WITHDRAWAL_COMMAND_VERSION,
  type OfferIssuanceWithdrawalReasonV1,
} from "@/lib/integrations/offers/issuance-contract";
import {
  approveOfferIssuanceAction,
  requestOfferIssuanceAction,
  withdrawOfferIssuanceAction,
} from "../issuance-actions";
import {
  OFFER_ISSUANCE_ACTION_INITIAL_STATE,
  type OfferIssuanceActionState,
} from "../issuance-action-state";
import { OfferDirtyNavigationLink } from "./dirty-navigation-guard";

export type OfferIssuanceSurfaceView = {
  issuanceId: string;
  issuanceReference: string;
  candidateId: string;
  candidateReference: string;
  variantName: string;
  variantRevision: number;
  state:
    | "queued"
    | "running"
    | "retry_wait"
    | "ready_for_approval"
    | "failed_final"
    | "approval_pending"
    | "approved_for_archive_not_issued"
    | "withdrawn_before_archive";
  renderState: "queued" | "running" | "retry_wait" | "ready_for_approval" | "failed_final";
  approvalCount: number;
  publicationStatus: "not_issued";
  requiresZeroTaxReview: boolean;
  attemptCount: number;
  nextAttemptAt: string;
  createdAt: string;
  viewerHasApproved: boolean;
  canCurrentActorApprove: boolean;
  withdrawal: null | {
    reasonCode: OfferIssuanceWithdrawalReasonV1;
    withdrawnAt: string;
  };
  canDownload: boolean;
};

export type OfferIssuanceCandidateSurfaceView = {
  candidateId: string;
  candidateReference: string;
  variantName: string;
  variantRevision: number;
  approvedAt: string;
};

type FormIssue = {
  id: string;
  label: string;
  paths: readonly string[];
};

const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? dateFormatter.format(parsed) : "Zeitpunkt nicht verfügbar";
}

function actionFeedback(state: OfferIssuanceActionState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "issuance_requested") {
    return state.replayed
      ? "Die vorhandene gebundene Erstellung wurde wiederverwendet und bei Bedarf erneut in die Warteschlange gestellt."
      : "Die finale Ausstellungsfassung wurde zur Erstellung angenommen.";
  }
  if (state.status === "issuance_approved") {
    if (state.approvalCount === 2) {
      return state.replayed
        ? "Die zwei erforderlichen Bytefreigaben waren bereits gespeichert. Das Dokument ist weiterhin nicht ausgestellt."
        : "Die zweite Bytefreigabe wurde gespeichert. Das Dokument ist noch nicht ausgestellt.";
    }
    return state.replayed
      ? "Deine Bytefreigabe war bereits gespeichert. Für 2 von 2 muss eine andere berechtigte Person freigeben."
      : "Die erste Bytefreigabe wurde gespeichert. Eine andere berechtigte Person muss zweitfreigeben.";
  }
  if (state.status === "issuance_withdrawn") {
    return "Die Ausstellungsfassung wurde vor der Archivierung zurückgezogen.";
  }
  if (state.status === "invalid") return "Die Eingabe wurde nicht akzeptiert. Prüfe alle Pflichtangaben.";
  if (state.status === "unauthenticated") return "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  if (state.status === "denied") return "Dir fehlt die Berechtigung für diesen Schritt.";
  if (state.status === "not_found") return "Die gebundene Ausstellungsfassung ist nicht mehr verfügbar.";
  if (state.status === "conflict") {
    const messages: Readonly<Record<string, string>> = {
      candidate_not_approved: "Der Freigabekandidat ist nicht mehr freigegeben. Status aktualisieren und einen weiterhin freigegebenen Stand wählen.",
      candidate_source_changed: "Die versiegelte Quellbindung des Freigabekandidaten stimmt nicht mehr. Status aktualisieren; dieser Stand kann nicht erneut angefordert werden.",
      candidate_expired: "Die Angebotsgültigkeit dieses Freigabekandidaten ist abgelaufen. Einen neuen Freigabekandidaten mit gültigem Datum abschließen.",
      candidate_artifact_integrity_changed: "Die Byte-Integritätsprüfung des Freigabekandidaten ist fehlgeschlagen. Diesen Stand nicht verwenden und einen neuen Freigabekandidaten abschließen.",
      issuance_not_ready: "Die finale PDF-Datei ist noch nicht prüfbereit. Status aktualisieren und bis zum prüfbereiten Zustand warten.",
      issuance_source_changed: "Eine fest gebundene Quelle der Ausstellungsfassung stimmt nicht mehr. Die Fassung nicht freigeben und den Status aktualisieren.",
      artifact_integrity_changed: "Die Byte-Integritätsprüfung der finalen PDF-Datei ist fehlgeschlagen. Die Fassung nicht freigeben und den Status aktualisieren.",
      approval_conflict: "Deine Bytefreigabe ist bereits erfasst. Für 2 von 2 muss eine andere berechtigte Person freigeben.",
      zero_tax_review_required: "Die erforderliche 0-%-Steuerprüfung fehlt. Prüfpunkte vollständig bestätigen und erneut freigeben.",
      zero_tax_review_forbidden: "Die 0-%-Bestätigung gehört nicht zu dieser Fassung. Status aktualisieren und nur die angezeigten Prüfpunkte bestätigen.",
      approval_limit_reached: "Die zwei erforderlichen Bytefreigaben liegen bereits vor. Status aktualisieren; eine weitere Freigabe ist nicht erforderlich.",
      withdrawn_before_archive: "Diese Fassung wurde bereits vor der Archivierung zurückgenommen. Sie kann nicht mehr freigegeben werden.",
      withdrawal_conflict: "Der Rücknahmestand wurde zwischenzeitlich geändert. Status aktualisieren und den angezeigten Endzustand prüfen.",
    };
    return state.code
      ? messages[state.code] ?? "Der gebundene Stand wurde geändert. Status aktualisieren und den angezeigten Zustand prüfen."
      : "Der gebundene Stand wurde geändert. Status aktualisieren und den angezeigten Zustand prüfen.";
  }
  return state.retryAfter
    ? `Die Aktion ist vorübergehend nicht verfügbar. Neuer Versuch frühestens ${formatDate(state.retryAfter)}.`
    : "Die Aktion ist vorübergehend nicht verfügbar. Versuche es später erneut.";
}

function pathMatchesIssue(path: string, issue: FormIssue): boolean {
  if (path === "/") return false;
  return issue.paths.some((candidate) => (
    path === candidate
    || path.startsWith(`${candidate}/`)
    || candidate.startsWith(`${path}/`)
  ));
}

function matchingIssues(
  state: OfferIssuanceActionState,
  issues: readonly FormIssue[],
): readonly FormIssue[] {
  if (state.status !== "invalid" || !state.paths) return [];
  return issues.filter((issue) => state.paths?.some((path) => pathMatchesIssue(path, issue)));
}

function isIssueInvalid(
  state: OfferIssuanceActionState,
  issues: readonly FormIssue[],
  id: string,
): boolean {
  return matchingIssues(state, issues).some((issue) => issue.id === id);
}

function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const value = ids.filter((id): id is string => typeof id === "string" && id.length > 0).join(" ");
  return value || undefined;
}

function ActionFeedback({
  id,
  state,
  issues = [],
  resetNotice,
}: {
  id: string;
  state: OfferIssuanceActionState;
  issues?: readonly FormIssue[];
  resetNotice?: string;
}) {
  const isError = ![
    "idle",
    "issuance_requested",
    "issuance_approved",
    "issuance_withdrawn",
  ].includes(state.status);
  const linkedIssues = matchingIssues(state, issues);
  const feedbackRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status !== "idle") feedbackRef.current?.focus();
  }, [state]);
  return (
    <div
      ref={feedbackRef}
      id={id}
      tabIndex={state.status === "idle" ? undefined : -1}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      className={`mt-3 min-h-6 text-sm font-semibold outline-none ${isError ? "text-rose-800" : "text-emerald-800"}`}
    >
      {actionFeedback(state)}
      {isError && resetNotice ? <p className="mt-2 font-normal">{resetNotice}</p> : null}
      {linkedIssues.length > 0 ? (
        <div className="mt-2 font-normal">
          <p>Betroffene Felder:</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {linkedIssues.map((issue) => (
              <li key={issue.id}>
                <a className="font-semibold underline decoration-2 underline-offset-4" href={`#${issue.id}`}>
                  {issue.label}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function SubmitButton({
  pendingLabel,
  accessibleContext,
  tone = "primary",
  children,
}: {
  pendingLabel: string;
  accessibleContext?: string;
  tone?: "primary" | "danger";
  children: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  const activeClass = tone === "danger"
    ? "border border-rose-700 bg-white text-rose-800 hover:bg-rose-50"
    : "bg-slate-950 text-white hover:bg-slate-800";
  return (
    <button
      type="submit"
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
      className={`inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${pending ? "cursor-wait bg-slate-700 text-white" : activeClass}`}
    >
      {pending ? pendingLabel : children}
      {accessibleContext ? <span className="sr-only">{accessibleContext}</span> : null}
    </button>
  );
}

function statusCopy(issuance: OfferIssuanceSurfaceView): string {
  if (issuance.state === "queued") return "Ausstellungsfassung wartet auf Erstellung";
  if (issuance.state === "running") return "Ausstellungsfassung wird erstellt";
  if (issuance.state === "retry_wait") return "Erstellung wird automatisch erneut versucht";
  if (issuance.state === "failed_final") return "Erstellung der Ausstellungsfassung ist endgültig fehlgeschlagen";
  if (issuance.state === "ready_for_approval") {
    return "Ausstellungsfassung wartet auf Freigabe (0 von 2)";
  }
  if (issuance.state === "approval_pending") {
    return "Ausstellungsfassung wartet auf Zweitfreigabe (1 von 2)";
  }
  if (issuance.state === "approved_for_archive_not_issued") {
    return "Für Archivierung freigegeben · noch nicht ausgestellt (2 von 2)";
  }
  return "Vor Archivierung zurückgezogen · nicht ausgestellt";
}

function withdrawalReasonLabel(reason: OfferIssuanceWithdrawalReasonV1): string {
  const labels: Record<OfferIssuanceWithdrawalReasonV1, string> = {
    content_error: "Inhaltlicher Fehler",
    recipient_error: "Empfängerfehler",
    legal_text_error: "Fehler in Rechtstexten",
    commercial_error: "Kaufmännischer Fehler",
    other: "Sonstiger strukturierter Grund",
  };
  return labels[reason];
}

function ApprovalForm({
  workspaceId,
  offerId,
  issuance,
  action,
  feedbackId,
  state,
}: {
  workspaceId: string;
  offerId: string;
  issuance: OfferIssuanceSurfaceView;
  action: (payload: FormData) => void;
  feedbackId: string;
  state: OfferIssuanceActionState;
}) {
  const buttonLabel = issuance.approvalCount === 0
    ? "Erste Bytefreigabe speichern"
    : "Zweite Bytefreigabe speichern";
  const approvalIssues: readonly FormIssue[] = [
    { id: `issuance-recipient-scope-${issuance.issuanceId}`, label: "Empfänger, Standort und Leistungsumfang", paths: ["/recipientAndScopeReviewed"] },
    { id: `issuance-commercial-totals-${issuance.issuanceId}`, label: "Positionen, Rabatte, Steuern und Summen", paths: ["/commercialTotalsReviewed"] },
    { id: `issuance-legal-profile-${issuance.issuanceId}`, label: "Angebotsbedingungen und Rechtshinweise", paths: ["/legalProfileReviewed"] },
    { id: `issuance-final-pdf-${issuance.issuanceId}`, label: "Finale PDF-Datei für das Archiv", paths: ["/finalPdfForArchiveUnderstood"] },
    { id: `issuance-zero-tax-${issuance.issuanceId}`, label: "0-%-Steuerbehandlung", paths: ["/zeroTaxTreatmentReviewed"] },
  ];
  const checks = [
    ["recipientAndScopeReviewed", `issuance-recipient-scope-${issuance.issuanceId}`, "Empfänger, Rechnungsadresse, Anlagenstandort und Leistungsumfang geprüft"],
    ["commercialTotalsReviewed", `issuance-commercial-totals-${issuance.issuanceId}`, "Positionen, Rabatte, Steuern und Summen geprüft"],
    ["legalProfileReviewed", `issuance-legal-profile-${issuance.issuanceId}`, "Aktive Angebotsbedingungen und Rechtshinweise geprüft"],
    ["finalPdfForArchiveUnderstood", `issuance-final-pdf-${issuance.issuanceId}`, "Verstanden: Genau diese finale PDF-Datei ist für das spätere Archiv bestimmt"],
  ] as const;
  return (
    <form action={action} aria-describedby={feedbackId} className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-4">
      <input type="hidden" name="schemaVersion" value={OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="issuanceId" value={issuance.issuanceId} />
      <fieldset className="grid gap-2 border-0 p-0">
        <legend className="mb-2 font-semibold text-slate-950">
          Exakte PDF-Bytes freigeben · {issuance.issuanceReference}
        </legend>
        {checks.map(([name, id, label]) => {
          const invalid = isIssueInvalid(state, approvalIssues, id);
          return (
            <label key={name} htmlFor={id} className={`flex min-h-11 items-start gap-3 rounded-md border bg-white px-3 py-3 text-sm leading-6 ${invalid ? "border-rose-600 ring-1 ring-rose-600/30" : "border-slate-200"}`}>
              <input id={id} className="mt-1 size-5 accent-slate-950" type="checkbox" name={name} value="true" required aria-invalid={invalid || undefined} aria-describedby={describedBy(feedbackId)} />
              <span><span className="sr-only">Ausstellungsfassung {issuance.issuanceReference}: </span>{label}</span>
            </label>
          );
        })}
        {issuance.requiresZeroTaxReview ? (
          <label htmlFor={`issuance-zero-tax-${issuance.issuanceId}`} className={`flex min-h-11 items-start gap-3 rounded-md border bg-amber-50 px-3 py-3 text-sm leading-6 text-amber-950 ${isIssueInvalid(state, approvalIssues, `issuance-zero-tax-${issuance.issuanceId}`) ? "border-rose-600 ring-1 ring-rose-600/30" : "border-amber-300"}`}>
            <input id={`issuance-zero-tax-${issuance.issuanceId}`} className="mt-1 size-5 accent-slate-950" type="checkbox" name="zeroTaxTreatmentReviewed" value="true" required aria-invalid={isIssueInvalid(state, approvalIssues, `issuance-zero-tax-${issuance.issuanceId}`) || undefined} aria-describedby={describedBy(feedbackId)} />
            <span><span className="sr-only">Ausstellungsfassung {issuance.issuanceReference}: </span>Die Voraussetzungen und Nachweise für die 0-%-Steuerbehandlung wurden geprüft.</span>
          </label>
        ) : null}
      </fieldset>
      <div className="mt-3">
        <SubmitButton
          pendingLabel="Freigabe wird geprüft …"
          accessibleContext={` für Ausstellungsfassung ${issuance.issuanceReference}`}
        >
          {buttonLabel}
        </SubmitButton>
      </div>
    </form>
  );
}

function WithdrawalForm({
  workspaceId,
  offerId,
  issuance,
  action,
  feedbackId,
  state,
}: {
  workspaceId: string;
  offerId: string;
  issuance: OfferIssuanceSurfaceView;
  action: (payload: FormData) => void;
  feedbackId: string;
  state: OfferIssuanceActionState;
}) {
  const reasonId = `issuance-withdrawal-reason-${issuance.issuanceId}`;
  const confirmationId = `issuance-withdrawal-confirmation-${issuance.issuanceId}`;
  const withdrawalIssues: readonly FormIssue[] = [{
    id: reasonId,
    label: "Rücknahmegrund",
    paths: ["/withdrawalReasonCode", "/reasonCode"],
  }];
  const reasonInvalid = isIssueInvalid(state, withdrawalIssues, reasonId);
  return (
    <form action={action} aria-describedby={feedbackId} className="mt-3 border-t border-slate-200 pt-4">
      <input type="hidden" name="schemaVersion" value={OFFER_ISSUANCE_WITHDRAWAL_COMMAND_VERSION} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="offerId" value={offerId} />
      <input type="hidden" name="issuanceId" value={issuance.issuanceId} />
      <label htmlFor={reasonId} className="block text-sm font-semibold text-slate-800">
        Rücknahmegrund für Ausstellungsfassung {issuance.issuanceReference}
      </label>
      <select
        id={reasonId}
        name="withdrawalReasonCode"
        required
        aria-invalid={reasonInvalid || undefined}
        aria-describedby={describedBy(feedbackId)}
        defaultValue=""
        className={`mt-1 min-h-11 w-full rounded-md border bg-white px-3 py-2 text-base outline-none focus-visible:ring-2 focus-visible:ring-blue-600 sm:max-w-md ${reasonInvalid ? "border-rose-600 ring-1 ring-rose-600/30" : "border-slate-300"}`}
      >
        <option value="" disabled>Grund auswählen</option>
        <option value="content_error">Inhaltlicher Fehler</option>
        <option value="recipient_error">Empfängerfehler</option>
        <option value="legal_text_error">Fehler in Rechtstexten</option>
        <option value="commercial_error">Kaufmännischer Fehler</option>
        <option value="other">Sonstiger strukturierter Grund</option>
      </select>
      <label htmlFor={confirmationId} className="mt-3 flex min-h-11 items-start gap-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-3 text-sm leading-6 text-rose-950">
        <input
          id={confirmationId}
          type="checkbox"
          required
          aria-describedby={feedbackId}
          className="mt-1 size-5 accent-rose-900"
        />
        <span>
          Ich bestätige die endgültige Rücknahme von {issuance.issuanceReference}. Diese Ausstellungsfassung kann danach weder geladen noch freigegeben werden.
        </span>
      </label>
      <div className="mt-3">
        <SubmitButton
          pendingLabel="Rücknahme wird gespeichert …"
          accessibleContext={` für Ausstellungsfassung ${issuance.issuanceReference}`}
          tone="danger"
        >
          Rücknahme endgültig speichern
        </SubmitButton>
      </div>
    </form>
  );
}

function IssuanceCard({
  workspaceId,
  offerId,
  issuance,
  canApprove,
  canWithdraw,
}: {
  workspaceId: string;
  offerId: string;
  issuance: OfferIssuanceSurfaceView;
  canApprove: boolean;
  canWithdraw: boolean;
}) {
  const [approvalState, approvalAction] = useActionState(
    approveOfferIssuanceAction,
    OFFER_ISSUANCE_ACTION_INITIAL_STATE,
  );
  const [withdrawalState, withdrawalAction] = useActionState(
    withdrawOfferIssuanceAction,
    OFFER_ISSUANCE_ACTION_INITIAL_STATE,
  );
  const withdrawn = issuance.state === "withdrawn_before_archive";
  const approvalOpen = !withdrawn
    && issuance.renderState === "ready_for_approval"
    && issuance.approvalCount < 2;
  const titleId = `issuance-title-${issuance.issuanceId}`;
  const approvalFeedbackId = `issuance-approval-feedback-${issuance.issuanceId}`;
  const withdrawalFeedbackId = `issuance-withdrawal-feedback-${issuance.issuanceId}`;
  const approvalIssues: readonly FormIssue[] = [
    { id: `issuance-recipient-scope-${issuance.issuanceId}`, label: "Empfänger, Standort und Leistungsumfang", paths: ["/recipientAndScopeReviewed"] },
    { id: `issuance-commercial-totals-${issuance.issuanceId}`, label: "Positionen, Rabatte, Steuern und Summen", paths: ["/commercialTotalsReviewed"] },
    { id: `issuance-legal-profile-${issuance.issuanceId}`, label: "Angebotsbedingungen und Rechtshinweise", paths: ["/legalProfileReviewed"] },
    { id: `issuance-final-pdf-${issuance.issuanceId}`, label: "Finale PDF-Datei für das Archiv", paths: ["/finalPdfForArchiveUnderstood"] },
    { id: `issuance-zero-tax-${issuance.issuanceId}`, label: "0-%-Steuerbehandlung", paths: ["/zeroTaxTreatmentReviewed"] },
  ];
  const withdrawalIssues: readonly FormIssue[] = [{
    id: `issuance-withdrawal-reason-${issuance.issuanceId}`,
    label: "Rücknahmegrund",
    paths: ["/withdrawalReasonCode", "/reasonCode"],
  }];
  return (
    <article aria-labelledby={titleId} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 id={titleId} className="font-semibold text-slate-950">
            <span className="sr-only">Ausstellungsfassung {issuance.issuanceReference}: </span>
            {statusCopy(issuance)}
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Referenz {issuance.issuanceReference} · Variante {issuance.variantName}, Revision {issuance.variantRevision}
          </p>
          <p className="mt-1 text-sm text-slate-600">
            Freigabekandidat {issuance.candidateReference} · angelegt {formatDate(issuance.createdAt)}
          </p>
          <dl className="mt-1 text-sm text-slate-600">
            <div><dt className="inline">Render-Versuche: </dt><dd className="inline tabular-nums">{issuance.attemptCount}</dd></div>
            {issuance.state === "retry_wait" ? <div><dt className="inline">Nächster Versuch: </dt><dd className="inline"><time dateTime={issuance.nextAttemptAt}>{formatDate(issuance.nextAttemptAt)}</time></dd></div> : null}
          </dl>
          {issuance.renderState === "ready_for_approval" ? (
            <p className="mt-1 text-sm font-semibold text-slate-800">
              Bytefreigaben: {issuance.approvalCount} von 2 verschiedenen Personen
            </p>
          ) : null}
        </div>
        <span className="w-fit rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-950">
          Nicht ausgestellt · nicht versendet
        </span>
      </div>

      {issuance.state === "failed_final" ? (
        <p role="alert" className="mt-3 text-sm font-semibold text-rose-800">
          Diese gebundene Fassung kann nicht erneut erstellt werden. Für einen neuen Versuch zuerst einen neuen Freigabekandidaten aus einem neuen gespeicherten Revisionsstand abschließen. Technische Fehlerdetails bleiben intern redigiert.
        </p>
      ) : null}
      {issuance.withdrawal ? (
        <div className="mt-3 text-sm text-slate-700">
          <p>Rücknahmegrund: {withdrawalReasonLabel(issuance.withdrawal.reasonCode)} · {formatDate(issuance.withdrawal.withdrawnAt)}</p>
          <p className="mt-1 font-semibold text-slate-800">
            Für einen neuen Versuch ist ein neuer Freigabekandidat aus einem neuen gespeicherten Revisionsstand erforderlich.
          </p>
        </div>
      ) : null}
      {issuance.canDownload ? (
        <a
          href={`/w/${workspaceId}/angebote/${offerId}/ausstellungsfassungen/${issuance.issuanceId}/pdf`}
          className="mt-4 inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-950 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Finale PDF intern prüfen<span className="sr-only"> · Ausstellungsfassung {issuance.issuanceReference}</span>
        </a>
      ) : null}

      <ActionFeedback
        id={approvalFeedbackId}
        state={approvalState}
        issues={approvalIssues}
        resetNotice="Alle Prüfpunkte wurden nach dem Antwortlauf zurückgesetzt. Prüfe die finale PDF-Datei und bestätige jeden Punkt vor einem erneuten Versuch nochmals."
      />
      {approvalOpen && canApprove && issuance.canCurrentActorApprove ? (
        <ApprovalForm
          workspaceId={workspaceId}
          offerId={offerId}
          issuance={issuance}
          action={approvalAction}
          feedbackId={approvalFeedbackId}
          state={approvalState}
        />
      ) : null}
      {approvalOpen && canApprove && issuance.viewerHasApproved ? (
        <p className="mt-4 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm font-semibold text-blue-950">
          Deine Bytefreigabe zählt bereits als {issuance.approvalCount} von 2. Die zweite Freigabe muss eine andere berechtigte Person übernehmen.
        </p>
      ) : null}
      {approvalOpen && canApprove && !issuance.viewerHasApproved && !issuance.canCurrentActorApprove ? (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-950">
          Eine Bytefreigabe ist in diesem Zustand für dich nicht möglich. Status aktualisieren und die angezeigte Rollen- und Freigabebindung prüfen.
        </p>
      ) : null}
      <ActionFeedback
        id={withdrawalFeedbackId}
        state={withdrawalState}
        issues={withdrawalIssues}
        resetNotice="Rücknahmegrund und Bestätigung wurden nach dem Antwortlauf zurückgesetzt. Prüfe beide Angaben vor einem erneuten Versuch nochmals."
      />
      {!withdrawn && canWithdraw ? (
        <details className="mt-4 rounded-md border border-rose-200 bg-rose-50/60 px-4 py-3">
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-rose-900 outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-rose-700 focus-visible:ring-offset-2">
            Ausstellungsfassung zurücknehmen
          </summary>
          <WithdrawalForm
            workspaceId={workspaceId}
            offerId={offerId}
            issuance={issuance}
            action={withdrawalAction}
            feedbackId={withdrawalFeedbackId}
            state={withdrawalState}
          />
        </details>
      ) : null}
    </article>
  );
}

function RequestForm({
  workspaceId,
  offerId,
  candidates,
  repairableCandidateIds,
  action,
  feedbackId,
  state,
}: {
  workspaceId: string;
  offerId: string;
  candidates: readonly OfferIssuanceCandidateSurfaceView[];
  repairableCandidateIds: ReadonlySet<string>;
  action: (payload: FormData) => void;
  feedbackId: string;
  state: OfferIssuanceActionState;
}) {
  const candidateFieldId = "offer-issuance-candidate";
  const repairableCount = candidates.filter((candidate) => (
    repairableCandidateIds.has(candidate.candidateId)
  )).length;
  const buttonLabel = repairableCount === candidates.length
    ? "Erstellung erneut anstoßen"
    : repairableCount > 0
      ? "Fassung erstellen oder Erstellung erneut anstoßen"
      : "Ausstellungsfassung erstellen";
  const candidateIssues: readonly FormIssue[] = [{
    id: candidateFieldId,
    label: "Freigabekandidat",
    paths: ["/candidateId"],
  }];
  const candidateInvalid = isIssueInvalid(state, candidateIssues, candidateFieldId);
  return (
    <form action={action} aria-describedby={feedbackId} className="rounded-lg border border-blue-200 bg-blue-50 p-4 sm:p-5">
      <input type="hidden" name="schemaVersion" value={OFFER_ISSUANCE_REQUEST_VERSION} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="offerId" value={offerId} />
      <fieldset
        id={candidateFieldId}
        tabIndex={-1}
        aria-invalid={candidateInvalid || undefined}
        aria-describedby={describedBy(feedbackId)}
        className={`min-w-0 rounded-md border p-3 outline-none ${candidateInvalid ? "border-rose-600 ring-1 ring-rose-600/30" : "border-blue-300"}`}
      >
        <legend className="px-1 text-sm font-semibold text-blue-950">Freigegebenen Freigabekandidaten wählen</legend>
        <div className="grid min-w-0 gap-2">
          {candidates.map((candidate) => {
            const inputId = `offer-issuance-candidate-${candidate.candidateId}`;
            const repairable = repairableCandidateIds.has(candidate.candidateId);
            return (
              <label key={candidate.candidateId} htmlFor={inputId} className="flex min-w-0 cursor-pointer items-start gap-3 rounded-md border border-blue-200 bg-white p-3 text-sm leading-6 text-slate-800 outline-none hover:border-blue-400">
                <input
                  id={inputId}
                  type="radio"
                  name="candidateId"
                  value={candidate.candidateId}
                  required
                  defaultChecked={candidates.length === 1}
                  aria-describedby={describedBy(feedbackId)}
                  className="mt-1 size-5 shrink-0 accent-slate-950"
                />
                <span className="min-w-0">
                  <span className="block break-words font-semibold text-slate-950">{candidate.variantName} · Revision {candidate.variantRevision}</span>
                  <span className="block break-words">{candidate.candidateReference} · freigegeben {formatDate(candidate.approvedAt)}</span>
                  <span className="block font-semibold text-blue-900">{repairable ? "Laufende Erstellung erneut anstoßen" : "Neue Fassung erstellen"}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      {repairableCount > 0 ? (
        <p className="mt-2 max-w-3xl text-sm font-semibold leading-6 text-blue-950">
          Als „laufende Erstellung erneut anstoßen“ markierte Einträge verwenden denselben gebundenen Auftrag und lösen dessen sichere Warteschlangen-Reparatur erneut aus.
        </p>
      ) : null}
      <div className="mt-3">
        <SubmitButton
          pendingLabel="Finale Fassung wird angefordert …"
          accessibleContext=" für den ausgewählten Freigabekandidaten"
        >
          {buttonLabel}
        </SubmitButton>
      </div>
    </form>
  );
}

export function OfferIssuancePanel({
  workspaceId,
  offerId,
  canPrepare,
  canApprove,
  canWithdraw,
  approvedCandidates,
  issuances,
}: {
  workspaceId: string;
  offerId: string;
  canPrepare: boolean;
  canApprove: boolean;
  canWithdraw: boolean;
  approvedCandidates: readonly OfferIssuanceCandidateSurfaceView[];
  issuances: readonly OfferIssuanceSurfaceView[];
}) {
  const [requestState, requestAction] = useActionState(
    requestOfferIssuanceAction,
    OFFER_ISSUANCE_ACTION_INITIAL_STATE,
  );
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();
  const refreshHref = queryString.length > 0 ? `${pathname}?${queryString}` : pathname;
  const terminalOrReviewCandidateIds = new Set(issuances.filter((issuance) => (
    issuance.state !== "queued"
    && issuance.state !== "running"
    && issuance.state !== "retry_wait"
  )).map((issuance) => issuance.candidateId));
  const repairableCandidateIds = new Set(issuances.filter((issuance) => (
    !terminalOrReviewCandidateIds.has(issuance.candidateId)
    && (
      issuance.state === "queued"
      || issuance.state === "running"
      || issuance.state === "retry_wait"
    )
  )).map((issuance) => issuance.candidateId));
  const requestableCandidates = approvedCandidates.filter((candidate) => (
    !terminalOrReviewCandidateIds.has(candidate.candidateId)
  ));
  const terminalOrReviewCandidateCount = approvedCandidates.length - requestableCandidates.length;
  const requestFeedbackId = "offer-issuance-request-feedback";
  const readOnly = !canPrepare && !canApprove && !canWithdraw;
  return (
    <section id="offer-issuance" tabIndex={-1} aria-labelledby="offer-issuance-title" className="min-w-0 rounded-xl border border-slate-300 bg-slate-100 p-4 outline-none sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="max-w-4xl">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Finale Dokumentstufe</p>
          <h2 id="offer-issuance-title" className="mt-1 text-xl font-semibold text-slate-950">Ausstellungsfassung</h2>
          <p className="mt-2 text-sm leading-6 text-slate-700">
            Der Freigabekandidat wird niemals ausgestellt. Aus demselben versiegelten Datenstand entsteht eine neue finale PDF-Datei. Erst zwei bytegebundene Freigaben und ein späterer echter Archivnachweis dürfen daraus ein ausgestelltes Dokument machen.
          </p>
          <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-950">
            Archivierung nicht verfügbar: Live-Object-Lock und Retention-Policy sind noch nicht verifiziert.
          </p>
          {readOnly ? <p className="mt-3 text-sm font-semibold text-slate-700">Nur Lesezugriff</p> : null}
        </div>
        <OfferDirtyNavigationLink
          href={refreshHref}
          label="Status der Ausstellungsfassungen aktualisieren"
          kind="refresh"
          className="inline-flex min-h-11 shrink-0 items-center text-sm font-semibold text-blue-700 underline decoration-2 underline-offset-4 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          <span className="sr-only">Ausstellungsfassungen: </span>Status aktualisieren
        </OfferDirtyNavigationLink>
      </div>

      {canPrepare && requestableCandidates.length > 0 ? (
        <div className="mt-5">
          <RequestForm
            workspaceId={workspaceId}
            offerId={offerId}
            candidates={requestableCandidates}
            repairableCandidateIds={repairableCandidateIds}
            action={requestAction}
            feedbackId={requestFeedbackId}
            state={requestState}
          />
        </div>
      ) : canPrepare && approvedCandidates.length === 0 ? (
        <p className="mt-5 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          Zuerst muss ein Freigabekandidat bytegebunden abgeschlossen werden.{" "}
          <OfferDirtyNavigationLink
            href={`${refreshHref}#offer-release-candidate`}
            label="Freigabekandidaten öffnen"
            className="font-semibold text-blue-700 underline decoration-2 underline-offset-4 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Freigabekandidaten öffnen
          </OfferDirtyNavigationLink>
          .
        </p>
      ) : null}
      <ActionFeedback
        id={requestFeedbackId}
        state={requestState}
        issues={[{ id: "offer-issuance-candidate", label: "Freigabekandidat", paths: ["/candidateId"] }]}
        resetNotice="Die Auswahl des Freigabekandidaten wurde nach dem Antwortlauf zurückgesetzt. Wähle den geprüften Stand vor einem erneuten Versuch nochmals aus."
      />
      {canPrepare && terminalOrReviewCandidateCount > 0 ? (
        <p className="mt-4 rounded-md border border-slate-300 bg-white px-4 py-3 text-sm leading-6 text-slate-700">
          {terminalOrReviewCandidateCount === 1
            ? "Für einen freigegebenen Freigabekandidaten existiert bereits eine eindeutig gebundene Ausstellungsfassung."
            : `Für ${terminalOrReviewCandidateCount} freigegebene Freigabekandidaten existieren bereits eindeutig gebundene Ausstellungsfassungen.`}{" "}
          Prüfbereite und terminale Stände stehen nicht erneut zur Erstellungsauswahl; nutze die jeweilige Karte unten. Nach endgültigem Fehler oder Rücknahme ist ein neuer Freigabekandidat aus einem neuen gespeicherten Revisionsstand erforderlich.{" "}
          <OfferDirtyNavigationLink
            href={`${refreshHref}#offer-release-candidate`}
            label="Neuen Freigabekandidaten vorbereiten"
            className="font-semibold text-blue-700 underline decoration-2 underline-offset-4 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Freigabekandidaten öffnen
          </OfferDirtyNavigationLink>
          .
        </p>
      ) : null}

      <div className="mt-5 grid gap-4">
        {issuances.length === 0 ? (
          <p className="rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
            Noch keine Ausstellungsfassung vorhanden.
          </p>
        ) : issuances.map((issuance) => (
          <IssuanceCard
            key={issuance.issuanceId}
            workspaceId={workspaceId}
            offerId={offerId}
            issuance={issuance}
            canApprove={canApprove}
            canWithdraw={canWithdraw}
          />
        ))}
      </div>
    </section>
  );
}
