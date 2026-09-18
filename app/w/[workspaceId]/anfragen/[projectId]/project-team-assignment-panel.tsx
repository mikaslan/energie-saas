"use client";

import {
  useActionState,
  useEffect,
  useRef,
} from "react";
import {
  changeProjectTeamAssignment,
  type ProjectTeamAssignmentActionState,
} from "./team-assignment-actions";
import type { TeamOption } from "@/modules/teams";

type TeamAssignment = {
  teamId: string;
  label: string;
};

type TeamAssignmentContext = {
  teamAssignmentRevision: number;
  teams: TeamAssignment[];
  canAssign: boolean;
};

const INITIAL_MUTATION_STATE: ProjectTeamAssignmentActionState = { status: "idle" };

function mutationMessage(state: ProjectTeamAssignmentActionState): string {
  switch (state.status) {
    case "success":
      return state.changed
        ? "Die Teamzuweisung wurde gespeichert."
        : "Die Teamzuweisung war bereits so hinterlegt.";
    case "invalid":
      return "Die Änderung war unvollständig oder ungültig. Bitte lade die Projektakte neu.";
    case "conflict":
      return "Die Zuweisung wurde zwischenzeitlich geändert. Die Projektakte wurde aktualisiert.";
    case "target_unavailable":
      return "Dieses Team ist für den Arbeitsbereich nicht mehr verfügbar.";
    case "limit_reached":
      return "Das Projekt hat bereits die maximale Anzahl Teamzuweisungen erreicht.";
    case "not_found":
      return "Das Projekt ist nicht mehr verfügbar.";
    case "denied":
      return "Für diese Änderung fehlt dir die Berechtigung.";
    case "unauthenticated":
      return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu und melde dich erneut an.";
    default:
      return "";
  }
}

function CommandFields({
  commandVersion,
  kind,
  projectId,
  expectedTeamAssignmentRevision,
  teamId,
}: {
  commandVersion: string;
  kind: "assign_team" | "unassign_team";
  projectId: string;
  expectedTeamAssignmentRevision: number;
  teamId: string;
}) {
  return (
    <>
      <input type="hidden" name="schemaVersion" value={commandVersion} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="projectId" value={projectId} />
      <input
        type="hidden"
        name="expectedTeamAssignmentRevision"
        value={expectedTeamAssignmentRevision}
      />
      <input type="hidden" name="teamId" value={teamId} />
    </>
  );
}

export function ProjectTeamAssignmentPanel({
  workspaceId,
  projectId,
  commandVersion,
  assignment,
  teamOptions,
}: {
  workspaceId: string;
  projectId: string;
  commandVersion: string;
  assignment: TeamAssignmentContext;
  teamOptions: TeamOption[];
}) {
  const [mutationState, mutationAction, mutationPending] = useActionState(
    changeProjectTeamAssignment.bind(null, workspaceId),
    INITIAL_MUTATION_STATE,
  );
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const message = mutationMessage(mutationState);
  const isError = mutationState.status !== "idle" && mutationState.status !== "success";
  const assignableOptions = teamOptions.filter(
    (option) => !assignment.teams.some((team) => team.teamId === option.id),
  );

  useEffect(() => {
    if (mutationState.status === "idle") return;
    feedbackRef.current?.focus();
  }, [mutationState]);

  return (
    <section id="project-team-assignment" aria-labelledby="project-team-assignment-title" className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-brand-800">
            Verantwortung
          </p>
          <h2 id="project-team-assignment-title" className="mt-1 text-lg font-semibold text-slate-950">
            Teams
          </h2>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium tabular-nums text-slate-600">
          Stand {assignment.teamAssignmentRevision}
        </span>
      </div>

      <div className="mt-5 min-w-0">
        {assignment.teams.length === 0 ? (
          <p className="text-sm text-slate-600">Keine Teams zugewiesen.</p>
        ) : (
          <ul className="grid list-none gap-2" aria-label="Zugewiesene Teams">
            {assignment.teams.map((team) => (
              <li key={team.teamId} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2">
                <span className="min-w-0 break-all text-sm text-slate-800">{team.label}</span>
                {assignment.canAssign ? (
                  <form action={mutationAction}>
                    <CommandFields
                      commandVersion={commandVersion}
                      kind="unassign_team"
                      projectId={projectId}
                      expectedTeamAssignmentRevision={assignment.teamAssignmentRevision}
                      teamId={team.teamId}
                    />
                    <button
                      type="submit"
                      disabled={mutationPending}
                      aria-label={`${team.label} vom Projekt entfernen`}
                      className="min-h-11 rounded-md px-3 py-2 text-sm font-semibold text-red-700 outline-none hover:bg-red-50 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-slate-400"
                    >
                      Entfernen
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>

      <p
        ref={feedbackRef}
        tabIndex={-1}
        role={isError ? "alert" : "status"}
        aria-live={isError ? "assertive" : "polite"}
        aria-atomic="true"
        className={message
          ? `mt-4 rounded-md border px-3 py-2 text-sm outline-none focus-visible:ring-2 ${isError
            ? "border-amber-200 bg-amber-50 text-amber-950 focus-visible:ring-amber-600"
            : "border-emerald-200 bg-emerald-50 text-emerald-950 focus-visible:ring-emerald-600"}`
          : "sr-only"}
      >
        {message}
      </p>

      {assignment.canAssign ? (
        <div className="mt-5 min-w-0 border-t border-slate-200 pt-5">
          <h3 className="text-sm font-semibold text-slate-900">Team zuweisen</h3>
          {assignableOptions.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">Keine weiteren aktiven Teams verfügbar.</p>
          ) : (
            <form action={mutationAction} className="mt-3 grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
              <label className="grid min-w-0 gap-1.5 text-sm font-medium text-slate-800">
                Team
                <select
                  name="teamId"
                  required
                  defaultValue=""
                  className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                >
                  <option value="" disabled>
                    Team auswählen
                  </option>
                  {assignableOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
              <input type="hidden" name="schemaVersion" value={commandVersion} />
              <input type="hidden" name="kind" value="assign_team" />
              <input type="hidden" name="projectId" value={projectId} />
              <input
                type="hidden"
                name="expectedTeamAssignmentRevision"
                value={assignment.teamAssignmentRevision}
              />
              <button
                type="submit"
                disabled={mutationPending}
                className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                Zuweisen
              </button>
            </form>
          )}
        </div>
      ) : (
        <p className="mt-5 border-t border-slate-200 pt-4 text-sm leading-6 text-slate-600">
          Du kannst die Teams sehen, aber nicht verändern.
        </p>
      )}
    </section>
  );
}
