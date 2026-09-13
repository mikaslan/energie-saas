"use client";

import { useActionState, useState } from "react";
import {
  EMAIL_TEMPLATE_PREVIEW_SAMPLE,
  renderEmailTemplate,
  type EmailTemplateDto,
} from "@/lib/email-template";
import {
  archiveEmailTemplateAction,
  restoreEmailTemplateAction,
  updateEmailTemplateAction,
  type EmailTemplateActionState,
} from "./actions";

const initialState: EmailTemplateActionState = { status: "idle" };

function Feedback({ state }: { state: EmailTemplateActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return <p role="status" className="mt-2 text-sm font-medium text-green-700">{state.message}</p>;
  }
  const message =
    state.status === "denied"
      ? "Dafür fehlt dir die Projekt-Freigabe."
      : state.status === "not_found"
        ? "Vorlage nicht gefunden."
        : state.status === "unauthenticated"
          ? "Bitte erneut anmelden."
          : "Eingaben prüfen (Betreff 1–200, Text 1–10000 Zeichen).";
  return <p role="alert" className="mt-2 text-sm font-medium text-red-700">{message}</p>;
}

// F16-10: Edit-Formular je fixem Schlüssel (Betreff, Text; Pflicht).
// Remount bei Erfolg/Datensatzwechsel (stale-DOM, Muster
// Aufgaben-/Termin-/Datei-Vorlagen).
function TemplateForm({
  workspaceId,
  template,
}: {
  workspaceId: string;
  template: EmailTemplateDto;
}) {
  const [state, dispatch] = useActionState(updateEmailTemplateAction, initialState);
  const [successCount, setSuccessCount] = useState(0);
  const [prevStatus, setPrevStatus] = useState(state.status);
  if (prevStatus !== state.status) {
    setPrevStatus(state.status);
    if (state.status === "success") setSuccessCount((count) => count + 1);
  }
  const formKey = `${template.key}:${template.updatedAt}:${successCount}`;
  const previewSubject = renderEmailTemplate(template.subject, EMAIL_TEMPLATE_PREVIEW_SAMPLE);
  const previewBody = renderEmailTemplate(template.body, EMAIL_TEMPLATE_PREVIEW_SAMPLE);
  return (
    <form action={dispatch} key={formKey} className="grid gap-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="key" value={template.key} />
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Betreff
        <input
          type="text"
          name="subject"
          defaultValue={template.subject}
          required
          maxLength={200}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
        />
      </label>
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Text
        <textarea
          name="body"
          defaultValue={template.body}
          required
          maxLength={10000}
          rows={6}
          className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
        />
      </label>
      <div>
        <button
          type="submit"
          className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          Speichern
        </button>
        <Feedback state={state} />
      </div>
      <div aria-label={`Vorschau ${template.label}`} className="rounded-md border border-slate-200 bg-slate-50 p-3">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
          Vorschau (Beispielwerte)
        </p>
        <p className="mt-2 text-sm font-semibold text-slate-900">{previewSubject}</p>
        <p className="mt-1 whitespace-pre-line text-sm text-slate-700">{previewBody}</p>
      </div>
    </form>
  );
}

export function EmailTemplateManager({
  workspaceId,
  templates,
  canWrite,
}: {
  workspaceId: string;
  templates: EmailTemplateDto[];
  canWrite: boolean;
}) {
  const [archiveState, archiveDispatch] = useActionState(archiveEmailTemplateAction, initialState);
  const [restoreState, restoreDispatch] = useActionState(restoreEmailTemplateAction, initialState);
  return (
    <div className="grid gap-8">
      <section aria-label="Vorlagen" className="grid gap-4">
        {templates.length === 0 ? (
          <p className="text-sm text-slate-600">Noch keine Vorlagen vorhanden.</p>
        ) : null}
        {templates.map((template) => (
          <article key={template.key} className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-semibold text-slate-950">{template.label}</h3>
              <span className="text-xs text-slate-500">
                {template.active ? "aktiv" : "archiviert"}
              </span>
            </div>
            {canWrite ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-semibold text-brand-800 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-600">
                  Bearbeiten
                </summary>
                <div className="mt-3">
                  <TemplateForm workspaceId={workspaceId} template={template} />
                </div>
              </details>
            ) : (
              <div aria-label={`Vorschau ${template.label}`} className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
                <p className="text-sm font-semibold text-slate-900">
                  {renderEmailTemplate(template.subject, EMAIL_TEMPLATE_PREVIEW_SAMPLE)}
                </p>
                <p className="mt-1 whitespace-pre-line text-sm text-slate-700">
                  {renderEmailTemplate(template.body, EMAIL_TEMPLATE_PREVIEW_SAMPLE)}
                </p>
              </div>
            )}
            {canWrite ? (
              template.active ? (
                <form action={archiveDispatch} className="mt-3">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="key" value={template.key} />
                  <button
                    type="submit"
                    aria-label={`${template.label} archivieren`}
                    className="min-h-11 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Archivieren
                  </button>
                </form>
              ) : (
                <form action={restoreDispatch} className="mt-3">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="key" value={template.key} />
                  <button
                    type="submit"
                    aria-label={`${template.label} reaktivieren`}
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
