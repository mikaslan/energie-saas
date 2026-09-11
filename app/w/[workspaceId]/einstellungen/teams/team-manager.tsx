"use client";

import { useActionState, useState } from "react";
import type { TeamDto } from "@/lib/integrations/teams/contract";
import {
  createTeamAction,
  renameTeamAction,
  setTeamActiveAction,
  setTeamMembersAction,
  type TeamActionState,
} from "./actions";

const initialState: TeamActionState = { status: "idle" };

function Feedback({ state }: { state: TeamActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return <p role="status" className="mt-2 text-sm font-medium text-green-700">{state.message}</p>;
  }
  const message =
    state.status === "denied"
      ? "Nur interne Admins können Teams verwalten."
      : state.status === "unauthenticated"
        ? "Bitte erneut anmelden."
        : state.status === "not_found"
          ? "Team nicht gefunden — Seite neu laden."
          : state.message ?? "Eingaben prüfen (Name 1–120 Zeichen, gültige Mitglieder).";
  return <p role="alert" className="mt-2 text-sm font-medium text-red-700">{message}</p>;
}

// F1-12: Team-Zeile mit Umbenennen, Archivieren/Wiederherstellen und
// Mitglieder-Checkboxen (Voll-Replace). Remount bei Erfolg (stale-DOM).
function TeamRow({
  workspaceId,
  team,
  members,
}: {
  workspaceId: string;
  team: TeamDto;
  members: { membershipId: string; label: string }[];
}) {
  const [renameState, renameDispatch] = useActionState(renameTeamAction, initialState);
  const [activeState, activeDispatch] = useActionState(setTeamActiveAction, initialState);
  const [membersState, membersDispatch] = useActionState(setTeamMembersAction, initialState);
  const [selected, setSelected] = useState<string[]>(
    team.members.map((member) => member.membershipId),
  );
  const [successCount, setSuccessCount] = useState(0);
  const [prevStatuses, setPrevStatuses] = useState(
    `${renameState.status}/${activeState.status}/${membersState.status}`,
  );
  const combined = `${renameState.status}/${activeState.status}/${membersState.status}`;
  if (prevStatuses !== combined) {
    setPrevStatuses(combined);
    if (combined.includes("success")) setSuccessCount((count) => count + 1);
  }
  const currentIds = new Set(team.members.map((member) => member.membershipId));
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-950">{team.name}</h2>
        <p className="text-xs text-slate-500">{team.active ? "Aktiv" : "Archiviert"}</p>
      </div>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        {team.members.length === 0
          ? "Noch keine Mitglieder."
          : team.members.map((member) => member.label).join(", ")}
      </p>
      <div className="mt-3 grid gap-3">
        <form
          action={renameDispatch}
          key={`rename:${team.id}:${team.revision}:${successCount}`}
          className="flex flex-wrap items-end gap-2"
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="teamId" value={team.id} />
          <input type="hidden" name="expectedRevision" value={team.revision} />
          <label className="grid min-w-52 flex-1 gap-1 text-sm font-semibold text-slate-800">
            Name
            <input
              type="text"
              name="name"
              defaultValue={team.name}
              required
              maxLength={120}
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
            />
          </label>
          <button
            type="submit"
            className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            Umbenennen
          </button>
        </form>
        <Feedback state={renameState} />
        <form action={membersDispatch} key={`members:${team.id}:${successCount}`}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="teamId" value={team.id} />
          <input type="hidden" name="membershipIds" value={JSON.stringify(selected)} />
          <fieldset>
            <legend className="px-1 text-sm font-semibold text-slate-800">Mitglieder</legend>
            {members.length === 0 ? (
              <p className="mt-1 text-sm text-slate-500">Keine internen Mitglieder verfügbar.</p>
            ) : (
              <ul className="mt-2 grid gap-1">
                {members.map((member) => (
                  <li key={member.membershipId}>
                    <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-800 has-checked:border-blue-600 has-checked:bg-blue-50">
                      <input
                        type="checkbox"
                        checked={selected.includes(member.membershipId)}
                        onChange={() => setSelected((current) =>
                          current.includes(member.membershipId)
                            ? current.filter((id) => id !== member.membershipId)
                            : [...current, member.membershipId],
                        )}
                        className="h-4 w-4 rounded border-slate-300 text-blue-700"
                      />
                      <span className="min-w-0 flex-1 truncate" title={member.label}>{member.label}</span>
                      {currentIds.has(member.membershipId) ? null : (
                        <span className="text-xs text-slate-400">neu</span>
                      )}
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
          <button
            type="submit"
            className="mt-2 min-h-11 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            Mitglieder speichern
          </button>
        </form>
        <Feedback state={membersState} />
        <form action={activeDispatch}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="teamId" value={team.id} />
          <input type="hidden" name="expectedRevision" value={team.revision} />
          <input type="hidden" name="active" value={team.active ? "false" : "true"} />
          <button
            type="submit"
            className="min-h-11 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            {team.active ? "Archivieren" : "Wiederherstellen"}
          </button>
        </form>
        <Feedback state={activeState} />
      </div>
    </section>
  );
}

export function TeamManager({
  workspaceId,
  teams,
  members,
}: {
  workspaceId: string;
  teams: TeamDto[];
  members: { membershipId: string; label: string }[];
}) {
  const [createState, createDispatch] = useActionState(createTeamAction, initialState);
  return (
    <div className="grid gap-4">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-950">Team anlegen</h2>
        <form action={createDispatch} className="mt-3 flex flex-wrap items-end gap-2">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <label className="grid min-w-52 flex-1 gap-1 text-sm font-semibold text-slate-800">
            Name
            <input
              type="text"
              name="name"
              required
              maxLength={120}
              placeholder="z. B. Montageteam Nord"
              className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
            />
          </label>
          <button
            type="submit"
            className="min-h-11 rounded-md bg-blue-700 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Anlegen
          </button>
        </form>
        <Feedback state={createState} />
      </section>
      {teams.map((team) => (
        <TeamRow key={team.id} workspaceId={workspaceId} team={team} members={members} />
      ))}
    </div>
  );
}
