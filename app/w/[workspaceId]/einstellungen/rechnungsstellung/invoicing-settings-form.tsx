"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import {
  WORKSPACE_DOCUMENT_NUMBER_FORMAT_COMMAND_VERSION,
  WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION,
  companyCountries,
  accountingMethods,
  type DocumentNumberType,
  type InvoicingSettingsV1,
  type NumberFormatListV1,
} from "@/lib/integrations/invoicing/contract";
import {
  saveInvoicingSettings,
  saveNumberFormat,
  type InvoicingSettingsActionState,
  type NumberFormatActionState,
} from "./actions";

const SETTINGS_INITIAL: InvoicingSettingsActionState = { status: "idle" };
const FORMAT_INITIAL: NumberFormatActionState = { status: "idle" };

const COUNTRY_LABELS: Record<string, string> = {
  DE: "Deutschland",
  AT: "Österreich",
  CH: "Schweiz",
  FR: "Frankreich",
  UK: "Vereinigtes Königreich",
  JE: "Jersey",
};

const TYPE_LABELS: Record<DocumentNumberType, string> = {
  invoice: "Rechnung",
  credit_note: "Gutschrift",
  order_confirmation: "Auftragsbestätigung",
  purchase_order: "Bestellung",
  delivery_note: "Lieferschein",
  letter: "Brief",
};

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending || undefined}
      className="min-h-11 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
    >
      {pending ? "Wird gespeichert …" : label}
    </button>
  );
}

function Field({
  label,
  name,
  defaultValue,
  type = "text",
  hint,
  required,
}: {
  label: string;
  name: string;
  defaultValue: string | number | null;
  type?: string;
  hint?: string;
  required?: boolean;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={`invoicing-${name}`} className="block text-sm font-semibold text-slate-800">
        {label}{required ? <span aria-hidden="true" className="text-red-600"> *</span> : null}
      </label>
      <input
        id={`invoicing-${name}`}
        name={name}
        type={type}
        defaultValue={defaultValue ?? ""}
        required={required}
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
      <label htmlFor={`invoicing-${name}`} className="block text-sm font-semibold text-slate-800">{label}</label>
      <select
        id={`invoicing-${name}`}
        name={name}
        defaultValue={defaultValue ?? ""}
        className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600 focus:ring-offset-1"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
    </div>
  );
}

function settingsMessage(state: InvoicingSettingsActionState): string {
  switch (state.status) {
    case "idle": return "";
    case "success": return "Gespeichert.";
    case "invalid": return "Die Eingabe ist unvollständig oder ungültig.";
    case "conflict": return "Die Daten wurden zwischenzeitlich geändert. Die Ansicht wurde aktualisiert.";
    case "not_found": return "Die Stammdaten sind nicht mehr verfügbar.";
    case "denied": return "Für diese Änderung fehlt dir die Berechtigung.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu.";
  }
}

export function InvoicingSettingsForm({
  workspaceId,
  settings,
  formats,
}: {
  workspaceId: string;
  settings: InvoicingSettingsV1 | null;
  formats: NumberFormatListV1;
}) {
  const settingsAction = saveInvoicingSettings.bind(null, workspaceId);
  const [settingsState, settingsFormAction] = useActionState(settingsAction, SETTINGS_INITIAL);
  const settingsFeedbackRef = useRef<HTMLParagraphElement | null>(null);

  const settingsMessageText = settingsMessage(settingsState);
  const isSettingsError = settingsState.status !== "idle" && settingsState.status !== "success";

  useEffect(() => {
    if (isSettingsError) settingsFeedbackRef.current?.focus();
  }, [isSettingsError, settingsState]);

  // Schreibrecht kommt aus dem Formate-DTO, wenn noch keine Stammdaten
  // existieren (settings === null): ein Editor muss die ERSTE Anlage ohne
  // vorhandene Zeile duerfen, sonst ist die Seite auf frischen Workspaces
  // faktisch read-only.
  const canWrite = (settings === null ? null : settings.permissions.canWrite)
    ?? formats.permissions.canWrite;
  const baseRevision = settings?.revision ?? 0;

  return (
    <div className="grid gap-6">
      {settings === null ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
          Noch keine Stammdaten hinterlegt. Für die Rechnungsausstellung sind diese Angaben erforderlich.
        </p>
      ) : null}

      {!canWrite ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
          Du kannst die Rechnungsstellung sehen, aber nicht verändern.
        </p>
      ) : null}

      <form action={settingsFormAction} className="grid gap-6">
        <input type="hidden" name="schemaVersion" value={WORKSPACE_INVOICING_SETTINGS_COMMAND_VERSION} />
        <input type="hidden" name="baseRevision" value={baseRevision} />

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-950">Unternehmensinformationen</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <Field label="Name des Unternehmens" name="companyName" defaultValue={settings?.companyName ?? null} required />
            <Field label="E-Mail" name="companyEmail" type="email" defaultValue={settings?.companyEmail ?? null} required />
            <Field label="Behörde" name="companyAuthority" defaultValue={settings?.companyAuthority ?? null} />
            <Field label="Registernummer" name="companyRegisterNumber" defaultValue={settings?.companyRegisterNumber ?? null} />
            <Field label="USt-IdNr." name="companyTaxId" defaultValue={settings?.companyTaxId ?? null} />
            <Field label="Adresszeile 1" name="companyAddressLine1" defaultValue={settings?.companyAddressLine1 ?? null} required />
            <Field label="Adresszeile 2" name="companyAddressLine2" defaultValue={settings?.companyAddressLine2 ?? null} />
            <Field label="Postleitzahl" name="companyPostalCode" defaultValue={settings?.companyPostalCode ?? null} required />
            <Field label="Ort" name="companyCity" defaultValue={settings?.companyCity ?? null} required />
            <SelectField
              label="Land"
              name="companyCountry"
              defaultValue={settings?.companyCountry ?? "DE"}
              options={companyCountries.map((value) => ({ value, label: COUNTRY_LABELS[value] ?? value }))}
            />
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-950">Steuern &amp; Zahlungen</h2>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Buchhaltungsmethode"
              name="accountingMethod"
              defaultValue={settings?.accountingMethod ?? "accrual"}
              options={accountingMethods.map((value) => ({
                value,
                label: value === "accrual" ? "Periodengerecht" : "Zahlungsbasiert",
              }))}
            />
            <Field label="Aufbewahrungsfrist (Tage)" name="goebdRetentionDefaultDays" type="number" defaultValue={settings?.goebdRetentionDefaultDays ?? 3650} />
            <Field label="Kontoinhaber" name="paymentAccountHolder" defaultValue={settings?.paymentAccountHolder ?? null} />
            <Field label="IBAN" name="paymentIban" defaultValue={settings?.paymentIban ?? null} hint="MOD-97-Prüfung; 15–34 Zeichen." />
            <Field label="BIC / SWIFT" name="paymentBic" defaultValue={settings?.paymentBic ?? null} hint="8 oder 11 Zeichen." />
          </div>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm" aria-disabled="true">
          <h2 className="text-lg font-semibold text-slate-400">Textvorlagen</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Textvorlagen sind in dieser Version noch nicht verfügbar und folgen in einem späteren Schritt.
          </p>
        </section>

        {canWrite ? (
          <div className="flex items-center gap-3">
            <SubmitButton label="Speichern" />
            <p
              ref={settingsFeedbackRef}
              tabIndex={-1}
              role={isSettingsError ? "alert" : "status"}
              aria-live={isSettingsError ? "assertive" : "polite"}
              aria-atomic="true"
              className={settingsMessageText ? `text-sm ${isSettingsError ? "text-amber-700" : "text-emerald-700"}` : "sr-only"}
            >
              {settingsMessageText}
            </p>
          </div>
        ) : null}
      </form>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-950">Zahlenkreise-Formate</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Platzhalter: <code>{'{YEAR}'}</code>, <code>{'{MONTH}'}</code>, <code>{'{DAY}'}</code>, <code>{'{NUMBER}'}</code> ({'{NUMBER}'} ist Pflicht).
        </p>
        <div className="mt-4 grid gap-3">
          {formats.formats.map((format) => (
            <NumberFormatRow
              key={format.type}
              workspaceId={workspaceId}
              type={format.type as DocumentNumberType}
              formatTemplate={format.formatTemplate}
              counter={format.counter}
              canWrite={canWrite}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function NumberFormatRow({
  workspaceId,
  type,
  formatTemplate,
  counter,
  canWrite,
}: {
  workspaceId: string;
  type: DocumentNumberType;
  formatTemplate: string;
  counter: number;
  canWrite: boolean;
}) {
  const formatAction = saveNumberFormat.bind(null, workspaceId);
  const [state, formAction] = useActionState(formatAction, FORMAT_INITIAL);
  const message = state.status === "success"
    ? "Gespeichert."
    : state.status === "invalid"
      ? "Ungültiges Template."
      : state.status === "denied"
        ? "Keine Berechtigung."
        : "";

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
      <input type="hidden" name="schemaVersion" value={WORKSPACE_DOCUMENT_NUMBER_FORMAT_COMMAND_VERSION} />
      <input type="hidden" name="type" value={type} />
      <div className="min-w-0 flex-1">
        <label htmlFor={`invoicing-format-${type}`} className="block text-sm font-semibold text-slate-800">
          {TYPE_LABELS[type]}
        </label>
        <input
          id={`invoicing-format-${type}`}
          name="formatTemplate"
          defaultValue={formatTemplate}
          disabled={!canWrite}
          className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600 focus:ring-offset-1 disabled:bg-slate-100 disabled:text-slate-500"
        />
      </div>
      <span className="text-xs text-slate-500">Zähler: {counter}</span>
      {canWrite ? (
        <div className="flex items-center gap-2">
          <SubmitButton label="Speichern" />
          <span role="status" aria-live="polite" className={message ? "text-sm text-emerald-700" : "sr-only"}>{message}</span>
        </div>
      ) : null}
    </form>
  );
}
