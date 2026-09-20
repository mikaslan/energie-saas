// F3-05c String-Member: Projekt-Sektionen je String (Client).
// UI-Vertrag aus der E2E-Spec tests/e2e/f3-05c-members.spec.ts — Testids
// exakt einhalten. Range-Anlage (Gruppen-Select + Zeilen-/Spalten-Fenster)
// + Member-Liste mit Effektiv-Count + Deselect-Warnung, eine Sektion je
// String in String-Listenreihenfolge. Viewer read-only (Muster:
// planning-panel-deselect-section.tsx).
// F3-05d: Effektiv-Zeile „X von Y" (Testid
// planning-string-members-effective, E2E-Spec f3-05d-effective).
"use client";

import { useActionState, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  removePlanningStringMemberAction,
  savePlanningStringMemberAction,
  type PlanningStringMemberActionState,
} from "./planning-string-members-actions";
import {
  type PlanningStringMemberGroupOption,
  type PlanningStringMemberStringSection,
} from "./planning-string-members-model";

const initialMemberAction: PlanningStringMemberActionState = { status: "idle" };

const MEMBER_GROUP_MESSAGE = "Bitte eine Panel-Gruppe wählen.";
const MEMBER_WINDOW_MESSAGE =
  "Zeilen-/Spalten-Fenster müssen ganze Zahlen ab 1 sein, von darf nicht größer als bis sein.";

function parseInteger(raw: string): number {
  if (raw.trim() === "") return Number.NaN;
  return Number.parseInt(raw.trim(), 10);
}

function actionFallbackMessage(state: PlanningStringMemberActionState): string | null {
  if (state.status === "not_found") return "Der Eintrag wurde nicht gefunden.";
  if (state.status === "denied") return "Dir fehlt die Berechtigung für diese Aktion.";
  if (state.status === "unauthenticated") return "Deine Sitzung ist abgelaufen.";
  return null;
}

function FormFeedback({
  state,
  clientError,
}: {
  state: PlanningStringMemberActionState;
  clientError: string | null;
}) {
  if (clientError) {
    return (
      <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
        {clientError}
      </p>
    );
  }
  if (state.status === "idle") return null;
  if (state.status === "success" || state.status === "invalid") {
    return (
      <p
        role={state.status === "invalid" ? "alert" : "status"}
        className={
          state.status === "invalid"
            ? "mt-3 text-sm font-semibold text-red-700"
            : "mt-3 text-sm font-semibold text-emerald-700"
        }
      >
        {state.message}
      </p>
    );
  }
  return (
    <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
      {actionFallbackMessage(state)}
    </p>
  );
}

function PlanningStringMemberForm({
  workspaceId,
  projectId,
  stringId,
  groups,
}: {
  workspaceId: string;
  projectId: string;
  stringId: string;
  groups: PlanningStringMemberGroupOption[];
}) {
  const router = useRouter();
  const [saveState, saveDispatch] = useActionState(
    savePlanningStringMemberAction,
    initialMemberAction,
  );
  const [memberError, setMemberError] = useState<string | null>(null);

  useEffect(() => {
    if (saveState.status === "success") {
      router.refresh();
    }
  }, [saveState, router]);

  function handleMemberSubmit(event: FormEvent<HTMLFormElement>): void {
    const form = new FormData(event.currentTarget);
    const groupId = form.get("groupId");
    if (typeof groupId !== "string" || groupId === "") {
      event.preventDefault();
      setMemberError(MEMBER_GROUP_MESSAGE);
      return;
    }
    const rawRowFrom = form.get("rowFrom");
    const rawRowTo = form.get("rowTo");
    const rawColFrom = form.get("colFrom");
    const rawColTo = form.get("colTo");
    const rowFrom = typeof rawRowFrom === "string" ? parseInteger(rawRowFrom) : Number.NaN;
    const rowTo = typeof rawRowTo === "string" ? parseInteger(rawRowTo) : Number.NaN;
    const colFrom = typeof rawColFrom === "string" ? parseInteger(rawColFrom) : Number.NaN;
    const colTo = typeof rawColTo === "string" ? parseInteger(rawColTo) : Number.NaN;
    if (
      !Number.isInteger(rowFrom)
      || rowFrom < 1
      || !Number.isInteger(rowTo)
      || rowTo < 1
      || !Number.isInteger(colFrom)
      || colFrom < 1
      || !Number.isInteger(colTo)
      || colTo < 1
      || rowFrom > rowTo
      || colFrom > colTo
    ) {
      event.preventDefault();
      setMemberError(MEMBER_WINDOW_MESSAGE);
      return;
    }
    setMemberError(null);
  }

  return (
    <form
      data-testid="planning-string-members-form"
      action={saveDispatch}
      onSubmit={handleMemberSubmit}
      className="mt-3 border-t border-slate-100 pt-3"
    >
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="stringId" value={stringId} />
      <div className="grid gap-2 sm:grid-cols-2">
        <label className="block text-sm text-slate-600">
          Panel-Gruppe
          <select
            name="groupId"
            data-testid="planning-string-members-group"
            defaultValue=""
            onChange={() => setMemberError(null)}
            className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
          >
            <option value="">Bitte wählen</option>
            {groups.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-slate-600">
          Zeilen von
          <input
            type="text"
            name="rowFrom"
            data-testid="planning-string-members-row-from"
            inputMode="numeric"
            autoComplete="off"
            onChange={() => setMemberError(null)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
          />
        </label>
        <label className="block text-sm text-slate-600">
          Zeilen bis
          <input
            type="text"
            name="rowTo"
            data-testid="planning-string-members-row-to"
            inputMode="numeric"
            autoComplete="off"
            onChange={() => setMemberError(null)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
          />
        </label>
        <label className="block text-sm text-slate-600">
          Spalten von
          <input
            type="text"
            name="colFrom"
            data-testid="planning-string-members-col-from"
            inputMode="numeric"
            autoComplete="off"
            onChange={() => setMemberError(null)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
          />
        </label>
        <label className="block text-sm text-slate-600">
          Spalten bis
          <input
            type="text"
            name="colTo"
            data-testid="planning-string-members-col-to"
            inputMode="numeric"
            autoComplete="off"
            onChange={() => setMemberError(null)}
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
          />
        </label>
      </div>
      <button
        type="submit"
        data-testid="planning-string-members-create"
        className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
      >
        Member speichern
      </button>
      <FormFeedback state={saveState} clientError={memberError} />
    </form>
  );
}

export function PlanningStringMembersSection({
  workspaceId,
  projectId,
  strings,
  groups,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  strings: PlanningStringMemberStringSection[];
  groups: PlanningStringMemberGroupOption[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [removeState, removeDispatch] = useActionState(
    removePlanningStringMemberAction,
    initialMemberAction,
  );

  useEffect(() => {
    if (removeState.status === "success") {
      router.refresh();
    }
  }, [removeState, router]);

  // Loesch-Feedback gehoert in die Sektion des geloeschten Members
  // (E2E adressiert je String-Sektion); globale Fehler einmal unten.
  const removeError =
    removeState.status !== "idle" && removeState.status !== "success" ? removeState : null;

  return (
    <div className="grid gap-4">
      {strings.map((entry) => (
        <section
          key={entry.id}
          data-testid="planning-string-members-section"
          aria-label={`String-Member ${entry.label}`}
          className="rounded-lg border border-slate-200 bg-white p-4"
        >
          <h2 className="text-sm font-semibold text-slate-900">
            {`String-Member: ${entry.label}`}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {`Rechteck-Ranges aus Panel-Gruppen am ${entry.inverterLabel} — Effektiv-Count ohne abgewählte Zellen.`}
          </p>
          <p data-testid="planning-string-members-count" className="mt-2 text-sm text-slate-900">
            {`Effektive Module: ${entry.effectiveCount}`}
          </p>
          <p data-testid="planning-string-members-effective" className="mt-1 text-sm text-slate-900">
            {`Effektiv: ${entry.effectiveCount} von ${entry.rawCount} Modulen`}
          </p>
          {entry.deselectedInside > 0 ? (
            <p className="mt-1 text-sm font-semibold text-amber-700">
              {`Abwahl-Hinweis: ${entry.deselectedInside} von ${entry.rawCount} Zellen sind abgewählt.`}
            </p>
          ) : null}

          {entry.members.length === 0 ? (
            <p data-testid="planning-string-members-empty" className="mt-2 text-sm text-slate-600">
              Noch keine Member angelegt.
            </p>
          ) : null}
          <ul data-testid="planning-string-members-list" className="mt-2 grid gap-2">
            {entry.members.map((member) => (
              <li
                key={member.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-3 py-2"
              >
                <span className="text-sm font-semibold text-slate-900">
                  {`Gruppe ${member.groupLabel}, Zeilen ${member.rowFrom}–${member.rowTo}, Spalten ${member.colFrom}–${member.colTo}`}
                </span>
                {canWrite ? (
                  <form action={removeDispatch} className="ml-auto">
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="memberId" value={member.id} />
                    <button
                      type="submit"
                      data-testid="planning-string-members-delete"
                      className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                    >
                      Entfernen
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          {removeState.status === "success"
          && removeState.stringId === entry.id.toLowerCase() ? (
            <FormFeedback state={removeState} clientError={null} />
          ) : null}
          {canWrite ? (
            <PlanningStringMemberForm
              workspaceId={workspaceId}
              projectId={projectId}
              stringId={entry.id}
              groups={groups}
            />
          ) : null}
        </section>
      ))}
      {removeError ? (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <FormFeedback state={removeError} clientError={null} />
        </div>
      ) : null}
    </div>
  );
}
