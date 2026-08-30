"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  OFFER_RECIPIENT_REVISE_COMMAND_VERSION,
  OFFER_RELEASE_APPROVAL_COMMAND_VERSION,
  OFFER_RELEASE_CANDIDATE_REQUEST_VERSION,
} from "@/lib/integrations/offers/release-contract";
import {
  approveOfferReleaseCandidateAction,
  requestOfferReleaseCandidateAction,
  reviseOfferRecipientAction,
} from "../release-actions";
import {
  OFFER_RELEASE_ACTION_INITIAL_STATE,
  type OfferReleaseActionState,
} from "../release-action-state";
import { OfferDirtyNavigationLink } from "./dirty-navigation-guard";

export type OfferReleaseProfileSurfaceView = {
  profileId: string;
  profileRevisionId: string;
  revision: number;
  profileName: string;
};

export type OfferRecipientSurfaceView = {
  recipientRevisionId: string;
  revision: number;
  displayName: string;
  company: string | null;
  email: string;
  billingAddress: {
    street: string;
    houseNumber: string;
    postalCode: string;
    city: string;
    country: "DE";
  };
};

export type OfferRecipientPresenceSurfaceView = {
  revision: number;
};

export type OfferReleaseValidityWindowSurfaceView = {
  min: string;
  suggested: string;
  max: string;
};

export type OfferReleaseCandidateSurfaceView = {
  candidateId: string;
  variantId: string;
  variantRevision: number;
  state: "queued" | "running" | "retry_wait" | "ready_for_approval" | "failed_final" | "approved_not_issued";
  publicationStatus: "not_issued";
  requiresZeroTaxReview: boolean;
  attemptCount: number;
  nextAttemptAt: string;
  createdAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  approvedAt: string | null;
  canDownload: boolean;
  approvalArtifactVersion?: string;
};

type FormIssue = {
  id: string;
  label: string;
  paths: readonly string[];
};

const fieldClass = "mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-950 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600/30 disabled:cursor-not-allowed disabled:bg-slate-100";
const invalidFieldClass = "border-rose-600 ring-1 ring-rose-600/30";
const dateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});
const calendarDateFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeZone: "Europe/Berlin",
});

const RECIPIENT_ISSUES: readonly FormIssue[] = [
  { id: "recipient-display-name", label: "Empfängername", paths: ["/displayName"] },
  { id: "recipient-company", label: "Firma", paths: ["/company"] },
  { id: "recipient-email", label: "E-Mail", paths: ["/email"] },
  { id: "billing-street", label: "Straße", paths: ["/billingAddress/street"] },
  { id: "billing-house-number", label: "Hausnummer", paths: ["/billingAddress/houseNumber"] },
  { id: "billing-postal-code", label: "Postleitzahl", paths: ["/billingAddress/postalCode"] },
  { id: "billing-city", label: "Ort", paths: ["/billingAddress/city"] },
  {
    id: "billing-details-confirmed",
    label: "Bestätigung der geprüften Rechnungsadresse",
    paths: ["/billingDetailsConfirmed"],
  },
];
const CANDIDATE_ISSUES: readonly FormIssue[] = [
  { id: "release-valid-through", label: "Gültig bis", paths: ["/validThrough"] },
];

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? dateFormatter.format(date) : "Zeitpunkt nicht verfügbar";
}

function formatCalendarDate(value: string): string {
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? calendarDateFormatter.format(date) : value;
}

function conflictFeedback(state: Extract<OfferReleaseActionState, { status: "conflict" }>): string {
  const labels: Readonly<Record<string, string>> = {
    variant_revision_changed: "Die Angebotsvariante wurde geändert.",
    profile_revision_changed: "Das Angebotsprofil wurde geändert.",
    recipient_revision_changed: "Die Empfängerangaben wurden geändert.",
    source_pdf_draft_changed: "Der interne Quellentwurf ist nicht mehr gültig.",
    profile_activation_changed: "Die Profilaktivierung wurde geändert.",
    hidden_line_present: "Mindestens eine ausgeblendete Position blockiert den Freigabekandidaten.",
    validity_window_changed: "Das Gültigkeitsdatum liegt nicht mehr im erlaubten Zeitraum.",
    candidate_not_ready: "Der Freigabekandidat ist noch nicht prüfbereit.",
    candidate_source_changed: "Eine gebundene Quelle wurde nachträglich geändert.",
    artifact_integrity_changed: "Die PDF-Integritätsprüfung ist fehlgeschlagen.",
    approval_conflict: "Dieser Freigabekandidat wurde bereits abschließend bearbeitet.",
    zero_tax_review_required: "Die zusätzliche Prüfung der 0-%-Steuerbehandlung fehlt.",
    zero_tax_review_forbidden: "Die zusätzliche 0-%-Bestätigung ist für diesen Kandidaten nicht zulässig.",
  };
  const prefix = state.code ? labels[state.code] : undefined;
  const revision = state.currentRevision === undefined
    ? ""
    : ` Aktuell ist Revision ${state.currentRevision}.`;
  return `${prefix ?? "Der gebundene Stand wurde zwischenzeitlich geändert."}${revision} Lade die Seite neu.`;
}

function actionFeedback(state: OfferReleaseActionState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "recipient_saved") return `Empfänger und Rechnungsadresse wurden als Revision ${state.recipientRevision} gespeichert.`;
  if (state.status === "candidate_requested") {
    return state.replayed
      ? `Der vorhandene Freigabekandidat für Variantenrevision ${state.variantRevision} wird angezeigt.`
      : `Der Freigabekandidat für Variantenrevision ${state.variantRevision} wurde zur Erstellung angenommen.`;
  }
  if (state.status === "candidate_approved") {
    return state.replayed
      ? "Die vorhandene Abschlussfreigabe wird angezeigt. Das Dokument bleibt nicht ausgestellt und nicht versendet."
      : "Die Abschlussfreigabe wurde gespeichert. Das Dokument bleibt nicht ausgestellt und nicht versendet.";
  }
  if (state.status === "invalid") return "Die Eingabe wurde nicht akzeptiert. Prüfe die Pflichtangaben und versuche es erneut.";
  if (state.status === "unauthenticated") return "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  if (state.status === "denied") return "Dir fehlt die Berechtigung für diesen Schritt.";
  if (state.status === "not_found") return "Der gebundene Angebotsstand ist nicht mehr verfügbar. Lade die Seite neu.";
  if (state.status === "conflict") return conflictFeedback(state);
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
  state: OfferReleaseActionState,
  issues: readonly FormIssue[],
): readonly FormIssue[] {
  if (state.status !== "invalid" || !state.paths) return [];
  return issues.filter((issue) => state.paths?.some((path) => pathMatchesIssue(path, issue)));
}

function isIssueInvalid(
  state: OfferReleaseActionState,
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
  successFocusTargetId,
  resetNotice,
}: {
  id: string;
  state: OfferReleaseActionState;
  issues?: readonly FormIssue[];
  successFocusTargetId?: string;
  resetNotice?: string;
}) {
  const isError = ![
    "idle",
    "recipient_saved",
    "candidate_requested",
    "candidate_approved",
  ].includes(state.status);
  const linkedIssues = matchingIssues(state, issues);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.status === "idle") return;
    const successTarget = !isError && successFocusTargetId
      ? document.getElementById(successFocusTargetId)
      : null;
    (successTarget ?? ref.current)?.focus();
  }, [isError, state, successFocusTargetId]);
  return (
    <div
      ref={ref}
      id={id}
      role={isError ? "alert" : "status"}
      aria-live={isError ? "assertive" : "polite"}
      aria-atomic="true"
      tabIndex={state.status === "idle" ? undefined : -1}
      className={`mt-3 min-h-6 text-sm font-semibold outline-none ${isError ? "text-rose-800" : "text-emerald-800"}`}
    >
      {actionFeedback(state)}
      {isError && resetNotice ? (
        <p className="mt-2 font-normal">{resetNotice}</p>
      ) : null}
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

function SubmitButton({ pendingLabel, children }: {
  pendingLabel: string;
  children: React.ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      aria-disabled={pending || undefined}
      aria-busy={pending || undefined}
      onClick={(event) => {
        if (pending) event.preventDefault();
      }}
      className={`inline-flex min-h-11 items-center justify-center rounded-md px-4 py-2 text-sm font-semibold text-white outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${pending ? "cursor-wait bg-slate-700" : "bg-slate-950 hover:bg-slate-800"}`}
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

function TextField({
  id,
  name,
  label,
  defaultValue,
  type = "text",
  autoComplete,
  required = true,
  invalid = false,
  feedbackId,
  validationState,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string | null;
  type?: "text" | "email";
  autoComplete?: string;
  required?: boolean;
  invalid?: boolean;
  feedbackId?: string;
  validationState: OfferReleaseActionState;
}) {
  const normalizedDefaultValue = defaultValue ?? "";
  const [value, setValue] = useState(normalizedDefaultValue);
  const [invalidClearedFor, setInvalidClearedFor] = useState<OfferReleaseActionState | null>(null);
  const effectiveInvalid = invalid && invalidClearedFor !== validationState;

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-semibold text-slate-800">
        {label}{required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={id}
        name={name}
        type={type}
        value={value}
        onChange={(event) => {
          setValue(event.currentTarget.value);
          if (invalid) setInvalidClearedFor(validationState);
        }}
        required={required}
        autoComplete={autoComplete}
        aria-invalid={effectiveInvalid || undefined}
        aria-describedby={describedBy(effectiveInvalid && feedbackId)}
        className={`${fieldClass} ${effectiveInvalid ? invalidFieldClass : ""}`}
      />
    </div>
  );
}

function CheckRow({
  id,
  name,
  invalid = false,
  feedbackId,
  validationState,
  children,
}: {
  id: string;
  name: string;
  invalid?: boolean;
  feedbackId?: string;
  validationState: OfferReleaseActionState;
  children: React.ReactNode;
}) {
  const [invalidClearedFor, setInvalidClearedFor] = useState<OfferReleaseActionState | null>(null);
  const effectiveInvalid = invalid && invalidClearedFor !== validationState;
  return (
    <label htmlFor={id} className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-md border bg-white px-3 py-3 text-sm leading-6 text-slate-800 focus-within:ring-2 focus-within:ring-blue-600 focus-within:ring-offset-2 ${effectiveInvalid ? "border-rose-600" : "border-slate-200"}`}>
      <input
        id={id}
        name={name}
        value="true"
        type="checkbox"
        required
        onChange={() => {
          if (invalid) setInvalidClearedFor(validationState);
        }}
        aria-invalid={effectiveInvalid || undefined}
        aria-describedby={describedBy(effectiveInvalid && feedbackId)}
        className="mt-1 size-5 shrink-0 accent-slate-950"
      />
      <span>{children}</span>
    </label>
  );
}

function candidateStateLabel(state: OfferReleaseCandidateSurfaceView["state"]): string {
  if (state === "queued") return "In Warteschlange";
  if (state === "running") return "PDF wird erzeugt";
  if (state === "retry_wait") return "Neuer Erstellungsversuch vorgesehen";
  if (state === "ready_for_approval") return "Bereit für die finale Prüfung";
  if (state === "approved_not_issued") return "Intern freigegeben · weiterhin nicht ausgestellt";
  return "Erstellung endgültig fehlgeschlagen";
}

function candidateErrorLabel(code: string | null): string | null {
  if (code === null) return null;
  const labels: Readonly<Record<string, string>> = {
    render_timeout: "Das Zeitlimit der PDF-Erstellung wurde erreicht.",
    render_failed: "Der PDF-Inhalt konnte nicht erzeugt werden.",
    invalid_render_output: "Das Dokument bestand die Integritätsprüfung nicht.",
    worker_shutdown: "Die Erstellung wurde unterbrochen.",
  };
  return labels[code] ?? "Die Erstellung konnte nicht abgeschlossen werden.";
}

function CandidateApprovalItem({
  workspaceId,
  offerId,
  variantId,
  variantRevision,
  canApprove,
  candidate,
}: {
  workspaceId: string;
  offerId: string;
  variantId: string;
  variantRevision: number;
  canApprove: boolean;
  candidate: OfferReleaseCandidateSurfaceView;
}) {
  const [approvalState, approvalAction] = useActionState(
    approveOfferReleaseCandidateAction,
    OFFER_RELEASE_ACTION_INITIAL_STATE,
  );
  const currentVariant = candidate.variantId === variantId
    && candidate.variantRevision === variantRevision;
  const failure = candidateErrorLabel(candidate.errorCode);
  const downloadHref = `/w/${workspaceId}/angebote/${offerId}/freigabekandidaten/${candidate.candidateId}/pdf`;
  const feedbackId = `approval-action-feedback-${candidate.candidateId}`;
  const candidateTitleId = `candidate-status-${candidate.candidateId}`;
  const approvalIssues: readonly FormIssue[] = [
    {
      id: `recipient-reviewed-${candidate.candidateId}`,
      label: "Empfänger und Rechnungsadresse",
      paths: ["/recipientBillingReviewed"],
    },
    {
      id: `commercial-reviewed-${candidate.candidateId}`,
      label: "Leistungsumfang und kaufmännische Inhalte",
      paths: ["/commercialContentReviewed"],
    },
    {
      id: `profile-reviewed-${candidate.candidateId}`,
      label: "Aktives Angebotsprofil",
      paths: ["/activeProfileReviewed"],
    },
    {
      id: `status-understood-${candidate.candidateId}`,
      label: "Status nicht ausgestellt und nicht versendet",
      paths: ["/notIssuedStatusUnderstood"],
    },
    {
      id: `zero-tax-reviewed-${candidate.candidateId}`,
      label: "0-%-Steuerbehandlung",
      paths: ["/zeroTaxTreatmentReviewed"],
    },
  ];

  return (
    <li className="rounded-md border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 id={candidateTitleId} tabIndex={-1} className="font-semibold text-slate-950 outline-none">Variantenrevision {candidate.variantRevision} · {candidateStateLabel(candidate.state)}</h4>
          <p className="mt-1 text-sm font-semibold text-slate-700">Nicht ausgestellt · nicht versendet</p>
          <dl className="mt-2 grid gap-x-5 gap-y-1 text-sm text-slate-700 sm:grid-cols-2">
            <div><dt className="inline">Erstellt: </dt><dd className="inline"><time dateTime={candidate.createdAt}>{formatDate(candidate.createdAt)}</time></dd></div>
            <div><dt className="inline">Render-Versuche: </dt><dd className="inline tabular-nums">{candidate.attemptCount}</dd></div>
            {candidate.state === "retry_wait" ? <div className="sm:col-span-2"><dt className="inline">Nächster Versuch: </dt><dd className="inline"><time dateTime={candidate.nextAttemptAt}>{formatDate(candidate.nextAttemptAt)}</time></dd></div> : null}
            {candidate.approvedAt ? <div className="sm:col-span-2"><dt className="inline">Abschlussfreigabe: </dt><dd className="inline"><time dateTime={candidate.approvedAt}>{formatDate(candidate.approvedAt)}</time></dd></div> : null}
          </dl>
          {!currentVariant ? <p className="mt-2 text-sm font-semibold text-amber-900">Historischer Kandidat; die aktuell angezeigte Variante hat Revision {variantRevision}.</p> : null}
          {failure ? <p className="mt-2 text-sm font-semibold text-rose-800">{failure}</p> : null}
          {candidate.state === "ready_for_approval" && currentVariant && !canApprove ? <p className="mt-2 text-sm text-slate-700">Für die finale Prüfung dieses Kandidaten ist ein eigenes Freigaberecht erforderlich.</p> : null}
        </div>
        {candidate.canDownload ? <a href={downloadHref} className="inline-flex min-h-11 shrink-0 items-center justify-center rounded-md border border-slate-400 bg-white px-4 py-2 text-sm font-semibold text-slate-900 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Freigabekandidat-PDF laden</a> : null}
      </div>
      {candidate.state === "ready_for_approval"
        && canApprove
        && currentVariant
        && candidate.approvalArtifactVersion !== undefined ? (
        <form action={approvalAction} aria-describedby={feedbackId} className="mt-4 border-t border-slate-200 pt-4">
          <input type="hidden" name="schemaVersion" value={OFFER_RELEASE_APPROVAL_COMMAND_VERSION} />
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="offerId" value={offerId} />
          <input type="hidden" name="candidateId" value={candidate.candidateId} />
          <input type="hidden" name="expectedArtifactVersion" value={candidate.approvalArtifactVersion} />
          <fieldset className="min-w-0 border-0 p-0">
            <legend className="text-sm font-semibold text-slate-950">Verbindliche interne Prüfpunkte</legend>
            <div className="mt-3 grid gap-2">
              <CheckRow id={`recipient-reviewed-${candidate.candidateId}`} name="recipientBillingReviewed" invalid={isIssueInvalid(approvalState, approvalIssues, `recipient-reviewed-${candidate.candidateId}`)} feedbackId={feedbackId} validationState={approvalState}>Empfänger und Rechnungsadresse stimmen mit dem geprüften Kundenstand überein.</CheckRow>
              <CheckRow id={`commercial-reviewed-${candidate.candidateId}`} name="commercialContentReviewed" invalid={isIssueInvalid(approvalState, approvalIssues, `commercial-reviewed-${candidate.candidateId}`)} feedbackId={feedbackId} validationState={approvalState}>Leistungsumfang, Preise, Rabatte, Steuern und Summen wurden am erzeugten PDF geprüft.</CheckRow>
              <CheckRow id={`profile-reviewed-${candidate.candidateId}`} name="activeProfileReviewed" invalid={isIssueInvalid(approvalState, approvalIssues, `profile-reviewed-${candidate.candidateId}`)} feedbackId={feedbackId} validationState={approvalState}>Ausstellerangaben und Rechtstexte entsprechen dem intern geprüften aktiven Profil.</CheckRow>
              <CheckRow id={`status-understood-${candidate.candidateId}`} name="notIssuedStatusUnderstood" invalid={isIssueInvalid(approvalState, approvalIssues, `status-understood-${candidate.candidateId}`)} feedbackId={feedbackId} validationState={approvalState}>Ich verstehe, dass dieser Kandidat nicht ausgestellt und nicht versendet ist.</CheckRow>
              {candidate.requiresZeroTaxReview ? <CheckRow id={`zero-tax-reviewed-${candidate.candidateId}`} name="zeroTaxTreatmentReviewed" invalid={isIssueInvalid(approvalState, approvalIssues, `zero-tax-reviewed-${candidate.candidateId}`)} feedbackId={feedbackId} validationState={approvalState}>Die Behandlung aller Positionen mit 0 % Umsatzsteuer wurde ausdrücklich geprüft.</CheckRow> : null}
            </div>
          </fieldset>
          <div className="mt-4"><SubmitButton pendingLabel="PDF-Bytes werden erneut geprüft …">Abschlussfreigabe speichern</SubmitButton></div>
        </form>
      ) : null}
      <ActionFeedback
        id={feedbackId}
        state={approvalState}
        issues={approvalIssues}
        successFocusTargetId={candidateTitleId}
        resetNotice="Alle Prüfpunkte wurden nach dem Antwortlauf zurückgesetzt. Prüfe das PDF und bestätige jeden Punkt vor einem erneuten Versuch nochmals."
      />
    </li>
  );
}

export function OfferReleaseCandidatePanel({
  workspaceId,
  offerId,
  variantId,
  variantRevision,
  contactDisplayName,
  profile,
  recipient,
  recipientPresence,
  sourcePdfDraftId,
  validityWindow,
  canPrepare,
  canApprove,
  candidates,
}: {
  workspaceId: string;
  offerId: string;
  variantId: string;
  variantRevision: number;
  contactDisplayName: string | null;
  profile: OfferReleaseProfileSurfaceView | null;
  recipient: OfferRecipientSurfaceView | null;
  recipientPresence: OfferRecipientPresenceSurfaceView | null;
  sourcePdfDraftId: string | null;
  validityWindow: OfferReleaseValidityWindowSurfaceView;
  canPrepare: boolean;
  canApprove: boolean;
  candidates: readonly OfferReleaseCandidateSurfaceView[];
}) {
  const [recipientState, recipientAction] = useActionState(
    reviseOfferRecipientAction,
    OFFER_RELEASE_ACTION_INITIAL_STATE,
  );
  const [candidateState, candidateAction] = useActionState(
    requestOfferReleaseCandidateAction,
    OFFER_RELEASE_ACTION_INITIAL_STATE,
  );
  const settingsHref = `/w/${workspaceId}/einstellungen/angebotsprofile`;
  const refreshHref = `/w/${workspaceId}/angebote/${offerId}?variante=${variantId}`;
  const canRequest = canPrepare && profile !== null && recipient !== null && sourcePdfDraftId !== null;
  const recipientFeedbackId = "recipient-action-feedback";
  const candidateFeedbackId = "candidate-action-feedback";
  const recipientBaselineKey = recipient
    ? `${recipient.recipientRevisionId}:${recipient.revision}`
    : "recipient-missing";
  const currentRecipientRevision = recipient?.revision ?? 0;
  const recipientStateMatchesBaseline = recipientState.status === "idle"
    || (recipientState.status === "recipient_saved"
      ? recipient !== null && recipientState.recipientRevision === recipient.revision
      : recipientState.submittedRecipientRevision === currentRecipientRevision);
  const visibleRecipientState = recipientStateMatchesBaseline
    ? recipientState
    : OFFER_RELEASE_ACTION_INITIAL_STATE;
  const validThroughInvalid = isIssueInvalid(candidateState, CANDIDATE_ISSUES, "release-valid-through");
  const [validThrough, setValidThrough] = useState(validityWindow.suggested);
  const [validThroughInvalidClearedFor, setValidThroughInvalidClearedFor] = useState<OfferReleaseActionState | null>(null);
  const effectiveValidThroughInvalid = validThroughInvalid
    && validThroughInvalidClearedFor !== candidateState;

  return (
    <section id="offer-release-candidate" tabIndex={-1} aria-labelledby="offer-release-title" className="rounded-lg border border-slate-300 bg-white p-5 shadow-sm outline-none sm:p-6">
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-5 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Kundentaugliche Dokumentvorbereitung</p>
          <h2 id="offer-release-title" className="mt-1 text-xl font-semibold text-slate-950">Angebots-Freigabekandidat</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">
            Drei getrennte Schritte binden Empfänger, gespeicherten Angebotsstand und die abschließend geprüften PDF-Bytes.
          </p>
          <p className="mt-3 inline-flex rounded-full border border-slate-400 bg-slate-100 px-3 py-1.5 text-sm font-semibold text-slate-800">
            Freigabekandidat · nicht ausgestellt · nicht versendet
          </p>
        </div>
        <OfferDirtyNavigationLink href={refreshHref} label="Freigabestatus aktualisieren" kind="refresh" className="inline-flex min-h-11 shrink-0 items-center text-sm font-semibold text-blue-700 underline decoration-2 underline-offset-4 outline-none hover:text-blue-900 focus-visible:rounded focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2">Status aktualisieren</OfferDirtyNavigationLink>
      </div>

      <ol role="list" className="mt-6 grid list-none gap-6 p-0">
        <li>
          <section aria-labelledby="release-step-recipient" className="rounded-lg border border-slate-200 bg-slate-50 p-4 sm:p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Schritt 1 von 3</p>
            <h3 id="release-step-recipient" tabIndex={-1} className="mt-1 text-lg font-semibold text-slate-950 outline-none"><span className="sr-only">Schritt 1 von 3: </span>Empfänger und Rechnungsadresse</h3>
            <p className="mt-2 text-sm leading-6 text-slate-700">Die Rechnungsadresse wird ausdrücklich erfasst und niemals still aus dem Anlagenstandort übernommen.</p>
            {canPrepare ? (
              <form key={recipientBaselineKey} action={recipientAction} aria-describedby={recipientFeedbackId} className="mt-5">
                <input type="hidden" name="schemaVersion" value={OFFER_RECIPIENT_REVISE_COMMAND_VERSION} />
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="offerId" value={offerId} />
                <input type="hidden" name="expectedCurrentRevision" value={String(recipient?.revision ?? 0)} />
                <input type="hidden" name="country" value="DE" />
                <fieldset className="min-w-0 border-0 p-0">
                  <legend className="sr-only">Geprüfte Empfängerangaben</legend>
                  <div className="grid min-w-0 gap-4 md:grid-cols-2">
                    <TextField id="recipient-display-name" name="displayName" label="Empfängername" defaultValue={recipient?.displayName ?? contactDisplayName} autoComplete="name" invalid={isIssueInvalid(visibleRecipientState, RECIPIENT_ISSUES, "recipient-display-name")} feedbackId={recipientFeedbackId} validationState={visibleRecipientState} />
                    <TextField id="recipient-company" name="company" label="Firma (optional)" defaultValue={recipient?.company} autoComplete="organization" required={false} invalid={isIssueInvalid(visibleRecipientState, RECIPIENT_ISSUES, "recipient-company")} feedbackId={recipientFeedbackId} validationState={visibleRecipientState} />
                    <TextField id="recipient-email" name="email" label="E-Mail" defaultValue={recipient?.email} type="email" autoComplete="email" invalid={isIssueInvalid(visibleRecipientState, RECIPIENT_ISSUES, "recipient-email")} feedbackId={recipientFeedbackId} validationState={visibleRecipientState} />
                    <TextField id="billing-street" name="street" label="Straße" defaultValue={recipient?.billingAddress.street} autoComplete="billing address-line1" invalid={isIssueInvalid(visibleRecipientState, RECIPIENT_ISSUES, "billing-street")} feedbackId={recipientFeedbackId} validationState={visibleRecipientState} />
                    <TextField id="billing-house-number" name="houseNumber" label="Hausnummer" defaultValue={recipient?.billingAddress.houseNumber} invalid={isIssueInvalid(visibleRecipientState, RECIPIENT_ISSUES, "billing-house-number")} feedbackId={recipientFeedbackId} validationState={visibleRecipientState} />
                    <TextField id="billing-postal-code" name="postalCode" label="Postleitzahl" defaultValue={recipient?.billingAddress.postalCode} autoComplete="billing postal-code" invalid={isIssueInvalid(visibleRecipientState, RECIPIENT_ISSUES, "billing-postal-code")} feedbackId={recipientFeedbackId} validationState={visibleRecipientState} />
                    <TextField id="billing-city" name="city" label="Ort" defaultValue={recipient?.billingAddress.city} autoComplete="billing address-level2" invalid={isIssueInvalid(visibleRecipientState, RECIPIENT_ISSUES, "billing-city")} feedbackId={recipientFeedbackId} validationState={visibleRecipientState} />
                  </div>
                  <div className="mt-4">
                    <CheckRow id="billing-details-confirmed" name="billingDetailsConfirmed" invalid={isIssueInvalid(visibleRecipientState, RECIPIENT_ISSUES, "billing-details-confirmed")} feedbackId={recipientFeedbackId} validationState={visibleRecipientState}>Ich habe Empfänger und Rechnungsadresse für dieses Angebot geprüft.</CheckRow>
                  </div>
                </fieldset>
                <div className="mt-4"><SubmitButton pendingLabel="Angaben werden geprüft …">Empfängerstand speichern</SubmitButton></div>
              </form>
            ) : (
              <p className="mt-4 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">Nur berechtigte interne Bearbeiter können Empfängerangaben speichern. Personenbezogene Empfängerdetails werden in dieser Portalansicht nicht bereitgestellt; ein intern freigegebener Kandidat kann gemäß Leserecht als PDF verfügbar sein.</p>
            )}
            {recipientPresence ? <p className="mt-3 text-sm font-semibold text-emerald-800">Gespeicherter und geprüfter Empfängerstand ist vorhanden: Revision {recipientPresence.revision}.</p> : null}
            <ActionFeedback
              id={recipientFeedbackId}
              state={visibleRecipientState}
              issues={RECIPIENT_ISSUES}
              successFocusTargetId="release-step-render"
              resetNotice="Die Prüfbestätigung wurde nach dem Antwortlauf zurückgesetzt. Prüfe die Angaben und bestätige sie vor einem erneuten Speichern nochmals."
            />
          </section>
        </li>

        <li>
          <section aria-labelledby="release-step-render" className="rounded-lg border border-slate-200 bg-slate-50 p-4 sm:p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Schritt 2 von 3</p>
            <h3 id="release-step-render" tabIndex={-1} className="mt-1 text-lg font-semibold text-slate-950 outline-none"><span className="sr-only">Schritt 2 von 3: </span>Freigabekandidat rendern</h3>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-md bg-white p-3"><dt className="text-slate-600">Variante</dt><dd className="mt-1 font-semibold text-slate-950">Revision {variantRevision}</dd></div>
              <div className="rounded-md bg-white p-3"><dt className="text-slate-600">Aktives Profil</dt><dd className="mt-1 font-semibold text-slate-950">{profile ? `${profile.profileName} · Rev. ${profile.revision}` : "Fehlt"}</dd></div>
              <div className="rounded-md bg-white p-3"><dt className="text-slate-600">Empfängerstand</dt><dd className="mt-1 font-semibold text-slate-950">{recipientPresence ? `Revision ${recipientPresence.revision}` : "Fehlt"}</dd></div>
            </dl>
            {!profile ? <p className="mt-4 text-sm text-amber-900">Ein intern geprüftes aktives Angebotsprofil fehlt. <OfferDirtyNavigationLink href={settingsHref} label="Angebotsprofile" className="font-semibold underline decoration-2 underline-offset-4">Angebotsprofile öffnen</OfferDirtyNavigationLink>.</p> : null}
            {sourcePdfDraftId === null ? <p className="mt-3 text-sm text-amber-900">Erzeuge zuerst einen erfolgreichen <a href="#offer-pdf-draft" className="font-semibold underline decoration-2 underline-offset-4">internen PDF-Entwurf für diese Variantenrevision</a>.</p> : null}
            {recipientPresence === null ? <p className="mt-3 text-sm text-amber-900">Speichere zuerst Schritt 1; der Anlagenstandort wird nicht als Rechnungsadresse verwendet.</p> : null}
            {!canPrepare ? <p className="mt-3 rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700">Nur berechtigte interne Bearbeiter können einen neuen Freigabekandidaten anfordern.</p> : null}
            {canRequest && profile && recipient && sourcePdfDraftId ? (
              <form action={candidateAction} aria-describedby={candidateFeedbackId} className="mt-5">
                <input type="hidden" name="schemaVersion" value={OFFER_RELEASE_CANDIDATE_REQUEST_VERSION} />
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="offerId" value={offerId} />
                <input type="hidden" name="variantId" value={variantId} />
                <input type="hidden" name="expectedVariantRevision" value={String(variantRevision)} />
                <input type="hidden" name="sourcePdfDraftId" value={sourcePdfDraftId} />
                <input type="hidden" name="documentProfileId" value={profile.profileId} />
                <input type="hidden" name="documentProfileRevisionId" value={profile.profileRevisionId} />
                <input type="hidden" name="expectedDocumentProfileRevision" value={String(profile.revision)} />
                <input type="hidden" name="recipientRevisionId" value={recipient.recipientRevisionId} />
                <input type="hidden" name="expectedRecipientRevision" value={String(recipient.revision)} />
                <div className="max-w-sm">
                  <label htmlFor="release-valid-through" className="block text-sm font-semibold text-slate-800">Gültig bis <span aria-hidden="true">*</span></label>
                  <p id="release-valid-through-hint" className="mt-1 text-xs leading-5 text-slate-600">
                    Zulässig sind 1 bis 60 Kalendertage nach dem serverseitigen Dokumentdatum: {formatCalendarDate(validityWindow.min)} bis {formatCalendarDate(validityWindow.max)}.
                  </p>
                  <input
                    id="release-valid-through"
                    name="validThrough"
                    type="date"
                    value={validThrough}
                    onChange={(event) => {
                      setValidThrough(event.currentTarget.value);
                      if (validThroughInvalid) setValidThroughInvalidClearedFor(candidateState);
                    }}
                    min={validityWindow.min}
                    max={validityWindow.max}
                    required
                    aria-invalid={effectiveValidThroughInvalid || undefined}
                    aria-describedby={describedBy("release-valid-through-hint", effectiveValidThroughInvalid && candidateFeedbackId)}
                    className={`${fieldClass} ${effectiveValidThroughInvalid ? invalidFieldClass : ""}`}
                  />
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-700">Gerendert wird ein neuer, unveränderlicher Kandidat aus den gebundenen Revisionen. Ungespeicherte Editoränderungen gehören nicht dazu und müssen zuerst gespeichert werden. Der Kandidat wird dadurch weder ausgestellt noch versendet.</p>
                <div className="mt-4"><SubmitButton pendingLabel="Renderauftrag wird geprüft …">Freigabekandidat erzeugen</SubmitButton></div>
              </form>
            ) : null}
            <ActionFeedback id={candidateFeedbackId} state={candidateState} issues={CANDIDATE_ISSUES} successFocusTargetId="release-step-approval" />
          </section>
        </li>

        <li>
          <section aria-labelledby="release-step-approval" className="rounded-lg border border-slate-200 bg-slate-50 p-4 sm:p-5">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Schritt 3 von 3</p>
            <h3 id="release-step-approval" tabIndex={-1} className="mt-1 text-lg font-semibold text-slate-950 outline-none"><span className="sr-only">Schritt 3 von 3: </span>Finale Prüfung der erzeugten PDF-Bytes</h3>
            <p className="mt-2 text-sm leading-6 text-slate-700">Die Bestätigungen gelten nur für den jeweils angezeigten Kandidaten. Auch nach Freigabe bleibt er ausdrücklich nicht ausgestellt und nicht versendet.</p>
            {candidates.length === 0 ? (
              <p className="mt-4 text-sm text-slate-600">Noch kein Freigabekandidat vorhanden.</p>
            ) : (
              <ol role="list" className="mt-4 grid list-none gap-4 p-0">
                {candidates.map((candidate) => (
                  <CandidateApprovalItem
                    key={candidate.candidateId}
                    workspaceId={workspaceId}
                    offerId={offerId}
                    variantId={variantId}
                    variantRevision={variantRevision}
                    canApprove={canApprove}
                    candidate={candidate}
                  />
                ))}
              </ol>
            )}
          </section>
        </li>
      </ol>
    </section>
  );
}
