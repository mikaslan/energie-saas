"use client";

import { useActionState, useState } from "react";
import type {
  TimeEntryDto,
  TimeEventTypeDto,
} from "@/lib/integrations/time-tracking/contract";
import { isoToBerlinLocalInput } from "@/lib/integrations/time-tracking/berlin-wall-clock";
import {
  updateTimeEntryAction,
  type TimeEntryActionState,
} from "../anfragen/[projectId]/zeiterfassung/actions";
import {
  Feedback,
  inputClass,
} from "../anfragen/[projectId]/zeiterfassung/time-entry-manager";

const initialState: TimeEntryActionState = { status: "idle" };

type RowDispatch = (formData: FormData) => void;

const buttonClass =
  "rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600";

// F9-15 R1a: Edit/Archiv/Freigabe je projektlosem Eintrag — Komposition
// macht der Lead im Projektlos-Manager. Formulare senden KEIN projectId
// (fehlend = projektloser Pfad + Revalidate der projektlosen Route,
// F9-14-Muster); Labels/Feedback/Markup spiegeln die Projektseite.
export function ProjectlessEditArchiveSection({
  workspaceId,
  entry,
  types,
  archivedType,
  canWrite,
  archiveDispatch,
  approveDispatch,
  unapproveDispatch,
}: {
  workspaceId: string;
  entry: TimeEntryDto;
  types: TimeEventTypeDto[];
  archivedType?: TimeEventTypeDto;
  canWrite: boolean;
  archiveDispatch: RowDispatch;
  approveDispatch: RowDispatch;
  unapproveDispatch: RowDispatch;
}) {
  if (!canWrite) return null;

  return (
    <>
      {entry.approvedAt === null ? (
        <ProjectlessEditForm
          workspaceId={workspaceId}
          entry={entry}
          types={types}
          archivedType={archivedType}
        />
      ) : null}
      <form action={archiveDispatch}>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="id" value={entry.id} />
        <button type="submit" className={buttonClass}>
          Archivieren
        </button>
      </form>
      {!entry.running && entry.archivedAt === null && !entry.billed ? (
        entry.approvedAt !== null ? (
          <form action={unapproveDispatch}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="id" value={entry.id} />
            <button type="submit" className={buttonClass}>
              Entsperren
            </button>
          </form>
        ) : (
          <form action={approveDispatch}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="id" value={entry.id} />
            <button type="submit" className={buttonClass}>
              Freigeben
            </button>
          </form>
        )
      ) : null}
    </>
  );
}

function ProjectlessEditForm({
  workspaceId,
  entry,
  types,
  archivedType,
}: {
  workspaceId: string;
  entry: TimeEntryDto;
  types: TimeEventTypeDto[];
  archivedType?: TimeEventTypeDto;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [state, dispatch] = useActionState(updateTimeEntryAction, initialState);
  if (!isOpen) {
    return (
      <button type="button" onClick={() => setIsOpen(true)} className={buttonClass}>
        Bearbeiten
      </button>
    );
  }
  return (
    <form action={dispatch} className="flex w-full flex-wrap items-center gap-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="id" value={entry.id} />
      <select name="typeId" defaultValue={entry.typeId ?? ""} aria-label="Ereignistyp" className={inputClass}>
        <option value="">Ohne Ereignistyp</option>
        {archivedType ? (
          <option value={archivedType.id}>{archivedType.name} (archiviert)</option>
        ) : null}
        {types.map((type) => (
          <option key={type.id} value={type.id}>{type.name}</option>
        ))}
      </select>
      <input
        type="datetime-local" name="startAt" required
        defaultValue={isoToBerlinLocalInput(entry.startAt)}
        aria-label="Beginn" className={inputClass}
      />
      <input
        type="datetime-local" name="endAt" required
        defaultValue={entry.endAt !== null ? isoToBerlinLocalInput(entry.endAt) : ""}
        aria-label="Ende" className={inputClass}
      />
      <input
        type="number" name="workingTimeMinutes" min={0} max={1440} step={1} required
        defaultValue={entry.workingTimeMinutes ?? ""} aria-label="Arbeitszeit (Minuten)"
        className={inputClass}
      />
      <input
        type="number" name="breakDurationMinutes" min={0} max={1440} step={1}
        defaultValue={entry.breakDurationMinutes} aria-label="Pause (Minuten)"
        className={inputClass}
      />
      <input
        type="text" name="comment" maxLength={500} defaultValue={entry.comment ?? ""}
        aria-label="Kommentar" className={inputClass}
      />
      <button
        type="submit"
        className="rounded-md bg-brand-700 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600"
      >
        Speichern
      </button>
      <button
        type="button" onClick={() => setIsOpen(false)}
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
