"use client";

import { useActionState } from "react";
import type {
  CalendarItemV1,
  PlanningBoardProjectOption,
} from "@/modules/calendar";
import type { TeamOption } from "@/modules/teams";
import {
  createPlanningBoardEntryAction,
  type PlanningBoardCreateState,
} from "./actions";

const initialState: PlanningBoardCreateState = { status: "idle" };

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "on_site", label: "Vor Ort" },
  { value: "phone", label: "Telefon" },
  { value: "installation", label: "Installation" },
  { value: "maintenance", label: "Wartung" },
  { value: "consultation", label: "Beratung" },
  { value: "other", label: "Sonstiges" },
];

function feedback(state: PlanningBoardCreateState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "success":
      return state.message;
    case "invalid":
      return "Eingabe ungültig — bitte Zeiten (Ende nach Beginn), Titel, Projekt, Typ und Kalender prüfen.";
    case "conflict":
      return "Konflikt — der Termin wurde zwischenzeitlich geändert oder kollidiert. Bitte neu laden.";
    case "not_found":
      return "Nicht gefunden — Projekt oder Kalender ist nicht mehr verfügbar.";
    case "denied":
      return "Nicht freigegeben — Termine anlegen braucht Editor-Rechte.";
    case "unauthenticated":
      return "Nicht angemeldet — bitte neu anmelden.";
  }
}

export function PlanningBoardCreateForm({
  workspaceId,
  date,
  memberId,
  memberLabel,
  projects,
  calendars,
  teams,
  cancelHref,
}: {
  workspaceId: string;
  date: string;
  memberId: string;
  memberLabel: string;
  projects: PlanningBoardProjectOption[];
  calendars: CalendarItemV1[];
  teams: TeamOption[];
  cancelHref: string;
}) {
  const [state, dispatch] = useActionState(createPlanningBoardEntryAction, initialState);
  const message = feedback(state);
  const inputClass = "mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm";
  const labelClass = "flex flex-col gap-1 text-sm text-slate-800";

  return (
    <section aria-label="Termin anlegen" className="mt-6 rounded-md border border-slate-200 bg-white px-4 py-4">
      <h2 className="text-lg font-semibold text-slate-900">
        Neuer Termin am {date} für {memberLabel}
      </h2>
      {projects.length === 0 || calendars.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">
          Anlegen ist hier nicht möglich (kein Projekt oder Kalender verfügbar).
        </p>
      ) : (
        <form action={dispatch} className="mt-3 grid max-w-2xl grid-cols-1 gap-3 sm:grid-cols-2">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="date" value={date} />
          <input type="hidden" name="attendeeMembershipId" value={memberId} />
          <label className={labelClass}>
            Beginn (Uhrzeit)
            <input type="time" name="startTime" required defaultValue="10:00" className={inputClass} />
          </label>
          <label className={labelClass}>
            Ende (Uhrzeit)
            <input type="time" name="endTime" required defaultValue="11:00" className={inputClass} />
          </label>
          <label className={`${labelClass} sm:col-span-2`}>
            Titel
            <input type="text" name="title" required maxLength={2000} className={inputClass} />
          </label>
          <label className={labelClass}>
            Projekt
            <select name="projectId" required className={inputClass}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Kalender
            <select name="calendarId" required className={inputClass}>
              {calendars.map((calendar) => (
                <option key={calendar.id} value={calendar.id}>{calendar.name}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Art
            <select name="type" required defaultValue="on_site" className={inputClass}>
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Team (optional)
            <select name="teamId" defaultValue="" className={inputClass}>
              <option value="">Ohne Team</option>
              {teams.map((team) => (
                <option key={team.id} value={team.id}>{team.name}</option>
              ))}
            </select>
          </label>
          <label className={labelClass}>
            Ort (optional)
            <input type="text" name="location" maxLength={2000} className={inputClass} />
          </label>
          <p className="text-sm sm:col-span-2">
            <button
              type="submit"
              className="rounded-md bg-brand-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-brand-800"
            >
              Anlegen
            </button>{" "}
            <a
              href={cancelHref}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Abbrechen
            </a>
          </p>
        </form>
      )}
      {message !== null && (
        <p className="mt-2 text-sm text-slate-700" aria-live="polite">{message}</p>
      )}
    </section>
  );
}
