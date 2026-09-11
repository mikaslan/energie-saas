"use client";

import { useActionState, useState } from "react";
import type { FileRequestTemplateDto } from "@/lib/file-request-template";
import {
  archiveFileRequestTemplateAction,
  createFileRequestTemplateAction,
  type FileRequestTemplateActionState,
  restoreFileRequestTemplateAction,
  updateFileRequestTemplateAction,
} from "./actions";

const initialState: FileRequestTemplateActionState = { status: "idle" };

function Feedback({ state }: { state: FileRequestTemplateActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return <p role="status" className="mt-2 text-sm font-medium text-green-700">{state.message}</p>;
  }
  const message =
    state.status === "conflict"
      ? "Eine aktive Vorlage mit diesem Namen existiert bereits."
      : state.status === "denied"
        ? "Dafür fehlt dir die Projekt-Freigabe."
        : state.status === "not_found"
          ? "Vorlage nicht gefunden."
          : state.status === "unauthenticated"
            ? "Bitte erneut anmelden."
            : "Eingaben prüfen (Name, Anfrage-Titel 1–160 Zeichen).";
  return <p role="alert" className="mt-2 text-sm font-medium text-red-700">{message}</p>;
}

// F16-07: Create-/Edit-Formular (Name, Anfrage-Titel, Beschreibung; Pflicht
// außer Beschreibung). Remount bei Erfolg/Datensatzwechsel (stale-DOM,
// Muster Aufgaben-/Termin-Vorlagen).
function TemplateForm({
  workspaceId,
  template,
  action,
  submitLabel,
}: {
  workspaceId: string;
  template?: FileRequestTemplateDto;
  action: (
    previous: FileRequestTemplateActionState,
    formData: FormData,
  ) => Promise<FileRequestTemplateActionState>;
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
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
        />
      </label>
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Anfrage-Titel
        <input
          type="text"
          name="title"
          defaultValue={template?.title ?? ""}
          required
          maxLength={160}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
        />
      </label>
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Beschreibung (optional)
        <input
          type="text"
          name="description"
          defaultValue={template?.description ?? ""}
          maxLength={2000}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
        />
      </label>
      <label className="flex items-center gap-2 text-sm font-semibold text-slate-800">
        <input
          type="checkbox"
          name="allowMany"
          defaultChecked={template?.allowMany ?? false}
          className="min-h-6 min-w-6 accent-slate-900"
        />
        Mehrere Dateien erlauben
      </label>
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Reihenfolge
        <input
          type="text"
          name="position"
          inputMode="numeric"
          defaultValue={template ? String(template.position) : "0"}
          required
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
        />
      </label>
      <div>
        <button
          type="submit"
          className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          {submitLabel}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function FileRequestTemplateManager({
  workspaceId,
  templates,
  canWrite,
}: {
  workspaceId: string;
  templates: FileRequestTemplateDto[];
  canWrite: boolean;
}) {
  const [archiveState, archiveDispatch] = useActionState(archiveFileRequestTemplateAction, initialState);
  const [restoreState, restoreDispatch] = useActionState(restoreFileRequestTemplateAction, initialState);
  return (
    <div className="grid gap-8">
      {canWrite ? (
        <section aria-label="Neue Vorlage" className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-950">Neue Vorlage</h2>
          <div className="mt-3">
            <TemplateForm
              workspaceId={workspaceId}
              action={createFileRequestTemplateAction}
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
            <p className="mt-1 text-sm text-slate-700">{template.title}</p>
            {template.allowMany ? (
              <p className="mt-1 text-xs font-semibold text-slate-600">Mehrere Dateien</p>
            ) : null}
            {template.description ? (
              <p className="mt-1 text-sm text-slate-500">{template.description}</p>
            ) : null}
            {canWrite ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-semibold text-blue-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-blue-600">
                  Bearbeiten
                </summary>
                <div className="mt-3">
                  <TemplateForm
                    workspaceId={workspaceId}
                    template={template}
                    action={updateFileRequestTemplateAction}
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
                    className="min-h-11 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
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
                    className="min-h-11 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
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
