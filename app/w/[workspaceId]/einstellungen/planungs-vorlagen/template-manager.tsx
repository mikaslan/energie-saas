"use client";

import { useActionState, useState } from "react";
import type { PlanningTemplateDto } from "@/lib/integrations/planning/template-contract";
import {
  archivePlanningTemplateAction,
  createPlanningTemplateAction,
  type PlanningTemplateActionState,
  restorePlanningTemplateAction,
  updatePlanningTemplateAction,
} from "./actions";

const initialState: PlanningTemplateActionState = { status: "idle" };

const MODE_LABELS: Record<PlanningTemplateDto["mode"], string> = {
  quick: "Quick-Planung",
  "2d": "2D-Planung",
  "3d": "3D-Planung",
};

function Feedback({ state }: { state: PlanningTemplateActionState }) {
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
            : "Eingaben prüfen (Name 1–200 Zeichen, Modus wählen).";
  return <p role="alert" className="mt-2 text-sm font-medium text-red-700">{message}</p>;
}

// F16-08: Create-/Edit-Formular (Name, Planungsmodus; Pflicht).
// Remount bei Erfolg/Datensatzwechsel (stale-DOM, Muster
// Aufgaben-/Termin-/Datei-Anfragen-Vorlagen).
function TemplateForm({
  workspaceId,
  template,
  action,
  submitLabel,
}: {
  workspaceId: string;
  template?: PlanningTemplateDto;
  action: (
    previous: PlanningTemplateActionState,
    formData: FormData,
  ) => Promise<PlanningTemplateActionState>;
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
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
        />
      </label>
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Planungsmodus
        <select
          name="mode"
          defaultValue={template?.mode ?? "quick"}
          required
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
        >
          <option value="quick">Quick-Planung</option>
          <option value="2d">2D-Planung</option>
          <option value="3d">3D-Planung</option>
        </select>
      </label>
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

export function PlanningTemplateManager({
  workspaceId,
  templates,
  canWrite,
}: {
  workspaceId: string;
  templates: PlanningTemplateDto[];
  canWrite: boolean;
}) {
  const [archiveState, archiveDispatch] = useActionState(archivePlanningTemplateAction, initialState);
  const [restoreState, restoreDispatch] = useActionState(restorePlanningTemplateAction, initialState);
  return (
    <div className="grid gap-8">
      {canWrite ? (
        <section aria-label="Neue Vorlage" className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-950">Neue Vorlage</h2>
          <div className="mt-3">
            <TemplateForm
              workspaceId={workspaceId}
              action={createPlanningTemplateAction}
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
            <p className="mt-1 text-sm text-slate-700">{MODE_LABELS[template.mode]}</p>
            {canWrite ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-semibold text-brand-800 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-600">
                  Bearbeiten
                </summary>
                <div className="mt-3">
                  <TemplateForm
                    workspaceId={workspaceId}
                    template={template}
                    action={updatePlanningTemplateAction}
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
