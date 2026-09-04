"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type {
  TimeEntryDto,
  TimeEntryListDto,
  TimeEntryRevisionDto,
  TimeEventTypeDto,
  TimeMemberOption,
} from "@/lib/integrations/time-tracking/contract";
import {
  archiveTimeEntryAction,
  createTimeEntryAction,
  discardTimeEntryAction,
  startTimeEntryAction,
  stopTimeEntryAction,
  updateTimeEntryAction,
  type TimeEntryActionState,
} from "./actions";

const initialState: TimeEntryActionState = { status: "idle" };

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30";

function message(state: TimeEntryActionState): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success": return { text: state.message, isError: false };
    case "invalid": return { text: state.message ?? "Die Eingabe ist ungültig.", isError: true };
    case "not_found": return { text: "Der Zeiteintrag wurde nicht gefunden.", isError: true };
    case "denied": return { text: "Dir fehlt die Berechtigung für diese Aktion.", isError: true };
    case "unauthenticated": return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    default: return null;
  }
}

function Feedback({ state }: { state: TimeEntryActionState }) {
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

function toLocalInput(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatRange(startAt: string, endAt: string | null): string {
  if (endAt === null) {
    const start = new Date(startAt);
    return `${start.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })} · läuft seit ${start.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })} Uhr`;
  }
  const start = new Date(startAt);
  const end = new Date(endAt);
  const date = start.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const time = (d: Date) => d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
  return `${date} · ${time(start)}–${time(end)} Uhr`;
}

function formatDuration(minutes: number | null): string {
  if (minutes === null) return "läuft";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} Std. ${m} Min.` : `${m} Min.`;
}

// F9.4 Slice B: Verlauf zeigt Berlin-Zeiten wie der CSV-Export — explizite
// Zeitzone statt Browser-Zeitzone (E2E-deterministisch).
const BERLIN_DATE = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});
const BERLIN_TIME = new Intl.DateTimeFormat("de-DE", {
  timeZone: "Europe/Berlin",
  hour: "2-digit",
  minute: "2-digit",
});

function formatBerlinRange(startAt: string, endAt: string | null): string {
  const start = new Date(startAt);
  const date = BERLIN_DATE.format(start);
  const from = BERLIN_TIME.format(start);
  if (endAt === null) return `${date} · ab ${from} Uhr`;
  return `${date} · ${from}–${BERLIN_TIME.format(new Date(endAt))} Uhr`;
}

function formatBerlinDateTime(iso: string): string {
  const date = new Date(iso);
  return `${BERLIN_DATE.format(date)}, ${BERLIN_TIME.format(date)} Uhr`;
}

export function TimeEntryManager({
  workspaceId,
  projectId,
  list,
  types,
  members,
  revisionsByEntry,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  list: TimeEntryListDto;
  types: TimeEventTypeDto[];
  members: TimeMemberOption[];
  revisionsByEntry: Record<string, TimeEntryRevisionDto[]>;
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createTimeEntryAction, initialState);
  const [updateState, updateDispatch] = useActionState(updateTimeEntryAction, initialState);
  const [archiveState, archiveDispatch] = useActionState(archiveTimeEntryAction, initialState);
  const [startState, startDispatch] = useActionState(startTimeEntryAction, initialState);
  const [stopState, stopDispatch] = useActionState(stopTimeEntryAction, initialState);
  const [discardState, discardDispatch] = useActionState(discardTimeEntryAction, initialState);

  // Kimi-P2-2: Anzeige löst gegen ALLE Typen auf (archivierte bleiben
  // historisch referenzierbar); Formular-Optionen nur AKTIVE Typen.
  const typeName = (typeId: string | null): string | null =>
    types.find((type) => type.id === typeId)?.name ?? null;
  const activeTypes = types.filter((type) => type.archivedAt === null);
  const archivedTypeOf = (typeId: string | null) =>
    typeId !== null ? types.find((type) => type.id === typeId && type.archivedAt !== null) : undefined;

  const runningEntry = list.entries.find((entry) => entry.running);

  const memberLabel = (userId: string): string =>
    members.find((member) => member.userId === userId)?.label ?? "Unbekannt";

  return (
    <div className="space-y-6">
      {canWrite && runningEntry ? (
        <section className="min-w-0 rounded-lg border border-blue-200 bg-blue-50 p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-950">Stoppuhr läuft</h2>
          <p className="mt-1 text-sm leading-6 text-slate-700">
            {typeName(runningEntry.typeId) ?? "Ohne Ereignistyp"} ·{" "}
            {formatRange(runningEntry.startAt, runningEntry.endAt)}
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <form action={stopDispatch} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="id" value={runningEntry.id} />
              <label className="block text-sm font-semibold text-slate-800">
                Arbeitszeit (Minuten)
                <input
                  type="number"
                  name="workingTimeMinutes"
                  min={1}
                  max={1440}
                  step={1}
                  required
                  className="mt-1 w-36 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
                />
              </label>
              <label className="block text-sm font-semibold text-slate-800">
                Pause (Minuten)
                <input
                  type="number"
                  name="breakDurationMinutes"
                  min={0}
                  max={1440}
                  step={1}
                  defaultValue={0}
                  className="mt-1 w-36 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
                />
              </label>
              <button
                type="submit"
                className="min-h-11 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                Stoppen
              </button>
            </form>
            <form action={discardDispatch}>
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <input type="hidden" name="id" value={runningEntry.id} />
              <button
                type="submit"
                className="min-h-11 rounded-md border border-slate-300 px-4 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
              >
                Verwerfen
              </button>
            </form>
          </div>
        </section>
      ) : canWrite ? (
        <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-950">Stoppuhr</h2>
          <form action={startDispatch} className="mt-3">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="typeId" value="" />
            <input type="hidden" name="comment" value="" />
            <button
              type="submit"
              className="min-h-11 rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600"
            >
              Stoppuhr starten
            </button>
          </form>
        </section>
      ) : null}
      {startState.status !== "idle" ? <Feedback state={startState} /> : null}
      {stopState.status !== "idle" ? <Feedback state={stopState} /> : null}
      {discardState.status !== "idle" ? <Feedback state={discardState} /> : null}
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-950">Zeiteinträge</h2>
          <p className="text-sm font-semibold text-slate-800">
            Summe: {formatDuration(list.totalWorkingMinutes)}
          </p>
        </div>

        {list.entries.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Noch keine Zeiteinträge erfasst.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {list.entries.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-slate-900">
                    {typeName(entry.typeId) ?? "Ohne Ereignistyp"}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {formatRange(entry.startAt, entry.endAt)}
                    {entry.running ? "" : ` · ${formatDuration(entry.workingTimeMinutes)}${entry.breakDurationMinutes > 0 ? ` · Pause ${formatDuration(entry.breakDurationMinutes)}` : ""}`}
                  </span>
                  {entry.comment ? (
                    <span className="block text-xs text-slate-500">{entry.comment}</span>
                  ) : null}
                </span>
                <RevisionHistory
                  entryId={entry.id}
                  revisions={revisionsByEntry[entry.id] ?? []}
                  typeName={typeName}
                  memberLabel={memberLabel}
                />
                {canWrite ? (
                  <>
                    <EditForm
                      workspaceId={workspaceId}
                      projectId={projectId}
                      entry={entry}
                      types={activeTypes}
                      archivedType={archivedTypeOf(entry.typeId)}
                      state={updateState}
                      dispatch={updateDispatch}
                    />
                    <form action={archiveDispatch}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="id" value={entry.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
                      >
                        Archivieren
                      </button>
                    </form>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        <Feedback state={archiveState} />
      </section>

      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Neuer Zeiteintrag</h2>
        {!canWrite ? (
          <p className="mt-1 text-sm leading-6 text-slate-500">
            Du hast Lesezugriff. Zum Erfassen brauchst du Editor-Rechte.
          </p>
        ) : (
          <form action={createDispatch}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="tzOffsetMinutes" value={new Date().getTimezoneOffset()} />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Ereignistyp</span>
                <select name="typeId" className={inputClass} defaultValue="">
                  <option value="">Ohne Ereignistyp</option>
                  {activeTypes.map((type) => (
                    <option key={type.id} value={type.id}>{type.name}</option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Beginn</span>
                <input type="datetime-local" name="startAt" required className={inputClass} />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Ende</span>
                <input type="datetime-local" name="endAt" required className={inputClass} />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Arbeitszeit (Minuten)</span>
                <input type="number" name="workingTimeMinutes" min={0} max={1440} step={1} required className={inputClass} />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Pause (Minuten)</span>
                <input type="number" name="breakDurationMinutes" min={0} max={1440} step={1} defaultValue={0} className={inputClass} />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Kommentar</span>
                <input type="text" name="comment" maxLength={500} className={inputClass} />
              </label>
            </div>

            <Feedback state={createState} />

            <div className="mt-5">
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Erfassen
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}

// F9.4 Slice B: Aufklapp-Verlauf je Eintrag. Kein toter Link — ohne
// Revisionen wird nichts gerendert. Natives <details> (ohne JS bedienbar,
// E2E-stabil).
function RevisionHistory({
  entryId,
  revisions,
  typeName,
  memberLabel,
}: {
  entryId: string;
  revisions: TimeEntryRevisionDto[];
  typeName: (typeId: string | null) => string | null;
  memberLabel: (userId: string) => string;
}) {
  if (revisions.length === 0) return null;
  return (
    <details className="w-full rounded-md bg-slate-50 px-3 py-2" data-testid={`verlauf-${entryId}`}>
      <summary className="cursor-pointer text-xs font-semibold text-blue-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-blue-600">
        Verlauf ({revisions.length})
      </summary>
      <ul className="mt-2 space-y-2">
        {revisions.map((revision) => (
          <li key={revision.id} className="border-t border-slate-200 pt-2 text-xs text-slate-600">
            <span className="block font-semibold text-slate-800">
              {typeName(revision.typeId) ?? "Ohne Ereignistyp"}
            </span>
            <span className="block">
              {formatBerlinRange(revision.startAt, revision.endAt)}
              {revision.workingTimeMinutes === null
                ? ""
                : ` · ${formatDuration(revision.workingTimeMinutes)}${revision.breakDurationMinutes > 0 ? ` · Pause ${formatDuration(revision.breakDurationMinutes)}` : ""}`}
            </span>
            {revision.comment ? (
              <span className="block italic">{revision.comment}</span>
            ) : null}
            <span className="block text-slate-500">
              Geändert von {memberLabel(revision.revisedBy)} am {formatBerlinDateTime(revision.revisedAt)}
            </span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function EditForm({
  workspaceId,
  projectId,
  entry,
  types,
  archivedType,
  state,
  dispatch,
}: {
  workspaceId: string;
  projectId: string;
  entry: TimeEntryDto;
  types: TimeEventTypeDto[];
  archivedType?: TimeEventTypeDto;
  state: TimeEntryActionState;
  dispatch: (formData: FormData) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        Bearbeiten
      </button>
    );
  }
  return (
    <form action={dispatch} className="flex w-full flex-wrap items-center gap-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="id" value={entry.id} />
      <input type="hidden" name="tzOffsetMinutes" value={new Date().getTimezoneOffset()} />
      <select name="typeId" defaultValue={entry.typeId ?? ""} aria-label="Ereignistyp"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600">
        <option value="">Ohne Ereignistyp</option>
        {archivedType ? (
          <option value={archivedType.id} disabled>{archivedType.name} (archiviert)</option>
        ) : null}
        {types.map((type) => (
          <option key={type.id} value={type.id}>{type.name}</option>
        ))}
      </select>
      <input type="datetime-local" name="startAt" required defaultValue={toLocalInput(entry.startAt)}
        aria-label="Beginn"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600" />
      <input type="datetime-local" name="endAt" required defaultValue={entry.endAt !== null ? toLocalInput(entry.endAt) : ""}
        aria-label="Ende"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600" />
      <input type="number" name="workingTimeMinutes" min={0} max={1440} step={1} required
        defaultValue={entry.workingTimeMinutes ?? ""} aria-label="Arbeitszeit (Minuten)"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600" />
      <input type="number" name="breakDurationMinutes" min={0} max={1440} step={1}
        defaultValue={entry.breakDurationMinutes} aria-label="Pause (Minuten)"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600" />
      <input type="text" name="comment" maxLength={500} defaultValue={entry.comment ?? ""}
        aria-label="Kommentar"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600" />
      <button
        type="submit"
        className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        Speichern
      </button>
      <button
        type="button"
        onClick={() => setIsOpen(false)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50"
      >
        Abbrechen
      </button>
      <div className="w-full">
        <Feedback state={state} />
      </div>
    </form>
  );
}
