"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { PROJECT_TASK_MAX_ASSIGNEES, PROJECT_TASK_MEMBER_SEARCH_LIMIT } from "@/lib/integrations/tasks/contract";
import type { TaskTemplateDto } from "@/lib/integrations/tasks/template-contract";
import {
  archiveTaskTemplateAction,
  createTaskTemplateAction,
  searchTaskTemplateMembersAction,
  type TaskTemplateActionState,
  type TaskTemplateMemberSearchState,
  restoreTaskTemplateAction,
  updateTaskTemplateAction,
} from "./actions";

const initialState: TaskTemplateActionState = { status: "idle" };
const initialSearchState: TaskTemplateMemberSearchState = { status: "idle" };

function Feedback({ state }: { state: TaskTemplateActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return <p role="status" className="mt-2 text-sm font-medium text-green-700">{state.message}</p>;
  }
  const message =
    state.status === "conflict"
      ? "Eine aktive Vorlage mit diesem Namen existiert bereits."
      : state.status === "denied"
        ? "Dafür fehlt dir die Aufgaben-Freigabe."
        : state.status === "not_found"
          ? "Vorlage nicht gefunden."
          : state.status === "unauthenticated"
            ? "Bitte erneut anmelden."
            : "Eingaben prüfen (Name, Titel, Offset 0–3650 oder leer).";
  return <p role="alert" className="mt-2 text-sm font-medium text-red-700">{message}</p>;
}

function formatOffset(template: TaskTemplateDto): string {
  if (template.dueOffsetDays === null) return "ohne Fälligkeit";
  if (template.dueOffsetDays === 0) return "fällig heute";
  if (template.dueOffsetDays === 1) return "fällig morgen";
  return `fällig in ${template.dueOffsetDays} Tagen`;
}

// F16-04b: Bearbeiter-Auswahl je Formular (Suche + Toggle, Auswahl als
// Hidden-JSON; Initial aus Vorlage, Remount-Key des Formulars gilt).
// F16-04c: Ausgeschiedene sichtbar (Zähler ohne Label, kein PII-Lookup)
// plus Hidden-JSON zum Werterhalt — Speichern purgt sie nicht mehr still.
function AssigneePicker({
  workspaceId,
  initial,
  departedIds,
}: {
  workspaceId: string;
  initial: { membershipId: string; label: string }[];
  departedIds: string[];
}) {
  const [selected, setSelected] = useState(initial);
  const [searchState, searchAction] = useActionState(
    searchTaskTemplateMembersAction.bind(null, workspaceId),
    initialSearchState,
  );
  const [, startSearchTransition] = useTransition();
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const toggle = (member: { membershipId: string; label: string }) => {
    setSelected((current) =>
      current.some((entry) => entry.membershipId === member.membershipId)
        ? current.filter((entry) => entry.membershipId !== member.membershipId)
        : current.length < PROJECT_TASK_MAX_ASSIGNEES
          ? [...current, member]
          : current,
    );
  };
  const runSearch = () => {
    const formData = new FormData();
    formData.set("query", searchInputRef.current?.value ?? "");
    startSearchTransition(() => searchAction(formData));
  };
  return (
    <div className="grid gap-2">
      <input
        type="hidden"
        name="assigneeMembershipIds"
        value={JSON.stringify(selected.map((entry) => entry.membershipId))}
      />
      <input
        type="hidden"
        name="departedAssigneeMembershipIds"
        value={JSON.stringify(departedIds)}
      />
      <span className="text-sm font-semibold text-slate-800">Bearbeiter (leer = Anwendender)</span>
      {departedIds.length > 0 ? (
        <p className="text-sm text-slate-600" data-testid="template-departed-notice">
          {departedIds.length === 1
            ? "1 ausgeschiedener Bearbeiter"
            : `${departedIds.length} ausgeschiedene Bearbeiter`} —{" "}
          beim Anwenden übersprungen, bleiben gespeichert.
        </p>
      ) : null}
      {selected.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {selected.map((entry) => (
            <li
              key={entry.membershipId}
              className="flex items-center gap-1 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-800"
            >
              {entry.label}
              <button
                type="button"
                aria-label={`${entry.label} entfernen`}
                onClick={() => toggle(entry)}
                className="rounded-full px-1 text-slate-500 outline-none hover:text-slate-900 focus-visible:ring-2 focus-visible:ring-brand-600"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div role="search" aria-label="Bearbeiter suchen" className="flex flex-wrap items-center gap-2">
        <input
          ref={searchInputRef}
          type="search"
          aria-label="Mitglieder suchen"
          placeholder="Mind. 2 Zeichen"
          minLength={2}
          maxLength={80}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              runSearch();
            }
          }}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
        />
        <button
          type="button"
          onClick={runSearch}
          className="min-h-11 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          Suchen
        </button>
      </div>
      <p className="text-xs leading-5 text-slate-600">
        Bis zu {PROJECT_TASK_MAX_ASSIGNEES} interne Personen. Die Suche zeigt höchstens {PROJECT_TASK_MEMBER_SEARCH_LIMIT} Treffer.
      </p>
      {searchState.status === "results" ? (
        <ul className="grid gap-1">
          {searchState.members.map((member) => {
            const active = selected.some((entry) => entry.membershipId === member.membershipId);
            return (
              <li key={member.membershipId}>
                <label className="flex min-h-11 w-fit cursor-pointer items-center gap-2 px-1 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={active}
                    onChange={() => toggle(member)}
                    className="h-5 w-5 rounded border-slate-300 text-brand-800 focus:ring-2 focus:ring-brand-600"
                  />
                  {member.label}
                </label>
              </li>
            );
          })}
        </ul>
      ) : null}
      {searchState.status === "empty" ? (
        <p className="text-sm text-slate-500">Keine Mitglieder für „{searchState.query}“ gefunden.</p>
      ) : null}
      {searchState.status === "invalid" ? (
        <p className="text-sm font-medium text-red-700">Suche prüfen (mind. 2 Zeichen).</p>
      ) : null}
    </div>
  );
}

// F16-04: Create-/Edit-Formular (Name, Titel-Preset, Offset; leer =
// ohne Fälligkeit). Remount bei Erfolg/Datensatzwechsel (stale-DOM,
// Muster Rabatt-Vorlagen).
function TemplateForm({
  workspaceId,
  template,
  action,
  submitLabel,
}: {
  workspaceId: string;
  template?: TaskTemplateDto;
  action: (
    previous: TaskTemplateActionState,
    formData: FormData,
  ) => Promise<TaskTemplateActionState>;
  submitLabel: string;
}) {
  const [state, dispatch] = useActionState(action, initialState);
  const [successCount, setSuccessCount] = useState(0);
  const [prevStatus, setPrevStatus] = useState(state.status);
  if (prevStatus !== state.status) {
    setPrevStatus(state.status);
    if (state.status === "success") setSuccessCount((count) => count + 1);
  }
  const formKey = template
    ? `${template.id}:${template.updatedAt}:${successCount}`
    : `new:${successCount}`;
  return (
    <form action={dispatch} key={formKey} className="grid gap-3">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      {template ? <input type="hidden" name="id" value={template.id} /> : null}
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Name
        <input
          type="text"
          name="name"
          defaultValue={template?.name ?? ""}
          required
          maxLength={200}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
        />
      </label>
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Aufgaben-Titel
        <input
          type="text"
          name="title"
          defaultValue={template?.title ?? ""}
          required
          maxLength={200}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-sm font-semibold text-slate-800">
          Fällig in Tagen (leer = ohne)
          <input
            type="text"
            name="dueOffsetDays"
            inputMode="numeric"
            defaultValue={template?.dueOffsetDays === null || template?.dueOffsetDays === undefined ? "" : String(template.dueOffsetDays)}
            placeholder="z. B. 14"
            className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
          />
        </label>
        <label className="grid gap-1 text-sm font-semibold text-slate-800">
          Reihenfolge
          <input
            type="text"
            name="position"
            inputMode="numeric"
            defaultValue={template ? String(template.position) : "0"}
            required
            className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
          />
        </label>
      </div>
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Checkliste (eine Zeile je Punkt, leer = ohne)
        <textarea
          name="checklistText"
          rows={3}
          maxLength={50_500}
          defaultValue={(template?.checklistItems ?? []).map((item) => item.text).join("\n")}
          placeholder={"z. B.\nWechselrichter prüfen\nZählerstand notieren"}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
        />
      </label>
      <label className="grid gap-1 text-sm font-semibold text-slate-800">
        Labels (eine Zeile je Label, Farbe mit | trennen, leer = ohne)
        <textarea
          name="labelText"
          rows={2}
          maxLength={1_000}
          defaultValue={(template?.labelItems ?? []).map((item) => item.color === "slate" ? item.name : `${item.name} | ${item.color}`).join("\n")}
          placeholder={"z. B.\nDringend | rose\nFörderung | emerald"}
          className="min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-normal text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
        />
      </label>
      <div>
        <AssigneePicker
          workspaceId={workspaceId}
          initial={template?.assignees ?? []}
          departedIds={template?.departedAssigneeMembershipIds ?? []}
        />
        <button
          type="submit"
          className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600"
        >
          {submitLabel}
        </button>
        <Feedback state={state} />
      </div>
    </form>
  );
}

export function TaskTemplateManager({
  workspaceId,
  templates,
  canWrite,
}: {
  workspaceId: string;
  templates: TaskTemplateDto[];
  canWrite: boolean;
}) {
  const [archiveState, archiveDispatch] = useActionState(archiveTaskTemplateAction, initialState);
  const [restoreState, restoreDispatch] = useActionState(restoreTaskTemplateAction, initialState);
  return (
    <div className="grid gap-8">
      {canWrite ? (
        <section aria-label="Neue Vorlage" className="rounded-xl border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-semibold text-slate-950">Neue Vorlage</h2>
          <div className="mt-3">
            <TemplateForm
              workspaceId={workspaceId}
              action={createTaskTemplateAction}
              submitLabel="Anlegen"
            />
          </div>
        </section>
      ) : null}
      <section aria-label="Vorlagen" className="grid gap-4">
        {templates.length === 0 ? (
          <p className="text-sm text-slate-600">Noch keine Vorlagen vorhanden.</p>
        ) : null}
        {templates.map((template) => (
          <article key={template.id} className="rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-semibold text-slate-950">{template.name}</h3>
              <span className="text-xs text-slate-500">
                {template.active ? "aktiv" : "archiviert"} · {formatOffset(template)}
              </span>
            </div>
            <p className="mt-1 text-sm text-slate-700">{template.title}</p>
            {template.checklistItems.length > 0 ? (
              <p className="mt-1 text-sm text-slate-500">
                {template.checklistItems.length === 1
                  ? "1 Checklistenpunkt"
                  : `${template.checklistItems.length} Checklistenpunkte`}
              </p>
            ) : null}
            {template.labelItems.length > 0 ? (
              <p className="mt-1 text-sm text-slate-500">
                {template.labelItems.length === 1
                  ? "1 Label"
                  : `${template.labelItems.length} Labels`}
              </p>
            ) : null}
            {canWrite ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-sm font-semibold text-brand-800 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-brand-600">
                  Bearbeiten
                </summary>
                <div className="mt-3">
                  <TemplateForm
                    workspaceId={workspaceId}
                    template={template}
                    action={updateTaskTemplateAction}
                    submitLabel="Speichern"
                  />
                </div>
              </details>
            ) : null}
            {canWrite ? (
              template.active ? (
                <form action={archiveDispatch} className="mt-3">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="id" value={template.id} />
                  <button
                    type="submit"
                    aria-label={`${template.name} archivieren`}
                    className="min-h-11 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Archivieren
                  </button>
                </form>
              ) : (
                <form action={restoreDispatch} className="mt-3">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="id" value={template.id} />
                  <button
                    type="submit"
                    aria-label={`${template.name} reaktivieren`}
                    className="min-h-11 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                  >
                    Reaktivieren
                  </button>
                </form>
              )
            ) : null}
          </article>
        ))}
      </section>
      {archiveState.status !== "idle" ? <Feedback state={archiveState} /> : null}
      {restoreState.status !== "idle" ? <Feedback state={restoreState} /> : null}
    </div>
  );
}
