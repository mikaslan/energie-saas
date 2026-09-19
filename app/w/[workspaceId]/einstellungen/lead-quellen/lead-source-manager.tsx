"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import type { LeadSourceDto } from "@/lib/integrations/lead-sources/contract";
import type {
  LeadRoutingRuleDto,
  RoutableMember,
} from "@/modules/lead-sources";
import {
  archiveLeadSourceAction,
  archiveRoutingRuleAction,
  clearRoutingRuleAction,
  createLeadSourceAction,
  reactivateRoutingRuleAction,
  restoreLeadSourceAction,
  setRoutingRuleAction,
  updateLeadSourceAction,
  type LeadSourceActionState,
} from "./actions";

const initialState: LeadSourceActionState = { status: "idle" };

const inputClass =
  "mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30";

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
  // F1-23: Regeln je Quelle (Kampagnen-Regeln pflegt der Kampagnen-Block),
  // sortiert nach Priorität aufsteigend, dann Änderungsstand.
  const rulesBySource = new Map<string, LeadRoutingRuleDto[]>();
  for (const rule of rules) {
    if (!rule.leadSourceId) continue;
    const list = rulesBySource.get(rule.leadSourceId) ?? [];
    list.push(rule);
    rulesBySource.set(rule.leadSourceId, list);
  }
  for (const list of rulesBySource.values()) {
    list.sort((a, b) => a.priority - b.priority || (a.updatedAt < b.updatedAt ? -1 : 1));
  }

  const active = sources.filter((source) => source.archivedAt === null);
  const archived = sources.filter((source) => source.archivedAt !== null);

  return (
    <div className="space-y-6">
      <RoutingRuleFormSection
        workspaceId={workspaceId}
        sources={active}
        members={members}
        canWrite={canWrite}
      />
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
          <form action={createDispatch} data-testid="lead-source-create-form">
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
                className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
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
                          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                        >
                          Archivieren
                        </button>
                      </form>
                    </>
                  ) : null}
                </div>
                <SourceRoutingSection
                  workspaceId={workspaceId}
                  sourceId={source.id}
                  sourceName={source.name}
                  rules={rulesBySource.get(source.id) ?? []}
                  members={members}
                  canWrite={canWrite}
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
                      className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
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
        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
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
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-brand-600"
      />
      <select
        name="projectDomain"
        defaultValue={source.projectDomain ?? ""}
        aria-label="Bereich"
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-brand-600"
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
        className="rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-brand-600"
      />
      <button
        type="submit"
        className="rounded-md bg-brand-700 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600"
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

function describeAutoTriggers(rule: { autoOnManual: boolean; autoOnIntake: boolean }): string {
  const triggers = [
    rule.autoOnManual ? "manueller Erfassung" : null,
    rule.autoOnIntake ? "Intake" : null,
  ].filter((trigger): trigger is string => trigger !== null);
  return triggers.length > 0 ? triggers.join(" und ") : "keinem Auslöser";
}

function modeLabel(mode: string): string {
  return mode === "auto" ? "Auto" : "Vorschlag";
}

// F1-23: Modus/Priorität/Auslöser-Felder, geteilt von Neu- und Edit-Formular.
// Labels wie das zentrale Regelformular (T8-Tests-E2E-Vertrag). Das Hidden
// steht als Sibling NACH dem Label — get() liefert "true" nur bei
// gesetzter Box, getByLabel trifft eindeutig die Checkbox.
function RuleFields({
  modeDefault,
  priorityDefault,
  autoOnManualDefault,
  autoOnIntakeDefault,
}: {
  modeDefault: string;
  priorityDefault: number;
  autoOnManualDefault: boolean;
  autoOnIntakeDefault: boolean;
}) {
  return (
    <>
      <label className="grid gap-1 text-xs font-medium text-slate-700">
        Modus
        <select
          name="mode"
          defaultValue={modeDefault}
          aria-label="Modus"
          className="min-h-11 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-600"
        >
          <option value="suggest">Vorschlag</option>
          <option value="auto">Automatisch</option>
        </select>
      </label>
      <label className="grid gap-1 text-xs font-medium text-slate-700">
        Priorität
        <input
          type="number"
          name="priority"
          min={0}
          max={9999}
          defaultValue={priorityDefault}
          aria-label="Priorität"
          className="min-h-11 w-28 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-600"
        />
      </label>
      <label className="flex min-h-11 items-center gap-2 text-xs font-medium text-slate-700">
        <input
          type="checkbox"
          name="autoOnManual"
          value="true"
          defaultChecked={autoOnManualDefault}
          className="h-4 w-4 accent-brand-700"
        />
        Auto bei manueller Erfassung
      </label>
      <input type="hidden" name="autoOnManual" value="false" />
      <label className="flex min-h-11 items-center gap-2 text-xs font-medium text-slate-700">
        <input
          type="checkbox"
          name="autoOnIntake"
          value="true"
          defaultChecked={autoOnIntakeDefault}
          className="h-4 w-4 accent-brand-700"
        />
        Auto bei Intake
      </label>
      <input type="hidden" name="autoOnIntake" value="false" />
    </>
  );
}

function AssigneeOptions({ members }: { members: RoutableMember[] }) {
  return (
    <>
      <option value="">Bitte wählen</option>
      {members.map((member) => (
        <option key={member.membershipId} value={member.membershipId}>
          {member.label}
        </option>
      ))}
    </>
  );
}

// F1-23 (T8-UI + T8-Tests-E2E-Vertrag): zentrales Regelformular für
// Quellen-Regeln — Labels und Test-IDs sind E2E-gepinnt (Lead-Quelle,
// Betreuer, Modus, Priorität, Auto-Trigger, "Regel speichern").
function RoutingRuleFormSection({
  workspaceId,
  sources,
  members,
  canWrite,
}: {
  workspaceId: string;
  sources: LeadSourceDto[];
  members: RoutableMember[];
  canWrite: boolean;
}) {
  const [ruleState, ruleDispatch] = useActionState(setRoutingRuleAction, initialState);

  return (
    <section className="min-w-0 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-4">
        <h2 className="text-base font-semibold text-slate-950">Neue Routing-Regel</h2>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Regeln steuern Vorschläge und automatische Zuweisungen je
          Lead-Quelle — niedrigere Priorität feuert zuerst.
        </p>
      </div>

      {!canWrite ? (
        <p className="text-sm leading-6 text-slate-500">
          Du hast Lesezugriff. Zum Anlegen brauchst du Editor-Rechte.
        </p>
      ) : (
        <form action={ruleDispatch} data-testid="routing-rule-form">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="formVariant" value="rule-form" />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <label className="block">
              <span className="block text-sm font-semibold text-slate-800">Lead-Quelle</span>
              <select name="leadSourceId" required defaultValue="" className={inputClass}>
                <option value="">Bitte wählen</option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-sm font-semibold text-slate-800">Betreuer</span>
              <select name="assigneeMembershipId" required defaultValue="" className={inputClass}>
                <AssigneeOptions members={members} />
              </select>
            </label>
            <label className="block">
              <span className="block text-sm font-semibold text-slate-800">Modus</span>
              <select name="mode" defaultValue="suggest" className={inputClass}>
                <option value="suggest">Vorschlag</option>
                <option value="auto">Automatisch</option>
              </select>
            </label>
            <label className="block">
              <span className="block text-sm font-semibold text-slate-800">Priorität</span>
              <input
                type="number"
                name="priority"
                min={0}
                max={9999}
                defaultValue={0}
                className={inputClass}
              />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
            <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-800">
              <input
                type="checkbox"
                name="autoOnManual"
                value="true"
                defaultChecked
                className="h-4 w-4 accent-brand-700"
              />
              Auto bei manueller Erfassung
            </label>
            <input type="hidden" name="autoOnManual" value="false" />
            <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-800">
              <input
                type="checkbox"
                name="autoOnIntake"
                value="true"
                defaultChecked={false}
                className="h-4 w-4 accent-brand-700"
              />
              Auto bei Intake
            </label>
            <input type="hidden" name="autoOnIntake" value="false" />
          </div>

          <Feedback state={ruleState} />

          <div className="mt-5">
            <button
              type="submit"
              className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
            >
              Regel speichern
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

// F1-23 (T8-UI): Regelpflege je Quelle — mehrere Regeln mit Modus,
// Priorität und Auto-Auslösern. Leser sehen die Regeln, Schreiber pflegen
// sie (Suggest bleibt Ein-Klick im Zuweisungs-Panel). Eigener
// useActionState je Quelle, damit Feedback lokal bleibt.
function SourceRoutingSection({
  workspaceId,
  sourceId,
  sourceName,
  rules,
  members,
  canWrite,
}: {
  workspaceId: string;
  sourceId: string;
  sourceName: string;
  rules: LeadRoutingRuleDto[];
  members: RoutableMember[];
  canWrite: boolean;
}) {
  const [setState, setDispatch] = useActionState(setRoutingRuleAction, initialState);
  const [clearState, clearDispatch] = useActionState(clearRoutingRuleAction, initialState);
  const [archiveState, archiveDispatch] = useActionState(archiveRoutingRuleAction, initialState);
  const [reactivateState, reactivateDispatch] = useActionState(reactivateRoutingRuleAction, initialState);
  const [editingId, setEditingId] = useState<string | null>(null);

  if (!canWrite) {
    if (rules.length === 0) {
      return (
        <p className="text-xs leading-5 text-slate-500" data-testid={`routing-readonly-${sourceId}`}>
          Kein Standard-Betreuer hinterlegt.
        </p>
      );
    }
    return (
      <ul
        className="grid gap-1 text-xs leading-5 text-slate-500"
        data-testid={`routing-readonly-${sourceId}`}
        aria-label={`Routing-Regeln für ${sourceName}`}
      >
        {rules.map((rule) => (
          <li key={rule.id}>
            {`Standard-Betreuer: ${rule.assigneeLabel} · ${modeLabel(rule.mode)} · Priorität ${rule.priority}`}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div className="rounded-md bg-slate-50 px-3 py-2" data-testid={`routing-form-${sourceId}`}>
      {rules.length > 0 ? (
        <ul className="mb-2 divide-y divide-slate-200" aria-label={`Routing-Regeln für ${sourceName}`}>
          {rules.map((rule) => (
            <li key={rule.id} data-testid={`routing-rule-${rule.id}`} className="grid gap-2 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 text-xs text-slate-600">
                  {`Aktuell: ${rule.assigneeLabel} · ${modeLabel(rule.mode)} · Priorität ${rule.priority}`}
                  {rule.mode === "auto" ? ` · Auto bei ${describeAutoTriggers(rule)}` : ""}
                  {rule.archivedAt !== null ? " · Archiviert" : ""}
                </span>
                <button
                  type="button"
                  onClick={() => setEditingId(editingId === rule.id ? null : rule.id)}
                  aria-expanded={editingId === rule.id}
                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600"
                >
                  Bearbeiten
                </button>
                <form action={clearDispatch}>
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="ruleId" value={rule.id} />
                  <input type="hidden" name="leadSourceId" value={sourceId} />
                  <button
                    type="submit"
                    aria-label={`Standard-Betreuer für ${sourceName} entfernen`}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Standard-Betreuer entfernen
                  </button>
                </form>
                {rule.archivedAt === null ? (
                  <form action={archiveDispatch}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="ruleId" value={rule.id} />
                    <button
                      type="submit"
                      aria-label={`Routing-Regel für ${sourceName} archivieren`}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      Archivieren
                    </button>
                  </form>
                ) : (
                  <form action={reactivateDispatch}>
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="ruleId" value={rule.id} />
                    <button
                      type="submit"
                      aria-label={`Routing-Regel für ${sourceName} reaktivieren`}
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      Reaktivieren
                    </button>
                  </form>
                )}
              </div>
              {editingId === rule.id ? (
                <form action={setDispatch} className="flex flex-wrap items-end gap-2 rounded-md border border-slate-200 bg-white px-2 py-2">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="ruleId" value={rule.id} />
                  <input type="hidden" name="leadSourceId" value={sourceId} />
                  <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium text-slate-700">
                    Betreuer
                    <select
                      name="assigneeMembershipId"
                      defaultValue={rule.assigneeMembershipId}
                      required
                      aria-label={`Standard-Betreuer für ${sourceName} bearbeiten`}
                      className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-600"
                    >
                      <AssigneeOptions members={members} />
                    </select>
                  </label>
                  <RuleFields
                    modeDefault={rule.mode}
                    priorityDefault={rule.priority}
                    autoOnManualDefault={rule.autoOnManual}
                    autoOnIntakeDefault={rule.autoOnIntake}
                  />
                  <button
                    type="submit"
                    aria-label={`Routing-Regel für ${sourceName} speichern`}
                    className="min-h-11 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Speichern
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingId(null)}
                    className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Abbrechen
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <form action={setDispatch} className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="leadSourceId" value={sourceId} />
        <label className="grid min-w-0 flex-1 gap-1 text-xs font-medium text-slate-700">
          {`Standard-Betreuer für „${sourceName}“`}
          <select
            name="assigneeMembershipId"
            defaultValue=""
            required
            aria-label={`Standard-Betreuer für ${sourceName}`}
            className="min-h-11 min-w-0 rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm outline-none focus:border-brand-600"
          >
            <AssigneeOptions members={members} />
          </select>
        </label>
        <RuleFields
          modeDefault="suggest"
          priorityDefault={0}
          autoOnManualDefault
          autoOnIntakeDefault={false}
        />
        <button
          type="submit"
          aria-label={`Standard-Betreuer für ${sourceName} speichern`}
          className="min-h-11 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          Speichern
        </button>
      </form>
      <Feedback state={setState} />
      <Feedback state={clearState} />
      <Feedback state={archiveState} />
      <Feedback state={reactivateState} />
    </div>
  );
}
