"use client";

import { useActionState } from "react";
import type { TeamOption } from "@/modules/teams";
import {
  assignPlanningBoardExtraTeamsAction,
  type PlanningBoardExtraTeamsState,
} from "./actions";

const initialState: PlanningBoardExtraTeamsState = { status: "idle" };

function feedback(state: PlanningBoardExtraTeamsState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "success":
      return state.message;
    case "invalid":
      return "Eingabe ungültig — bitte die Auswahl prüfen (ein Team ist eventuell bereits als Haupt-Team gesetzt).";
    case "conflict":
      return "Konflikt — die Teams wurden zwischenzeitlich geändert. Bitte neu laden.";
    case "target_unavailable":
      return "Team nicht verfügbar — ein gewähltes Team wurde inzwischen archiviert oder entfernt.";
    case "limit_reached":
      return "Limit erreicht — höchstens 50 weitere Teams je Termin.";
    case "not_found":
      return "Nicht gefunden — der Termin ist nicht mehr verfügbar.";
    case "denied":
      return "Nicht freigegeben — Teams zuweisen braucht Editor-Rechte.";
    case "unauthenticated":
      return "Nicht angemeldet — bitte neu anmelden.";
  }
}

export type ExtraAssignedTeam = {
  id: string;
  name: string;
};

// F7-11 Mehr-Team-Zuweisung im Event-Drawer: Checkbox je aktivem Team,
// Speichern diff-basiert mit Team-Revisions-CAS (Server-Action). Archivierte
// Junction-Teams bleiben lesbar (disabled) und werden nie still entfernt.
export function PlanningBoardExtraTeamsForm({
  workspaceId,
  projectId,
  appointmentId,
  teamAssignmentRevision,
  assignedTeams,
  teams,
  canAssign,
}: {
  workspaceId: string;
  projectId: string;
  appointmentId: string;
  teamAssignmentRevision: number;
  assignedTeams: ExtraAssignedTeam[];
  teams: TeamOption[];
  canAssign: boolean;
}) {
  const [state, dispatch] = useActionState(assignPlanningBoardExtraTeamsAction, initialState);
  const message = feedback(state);
  const assignedIds = new Set(assignedTeams.map((team) => team.id));
  const activeIds = new Set(teams.map((team) => team.id));
  const archivedAssigned = assignedTeams.filter((team) => !activeIds.has(team.id));
  if (!canAssign) {
    return (
      <section aria-label="Weitere Teams" className="mt-4 max-w-2xl">
        <h3 className="text-sm font-semibold text-slate-900">Weitere Teams</h3>
        {assignedTeams.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">Keine weiteren Teams.</p>
        ) : (
          <ul className="mt-1 flex flex-wrap gap-1">
            {assignedTeams.map((team) => (
              <li
                key={team.id}
                className="rounded bg-sky-100 px-1.5 py-0.5 text-xs font-semibold text-sky-900"
              >
                {team.name}
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }
  return (
    <section aria-label="Weitere Teams" className="mt-4 max-w-2xl">
      <h3 className="text-sm font-semibold text-slate-900">Weitere Teams</h3>
      <form
        action={dispatch}
        data-testid="planning-board-extra-teams-form"
        className="mt-2 flex flex-col gap-2"
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="appointmentId" value={appointmentId} />
        <input type="hidden" name="revision" value={String(teamAssignmentRevision)} />
        {teams.length === 0 && archivedAssigned.length === 0 ? (
          <p className="text-sm text-slate-600">Keine Teams verfügbar.</p>
        ) : (
          <fieldset>
            <legend className="sr-only">Weitere Teams wählen</legend>
            <ul className="flex flex-col gap-1">
              {teams.map((team) => (
                <li key={team.id}>
                  <label className="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-800">
                    <input
                      type="checkbox"
                      name="teamIds"
                      value={team.id}
                      defaultChecked={assignedIds.has(team.id)}
                      data-testid={`planning-board-extra-team-${team.id}`}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    {team.name}
                  </label>
                </li>
              ))}
              {archivedAssigned.map((team) => (
                <li key={team.id} className="inline-flex items-center gap-2 text-sm text-slate-500">
                  <input
                    type="checkbox"
                    defaultChecked
                    disabled
                    aria-label={`${team.name} (archiviert)`}
                    data-testid={`planning-board-extra-team-${team.id}`}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  {team.name} (archiviert — nur lesbar)
                </li>
              ))}
            </ul>
          </fieldset>
        )}
        <div>
          <button
            type="submit"
            className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Speichern
          </button>
        </div>
        {message !== null ? (
          <p
            role={state.status === "success" ? "status" : "alert"}
            className={`text-sm font-semibold ${
              state.status === "success" ? "text-emerald-700" : "text-red-700"
            }`}
          >
            {message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
