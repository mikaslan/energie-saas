"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { LeadSourceDto } from "@/lib/integrations/lead-sources/contract";
import type {
  LeadRoutingRuleDto,
  RoutableMember,
} from "@/modules/lead-sources";
import {
  archiveLeadSourceAction,
  clearRoutingRuleAction,
  createLeadSourceAction,
  restoreLeadSourceAction,
  setRoutingRuleAction,
  updateLeadSourceAction,
  type LeadSourceActionState,
} from "./actions";

const initialState: LeadSourceActionState = { status: "idle" };

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30";

function message(state: LeadSourceActionState): { text: string; isError: boolean } | null {
  switch (state.status) {
    case "success": return { text: state.message, isError: false };
    case "invalid": return {
      text: state.message ?? "Die Eingabe ist ungültig.",
      isError: true,
    };
    case "conflict": return {
      text: "Eine aktive Lead-Quelle mit diesem Namen existiert bereits.",
      isError: true,
    };
    case "not_found": return { text: "Die Lead-Quelle wurde nicht gefunden.", isError: true };
    case "denied": return { text: "Dir fehlt die Berechtigung für diese Aktion.", isError: true };
    case "unauthenticated": return { text: "Deine Sitzung ist abgelaufen.", isError: true };
    default: return null;
  }
}

function Feedback({ state }: { state: LeadSourceActionState }) {
  // Kimi-P3-4: jedes Feedback führt sein eigenes Ref — ein geteiltes Ref
  // würde an die zuletzt gemountete Instanz gebunden.
  const feedbackRef = useRef<HTMLParagraphElement | null>(null);
  const feedback = message(state);
  useEffect(() => {
    if (feedback?.isError) feedbackRef.current?.focus();
  }, [feedback?.isError, state]);
  return (
    <p
      ref={feedbackRef}
      tabIndex={-1}
      role={feedback?.isError ? "alert" : "status"}
      aria-live="polite"
      className={`mt-4 text-sm font-semibold ${
        feedback === null ? "hidden" : feedback.isError ? "text-red-700" : "text-green-700"
      }`}
    >
      {feedback?.text}
    </p>
  );
}

export function LeadSourceManager({
  workspaceId,
  sources,
  canWrite,
  rules,
  members,
}: {
  workspaceId: string;
  sources: LeadSourceDto[];
  canWrite: boolean;
  rules: LeadRoutingRuleDto[];
  members: RoutableMember[];
}) {
  const [createState, createDispatch] = useActionState(createLeadSourceAction, initialState);
  const [updateState, updateDispatch] = useActionState(updateLeadSourceAction, initialState);
  const [archiveState, archiveDispatch] = useActionState(archiveLeadSourceAction, initialState);
  const [restoreState, restoreDispatch] = useActionState(restoreLeadSourceAction, initialState);
  const [routingState, routingDispatch] = useActionState(setRoutingRuleAction, initialState);
  const [routingClearState, routingClearDispatch] = useActionState(clearRoutingRuleAction, initialState);
  const ruleBySource = new Map(rules.map((rule) => [rule.leadSourceId, rule]));

  const active = sources.filter((source) => source.archivedAt === null);
  const archived = sources.filter((source) => source.archivedAt !== null);

  return (
    <div className="space-y-6">
      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <div className="mb-4">
          <h2 className="text-base font-semibold text-slate-950">Neue Lead-Quelle</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Quellen wie „wmee-rechner-v5&quot; werden automatisch zugeordnet,
            wenn Leads mit diesem Herkunftsnamen eingehen.
          </p>
        </div>

        {!canWrite ? (
          <p className="text-sm leading-6 text-slate-500">
            Du hast Lesezugriff. Zum Anlegen brauchst du Editor-Rechte.
          </p>
        ) : (
          <form action={createDispatch}>
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Name</span>
                <input type="text" name="name" required maxLength={120} className={inputClass} />
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Bereich</span>
                <select name="projectDomain" className={inputClass} defaultValue="">
                  <option value="">Ohne Zuordnung</option>
                  <option value="residential">Wohnbau</option>
                  <option value="commercial">Gewerbe</option>
                </select>
              </label>
              <label className="block">
                <span className="block text-sm font-semibold text-slate-800">Farbe</span>
                <input
                  type="text"
                  name="color"
                  placeholder="#3B82F6"
                  maxLength={7}
                  className={inputClass}
                />
              </label>
            </div>

            <Feedback state={createState} />

            <div className="mt-5">
              <button
                type="submit"
                className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Anlegen
              </button>
            </div>
          </form>
        )}
      </section>

      <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
        <h2 className="text-base font-semibold text-slate-950">Aktive Quellen</h2>
        {active.length === 0 ? (
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Noch keine aktiven Lead-Quellen angelegt.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-100">
            {active.map((source) => (
              <li key={source.id} className="grid gap-2 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span
                    aria-hidden
                    className="inline-block h-3 w-3 rounded-full ring-1 ring-black/10"
                    style={{ backgroundColor: source.color ?? "#94A3B8" }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold text-slate-900">{source.name}</span>
                    <span className="block text-xs text-slate-500">
                      {source.projectDomain === "residential" ? "Wohnbau" : source.projectDomain === "commercial" ? "Gewerbe" : "Ohne Zuordnung"}
                    </span>
                  </span>
                  {canWrite ? (
                    <>
                      <EditForm
                        key={`edit-${source.id}`}
                        workspaceId={workspaceId}
                        source={source}
                        state={updateState}
                        dispatch={updateDispatch}
                      />
                      <form action={archiveDispatch}>
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="id" value={source.id} />
                        <button
                          type="submit"
                          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
                        >
                          Archivieren
                        </button>
                      </form>
                    </>
                  ) : null}
                </div>
                <RoutingForm
                  workspaceId={workspaceId}
                  sourceId={source.id}
                  sourceName={source.name}
                  rule={ruleBySource.get(source.id) ?? null}
                  members={members}
                  canWrite={canWrite}
                  setState={routingState}
                  setDispatch={routingDispatch}
                  clearState={routingClearState}
                  clearDispatch={routingClearDispatch}
                />
              </li>
            ))}
          </ul>
        )}
        <Feedback state={archiveState} />
      </section>

      {archived.length > 0 || restoreState.status !== "idle" ? (
        <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
          <h2 className="text-base font-semibold text-slate-950">Archivierte Quellen</h2>
          {archived.length === 0 ? (
            <p className="mt-2 text-sm leading-6 text-slate-500">
              Keine archivierten Quellen.
            </p>
          ) : null}
          <ul className="mt-3 divide-y divide-slate-100">
            {archived.map((source) => (
              <li key={source.id} className="flex flex-wrap items-center gap-3 py-3">
                <span className="min-w-0 flex-1 text-sm text-slate-500">{source.name}</span>
                {canWrite ? (
                  <form action={restoreDispatch}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="id" value={source.id} />
                    <button
                      type="submit"
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
                    >
                      Reaktivieren
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          <Feedback state={restoreState} />
        </section>
      ) : null}
    </div>
  );
}

function EditForm({
  workspaceId,
  source,
  state,
  dispatch,
}: {
  workspaceId: string;
  source: LeadSourceDto;
  state: LeadSourceActionState;
  dispatch: (formData: FormData) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  void state;
  if (!isOpen) {
    return (
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        Bearbeiten
      </button>
    );
  }
  return (
    <form action={dispatch} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="id" value={source.id} />
      <input
        type="text"
        name="name"
        required
        maxLength={120}
        defaultValue={source.name}
        aria-label="Name"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
      />
      <select
        name="projectDomain"
        defaultValue={source.projectDomain ?? ""}
        aria-label="Bereich"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
      >
        <option value="">Ohne Zuordnung</option>
        <option value="residential">Wohnbau</option>
        <option value="commercial">Gewerbe</option>
      </select>
      <input
        type="text"
        name="color"
        maxLength={7}
        placeholder="#3B82F6"
        defaultValue={source.color ?? ""}
        aria-label="Farbe"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-600"
      />
      <button
        type="submit"
        className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600"
      >
        Speichern
      </button>
      <button
        type="button"
        onClick={() => setIsOpen(false)}
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50"
      >
        Abbrechen
      </button>
      <div className="w-full">
        <Feedback state={state} />
      </div>
    </form>
  );
}

// F1-10 Lead-Routing: Standard-Betreuer je Quelle. Leser sehen die Regel,
// Schreiber pflegen sie über das Mitglieder-Dropdown.
function RoutingForm({
  workspaceId,
  sourceId,
  sourceName,
  rule,
  members,
  canWrite,
  setState,
  setDispatch,
  clearState,
  clearDispatch,
}: {
  workspaceId: string;
  sourceId: string;
  sourceName: string;
  rule: LeadRoutingRuleDto | null;
  members: RoutableMember[];
  canWrite: boolean;
  setState: LeadSourceActionState;
  setDispatch: (formData: FormData) => void;
  clearState: LeadSourceActionState;
  clearDispatch: (formData: FormData) => void;
}) {
  if (!canWrite) {
    return (
      <p className="text-xs leading-5 text-slate-500" data-testid={`routing-readonly-${sourceId}`}>
        {rule
          ? `Standard-Betreuer: ${rule.assigneeLabel}`
          : "Kein Standard-Betreuer hinterlegt."}
      </p>
    );
  }
  return (
    <div className="rounded-md bg-slate-50 px-3 py-2" data-testid={`routing-form-${sourceId}`}>
      <form action={setDispatch} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="leadSourceId" value={sourceId} />
        <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium text-slate-700">
          {`Standard-Betreuer für „${sourceName}“`}
          <select
            name="assigneeMembershipId"
            defaultValue={rule?.assigneeMembershipId ?? ""}
            required
            aria-label={`Standard-Betreuer für ${sourceName}`}
            className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-blue-600"
          >
            <option value="">Bitte wählen</option>
            {members.map((member) => (
              <option key={member.membershipId} value={member.membershipId}>
                {member.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          aria-label={`Standard-Betreuer für ${sourceName} speichern`}
          className="min-h-11 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-blue-600"
        >
          Speichern
        </button>
        {rule ? (
          <span className="text-xs text-slate-600">
            {`Aktuell: ${rule.assigneeLabel}`}
          </span>
        ) : null}
      </form>
      {rule ? (
        <form action={clearDispatch} className="mt-2">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="leadSourceId" value={sourceId} />
          <button
            type="submit"
            aria-label={`Standard-Betreuer für ${sourceName} entfernen`}
            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            Standard-Betreuer entfernen
          </button>
        </form>
      ) : null}
      <Feedback state={setState} />
      <Feedback state={clearState} />
    </div>
  );
}
