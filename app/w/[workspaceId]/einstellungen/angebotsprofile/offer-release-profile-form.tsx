"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import {
  OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION,
  OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION,
} from "@/lib/integrations/offers/release-contract";
import {
  activateOfferReleaseProfileAction,
  reviseOfferReleaseProfileAction,
} from "./actions";
import {
  OFFER_RELEASE_PROFILE_INITIAL_STATE,
  type OfferReleaseProfileActionState,
} from "./action-state";

export type OfferReleaseProfileSurface = {
  profileId: string;
  currentRevision: number;
  current: {
    profileRevisionId: string;
    profileName: string;
    sender: {
      legalName: string;
      tradingName: string | null;
      representedBy: string;
      address: {
        street: string;
        houseNumber: string;
        postalCode: string;
        city: string;
        country: "DE";
      };
      email: string;
      phoneE164: string | null;
      websiteHttpsUrl: string | null;
      registerCourt: string | null;
      registerNumber: string | null;
      vatId: string | null;
    };
    legalDocuments: {
      terms: { title: string; plainText: string };
      withdrawalInformation: { title: string; plainText: string };
      privacyNotice: { title: string; plainText: string };
    };
  };
  active: null | {
    profileRevisionId: string;
    profileRevision: number;
    reviewedAt: string;
  };
};

const fieldClass = "mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-950 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600/30";
const invalidFieldClass = "border-rose-600 ring-1 ring-rose-600/30";
const textareaClass = `${fieldClass} min-h-36 resize-y leading-6`;

type FormIssue = {
  id: string;
  label: string;
  paths: readonly string[];
};

const PROFILE_ISSUES: readonly FormIssue[] = [
  { id: "profile-name", label: "Profilname", paths: ["/profileName"] },
  { id: "legal-name", label: "Vollständige Firmierung", paths: ["/sender/legalName"] },
  { id: "trading-name", label: "Abweichender Geschäftsname", paths: ["/sender/tradingName"] },
  { id: "represented-by", label: "Vertreten durch", paths: ["/sender/representedBy"] },
  { id: "sender-street", label: "Straße", paths: ["/sender/address/street"] },
  { id: "sender-house-number", label: "Hausnummer", paths: ["/sender/address/houseNumber"] },
  { id: "sender-postal-code", label: "Postleitzahl", paths: ["/sender/address/postalCode"] },
  { id: "sender-city", label: "Ort", paths: ["/sender/address/city"] },
  { id: "sender-email", label: "E-Mail", paths: ["/sender/email"] },
  { id: "sender-phone", label: "Telefon", paths: ["/sender/phoneE164"] },
  { id: "sender-website", label: "Website", paths: ["/sender/websiteHttpsUrl"] },
  { id: "sender-vat-id", label: "Umsatzsteuer-ID", paths: ["/sender/vatId"] },
  { id: "sender-register-court", label: "Registergericht", paths: ["/sender/registerCourt"] },
  { id: "sender-register-number", label: "Registernummer", paths: ["/sender/registerNumber"] },
  { id: "terms-title", label: "Überschrift der Angebotsbedingungen", paths: ["/legalDocuments/terms/title"] },
  { id: "terms-text", label: "Text der Angebotsbedingungen", paths: ["/legalDocuments/terms/plainText"] },
  { id: "withdrawal-title", label: "Überschrift der Widerrufsinformation", paths: ["/legalDocuments/withdrawalInformation/title"] },
  { id: "withdrawal-text", label: "Text der Widerrufsinformation", paths: ["/legalDocuments/withdrawalInformation/plainText"] },
  { id: "privacy-title", label: "Überschrift des Datenschutzhinweises", paths: ["/legalDocuments/privacyNotice/title"] },
  { id: "privacy-text", label: "Text des Datenschutzhinweises", paths: ["/legalDocuments/privacyNotice/plainText"] },
];
const ACTIVATION_ISSUES: readonly FormIssue[] = [
  {
    id: "profile-operator-reviewed",
    label: "Bestätigung der internen Betreiberprüfung",
    paths: ["/operatorReviewed"],
  },
];

function pathMatchesIssue(path: string, issue: FormIssue): boolean {
  if (path === "/") return false;
  return issue.paths.some((candidate) => (
    path === candidate
    || path.startsWith(`${candidate}/`)
    || candidate.startsWith(`${path}/`)
  ));
}

function matchingIssues(
  state: OfferReleaseProfileActionState,
  issues: readonly FormIssue[],
): readonly FormIssue[] {
  if (state.status !== "invalid" || !state.paths) return [];
  return issues.filter((issue) => state.paths?.some((path) => pathMatchesIssue(path, issue)));
}

function isIssueInvalid(
  state: OfferReleaseProfileActionState,
  issues: readonly FormIssue[],
  id: string,
): boolean {
  return matchingIssues(state, issues).some((issue) => issue.id === id);
}

function describedBy(...ids: Array<string | false | null | undefined>): string | undefined {
  const value = ids.filter((id): id is string => typeof id === "string" && id.length > 0).join(" ");
  return value || undefined;
}

function feedback(state: OfferReleaseProfileActionState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "revised") {
    return `Profilrevision ${state.revision} wurde gespeichert. Prüfe den Inhalt und aktiviere ihn anschließend getrennt.`;
  }
  if (state.status === "activated") {
    return `Profilrevision ${state.revision} ist als intern geprüft aktiv.`;
  }
  if (state.status === "invalid") return "Die Eingabe wurde nicht akzeptiert. Prüfe die Pflichtangaben und versuche es erneut.";
  if (state.status === "unauthenticated") return "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  if (state.status === "denied") return "Nur Workspace-Administrationen dürfen Angebotsprofile ändern.";
  if (state.status === "not_found") return "Der Profilstand ist nicht mehr verfügbar. Lade die Seite neu.";
  if (state.status === "conflict") {
    return state.currentRevision === undefined
      ? "Das Profil wurde zwischenzeitlich geändert. Lade die Seite neu."
      : `Das Profil ist inzwischen Revision ${state.currentRevision}. Lade die Seite neu.`;
  }
  return "Das Angebotsprofil ist vorübergehend nicht verfügbar. Versuche es später erneut.";
}

function SubmitButton({ children }: { children: React.ReactNode }) {
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
      {pending ? "Wird geprüft …" : children}
    </button>
  );
}

function ActionFeedback({
  state,
  id,
  issues = [],
  successFocusTargetId,
  resetNotice,
}: {
  state: OfferReleaseProfileActionState;
  id: string;
  issues?: readonly FormIssue[];
  successFocusTargetId?: string;
  resetNotice?: string;
}) {
  const isError = !["idle", "revised", "activated"].includes(state.status);
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
      {feedback(state)}
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

function TextField({
  id,
  name,
  label,
  defaultValue,
  required = false,
  type = "text",
  autoComplete,
  hint,
  invalid = false,
  feedbackId,
  validationState,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string | null;
  required?: boolean;
  type?: "text" | "email" | "tel" | "url";
  autoComplete?: string;
  hint?: string;
  invalid?: boolean;
  feedbackId?: string;
  validationState: OfferReleaseProfileActionState;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const normalizedDefaultValue = defaultValue ?? "";
  const [value, setValue] = useState(normalizedDefaultValue);
  const [invalidClearedFor, setInvalidClearedFor] = useState<OfferReleaseProfileActionState | null>(null);
  const effectiveInvalid = invalid && invalidClearedFor !== validationState;

  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-semibold text-slate-800">
        {label}{required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {hint ? <p id={hintId} className="mt-1 text-xs leading-5 text-slate-600">{hint}</p> : null}
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
        aria-describedby={describedBy(hintId, effectiveInvalid && feedbackId)}
        className={`${fieldClass} ${effectiveInvalid ? invalidFieldClass : ""}`}
      />
    </div>
  );
}

function LegalTextField({
  id,
  titleName,
  textName,
  label,
  defaultTitle,
  defaultText,
  titleInvalid = false,
  textInvalid = false,
  feedbackId,
  validationState,
}: {
  id: string;
  titleName: string;
  textName: string;
  label: string;
  defaultTitle?: string;
  defaultText?: string;
  titleInvalid?: boolean;
  textInvalid?: boolean;
  feedbackId?: string;
  validationState: OfferReleaseProfileActionState;
}) {
  const normalizedDefaultText = defaultText ?? "";
  const [text, setText] = useState(normalizedDefaultText);
  const [textInvalidClearedFor, setTextInvalidClearedFor] = useState<OfferReleaseProfileActionState | null>(null);
  const effectiveTextInvalid = textInvalid && textInvalidClearedFor !== validationState;

  return (
    <fieldset className="min-w-0 rounded-md border border-slate-200 p-4">
      <legend className="px-1 text-sm font-semibold text-slate-950">{label}</legend>
      <TextField
        id={`${id}-title`}
        name={titleName}
        label="Überschrift"
        defaultValue={defaultTitle}
        required
        invalid={titleInvalid}
        feedbackId={feedbackId}
        validationState={validationState}
      />
      <div className="mt-4">
        <label htmlFor={`${id}-text`} className="block text-sm font-semibold text-slate-800">
          Vollständiger Text <span aria-hidden="true">*</span>
        </label>
        <textarea
          id={`${id}-text`}
          name={textName}
          value={text}
          onChange={(event) => {
            setText(event.currentTarget.value);
            if (textInvalid) setTextInvalidClearedFor(validationState);
          }}
          required
          aria-invalid={effectiveTextInvalid || undefined}
          aria-describedby={describedBy(effectiveTextInvalid && feedbackId)}
          className={`${textareaClass} ${effectiveTextInvalid ? invalidFieldClass : ""}`}
        />
      </div>
    </fieldset>
  );
}

export function OfferReleaseProfileForm({
  workspaceId,
  profile,
  canManage,
}: {
  workspaceId: string;
  profile: OfferReleaseProfileSurface | null;
  canManage: boolean;
}) {
  const [reviseState, reviseAction] = useActionState(
    reviseOfferReleaseProfileAction,
    OFFER_RELEASE_PROFILE_INITIAL_STATE,
  );
  const [activateState, activateAction] = useActionState(
    activateOfferReleaseProfileAction,
    OFFER_RELEASE_PROFILE_INITIAL_STATE,
  );
  const current = profile?.current;
  const isCurrentActive = profile?.active?.profileRevisionId === current?.profileRevisionId;
  const profileBaselineKey = current?.profileRevisionId ?? "profile-missing";
  const reviseInvalid = (id: string) => isIssueInvalid(reviseState, PROFILE_ISSUES, id);
  const activationInvalid = isIssueInvalid(
    activateState,
    ACTIVATION_ISSUES,
    "profile-operator-reviewed",
  );
  const [activationInvalidClearedFor, setActivationInvalidClearedFor] = useState<OfferReleaseProfileActionState | null>(null);
  const effectiveActivationInvalid = activationInvalid
    && activationInvalidClearedFor !== activateState;

  return (
    <div className="grid gap-6">
      {!canManage ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-950">Nur Lesezugriff</h2>
          <p className="mt-2 text-sm leading-6 text-slate-700">
            Nur Workspace-Administrationen dürfen einen neuen Profilstand speichern oder aktivieren.
          </p>
        </section>
      ) : (
        <form key={profileBaselineKey} action={reviseAction} aria-describedby="profile-form-safety profile-revise-feedback" className="rounded-lg border border-slate-300 bg-white p-5 shadow-sm sm:p-6">
          <input type="hidden" name="schemaVersion" value={OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION} />
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="expectedCurrentRevision" value={String(profile?.currentRevision ?? 0)} />
          <input type="hidden" name="country" value="DE" />

          <div className="border-b border-slate-200 pb-5">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Neuer append-only Stand</p>
            <h2 className="mt-1 text-xl font-semibold text-slate-950">Angebotsprofil erfassen</h2>
            <p id="profile-form-safety" className="mt-2 max-w-3xl text-sm leading-6 text-slate-700">
              Es gibt keine Standardtexte. Trage ausschließlich fachlich und rechtlich verantwortete Inhalte ein.
              Speichern aktiviert den Stand noch nicht.
            </p>
          </div>

          <fieldset className="mt-5 min-w-0 border-0 p-0">
            <legend className="text-base font-semibold text-slate-950">Profil und Aussteller</legend>
            <div className="mt-4 grid min-w-0 gap-4 md:grid-cols-2">
              <TextField id="profile-name" name="profileName" label="Profilname" defaultValue={current?.profileName} required invalid={reviseInvalid("profile-name")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="legal-name" name="legalName" label="Vollständige Firmierung" defaultValue={current?.sender.legalName} required autoComplete="organization" invalid={reviseInvalid("legal-name")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="trading-name" name="tradingName" label="Abweichender Geschäftsname" defaultValue={current?.sender.tradingName} invalid={reviseInvalid("trading-name")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="represented-by" name="representedBy" label="Vertreten durch" defaultValue={current?.sender.representedBy} required invalid={reviseInvalid("represented-by")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="sender-street" name="street" label="Straße" defaultValue={current?.sender.address.street} required autoComplete="address-line1" invalid={reviseInvalid("sender-street")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="sender-house-number" name="houseNumber" label="Hausnummer" defaultValue={current?.sender.address.houseNumber} required invalid={reviseInvalid("sender-house-number")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="sender-postal-code" name="postalCode" label="Postleitzahl" defaultValue={current?.sender.address.postalCode} required autoComplete="postal-code" invalid={reviseInvalid("sender-postal-code")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="sender-city" name="city" label="Ort" defaultValue={current?.sender.address.city} required autoComplete="address-level2" invalid={reviseInvalid("sender-city")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="sender-email" name="email" label="E-Mail" defaultValue={current?.sender.email} required type="email" autoComplete="email" invalid={reviseInvalid("sender-email")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="sender-phone" name="phoneE164" label="Telefon im internationalen Format" defaultValue={current?.sender.phoneE164} type="tel" autoComplete="tel" hint="Optional, zum Beispiel +491701234567." invalid={reviseInvalid("sender-phone")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="sender-website" name="websiteHttpsUrl" label="Website (HTTPS)" defaultValue={current?.sender.websiteHttpsUrl} type="url" autoComplete="url" invalid={reviseInvalid("sender-website")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="sender-vat-id" name="vatId" label="Umsatzsteuer-ID" defaultValue={current?.sender.vatId} invalid={reviseInvalid("sender-vat-id")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="sender-register-court" name="registerCourt" label="Registergericht" defaultValue={current?.sender.registerCourt} hint="Registergericht und Registernummer nur gemeinsam ausfüllen." invalid={reviseInvalid("sender-register-court")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <TextField id="sender-register-number" name="registerNumber" label="Registernummer" defaultValue={current?.sender.registerNumber} hint="Registergericht und Registernummer nur gemeinsam ausfüllen." invalid={reviseInvalid("sender-register-number")} feedbackId="profile-revise-feedback" validationState={reviseState} />
            </div>
          </fieldset>

          <fieldset className="mt-6 min-w-0 border-0 p-0">
            <legend className="text-base font-semibold text-slate-950">Verantwortete Rechtstexte</legend>
            <div className="mt-4 grid min-w-0 gap-4">
              <LegalTextField id="terms" titleName="termsTitle" textName="termsPlainText" label="Angebotsbedingungen" defaultTitle={current?.legalDocuments.terms.title} defaultText={current?.legalDocuments.terms.plainText} titleInvalid={reviseInvalid("terms-title")} textInvalid={reviseInvalid("terms-text")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <LegalTextField id="withdrawal" titleName="withdrawalInformationTitle" textName="withdrawalInformationPlainText" label="Widerrufsinformation" defaultTitle={current?.legalDocuments.withdrawalInformation.title} defaultText={current?.legalDocuments.withdrawalInformation.plainText} titleInvalid={reviseInvalid("withdrawal-title")} textInvalid={reviseInvalid("withdrawal-text")} feedbackId="profile-revise-feedback" validationState={reviseState} />
              <LegalTextField id="privacy" titleName="privacyNoticeTitle" textName="privacyNoticePlainText" label="Datenschutzhinweis" defaultTitle={current?.legalDocuments.privacyNotice.title} defaultText={current?.legalDocuments.privacyNotice.plainText} titleInvalid={reviseInvalid("privacy-title")} textInvalid={reviseInvalid("privacy-text")} feedbackId="profile-revise-feedback" validationState={reviseState} />
            </div>
          </fieldset>

          <div className="mt-6 flex flex-col items-start gap-2 border-t border-slate-200 pt-5">
            <SubmitButton>Neue Profilrevision speichern</SubmitButton>
            <ActionFeedback state={reviseState} id="profile-revise-feedback" issues={PROFILE_ISSUES} successFocusTargetId="profile-activation-title" />
          </div>
        </form>
      )}

      {profile ? (
        <section aria-labelledby="profile-activation-title" className="rounded-lg border border-slate-300 bg-white p-5 shadow-sm sm:p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Getrennte Betreiberprüfung</p>
          <h2 id="profile-activation-title" tabIndex={-1} className="mt-1 text-xl font-semibold text-slate-950 outline-none">Aktuellen Profilstand aktivieren</h2>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div className="rounded-md bg-slate-50 p-3"><dt className="text-slate-600">Aktuelle Revision</dt><dd className="mt-1 font-semibold tabular-nums text-slate-950">{profile.currentRevision}</dd></div>
            <div className="rounded-md bg-slate-50 p-3"><dt className="text-slate-600">Status</dt><dd className="mt-1 font-semibold text-slate-950">{isCurrentActive ? "Intern geprüft und aktiv" : "Noch nicht aktiv"}</dd></div>
          </dl>
          <p className="mt-4 max-w-3xl text-sm leading-6 text-slate-700">
            Die Aktivierung bestätigt eine interne Betreiberprüfung des exakten Profilstands. Sie ist keine anwaltliche Beratung und keine Wirksamkeitsgarantie.
          </p>
          {canManage && !isCurrentActive ? (
            <form key={profileBaselineKey} action={activateAction} aria-describedby="profile-activation-feedback" className="mt-5">
              <input type="hidden" name="schemaVersion" value={OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION} />
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="profileId" value={profile.profileId} />
              <input type="hidden" name="profileRevisionId" value={profile.current.profileRevisionId} />
              <input type="hidden" name="expectedProfileRevision" value={String(profile.currentRevision)} />
              <label htmlFor="profile-operator-reviewed" className={`mb-4 flex min-h-11 cursor-pointer items-start gap-3 rounded-md border bg-slate-50 px-3 py-3 text-sm leading-6 text-slate-800 focus-within:ring-2 focus-within:ring-blue-600 focus-within:ring-offset-2 ${effectiveActivationInvalid ? "border-rose-600" : "border-slate-200"}`}>
                <input
                  id="profile-operator-reviewed"
                  name="operatorReviewed"
                  value="true"
                  type="checkbox"
                  required
                  onChange={() => {
                    if (activationInvalid) setActivationInvalidClearedFor(activateState);
                  }}
                  aria-invalid={effectiveActivationInvalid || undefined}
                  aria-describedby={describedBy(effectiveActivationInvalid && "profile-activation-feedback")}
                  className="mt-1 size-5 shrink-0 accent-slate-950"
                />
                <span>Ich habe Ausstellerangaben und Rechtstexte dieser exakten Profilrevision intern geprüft und übernehme die Betreiberverantwortung für ihre Aktivierung.</span>
              </label>
              <SubmitButton>Revision {profile.currentRevision} als geprüft aktivieren</SubmitButton>
            </form>
          ) : null}
          <ActionFeedback
            state={activateState}
            id="profile-activation-feedback"
            issues={ACTIVATION_ISSUES}
            successFocusTargetId="profile-activation-title"
            resetNotice="Die Betreiberbestätigung wurde nach dem Antwortlauf zurückgesetzt. Prüfe den Profilstand und bestätige ihn vor einem erneuten Versuch nochmals."
          />
        </section>
      ) : null}
    </div>
  );
}
