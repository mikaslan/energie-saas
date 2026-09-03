"use client";

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import {
  PROJECT_APPOINTMENT_COMMAND_VERSION,
  type CalendarCategoryItemV1,
  type ProjectAppointmentItemV1,
} from "@/lib/integrations/calendar/contract";
import {
  APPOINTMENT_TYPE_OPTIONS,
  toBerlinDateValue,
  toBerlinDateTimeValue,
} from "./appointment-editor-model";
import {
  changeProjectAppointment,
  type ProjectAppointmentActionState,
} from "./appointment-actions";

const INITIAL_STATE: ProjectAppointmentActionState = { status: "idle" };

const DIALOG_FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "input:not([type='hidden']):not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

function actionMessage(state: ProjectAppointmentActionState): string {
  switch (state.status) {
    case "idle": return "";
    case "success":
      if (!state.changed) return "Der Termin war bereits auf diesem Stand.";
      if (state.operation === "create_appointment") return "Der Termin wurde angelegt.";
      if (state.operation === "update_appointment") return "Der Termin wurde aktualisiert.";
      if (state.operation === "delete_appointment") return "Der Termin wurde gelöscht.";
      return "Der Termin wurde geändert.";
    case "invalid": return "Die Terminänderung ist unvollständig oder ungültig.";
    case "conflict": return "Der Termin wurde zwischenzeitlich geändert. Die Ansicht wurde aktualisiert.";
    case "not_found": return "Der Termin oder das Projekt ist nicht mehr verfügbar.";
    case "denied": return "Für diese Terminänderung fehlt dir die Berechtigung.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu.";
  }
}

export function AppointmentDialog({
  workspaceId,
  projectId,
  appointment,
  categories,
  members,
  returnFocusRef,
  onClose,
}: {
  workspaceId: string;
  projectId: string;
  appointment: ProjectAppointmentItemV1 | null;
  categories: CalendarCategoryItemV1[];
  members: { membershipId: string; label: string }[];
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const boundAction = changeProjectAppointment.bind(null, workspaceId, projectId);
  const [state, formAction, pending] = useActionState(boundAction, INITIAL_STATE);
  const [allDay, setAllDay] = useState(appointment?.allDay ?? false);
  const [selectedAttendees, setSelectedAttendees] = useState<string[]>(
    appointment?.attendees.map((a) => a.membershipId) ?? [],
  );

  useEffect(() => {
    const returnTarget = returnFocusRef.current;
    return () => {
      returnTarget?.focus();
    };
  }, [returnFocusRef]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    if (state.status === "success") onClose();
  }, [state.status, onClose]);

  const toggleAttendee = (membershipId: string) => {
    setSelectedAttendees((current) =>
      current.includes(membershipId)
        ? current.filter((id) => id !== membershipId)
        : [...current, membershipId],
    );
  };

  const message = actionMessage(state);
  const isError = state.status !== "idle" && state.status !== "success";

  function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (!pending) onClose();
      return;
    }
    if (event.key === "Tab") {
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        DIALOG_FOCUSABLE_SELECTOR,
      ) ?? []);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (focusable.length === 0) {
        event.preventDefault();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/60 p-2 sm:p-4">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={onDialogKeyDown}
        className="max-h-[calc(100dvh-1rem)] w-full max-w-2xl overflow-y-auto rounded-lg border border-slate-200 bg-white p-4 shadow-2xl sm:max-h-[calc(100dvh-2rem)] sm:p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Termin</p>
            <h2 id={titleId} className="mt-1 break-words text-xl font-semibold text-slate-950">
              {appointment === null ? "Termin anlegen" : "Termin bearbeiten"}
            </h2>
            <p id={descriptionId} className="mt-2 text-sm leading-6 text-slate-600">
              Zeitfenster werden in der Zeitzone Europe/Berlin gespeichert. Löschen ist endgültig.
            </p>
          </div>
          <button
            type="button"
            disabled={pending}
            onClick={onClose}
            aria-label="Termineditor schließen"
            className="min-h-11 rounded-md px-3 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-slate-400"
          >
            Schließen
          </button>
        </div>

        <form action={formAction} className="mt-5 grid min-w-0 gap-4">
          <input type="hidden" name="schemaVersion" value={PROJECT_APPOINTMENT_COMMAND_VERSION} />
          <input type="hidden" name="kind" value={appointment === null ? "create_appointment" : "update_appointment"} />
          <input type="hidden" name="projectId" value={projectId} />
          {appointment !== null ? (
            <>
              <input type="hidden" name="appointmentId" value={appointment.id} />
              <input type="hidden" name="expectedRevision" value={appointment.revision} />
            </>
          ) : null}
          <input type="hidden" name="attendees" value={JSON.stringify(selectedAttendees)} />
          <input type="hidden" name="allDay" value={allDay ? "true" : "false"} />

          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            Titel
            <input
              type="text"
              name="title"
              required
              minLength={1}
              maxLength={2000}
              disabled={pending}
              defaultValue={appointment?.title ?? ""}
              className="mt-1 min-h-11 rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-50"
            />
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm font-semibold text-slate-800">
              Typ
              <select
                name="type"
                disabled={pending}
                defaultValue={appointment?.type ?? "on_site"}
                className="mt-1 min-h-11 rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-50"
              >
                {APPOINTMENT_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>

            <label className="grid gap-1 text-sm font-semibold text-slate-800">
              Kategorie
              <select
                name="categoryId"
                disabled={pending}
                defaultValue={appointment?.categoryId ?? ""}
                className="mt-1 min-h-11 rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-50"
              >
                <option value="">Keine</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </label>
          </div>

          <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-800">
            <input
              type="checkbox"
              checked={allDay}
              disabled={pending}
              onChange={(event) => setAllDay(event.currentTarget.checked)}
              className="h-4 w-4 rounded border-slate-300 text-blue-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            />
            Ganztägig
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="grid gap-1 text-sm font-semibold text-slate-800">
              Beginn
              <input
                type={allDay ? "date" : "datetime-local"}
                name="start"
                required
                disabled={pending}
                defaultValue={
                  appointment === null
                    ? ""
                    : allDay
                      ? toBerlinDateValue(appointment.start)
                      : toBerlinDateTimeValue(appointment.start)
                }
                className="mt-1 min-h-11 rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-50"
              />
            </label>
            <label className="grid gap-1 text-sm font-semibold text-slate-800">
              Ende
              <input
                type={allDay ? "date" : "datetime-local"}
                name="end"
                required
                disabled={pending}
                defaultValue={
                  appointment === null
                    ? ""
                    : allDay
                      ? toBerlinDateValue(appointment.end)
                      : toBerlinDateTimeValue(appointment.end)
                }
                className="mt-1 min-h-11 rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-50"
              />
            </label>
          </div>

          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            Ort
            <input
              type="text"
              name="location"
              maxLength={2000}
              disabled={pending}
              defaultValue={appointment?.location ?? ""}
              className="mt-1 min-h-11 rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-50"
            />
          </label>

          <label className="grid gap-1 text-sm font-semibold text-slate-800">
            Beschreibung
            <textarea
              name="description"
              rows={3}
              maxLength={5000}
              disabled={pending}
              defaultValue={appointment?.description ?? ""}
              className="mt-1 rounded-md border border-slate-300 px-3 py-2 text-sm font-normal text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-50"
            />
          </label>

          <fieldset className="rounded-md border border-slate-200 p-3">
            <legend className="px-1 text-sm font-semibold text-slate-800">Teilnehmer</legend>
            {members.length === 0 ? (
              <p className="text-sm text-slate-600">Keine internen Mitglieder verfügbar.</p>
            ) : (
              <div className="grid max-h-44 gap-1 overflow-y-auto">
                {members.map((member) => (
                  <label key={member.membershipId} className="flex min-h-11 items-center gap-2 rounded px-2 py-1 text-sm text-slate-800 hover:bg-slate-50">
                    <input
                      type="checkbox"
                      checked={selectedAttendees.includes(member.membershipId)}
                      disabled={pending}
                      onChange={() => toggleAttendee(member.membershipId)}
                      className="h-4 w-4 rounded border-slate-300 text-blue-700 outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                    />
                    {member.label}
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          <p
            role={isError ? "alert" : "status"}
            aria-live={isError ? "assertive" : "polite"}
            className={message
              ? `rounded-md border px-3 py-2 text-sm outline-none ${isError
                ? "border-amber-200 bg-amber-50 text-amber-950"
                : "border-emerald-200 bg-emerald-50 text-emerald-950"}`
              : "sr-only"}
          >
            {message}
          </p>

          <div className="flex flex-col-reverse gap-2 border-t border-slate-200 pt-4 sm:flex-row sm:justify-end">
            <button
              type="button"
              disabled={pending}
              onClick={onClose}
              className="min-h-11 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:text-slate-400"
            >
              Abbrechen
            </button>
            <button
              type="submit"
              disabled={pending}
              aria-busy={pending || undefined}
              className="min-h-11 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
            >
              {pending ? "Wird gespeichert …" : "Speichern"}
            </button>
          </div>
        </form>

        {appointment !== null ? (
          <details className="group mt-4 rounded-md border border-red-300 bg-white">
            <summary className="flex min-h-11 cursor-pointer list-none items-center px-3 py-2 text-sm font-semibold text-red-700 outline-none focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2">
              Löschen
            </summary>
            <div className="max-w-sm border-t border-red-200 p-3">
              <p className="text-xs leading-5 text-slate-600">
                Der Termin wird dauerhaft entfernt und ist danach nicht mehr sichtbar.
              </p>
              <form action={formAction} className="mt-3">
                <input type="hidden" name="schemaVersion" value={PROJECT_APPOINTMENT_COMMAND_VERSION} />
                <input type="hidden" name="kind" value="delete_appointment" />
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="appointmentId" value={appointment.id} />
                <input type="hidden" name="expectedRevision" value={appointment.revision} />
                <button
                  type="submit"
                  disabled={pending}
                  className="min-h-11 rounded-md bg-red-700 px-3 py-2 text-sm font-semibold text-white outline-none hover:bg-red-800 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-400"
                >
                  Endgültig löschen
                </button>
              </form>
            </div>
          </details>
        ) : null}
      </div>
    </div>
  );
}
