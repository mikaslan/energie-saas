"use client";

import { useCallback, useRef, useState, type MouseEvent } from "react";
import type {
  ProjectAppointmentItemV1,
  ProjectAppointmentRangeV1,
} from "@/lib/integrations/calendar/contract";
import { APPOINTMENT_TYPE_LABELS } from "./appointment-editor-model";
import { AppointmentCalendar, type ViewMode } from "./appointment-calendar";
import { AppointmentDialog } from "./appointment-dialog";

const dateTimeFormatter = new Intl.DateTimeFormat("de-DE", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Europe/Berlin",
});

function formatWallClock(value: string): string {
  // value ist Berlin-Wanduhr ohne Offset; für die Anzeige als lokale Zeit
  // wird sie als Offset-lose Zeit interpretiert und formatiert.
  const normalized = value.length === 16 ? `${value}:00` : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? value : dateTimeFormatter.format(date);
}

export function AppointmentCalendarSection({
  workspaceId,
  projectId,
  range,
}: {
  workspaceId: string;
  projectId: string;
  range: ProjectAppointmentRangeV1;
}) {
  const createButtonRef = useRef<HTMLButtonElement | null>(null);
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
    <section id="project-appointments" aria-labelledby="project-appointments-title" className="min-w-0">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Akte</p>
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
            className="min-h-11 rounded-md border border-blue-700 bg-white px-4 py-2 text-sm font-semibold text-blue-800 outline-none hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
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
                    {" · "}{formatWallClock(appointment.start)}
                    {" – "}{formatWallClock(appointment.end)}
                  </p>
                  {appointment.location ? (
                    <p className="mt-1 text-xs text-slate-500">Ort: {appointment.location}</p>
                  ) : null}
                </div>
                {range.permissions.canWrite ? (
                  <button
                    type="button"
                    onClick={() => openEdit(appointment)}
                    className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
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
          returnFocusRef={createButtonRef}
          onClose={closeDialog}
        />
      ) : null}
    </section>
  );
}
