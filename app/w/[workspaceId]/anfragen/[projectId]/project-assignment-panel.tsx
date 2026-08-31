"use client";

import {
  useActionState,
  useEffect,
  useMemo,
  useRef,
} from "react";
import {
  changeProjectAssignment,
  membershipSearch,
  type ProjectAssignmentActionState,
  type ProjectAssignmentSearchState,
} from "./assignment-actions";

type AssignmentMember = {
  membershipId: string;
  label: string;
};

type AssignmentSearchResult = AssignmentMember & {
  alreadyAssigned: boolean;
  assignmentRole: "key_account" | "user" | null;
};

type AssignmentContext = {
  assignmentRevision: number;
  keyAccount: AssignmentMember | null;
  users: AssignmentMember[];
  canAssign: boolean;
};

const INITIAL_MUTATION_STATE: ProjectAssignmentActionState = { status: "idle" };
const INITIAL_SEARCH_STATE: ProjectAssignmentSearchState = { status: "idle" };

function mutationMessage(state: ProjectAssignmentActionState): string {
  switch (state.status) {
    case "success":
      return state.changed
        ? "Die Projektverantwortung wurde gespeichert."
        : "Die Projektverantwortung war bereits so hinterlegt.";
    case "invalid":
      return "Die Änderung war unvollständig oder ungültig. Bitte lade die Projektakte neu.";
    case "conflict":
      return "Die Zuweisung wurde zwischenzeitlich geändert. Die Projektakte wurde aktualisiert.";
    case "target_unavailable":
      return "Diese Person ist für den Arbeitsbereich nicht mehr verfügbar.";
    case "limit_reached":
      return "Das Projekt hat bereits die maximale Anzahl direkter Zuweisungen erreicht.";
    case "key_account_requires_clear":
      return "Der Key Account muss zuerst ausdrücklich abgewählt werden.";
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

function searchMessage(state: ProjectAssignmentSearchState): string {
  switch (state.status) {
    case "results":
      return `${state.results.length} passende ${state.results.length === 1 ? "Person" : "Personen"} gefunden.`;
    case "empty":
      return `Keine passende Person für „${state.query}“ gefunden.`;
    case "invalid":
      return "Bitte gib mindestens zwei und höchstens einhundert Zeichen ein.";
    case "not_found":
      return "Das Projekt ist nicht mehr verfügbar.";
    case "denied":
      return "Für die Personensuche fehlt dir die Berechtigung.";
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
  expectedAssignmentRevision,
  membershipId,
}: {
  commandVersion: string;
  kind: "set_key_account" | "clear_key_account" | "add_user" | "remove_user";
  projectId: string;
  expectedAssignmentRevision: number;
  membershipId?: string;
}) {
  return (
    <>
      <input type="hidden" name="schemaVersion" value={commandVersion} />
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="projectId" value={projectId} />
      <input
        type="hidden"
        name="expectedAssignmentRevision"
        value={expectedAssignmentRevision}
      />
      {membershipId ? <input type="hidden" name="membershipId" value={membershipId} /> : null}
    </>
  );
}

function ResultActions({
  result,
  action,
  pending,
  commandVersion,
  projectId,
  expectedAssignmentRevision,
}: {
  result: AssignmentSearchResult;
  action: (formData: FormData) => void;
  pending: boolean;
  commandVersion: string;
  projectId: string;
  expectedAssignmentRevision: number;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {result.assignmentRole !== "key_account" ? (
        <form action={action}>
          <CommandFields
            commandVersion={commandVersion}
            kind="set_key_account"
            projectId={projectId}
            expectedAssignmentRevision={expectedAssignmentRevision}
            membershipId={result.membershipId}
          />
          <button
            type="submit"
            disabled={pending}
            aria-label={`${result.label} als Key Account festlegen`}
            className="min-h-11 rounded-md bg-blue-700 px-3 py-2 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Als Key Account
          </button>
        </form>
      ) : null}
      {!result.alreadyAssigned ? (
        <form action={action}>
          <CommandFields
            commandVersion={commandVersion}
            kind="add_user"
            projectId={projectId}
            expectedAssignmentRevision={expectedAssignmentRevision}
            membershipId={result.membershipId}
          />
          <button
            type="submit"
            disabled={pending}
            aria-label={`${result.label} zusätzlich zuweisen`}
            className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-slate-400"
          >
            Zusätzlich zuweisen
          </button>
        </form>
      ) : (
        <span className="inline-flex min-h-11 items-center text-xs font-medium text-slate-500">
          Bereits zugewiesen
        </span>
      )}
    </div>
  );
}

export function ProjectAssignmentPanel({
  workspaceId,
  projectId,
  commandVersion,
  assignment,
}: {
  workspaceId: string;
  projectId: string;
  commandVersion: string;
  assignment: AssignmentContext;
}) {
  const boundMutation = useMemo(
    () => changeProjectAssignment.bind(null, workspaceId),
    [workspaceId],
  );
  const boundSearch = useMemo(
    () => membershipSearch.bind(null, workspaceId, projectId),
    [projectId, workspaceId],
  );
  const [mutationState, mutationAction, mutationPending] = useActionState(
    boundMutation,
    INITIAL_MUTATION_STATE,
  );
  const [searchState, searchAction, searchPending] = useActionState(
    boundSearch,
    INITIAL_SEARCH_STATE,
  );
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const message = mutationMessage(mutationState);
  const isError = mutationState.status !== "idle" && mutationState.status !== "success";
  const results = searchState.status === "results" ? searchState.results : [];

  useEffect(() => {
    if (mutationState.status === "idle") return;
    feedbackRef.current?.focus();
  }, [mutationState]);

  return (
    <section id="project-assignment" aria-labelledby="project-assignment-title" className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">
            Verantwortung
          </p>
          <h2 id="project-assignment-title" className="mt-1 text-lg font-semibold text-slate-950">
            Projektverantwortung
          </h2>
        </div>
        <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium tabular-nums text-slate-600">
          Stand {assignment.assignmentRevision}
        </span>
      </div>

      <div className="mt-5 grid min-w-0 gap-4">
        <div className="min-w-0 rounded-md border border-slate-200 bg-slate-50 p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Key Account</p>
          <p className="mt-1 break-words text-sm font-semibold text-slate-950">
            {assignment.keyAccount?.label ?? "Nicht zugewiesen"}
          </p>
          {assignment.canAssign && assignment.keyAccount ? (
            <form action={mutationAction} className="mt-3">
              <CommandFields
                commandVersion={commandVersion}
                kind="clear_key_account"
                projectId={projectId}
                expectedAssignmentRevision={assignment.assignmentRevision}
              />
              <button
                type="submit"
                disabled={mutationPending}
                aria-label={`${assignment.keyAccount.label} als Key Account abwählen`}
                className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-slate-400"
              >
                Key Account abwählen
              </button>
              <p className="mt-2 text-xs leading-5 text-slate-500">
                Die Person bleibt danach als zusätzliche Zuweisung am Projekt.
              </p>
            </form>
          ) : null}
        </div>

        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-900">Zusätzlich zugewiesen</h3>
          {assignment.users.length === 0 ? (
            <p className="mt-2 text-sm text-slate-600">Keine weiteren Personen zugewiesen.</p>
          ) : (
            <ul className="mt-2 grid list-none gap-2">
              {assignment.users.map((member) => (
                <li key={member.membershipId} className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-md border border-slate-200 px-3 py-2">
                  <span className="min-w-0 break-all text-sm text-slate-800">{member.label}</span>
                  {assignment.canAssign ? (
                    <form action={mutationAction}>
                      <CommandFields
                        commandVersion={commandVersion}
                        kind="remove_user"
                        projectId={projectId}
                        expectedAssignmentRevision={assignment.assignmentRevision}
                        membershipId={member.membershipId}
                      />
                      <button
                        type="submit"
                        disabled={mutationPending}
                        aria-label={`${member.label} vom Projekt entfernen`}
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
          <h3 className="text-sm font-semibold text-slate-900">Person hinzufügen oder Verantwortung ändern</h3>
          <form action={searchAction} className="mt-3 grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
            <label className="grid min-w-0 gap-1.5 text-sm font-medium text-slate-800">
              Personensuche
              <input
                type="search"
                name="query"
                minLength={2}
                maxLength={100}
                required
                autoComplete="off"
                aria-describedby="project-assignment-search-status"
                className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-3 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200"
              />
            </label>
            <button
              type="submit"
              disabled={searchPending}
              className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {searchPending ? "Suche läuft …" : "Suchen"}
            </button>
          </form>
          <p
            id="project-assignment-search-status"
            role="status"
            aria-live="polite"
            className={searchMessage(searchState) ? "mt-3 text-sm text-slate-600" : "sr-only"}
          >
            {searchMessage(searchState)}
          </p>
          {results.length > 0 ? (
            <ul className="mt-3 grid list-none gap-3" aria-label="Suchergebnisse">
              {results.map((result) => (
                <li key={result.membershipId} className="grid min-w-0 gap-3 rounded-md border border-slate-200 p-3">
                  <span className="break-all text-sm font-medium text-slate-900">{result.label}</span>
                  <ResultActions
                    result={result}
                    action={mutationAction}
                    pending={mutationPending}
                    commandVersion={commandVersion}
                    projectId={projectId}
                    expectedAssignmentRevision={assignment.assignmentRevision}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        <p className="mt-5 border-t border-slate-200 pt-4 text-sm leading-6 text-slate-600">
          Du kannst die Verantwortung sehen, aber nicht verändern.
        </p>
      )}
    </section>
  );
}
