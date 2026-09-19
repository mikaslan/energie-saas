"use client";

import { useActionState } from "react";
import type {
  TimeEntryListDto,
  TimeEventTypeDto,
} from "@/lib/integrations/time-tracking/contract";
import {
  approveTimeEntryAction,
  archiveTimeEntryAction,
  createTimeEntryAction,
  startTimeEntryAction,
  stopTimeEntryAction,
  unapproveTimeEntryAction,
  type TimeEntryActionState,
} from "../anfragen/[projectId]/zeiterfassung/actions";
import {
  Feedback,
  formatDuration,
  formatTimeEntryRange,
  inputClass,
} from "../anfragen/[projectId]/zeiterfassung/time-entry-manager";
import { ProjectlessEditArchiveSection } from "./edit-archive-section";
import { ProjectlessExportButton } from "./export-button";
import { useProjectlessOffline } from "./use-projectless-offline";

const initialState: TimeEntryActionState = { status: "idle" };

// F9-14: schlanker Manager für projektlose Einträge — Anlage + Liste +
// Stoppuhr (online). Bewusst OHNE Bearbeiten/Archiv/Freigabe/Pausen/
// Verlauf/Offline (eigene Folge-Slices); Labels/Feedback/Markup spiegeln
// die Projektseite (gleiche Actions, gleiche Meldungen).
export function ProjectlessTimeManager({
  workspaceId,
  list,
  types,
  canWrite,
}: {
  workspaceId: string;
  list: TimeEntryListDto;
  types: TimeEventTypeDto[];
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createTimeEntryAction, initialState);
  const [startState, startDispatch] = useActionState(startTimeEntryAction, initialState);
  const [stopState, stopDispatch] = useActionState(stopTimeEntryAction, initialState);
  // F9-15 R1a: Archiv/Freigabe-State auf Manager-Ebene (Projektseiten-Muster) —
  // die Zeile demontiert nach Archivierung, zeilenlokales Feedback ginge verloren.
  const [archiveState, archiveDispatch] = useActionState(archiveTimeEntryAction, initialState);
  const [approveState, approveDispatch] = useActionState(approveTimeEntryAction, initialState);
  const [unapproveState, unapproveDispatch] = useActionState(unapproveTimeEntryAction, initialState);
  // F9-15 R1c: Offline-Anlage (Hook aus Track R1c, Verdrahtung Lead).
  const offline = useProjectlessOffline({ workspaceId, canWrite, createDispatch });

  const typeName = (typeId: string | null): string | null =>
    types.find((type) => type.id === typeId)?.name ?? null;
  const activeTypes = types.filter((type) => type.archivedAt === null);
  const archivedTypeOf = (typeId: string | null) =>
    typeId !== null ? types.find((type) => type.id === typeId && type.archivedAt !== null) : undefined;
  const runningEntry = list.entries.find((entry) => entry.running) ?? null;

  return (
    <div className="grid gap-6">
      {runningEntry ? (
        <section className="min-w-0 rounded-lg border border-brand-200 bg-brand-50 p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-950">Stoppuhr läuft</h2>
          <p className="mt-1 text-sm leading-6 text-slate-700">
            {typeName(runningEntry.typeId) ?? "Ohne Ereignistyp"} ·{" "}
            {formatTimeEntryRange(runningEntry.startAt, runningEntry.endAt)}
          </p>
          <form action={stopDispatch} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="workspaceId" value={workspaceId} />
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
                className="mt-1 w-36 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-brand-600"
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
                className="mt-1 w-36 rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-brand-600"
              />
            </label>
            <button
              type="submit"
              className="min-h-11 rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              Stoppen
            </button>
          </form>
        </section>
      ) : canWrite ? (
        <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-950">Stoppuhr</h2>
          <form action={startDispatch} className="mt-3">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="typeId" value="" />
            <input type="hidden" name="comment" value="" />
            <button
              type="submit"
              className="min-h-11 rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600"
            >
              Stoppuhr starten
            </button>
          </form>
        </section>
      ) : null}
      {/* Feedbacks ausserhalb der bedingten Sektion (Projektseiten-Muster):
          sonst demontiert die Revalidierung nach Start/Stopp das Feedback. */}
      {startState.status !== "idle" ? <Feedback state={startState} /> : null}
      {stopState.status !== "idle" ? <Feedback state={stopState} /> : null}

      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-base font-semibold text-slate-950">Zeiteinträge</h2>
          <div className="flex items-baseline gap-3">
            <p className="text-sm font-semibold text-slate-800">
              Summe: {formatDuration(list.totalWorkingMinutes)}
            </p>
            <ProjectlessExportButton workspaceId={workspaceId} />
          </div>
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
                  <span className="block break-words text-sm font-semibold text-slate-900">
                    {typeName(entry.typeId) ?? "Ohne Ereignistyp"}
                  </span>
                  <span className="block text-xs text-slate-500">
                    {formatTimeEntryRange(entry.startAt, entry.endAt)}
                    {entry.running ? "" : ` · ${formatDuration(entry.workingTimeMinutes)}${entry.breakDurationMinutes > 0 ? ` · Pause ${formatDuration(entry.breakDurationMinutes)}` : ""}`}
                  </span>
                  {entry.comment ? (
                    <span className="block break-words text-xs text-slate-500">{entry.comment}</span>
                  ) : null}
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <ProjectlessEditArchiveSection
                    workspaceId={workspaceId}
                    entry={entry}
                    types={activeTypes}
                    archivedType={archivedTypeOf(entry.typeId)}
                    canWrite={canWrite}
                    archiveDispatch={archiveDispatch}
                    approveDispatch={approveDispatch}
                    unapproveDispatch={unapproveDispatch}
                  />
                </span>
              </li>
            ))}
          </ul>
        )}
        <Feedback state={archiveState} />
        <Feedback state={approveState} />
        <Feedback state={unapproveState} />
      </section>

      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Neuer Zeiteintrag</h2>
        {!canWrite ? (
          <p className="mt-1 text-sm leading-6 text-slate-500">
            Du hast Lesezugriff. Zum Erfassen brauchst du Editor-Rechte.
          </p>
        ) : (
          <form action={createDispatch} onSubmit={offline.onSubmit}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
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
            {offline.syncState.notice !== "" ? (
              <p role="status" className="mt-3 text-sm font-semibold text-green-700">
                {offline.syncState.notice}
              </p>
            ) : null}
            {offline.syncState.message !== "" ? (
              <p role="status" className="mt-3 text-sm font-semibold text-green-700">
                {offline.syncState.message}
              </p>
            ) : null}
            {offline.syncState.queueError ? (
              <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
                Offline-Speichern ist fehlgeschlagen.
              </p>
            ) : null}
            {offline.pendingCount > 0 ? (
              <p className="mt-1 text-xs text-slate-500">
                {offline.pendingCount} Eintrag wartet auf Synchronisierung.
              </p>
            ) : null}

            <div className="mt-5">
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
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
