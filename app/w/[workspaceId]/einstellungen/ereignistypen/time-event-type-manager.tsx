"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { TimeEventTypeDto } from "@/lib/integrations/time-tracking/contract";
import {
  archiveTimeEventTypeAction,
  createTimeEventTypeAction,
  restoreTimeEventTypeAction,
  updateTimeEventTypeAction,
  type TimeEventTypeActionState,
} from "./actions";

const initialState: TimeEventTypeActionState = { status: "idle" };

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30";

function message(state: TimeEventTypeActionState): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success": return { text: state.message, isError: false };
    case "invalid": return { text: state.message ?? "Die Eingabe ist ungültig.", isError: true };
    case "conflict": return { text: "Ein aktiver Ereignistyp mit diesem Namen existiert bereits.", isError: true };
    case "not_found": return { text: "Der Ereignistyp wurde nicht gefunden.", isError: true };
    case "denied": return { text: "Dir fehlt die Berechtigung für diese Aktion.", isError: true };
    case "unauthenticated": return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    default: return null;
  }
}

function Feedback({ state }: { state: TimeEventTypeActionState }) {
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
      className={`mt-4 text-sm font-semibold ${
        feedback === null ? "hidden" : feedback.isError ? "text-red-700" : "text-green-700"
      }`}
    >
      {feedback?.text}
    </p>
  );
}

function TypeBadge({ name, textColor, backgroundColor }: {
  name: string;
  textColor: string | null;
  backgroundColor: string | null;
}) {
  return (
    <span
      className="inline-flex rounded px-2 py-0.5 text-xs font-semibold"
      style={{
        color: textColor ?? "#0F172A",
        backgroundColor: backgroundColor ?? "#E2E8F0",
      }}
    >
      {name}
    </span>
  );
}

export function TimeEventTypeManager({
  workspaceId,
  types,
  canWrite,
}: {
  workspaceId: string;
  types: TimeEventTypeDto[];
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createTimeEventTypeAction, initialState);
  const [updateState, updateDispatch] = useActionState(updateTimeEventTypeAction, initialState);
  const [archiveState, archiveDispatch] = useActionState(archiveTimeEventTypeAction, initialState);
  const [restoreState, restoreDispatch] = useActionState(restoreTimeEventTypeAction, initialState);

  const active = types.filter((type) => type.archivedAt === null);
  const archived = types.filter((type) => type.archivedAt !== null);

  return (
    <div className="space-y-6">
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-950">Neuer Ereignistyp</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Ereignistypen ordnen Zeiteinträge (z. B. Montage, Büro, Anfahrt).
          </p>
        </div>

        {!canWrite ? (
          <p className="text-sm leading-6 text-slate-500">
            Du hast Lesezugriff. Zum Anlegen brauchst du Editor-Rechte.
          </p>
        ) : (
          <form action={createDispatch}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <div className="grid gap-4 sm:grid-cols-4">
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Name</span>
                <input type="text" name="name" required maxLength={120} className={inputClass} />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Position</span>
                <input type="number" name="position" min={0} step={1} defaultValue={0} className={inputClass} />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Textfarbe</span>
                <input type="text" name="textColor" placeholder="#FFFFFF" maxLength={7} className={inputClass} />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Hintergrundfarbe</span>
                <input type="text" name="backgroundColor" placeholder="#3B82F6" maxLength={7} className={inputClass} />
              </label>
            </div>

            <Feedback state={createState} />

            <div className="mt-5">
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Anlegen
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Aktive Ereignistypen</h2>
        {active.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Noch keine Ereignistypen angelegt.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {active.map((type) => (
              <li key={type.id} className="flex flex-wrap items-center gap-3 py-3">
                <TypeBadge name={type.name} textColor={type.textColor} backgroundColor={type.backgroundColor} />
                <span className="text-xs text-slate-500">Position {type.position}</span>
                <span className="min-w-0 flex-1" />
                {canWrite ? (
                  <>
                    <EditForm
                      workspaceId={workspaceId}
                      type={type}
                      state={updateState}
                      dispatch={updateDispatch}
                    />
                    <form action={archiveDispatch}>
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="id" value={type.id} />
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

      {archived.length > 0 || restoreState.status !== "idle" ? (
        <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-950">Archivierte Ereignistypen</h2>
          {archived.length === 0 ? (
            <p className="mt-2 text-sm leading-6 text-slate-500">Keine archivierten Ereignistypen.</p>
          ) : null}
          <ul className="mt-3 divide-y divide-slate-100">
            {archived.map((type) => (
              <li key={type.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1 text-sm text-slate-500">{type.name}</span>
                {canWrite ? (
                  <form action={restoreDispatch}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="id" value={type.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
                    >
                      Reaktivieren
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          <Feedback state={restoreState} />
        </section>
      ) : null}
    </div>
  );
}

function EditForm({
  workspaceId,
  type,
  state,
  dispatch,
}: {
  workspaceId: string;
  type: TimeEventTypeDto;
  state: TimeEventTypeActionState;
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
    <form action={dispatch} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="id" value={type.id} />
      <input
        type="text"
        name="name"
        required
        maxLength={120}
        defaultValue={type.name}
        aria-label="Name"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
      />
      <input
        type="number"
        name="position"
        min={0}
        step={1}
        defaultValue={type.position}
        aria-label="Position"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
      />
      <input
        type="text"
        name="textColor"
        maxLength={7}
        defaultValue={type.textColor ?? ""}
        aria-label="Textfarbe"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
      />
      <input
        type="text"
        name="backgroundColor"
        maxLength={7}
        defaultValue={type.backgroundColor ?? ""}
        aria-label="Hintergrundfarbe"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
      />
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
