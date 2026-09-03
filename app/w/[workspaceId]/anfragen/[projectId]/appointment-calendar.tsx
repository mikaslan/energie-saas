"use client";

import { useMemo, useRef } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import listPlugin from "@fullcalendar/list";
import interactionPlugin from "@fullcalendar/interaction";
import type { EventClickArg, EventInput } from "@fullcalendar/core";
import type { ProjectAppointmentItemV1 } from "@/lib/integrations/calendar/contract";
import { APPOINTMENT_TYPE_COLORS } from "./appointment-editor-model";

type ViewMode = "month" | "week" | "list";

const FULLCALENDAR_VIEWS: Record<ViewMode, string> = {
  month: "dayGridMonth",
  week: "timeGridWeek",
  list: "listWeek",
};

const VIEW_LABELS: Record<ViewMode, string> = {
  month: "Monat",
  week: "Woche",
  list: "Liste",
};

function toEventInput(item: ProjectAppointmentItemV1): EventInput {
  return {
    id: item.id,
    title: item.title,
    start: item.start,
    end: item.end,
    allDay: item.allDay,
    color: APPOINTMENT_TYPE_COLORS[item.type],
    extendedProps: {
      revision: item.revision,
      type: item.type,
      location: item.location,
    },
  };
}

export function AppointmentCalendar({
  items,
  view,
  onViewChange,
  onRangeChange,
  onEventClick,
}: {
  items: ProjectAppointmentItemV1[];
  view: ViewMode;
  onViewChange: (view: ViewMode) => void;
  onRangeChange: (range: { start: string; end: string }) => void;
  onEventClick: (appointmentId: string) => void;
}) {
  const calendarRef = useRef<FullCalendar | null>(null);
  const events = useMemo(() => items.map(toEventInput), [items]);

  const handleViewChange = (next: ViewMode) => {
    onViewChange(next);
    const api = calendarRef.current?.getApi();
    if (api) api.changeView(FULLCALENDAR_VIEWS[next]);
  };

  const handleDatesSet = (arg: { start: Date; end: Date }) => {
    onRangeChange({
      start: arg.start.toISOString(),
      end: arg.end.toISOString(),
    });
  };

  const handleEventClick = (arg: EventClickArg) => {
    onEventClick(arg.event.id);
  };

  return (
    <div className="min-w-0">
      <div className="mb-3 flex flex-wrap gap-2" role="group" aria-label="Kalenderansicht">
        {(Object.keys(VIEW_LABELS) as ViewMode[]).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => handleViewChange(mode)}
            aria-pressed={view === mode}
            className={`min-h-11 rounded-md border px-3 py-2 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 ${
              view === mode
                ? "border-blue-700 bg-blue-50 text-blue-900"
                : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            }`}
          >
            {VIEW_LABELS[mode]}
          </button>
        ))}
      </div>

      <FullCalendar
        ref={calendarRef}
        plugins={[dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin]}
        initialView={FULLCALENDAR_VIEWS[view]}
        headerToolbar={{ left: "prev,next today", center: "title", right: "" }}
        buttonText={{ prev: "Zurück", next: "Vor", today: "Heute" }}
        height="auto"
        timeZone="Europe/Berlin"
        locale="de"
        nowIndicator
        events={events}
        datesSet={handleDatesSet}
        eventClick={handleEventClick}
        eventTimeFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        slotLabelFormat={{ hour: "2-digit", minute: "2-digit", hour12: false }}
        displayEventEnd
      />
    </div>
  );
}

export type { ViewMode };
