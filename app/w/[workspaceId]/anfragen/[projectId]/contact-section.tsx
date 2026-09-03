"use client";

import { useActionState, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import {
  CONTACT_UPDATE_COMMAND_VERSION,
  type ContactDatasetV1,
} from "@/lib/integrations/contacts/contract";
import { changeContact, type ContactActionState } from "./contact-actions";

const INITIAL_STATE: ContactActionState = { status: "idle" };

const SALUTATION_LABELS: Record<string, string> = {
  female: "Frau",
  male: "Herr",
  diverse: "Divers",
  family: "Familie",
  business: "Unternehmen",
};

const REACHABILITY_LABELS: Record<string, string> = {
  morning: "Vormittag",
  afternoon: "Nachmittag",
  evening: "Abend",
  fulltime: "Ganztags",
  weekend_only: "Nur am Wochenende",
  email_only: "Nur per E-Mail",
};

function display(value: string | null | boolean | undefined, booleanLabel?: string): string {
  if (value === null || value === undefined || value === "") return "Nicht hinterlegt";
  if (typeof value === "boolean") return value ? booleanLabel ?? "Ja" : "Nein";
  return value;
}

function actionMessage(state: ContactActionState): string {
  switch (state.status) {
    case "idle": return "";
    case "success": return "Die Kontaktdaten wurden gespeichert.";
    case "invalid": return "Die Eingabe ist unvollständig oder ungültig.";
    case "conflict": return "Die Kontaktdaten wurden zwischenzeitlich geändert. Die Ansicht wurde aktualisiert.";
    case "not_found": return "Der Kontakt ist nicht mehr verfügbar.";
    case "deleted_contact": return "Der Kontakt wurde gelöscht und kann nicht mehr bearbeitet werden.";
    case "denied": return "Für diese Änderung fehlt dir die Berechtigung.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu.";
  }
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending || undefined}
      className="min-h-11 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
    >
      {pending ? "Wird gespeichert …" : "Speichern"}
    </button>
  );
}

function Field({
  label,
  name,
  defaultValue,
  type = "text",
  autoComplete,
  hint,
}: {
  label: string;
  name: string;
  defaultValue: string | null;
  type?: string;
  autoComplete?: string;
  hint?: string;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={`contact-${name}`} className="block text-sm font-semibold text-slate-800">
        {label}
      </label>
      <input
        id={`contact-${name}`}
        name={name}
        type={type}
        defaultValue={defaultValue ?? ""}
        autoComplete={autoComplete}
        className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600 focus:ring-offset-1"
      />
      {hint ? <p className="mt-1 text-xs leading-5 text-slate-500">{hint}</p> : null}
    </div>
  );
}

function SelectField({
  label,
  name,
  defaultValue,
  options,
}: {
  label: string;
  name: string;
  defaultValue: string | null;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={`contact-${name}`} className="block text-sm font-semibold text-slate-800">
        {label}
      </label>
      <select
        id={`contact-${name}`}
        name={name}
        defaultValue={defaultValue ?? ""}
        className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600 focus:ring-offset-1"
      >
        <option value="">Nicht hinterlegt</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

function ContactEditForm({
  workspaceId,
  projectId,
  dataset,
  onClose,
}: {
  workspaceId: string;
  projectId: string;
  dataset: ContactDatasetV1;
  onClose: () => void;
}) {
  const boundAction = useMemo(
    () => changeContact.bind(null, workspaceId, projectId),
    [projectId, workspaceId],
  );
  const [state, action] = useActionState(boundAction, INITIAL_STATE);
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);

  const message = actionMessage(state);
  const isError = state.status !== "idle" && state.status !== "success";

  useEffect(() => {
    if (isError) feedbackRef.current?.focus();
  }, [isError, state]);

  useEffect(() => {
    // Nach einem erfolgreichen Speichern zurück in den Lesezustand. onClose
    // ist ein Prop, das setState kapselt der Eltern-Komponente.
    if (state.status === "success") onClose();
  }, [onClose, state]);

  return (
    <form action={action} className="min-w-0">
      <input type="hidden" name="schemaVersion" value={CONTACT_UPDATE_COMMAND_VERSION} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="expectedRevision" value={dataset.revision} />

      <fieldset className="grid gap-4">
        <legend className="text-sm font-semibold text-slate-950">Name und Anrede</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Vorname" name="firstName" defaultValue={dataset.name.firstName} autoComplete="given-name" />
          <Field label="Nachname" name="lastName" defaultValue={dataset.name.lastName} autoComplete="family-name" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField
            label="Anrede"
            name="salutation"
            defaultValue={dataset.name.salutation}
            options={Object.entries(SALUTATION_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <div className="min-w-0">
            <label htmlFor="contact-isBusiness" className="block text-sm font-semibold text-slate-800">
              Kundentyp
            </label>
            <select
              id="contact-isBusiness"
              name="isBusiness"
              defaultValue={dataset.name.isBusiness ? "true" : "false"}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600 focus:ring-offset-1"
            >
              <option value="false">Privatkunde (B2C)</option>
              <option value="true">Geschäftskunde (B2B)</option>
            </select>
          </div>
        </div>
      </fieldset>

      <fieldset className="mt-6 grid gap-4 border-t border-slate-200 pt-5">
        <legend className="text-sm font-semibold text-slate-950">Kontaktwege</legend>
        <p className="text-xs leading-5 text-slate-500">
          Primäre E-Mail und Festnetznummer werden aus der Anfrage übernommen und hier nur angezeigt.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sekundäre E-Mail" name="emailSecondary" defaultValue={dataset.contactWays.secondaryEmail} type="email" autoComplete="email" />
          <Field label="Mobil (E.164, z. B. +49170…)" name="phoneMobile" defaultValue={dataset.contactWays.phoneMobile} type="tel" autoComplete="tel" />
        </div>
        <SelectField
          label="Erreichbarkeit"
          name="phoneReachability"
          defaultValue={dataset.contactWays.phoneReachability}
          options={Object.entries(REACHABILITY_LABELS).map(([value, label]) => ({ value, label }))}
        />
      </fieldset>

      <fieldset className="mt-6 grid gap-4 border-t border-slate-200 pt-5">
        <legend className="text-sm font-semibold text-slate-950">Kontaktadresse</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Straße" name="addressStreet" defaultValue={dataset.address.street} autoComplete="street-address" />
          <Field label="Hausnummer" name="addressHouseNumber" defaultValue={dataset.address.houseNumber} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Postleitzahl" name="addressPostalCode" defaultValue={dataset.address.postalCode} autoComplete="postal-code" />
          <Field label="Ort" name="addressCity" defaultValue={dataset.address.city} autoComplete="address-level2" />
        </div>
        <Field label="Land" name="addressCountry" defaultValue={dataset.address.country} autoComplete="country-name" hint="Bei DE wird die PLZ als 5-stellige Zahl geprüft." />
      </fieldset>

      <fieldset className="mt-6 grid gap-4 border-t border-slate-200 pt-5">
        <legend className="text-sm font-semibold text-slate-950">Marketing-Consent</legend>
        <Field label="Policy-Version" name="marketingConsentPolicyVersion" defaultValue={dataset.marketingConsent.policyVersion} />
        <div>
          <label htmlFor="contact-marketingConsentText" className="block text-sm font-semibold text-slate-800">Text</label>
          <textarea
            id="contact-marketingConsentText"
            name="marketingConsentText"
            defaultValue={dataset.marketingConsent.text ?? ""}
            rows={3}
            className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600 focus:ring-offset-1"
          />
        </div>
        <Field label="Datenschutzlink" name="marketingConsentDataProtectionLink" defaultValue={dataset.marketingConsent.dataProtectionLink} type="url" hint="Muss mit https:// beginnen." />
      </fieldset>

      <fieldset className="mt-6 grid gap-4 border-t border-slate-200 pt-5">
        <legend className="text-sm font-semibold text-slate-950">Kampagne (UTM)</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Quelle" name="utmSource" defaultValue={dataset.utm.source} />
          <Field label="Medium" name="utmMedium" defaultValue={dataset.utm.medium} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Kampagne" name="utmCampaign" defaultValue={dataset.utm.campaign} />
          <Field label="Term" name="utmTerm" defaultValue={dataset.utm.term} />
        </div>
        <Field label="Inhalt" name="utmContent" defaultValue={dataset.utm.content} />
      </fieldset>

      <p
        ref={feedbackRef}
        tabIndex={-1}
        role={isError ? "alert" : "status"}
        aria-live={isError ? "assertive" : "polite"}
        aria-atomic="true"
        className={message
          ? `mt-4 rounded-md border px-3 py-2 text-sm outline-none ${isError
            ? "border-amber-200 bg-amber-50 text-amber-950"
            : "border-emerald-200 bg-emerald-50 text-emerald-950"}`
          : "sr-only"}
      >
        {message}
      </p>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SubmitButton />
        <button
          type="button"
          onClick={onClose}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
        >
          Abbrechen
        </button>
      </div>
    </form>
  );
}

export function ContactSection({
  workspaceId,
  projectId,
  dataset,
}: {
  workspaceId: string;
  projectId: string;
  dataset: ContactDatasetV1;
}) {
  const [editing, setEditing] = useState(false);
  const openedRevisionRef = useRef<number | null>(null);

  const openEditor = useCallback(() => {
    openedRevisionRef.current = dataset.revision;
    setEditing(true);
  }, [dataset.revision]);

  // Schließen über die SERVER-Wahrheit: Sobald die RSC-Auffrischung eine
  // höhere Revision liefert, war der Speichervorgang erfolgreich. Der
  // useActionState-Success-Effekt allein ist nicht zuverlässig, weil
  // `key={dataset.revision}` die Form beim Refresh remountet und den
  // State vor dem Effekt auf idle zurücksetzt (im echten Browser gefunden).
  useEffect(() => {
    if (
      editing
      && openedRevisionRef.current !== null
      && dataset.revision > openedRevisionRef.current
    ) {
      setEditing(false);
    }
  }, [dataset.revision, editing]);

  if (!editing) {
    const isDeleted = dataset.deletedAt !== null;
    return (
      <div className="min-w-0">
        {isDeleted ? (
          <p className="mb-5 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
            Dieser Kontakt ist gelöscht und kann nicht mehr bearbeitet werden.
          </p>
        ) : null}
        <dl className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Name</dt>
            <dd className="mt-1 break-words text-sm leading-6 text-slate-900">
              {dataset.name.displayName}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Vorname</dt>
            <dd className="mt-1 text-sm leading-6 text-slate-900">{dataset.name.firstName}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Nachname</dt>
            <dd className="mt-1 text-sm leading-6 text-slate-900">{dataset.name.lastName}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Anrede</dt>
            <dd className="mt-1 text-sm leading-6 text-slate-900">
              {dataset.name.salutation
                ? SALUTATION_LABELS[dataset.name.salutation] ?? dataset.name.salutation
                : "Nicht hinterlegt"}
            </dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Geschäftskunde</dt>
            <dd className="mt-1 text-sm leading-6 text-slate-900">
              {dataset.name.isBusiness ? "Ja" : "Nein"}
            </dd>
          </div>

          <div className="sm:col-span-2">
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Kontaktwege</dt>
            <dd className="mt-2 grid gap-1 text-sm leading-6 text-slate-900">
              <span>E-Mail: {display(dataset.contactWays.primaryEmail)}</span>
              <span>Sekundäre E-Mail: {display(dataset.contactWays.secondaryEmail)}</span>
              <span>Telefon: {display(dataset.contactWays.phone)}</span>
              <span>Mobil: {display(dataset.contactWays.phoneMobile)}</span>
              <span>
                Erreichbarkeit: {dataset.contactWays.phoneReachability
                  ? REACHABILITY_LABELS[dataset.contactWays.phoneReachability] ?? dataset.contactWays.phoneReachability
                  : "Nicht hinterlegt"}
              </span>
            </dd>
          </div>

          <div className="sm:col-span-2">
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Kontaktadresse</dt>
            <dd className="mt-1 text-sm leading-6 text-slate-900">
              {[
                dataset.address.street && dataset.address.houseNumber
                  ? `${dataset.address.street} ${dataset.address.houseNumber}`
                  : dataset.address.street,
                [dataset.address.postalCode, dataset.address.city].filter(Boolean).join(" "),
                dataset.address.country,
              ].filter(Boolean).join(", ") || "Nicht hinterlegt"}
            </dd>
          </div>

          <div className="sm:col-span-2">
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Marketing-Consent</dt>
            <dd className="mt-2 grid gap-1 text-sm leading-6 text-slate-900">
              <span>Einwilligung: {dataset.marketingConsent.granted ? "Erteilt" : "Nicht erteilt"}</span>
              <span>Policy-Version: {display(dataset.marketingConsent.policyVersion)}</span>
              <span>Text: {display(dataset.marketingConsent.text)}</span>
              <span>Datenschutzlink: {display(dataset.marketingConsent.dataProtectionLink)}</span>
            </dd>
          </div>

          <div className="sm:col-span-2">
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Kampagne (UTM)</dt>
            <dd className="mt-2 grid gap-1 text-sm leading-6 text-slate-900">
              <span>Quelle: {display(dataset.utm.source)}</span>
              <span>Medium: {display(dataset.utm.medium)}</span>
              <span>Kampagne: {display(dataset.utm.campaign)}</span>
              <span>Term: {display(dataset.utm.term)}</span>
              <span>Inhalt: {display(dataset.utm.content)}</span>
            </dd>
          </div>

          <div>
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Stand</dt>
            <dd className="mt-1 text-sm leading-6 text-slate-900">{dataset.revision}</dd>
          </div>
        </dl>

        {dataset.permissions.canWrite && !isDeleted ? (
          <div className="mt-5 border-t border-slate-200 pt-5">
            <button
              type="button"
              onClick={openEditor}
              className="min-h-11 rounded-md border border-blue-700 bg-white px-4 py-2 text-sm font-semibold text-blue-800 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Kontakt bearbeiten
            </button>
          </div>
        ) : (
          <p className="mt-5 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
            Du kannst die Kontaktdaten sehen, aber nicht verändern.
          </p>
        )}
      </div>
    );
  }

  return (
    <ContactEditForm
      key={dataset.revision}
      workspaceId={workspaceId}
      projectId={projectId}
      dataset={dataset}
      onClose={() => setEditing(false)}
    />
  );
}
