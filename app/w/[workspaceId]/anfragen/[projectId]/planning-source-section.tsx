// F3-02 Dachquellen-Registry: Projekt-Sektion (Client). UI-Vertrag aus
// tests/e2e/f3-02-sources.spec.ts — Testids exakt einhalten. Viewer liest
// read-only (keine Submit-Buttons); nach erfolgreicher Anlage wird die
// neue Zeile lokal angehaengt, damit die Liste ohne Reload waechst.
"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  createSelfDrawnSourceAction,
  uploadPlanningSourceAction,
  type PlanningSourceActionState,
} from "./planning-source-actions";
import {
  PLANNING_SOURCE_KIND_LABEL,
  type PlanningSourceDto,
} from "./planning-source-model";

const initialAction: PlanningSourceActionState = { status: "idle" };

function Feedback({ state, testId }: { state: PlanningSourceActionState; testId: string }) {
  if (state.status === "idle") return null;
  if (state.status === "success" || state.status === "exists" || state.status === "invalid") {
    return (
      <p
        role={state.status === "invalid" ? "alert" : "status"}
        data-testid={testId}
        className={
          state.status === "invalid"
            ? "mt-3 text-sm font-semibold text-red-700"
            : "mt-3 text-sm font-semibold text-emerald-700"
        }
      >
        {state.message}
      </p>
    );
  }
  const message =
    state.status === "not_found"
      ? "Das Projekt wurde nicht gefunden."
      : state.status === "denied"
        ? "Dir fehlt die Berechtigung für diese Aktion."
        : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" data-testid={testId} className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

export function PlanningSourceSection({
  workspaceId,
  projectId,
  sources,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  sources: PlanningSourceDto[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [uploadState, uploadDispatch] = useActionState(uploadPlanningSourceAction, initialAction);
  const [drawnState, drawnDispatch] = useActionState(createSelfDrawnSourceAction, initialAction);

  // Server-Wahrheit nachziehen (revalidatePath allein aktualisiert die
  // Client-Props nicht); die frische Zeile wird unten beim Rendern
  // direkt aus dem Action-State gemischt — ohne Render-Kaskade.
  useEffect(() => {
    if (uploadState.status === "success" || uploadState.status === "exists") {
      router.refresh();
    }
  }, [uploadState, router]);

  useEffect(() => {
    if (drawnState.status === "success") {
      router.refresh();
    }
  }, [drawnState, router]);

  const appended: PlanningSourceDto[] = [];
  if (uploadState.status === "success" && uploadState.source !== null) {
    appended.push(uploadState.source);
  }
  if (drawnState.status === "success" && drawnState.source !== null) {
    appended.push(drawnState.source);
  }
  const visible = [
    ...sources,
    ...appended.filter((entry) => !sources.some((stored) => stored.id === entry.id)),
  ];

  return (
    <section
      data-testid="planning-sources-section"
      aria-label="Dachquellen"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-900">Dachquellen</h2>
      {visible.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">Noch keine Dachquelle für dieses Projekt.</p>
      ) : (
        <ul className="mt-2 space-y-2">
          {visible.map((source) => (
            <li
              key={source.id}
              data-testid="planning-source-item"
              className="rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-800"
            >
              <span data-testid="planning-source-kind" className="font-semibold">
                {PLANNING_SOURCE_KIND_LABEL[source.kind]}
              </span>
              {source.filename ? <span className="ml-2 text-slate-600">{source.filename}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form action={uploadDispatch} className="mt-3 space-y-2 border-t border-slate-100 pt-3">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <label className="block text-sm text-slate-600">
            Dachbild (JPEG/PNG, max. 10 MiB)
            <input
              type="file"
              name="file"
              accept="image/jpeg,image/png"
              data-testid="planning-source-upload-input"
              className="mt-1 block w-full text-sm text-slate-900"
            />
          </label>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-sm text-slate-600">
              Referenzstrecke (Meter)
              <input
                type="text"
                inputMode="decimal"
                name="scaleMeters"
                autoComplete="off"
                data-testid="planning-source-scale-meters"
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Referenzstrecke (Pixel)
              <input
                type="text"
                inputMode="decimal"
                name="scalePixels"
                autoComplete="off"
                data-testid="planning-source-scale-pixels"
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900"
              />
            </label>
          </div>
          <button
            type="submit"
            data-testid="planning-source-upload-submit"
            className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Dachquelle hochladen
          </button>
        </form>
      ) : null}
      <Feedback state={uploadState} testId="planning-source-upload-feedback" />
      {canWrite ? (
        <form action={drawnDispatch} className="mt-3">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <button
            type="submit"
            data-testid="planning-source-self-drawn-create"
            className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Selbstzeichnen-Anlage
          </button>
        </form>
      ) : null}
      <Feedback state={drawnState} testId="planning-source-self-drawn-feedback" />
    </section>
  );
}
