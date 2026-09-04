"use client";

import { useActionState, useEffect, useRef } from "react";
import type { CalendarItemV1 } from "@/lib/integrations/calendar/contract";
import {
  archiveCalendarAction,
  createCalendarAction,
  type CalendarActionState,
} from "./actions";

const initialState: CalendarActionState = { status: "idle" };

function message(state: CalendarActionState): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success": return { text: state.message, isError: false };
    case "invalid": return { text: "Die Eingabe ist ungültig.", isError: true };
    case "not_found": return { text: "Der Kalender wurde nicht gefunden.", isError: true };
    case "denied": return { text: "Nur Administratoren verwalten Kalender.", isError: true };
    case "unauthenticated": return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    default: return null;
  }
}

function Feedback({ state }: { state: CalendarActionState }) {
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const feedback = message(state);
  useEffect(() => {
    if (feedback?.isError) feedbackRef.current?.focus();
  }, [feedback?.isError, state]);
  return (
    <p
      ref={feedbackRef}
      tabIndex={-1}
      role={feedback?.isError ? "alert" : "status"}
      aria-live="polite"
      className={`mt-3 text-sm font-semibold ${
        feedback === null ? "hidden" : feedback.isError ? "text-red-700" : "text-green-700"
      }`}
    >
      {feedback?.text}
    </p>
  );
}

const scopeLabel: Record<CalendarItemV1["type"], string> = {
  tenancy: "Unternehmen",
  user: "Persönlich",
  team: "Team",
  client: "Kundenportal",
};

export function CalendarManager({
  workspaceId,
  calendars,
  canWrite,
}: {
  workspaceId: string;
  calendars: CalendarItemV1[];
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createCalendarAction, initialState);
  const [archiveState, archiveDispatch] = useActionState(archiveCalendarAction, initialState);

  return (
    <div className="space-y-6">
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Kalender</h2>
        {calendars.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-500">Noch keine sichtbaren Kalender.</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {calendars.map((calendar) => (
              <li key={calendar.id} className="flex flex-wrap items-center gap-3 py-3">
                <span
                  aria-hidden
                  className="inline-block h-3 w-3 rounded-full ring-1 ring-black/10"
                  style={{ backgroundColor: calendar.color ?? "#94A3B8" }}
                />
                <span className="min-w-0 flex-1 text-sm font-semibold text-slate-900">
                  {calendar.name}
                </span>
                <span className="text-xs text-slate-500">{scopeLabel[calendar.type]}</span>
                {canWrite && calendar.type !== "user" ? (
                  <form action={archiveDispatch}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="id" value={calendar.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
                    >
                      Archivieren
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Feedback state={archiveState} />
      </section>

      {canWrite ? (
        <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-950">Unternehmenskalender anlegen</h2>
          <form action={createDispatch} className="mt-3">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Name</span>
                <input
                  type="text"
                  name="name"
                  required
                  maxLength={200}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
                />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Farbe</span>
                <input
                  type="text"
                  name="color"
                  placeholder="#3B82F6"
                  maxLength={7}
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
                />
              </label>
            </div>
            <Feedback state={createState} />
            <button
              type="submit"
              className="mt-4 inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Anlegen
            </button>
          </form>
        </section>
      ) : (
        <p className="text-sm leading-6 text-slate-500">
          Du hast Lesezugriff. Die Kalenderverwaltung ist Administratoren vorbehalten.
        </p>
      )}
    </div>
  );
}
