"use client";

import { useActionState, useEffect, useRef } from "react";
import { useFormStatus } from "react-dom";
import type { BillingRunBreakdownDto, BillingRunDto } from "@/lib/integrations/time-tracking/billing-contract";
import {
  closeBillingRunAction,
  createBillingRunAction,
  type TimeEntryActionState,
} from "./actions";

const initialState: TimeEntryActionState = { status: "idle" };

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} Std. ${m} Min.` : `${m} Min.`;
}

function formatDay(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeZone: "Europe/Berlin" }).format(date);
}

function toActionMessage(state: TimeEntryActionState): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success": return { text: state.message, isError: false };
    case "invalid": return { text: state.message ?? "Der Abrechnungslauf ist ungültig.", isError: true };
    case "not_found": return { text: "Der Abrechnungslauf wurde nicht gefunden.", isError: true };
    case "denied": return { text: "Dir fehlt die Berechtigung für diese Aktion.", isError: true };
    case "unauthenticated": return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    case "conflict": return { text: "Der Lauf ist bereits geschlossen.", isError: true };
    default: return null;
  }
}

function SubmitButton({ children, pendingLabel }: { children: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 disabled:cursor-wait disabled:bg-slate-400"
    >
      {pending ? pendingLabel : children}
    </button>
  );
}

export function BillingRunSection({
  workspaceId,
  projectId,
  runs,
  breakdowns,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  runs: BillingRunDto[];
  breakdowns: Record<string, BillingRunBreakdownDto>;
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createBillingRunAction, initialState);
  const [closeState, closeDispatch] = useActionState(closeBillingRunAction, initialState);
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const feedback = toActionMessage(closeState.status === "idle" ? createState : closeState);
  useEffect(() => {
    if (feedback?.isError) feedbackRef.current?.focus();
  }, [feedback?.isError, createState, closeState]);

  return (
    <section aria-labelledby="billing-runs-title" className="mt-8 rounded-xl border border-slate-200 bg-white p-5">
      <h2 id="billing-runs-title" className="text-lg font-semibold text-slate-950">Abrechnungsläufe</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        Freigegebene Einträge je Zeitraum übernehmen und den Lauf schließen.
        Geschlossene Läufe sperren ihre Einträge gegen Entsperren und Bearbeiten.
      </p>

      {canWrite ? (
        <form action={createDispatch} className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            Bezeichnung
            <input
              type="text"
              name="label"
              required
              maxLength={120}
              placeholder="z. B. September 2026"
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            Von
            <input
              type="date"
              name="periodStart"
              required
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            />
          </label>
          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            Bis
            <input
              type="date"
              name="periodEnd"
              required
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            />
          </label>
          <SubmitButton pendingLabel="Wird angelegt …">Lauf anlegen</SubmitButton>
        </form>
      ) : null}

      <p
        ref={feedbackRef}
        tabIndex={-1}
        role={feedback?.isError ? "alert" : "status"}
        aria-live="polite"
        aria-atomic="true"
        className={feedback === null
          ? "sr-only"
          : `mt-4 rounded-md border px-3 py-2 text-sm outline-none ${feedback.isError
            ? "border-amber-200 bg-amber-50 text-amber-950"
            : "border-emerald-200 bg-emerald-50 text-emerald-950"}`}
      >
        {feedback?.text}
      </p>

      {runs.length === 0 ? (
        <p className="mt-4 text-sm text-slate-600">Noch keine Abrechnungsläufe vorhanden.</p>
      ) : (
        <ul className="mt-4 grid gap-3">
          {runs.map((run) => (
            <li key={run.id} className="rounded-lg border border-slate-200 p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold text-slate-950">{run.label}</h3>
                <span className="text-xs text-slate-500">
                  {run.status === "closed" ? "geschlossen" : "offen"}
                </span>
              </div>
              <p className="mt-1 text-sm text-slate-700">
                {formatDay(run.periodStart)} – {formatDay(run.periodEnd)}
                {run.status === "closed" ? (
                  <> · {run.entryCount} {run.entryCount === 1 ? "Eintrag" : "Einträge"} · {formatMinutes(run.totalMinutes)}</>
                ) : null}
              </p>
              {run.status === "closed" && breakdowns[run.id] ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-sm font-semibold text-brand-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-600">
                    Aufschlüsselung je Person
                  </summary>
                  <ul className="mt-2 grid gap-1">
                    {breakdowns[run.id]!.rows.map((row) => (
                      <li key={row.userId} className="text-sm text-slate-700">
                        {row.label} — {row.entryCount} {row.entryCount === 1 ? "Eintrag" : "Einträge"} — {formatMinutes(row.totalWorkingMinutes)}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
              {canWrite && run.status === "open" ? (
                <form action={closeDispatch} className="mt-3">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="id" value={run.id} />
                  <SubmitButton pendingLabel="Wird geschlossen …">Lauf schließen</SubmitButton>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
