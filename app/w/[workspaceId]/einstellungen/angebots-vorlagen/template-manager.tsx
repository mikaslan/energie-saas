"use client";

import { useActionState, useState } from "react";
import type { OfferTemplateDto } from "@/lib/integrations/offers/template-contract";
import {
  archiveOfferTemplateAction,
  createOfferTemplateAction,
  type OfferTemplateActionState,
  restoreOfferTemplateAction,
  updateOfferTemplateAction,
} from "./actions";

const initialState: OfferTemplateActionState = { status: "idle" };

export type OfferTemplatePresetOption = {
  id: string;
  label: string;
  detail: string;
  usable: boolean;
};

function Feedback({ state }: { state: OfferTemplateActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return <p role="status" className="mt-2 text-sm font-medium text-green-700">{state.message}</p>;
  }
  const message =
    state.status === "conflict"
      ? "Eine aktive Vorlage mit diesem Namen existiert bereits."
      : state.status === "denied"
        ? "Dafür fehlt dir die Rabatt-Freigabe."
        : state.status === "not_found"
          ? "Vorlage nicht gefunden."
          : state.status === "unauthenticated"
            ? "Bitte erneut anmelden."
            : "Eingaben prüfen (Name plus mindestens ein Preset: Zahlart oder Rabatt).";
  return <p role="alert" className="mt-2 text-sm font-medium text-red-700">{message}</p>;
}

function formatPresets(
  template: OfferTemplateDto,
  paymentOptions: OfferTemplatePresetOption[],
  discountTemplates: OfferTemplatePresetOption[],
): string {
  const parts: string[] = [];
  const payment = paymentOptions.find((option) => option.id === template.paymentOptionId);
  const discount = discountTemplates.find((entry) => entry.id === template.discountTemplateId);
  parts.push(payment ? `Zahlart: ${payment.label}` : "Zahlart: –");
  parts.push(discount ? `Rabatt: ${discount.label}` : "Rabatt: –");
  return parts.join(" · ");
}

// F16-06: Create-/Edit-Formular (Name, Zahlart-Preset, Rabatt-Preset;
// mindestens eines belegt). Remount bei Erfolg/Datensatzwechsel (stale-DOM,
// Muster Termin-Vorlagen).
function TemplateForm({
  workspaceId,
  template,
  paymentOptions,
  discountTemplates,
  action,
  submitLabel,
}: {
  workspaceId: string;
  template?: OfferTemplateDto;
  paymentOptions: OfferTemplatePresetOption[];
  discountTemplates: OfferTemplatePresetOption[];
  action: (
    previous: OfferTemplateActionState,
    formData: FormData,
  ) => Promise<OfferTemplateActionState>;
  submitLabel: string;
}) {
  const [state, dispatch] = useActionState(action, initialState);
  const [successCount, setSuccessCount] = useState(0);
  const [prevStatus, setPrevStatus] = useState(state.status);
  if (prevStatus !== state.status) {
    setPrevStatus(state.status);
    if (state.status === "success") setSuccessCount((count) => count + 1);
  }
  const formKey = template
    ? `${template.id}:${template.updatedAt}:${successCount}`
    : `new:${successCount}`;
  const selectClass = "min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30";
  return (
    <form action={dispatch} key={formKey} className="grid gap-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      {template ? <input type="hidden" name="id" value={template.id} /> : null}
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Name
        <input
          type="text"
          name="name"
          defaultValue={template?.name ?? ""}
          required
          maxLength={200}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-semibold text-slate-800">
          Zahlart-Preset
          <select
            name="paymentOptionId"
            defaultValue={template?.paymentOptionId ?? ""}
            className={selectClass}
          >
            <option value="">Keine Zahlart</option>
            {paymentOptions.map((option) => (
              <option key={option.id} value={option.id} disabled={!option.usable}>
                {option.label}{option.usable ? "" : " (archiviert)"}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm font-semibold text-slate-800">
          Rabatt-Preset
          <select
            name="discountTemplateId"
            defaultValue={template?.discountTemplateId ?? ""}
            className={selectClass}
          >
            <option value="">Kein Rabatt</option>
            {discountTemplates.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={!entry.usable}>
                {entry.label}{entry.usable ? "" : " (archiviert)"}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Reihenfolge
        <input
          type="text"
          name="position"
          inputMode="numeric"
          defaultValue={template ? String(template.position) : "0"}
          required
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
        />
      </label>
      <div>
        <button
          type="submit"
          className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          {submitLabel}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function OfferTemplateManager({
  workspaceId,
  templates,
  paymentOptions,
  discountTemplates,
  canWrite,
}: {
  workspaceId: string;
  templates: OfferTemplateDto[];
  paymentOptions: OfferTemplatePresetOption[];
  discountTemplates: OfferTemplatePresetOption[];
  canWrite: boolean;
}) {
  const [archiveState, archiveDispatch] = useActionState(archiveOfferTemplateAction, initialState);
  const [restoreState, restoreDispatch] = useActionState(restoreOfferTemplateAction, initialState);
  return (
    <div className="grid gap-8">
      {canWrite ? (
        <section aria-label="Neue Vorlage" className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-950">Neue Vorlage</h2>
          <div className="mt-3">
            <TemplateForm
              workspaceId={workspaceId}
              paymentOptions={paymentOptions}
              discountTemplates={discountTemplates}
              action={createOfferTemplateAction}
              submitLabel="Anlegen"
            />
          </div>
        </section>
      ) : null}
      <section aria-label="Vorlagen" className="grid gap-4">
        {templates.length === 0 ? (
          <p className="text-sm text-slate-600">Noch keine Vorlagen vorhanden.</p>
        ) : null}
        {templates.map((template) => (
          <article key={template.id} className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-semibold text-slate-950">{template.name}</h3>
              <span className="text-xs text-slate-500">
                {template.active ? "aktiv" : "archiviert"}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-700">
              {formatPresets(template, paymentOptions, discountTemplates)}
            </p>
            {canWrite ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-semibold text-brand-800 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-600">
                  Bearbeiten
                </summary>
                <div className="mt-3">
                  <TemplateForm
                    workspaceId={workspaceId}
                    template={template}
                    paymentOptions={paymentOptions}
                    discountTemplates={discountTemplates}
                    action={updateOfferTemplateAction}
                    submitLabel="Speichern"
                  />
                </div>
              </details>
            ) : null}
            {canWrite ? (
              template.active ? (
                <form action={archiveDispatch} className="mt-3">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="id" value={template.id} />
                  <button
                    type="submit"
                    aria-label={`${template.name} archivieren`}
                    className="min-h-11 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Archivieren
                  </button>
                </form>
              ) : (
                <form action={restoreDispatch} className="mt-3">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="id" value={template.id} />
                  <button
                    type="submit"
                    aria-label={`${template.name} reaktivieren`}
                    className="min-h-11 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Reaktivieren
                  </button>
                </form>
              )
            ) : null}
          </article>
        ))}
      </section>
      {archiveState.status !== "idle" ? <Feedback state={archiveState} /> : null}
      {restoreState.status !== "idle" ? <Feedback state={restoreState} /> : null}
    </div>
  );
}
