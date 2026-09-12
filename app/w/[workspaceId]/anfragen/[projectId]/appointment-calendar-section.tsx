"use client";

import { useActionState, useCallback, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";
import { useFormStatus } from "react-dom";
import type {
  CalendarItemV1,
  ProjectAppointmentItemV1,
  ProjectAppointmentRangeV1,
} from "@/lib/integrations/calendar/contract";
import type { AppointmentTemplateDto } from "@/lib/integrations/calendar/template-contract";
import { APPOINTMENT_TYPE_LABELS } from "./appointment-editor-model";
import { AppointmentCalendar, type ViewMode } from "./appointment-calendar";
import { AppointmentDialog } from "./appointment-dialog";
import {
  applyAppointmentTemplateAction,
  type ApplyAppointmentTemplateActionState,
} from "./appointment-actions";

const dateTimeFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  // Die Eingabe ist bereits die Berlin-Wanduhr (kein Instant). UTC dient hier
  // nur als verschiebungsfreie Darstellungsachse für ihre Zahlenbestandteile.
  timeZone: "UTC",
});

const WALL_CLOCK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/u;

export function formatAppointmentWallClock(value: string): string {
  // value ist eine Berlin-Wanduhr ohne Offset, kein ISO-Instant. Die Teile
  // werden deshalb nie über den lokalen Date-String-Parser interpretiert.
  const match = WALL_CLOCK_PATTERN.exec(value);
  if (!match) return value;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6] ?? "0");
  const millisecond = Number((match[7] ?? "0").padEnd(3, "0"));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  if (
    year < 1
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) return value;
  return dateTimeFormatter.format(date);
}

const INITIAL_APPLY_TEMPLATE_STATE: ApplyAppointmentTemplateActionState = { status: "idle" };

function applyTemplateMessage(state: ApplyAppointmentTemplateActionState): string {
  switch (state.status) {
    case "idle": return "";
    case "success": return "Der Termin wurde aus der Vorlage erstellt.";
    case "invalid": return "Die Vorlage ist unvollständig oder der Start liegt in der Zeitumstellungs-Lücke.";
    case "not_found": return "Die Vorlage, das Projekt oder der Kalender ist nicht mehr verfügbar.";
    case "denied": return "Für diese Terminänderung fehlt dir die Berechtigung.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu.";
  }
}

function ApplyTemplateSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-11 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-100"
    >
      {pending ? "Wird angelegt …" : "Vorlage anwenden"}
    </button>
  );
}

function formatTemplateDuration(minutes: number): string {
  if (minutes < 60) return `${minutes} Min.`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} Std.` : `${hours} Std. ${rest} Min.`;
}

function ApplyAppointmentTemplateForm({
  workspaceId,
  projectId,
  templates,
  calendars,
}: {
  workspaceId: string;
  projectId: string;
  templates: AppointmentTemplateDto[];
  calendars: CalendarItemV1[];
}) {
  const boundApply = useMemo(
    () => applyAppointmentTemplateAction.bind(null, workspaceId, projectId),
    [projectId, workspaceId],
  );
  const [state, applyAction] = useActionState(boundApply, INITIAL_APPLY_TEMPLATE_STATE);
  const message = applyTemplateMessage(state);
  const isError = state.status !== "idle" && state.status !== "success";

  return (
    <form action={applyAction} className="mt-4 grid min-w-0 gap-2 rounded-lg border border-slate-200 bg-white p-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
      <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-slate-900">
        Termin aus Vorlage anlegen
        <select
          name="templateId"
          aria-label="Terminvorlage"
          required
          defaultValue=""
          className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-base font-normal text-slate-950 outline-none focus-visible:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1"
        >
          <option value="" disabled>Vorlage wählen …</option>
          {templates.map((template) => (
            <option key={template.id} value={template.id}>
              {template.name} – {template.title} ({formatTemplateDuration(template.durationMinutes)})
            </option>
          ))}
        </select>
      </label>
      <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-slate-900">
        Beginn
        <input
          type="datetime-local"
          name="start"
          aria-label="Beginn"
          required
          className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-base font-normal text-slate-950 outline-none focus-visible:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1"
        />
      </label>
      <label className="grid min-w-0 gap-1.5 text-sm font-semibold text-slate-900">
        Kalender
        <select
          name="calendarId"
          aria-label="Kalender"
          required
          defaultValue=""
          className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-base font-normal text-slate-950 outline-none focus-visible:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1"
        >
          <option value="" disabled>Kalender wählen …</option>
          {calendars.map((calendar) => (
            <option key={calendar.id} value={calendar.id}>
              {calendar.name}
            </option>
          ))}
        </select>
      </label>
      <ApplyTemplateSubmitButton />
      {message ? (
        <p
          role={isError ? "alert" : "status"}
          aria-live={isError ? "assertive" : "polite"}
          aria-atomic="true"
          className={isError
            ? "rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950 sm:col-span-4"
            : "rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-950 sm:col-span-4"}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}

// M1-15-Härtung (CI 34692521678/34694681228/34697426710): SSR-HTML ist schon
// vor der React-Hydration klickbar — ein Klick auf „Bearbeiten" ohne Listener
// öffnet den Dialog nie (synchroner openEdit-Pfad, kein App-Fehler). Das
// Marker-Attribut belegt die Hydration für die E2E-Bereitschaft
// (Muster: data-catalog-import-hydrated).
const subscribeToHydration = () => () => undefined;

export function AppointmentCalendarSection({
  workspaceId,
  projectId,
  range,
  templates,
}: {
  workspaceId: string;
  projectId: string;
  range: ProjectAppointmentRangeV1;
  templates: AppointmentTemplateDto[];
}) {
  const createButtonRef = useRef<HTMLButtonElement | null>(null);
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  );
  const [view, setView] = useState<ViewMode>(range.view);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogAppointment, setDialogAppointment] = useState<ProjectAppointmentItemV1 | null>(null);

  const openCreate = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    createButtonRef.current = event.currentTarget;
    setDialogAppointment(null);
    setDialogOpen(true);
  }, []);

  const openEdit = useCallback((appointment: ProjectAppointmentItemV1) => {
    setDialogAppointment(appointment);
    setDialogOpen(true);
  }, []);

  const closeDialog = useCallback(() => setDialogOpen(false), []);

  return (
    <section id="project-appointments" data-appointments-hydrated={hydrated ? "true" : "false"} aria-labelledby="project-appointments-title" className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-800">Akte</p>
          <h2 id="project-appointments-title" className="mt-1 text-xl font-semibold text-slate-950">Termine</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Projekttermine im Kalender. Termine werden dauerhaft gelöscht und bleiben über die Aktivität nachvollziehbar.
          </p>
        </div>
        {range.permissions.canWrite ? (
          <button
            type="button"
            onClick={openCreate}
            ref={createButtonRef}
            className="min-h-11 rounded-md border border-brand-700 bg-white px-4 py-2 text-sm font-semibold text-brand-800 outline-none hover:bg-brand-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Termin anlegen
          </button>
        ) : null}
      </div>

      {!range.permissions.canWrite ? (
        <p className="mt-5 rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
          Du kannst Termine sehen, aber nicht verändern.
        </p>
      ) : null}

      {range.permissions.canWrite && templates.length > 0 && range.calendars.length > 0 ? (
        <ApplyAppointmentTemplateForm
          workspaceId={workspaceId}
          projectId={projectId}
          templates={templates}
          calendars={range.calendars}
        />
      ) : null}

      <div className="mt-5 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <AppointmentCalendar
          items={range.items}
          view={view}
          onViewChange={setView}
          onRangeChange={() => undefined}
          onEventClick={(appointmentId) => {
            const item = range.items.find((entry) => entry.id === appointmentId);
            if (item) openEdit(item);
          }}
        />
      </div>

      {range.items.length === 0 ? (
        <p className="mt-5 rounded-lg border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-sm text-slate-600">
          Noch keine Termine vorhanden.
        </p>
      ) : (
        <div className="mt-5 grid min-w-0 gap-3">
          {range.items.map((appointment) => (
            <article
              key={appointment.id}
              className="min-w-0 rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900">{appointment.title}</p>
                  <p className="mt-1 text-xs text-slate-500">
                    {APPOINTMENT_TYPE_LABELS[appointment.type]}
                    {appointment.allDay ? " · ganztägig" : null}
                    {" · "}{formatAppointmentWallClock(appointment.start)}
                    {" – "}{formatAppointmentWallClock(appointment.end)}
                  </p>
                  {appointment.location ? (
                    <p className="mt-1 text-xs text-slate-500">Ort: {appointment.location}</p>
                  ) : null}
                  {appointment.teamName ? (
                    <p className="mt-1 text-xs text-slate-500">Team: {appointment.teamName}</p>
                  ) : null}
                </div>
                {range.permissions.canWrite ? (
                  <button
                    type="button"
                    onClick={() => openEdit(appointment)}
                    className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                  >
                    Bearbeiten
                  </button>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}

      {dialogOpen ? (
        <AppointmentDialog
          key={dialogAppointment?.id ?? "create"}
          workspaceId={workspaceId}
          projectId={projectId}
          appointment={dialogAppointment}
          calendars={range.calendars}
          members={range.members}
          teams={range.teams}
          returnFocusRef={createButtonRef}
          onClose={closeDialog}
        />
      ) : null}
    </section>
  );
}
