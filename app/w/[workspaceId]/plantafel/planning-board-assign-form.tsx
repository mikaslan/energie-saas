"use client";

import { useActionState } from "react";
import type { TeamOption } from "@/modules/teams";
import {
  assignPlanningBoardEntryTeamAction,
  type PlanningBoardAssignState,
} from "./actions";

const initialState: PlanningBoardAssignState = { status: "idle" };

function feedback(state: PlanningBoardAssignState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "success":
      return state.message;
    case "invalid":
      return "Eingabe ungültig — bitte ein Team aus der Liste wählen.";
    case "conflict":
      return "Konflikt — der Termin wurde zwischenzeitlich geändert. Bitte neu laden.";
    case "not_found":
      return "Nicht gefunden — der Termin ist nicht mehr verfügbar.";
    case "denied":
      return "Nicht freigegeben — Team zuweisen braucht Editor-Rechte.";
    case "unauthenticated":
      return "Nicht angemeldet — bitte neu anmelden.";
  }
}

// F7-06 Team-Blockzuweisung im Event-Drawer (Revision-CAS, Server-Action).
export function PlanningBoardAssignForm({
  workspaceId,
  projectId,
  appointmentId,
  revision,
  start,
  end,
  currentTeamId,
  currentTeamName,
  teams,
}: {
  workspaceId: string;
  projectId: string;
  appointmentId: string;
  revision: number;
  start: string;
  end: string;
  currentTeamId: string | null;
  currentTeamName: string | null;
  teams: TeamOption[];
}) {
  const [state, dispatch] = useActionState(assignPlanningBoardEntryTeamAction, initialState);
  const message = feedback(state);
  // Archiviertes Team: nur Hinweis (keine Option — Einreichen ohne Auswahl
  // entzieht ehrlich auf „Ohne Team", statt eine abgelehnte ID zu senden).
  const archived = currentTeamId !== null && !teams.some((team) => team.id === currentTeamId);
  return (
    <form action={dispatch} className="mt-3 flex max-w-2xl flex-wrap items-end gap-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="appointmentId" value={appointmentId} />
      <input type="hidden" name="revision" value={String(revision)} />
      <input type="hidden" name="start" value={start} />
      <input type="hidden" name="end" value={end} />
      {archived ? (
        <p className="w-full text-sm text-slate-600" data-testid="planning-board-assign-archived">
          Aktuell: {currentTeamName ?? "Archiviertes Team"} (archiviert — unten neu zuweisen oder entziehen).
        </p>
      ) : null}
      <label className="flex min-w-52 flex-1 flex-col gap-1 text-sm text-slate-800">
        Team
        <select
          name="teamId"
          defaultValue={archived ? "" : (currentTeamId ?? "")}
          data-testid="planning-board-assign-team"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="">Ohne Team</option>
          {teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        data-testid="planning-board-assign-submit"
        className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
      >
        Team zuweisen
      </button>
      {message !== null ? (
        <p
          role={state.status === "success" ? "status" : "alert"}
          data-testid="planning-board-assign-feedback"
          className={`w-full text-sm font-semibold ${
            state.status === "success" ? "text-emerald-700" : "text-red-700"
          }`}
        >
          {message}
        </p>
      ) : null}
    </form>
  );
}
