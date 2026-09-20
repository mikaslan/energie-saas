// F3-05b String-Equipment: Projekt-Sektion (Client). UI-Vertrag aus der
// E2E-Spec tests/e2e/f3-05b-equipment.spec.ts — Testids exakt einhalten.
// Optimierer-Anlage (scope String/Panel) und Mikro-Anlage je Panel-Ref in
// einer Sektion; Advisory bei Mikro-Teilabdeckung inline (Warnung, nie
// Reject). Viewer read-only (Muster: planning-string-section.tsx).
"use client";

import { useActionState, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { PlanningStringEquipmentAdvisory } from "@/lib/integrations/planning/contracts/string-equipment";
import {
  removePlanningStringEquipmentAction,
  savePlanningStringEquipmentAction,
  type PlanningStringEquipmentActionState,
} from "./planning-string-equipment-actions";
import {
  planningStringEquipmentLabel,
  type PlanningStringEquipmentListItem,
  type PlanningStringEquipmentStringOption,
} from "./planning-string-equipment-model";

const initialEquipmentAction: PlanningStringEquipmentActionState = { status: "idle" };

const EQUIPMENT_STRING_MESSAGE = "Bitte einen String wählen.";
const EQUIPMENT_PANEL_MESSAGE = "Bitte Gruppe, Zeile und Spalte für das Panel angeben.";
const EQUIPMENT_RANGE_MESSAGE = "Zeile und Spalte müssen ganze Zahlen ab 1 sein.";

function parseInteger(raw: string): number {
  if (raw.trim() === "") return Number.NaN;
  return Number.parseInt(raw.trim(), 10);
}

function actionFallbackMessage(state: PlanningStringEquipmentActionState): string | null {
  if (state.status === "not_found") return "Der Eintrag wurde nicht gefunden.";
  if (state.status === "denied") return "Dir fehlt die Berechtigung für diese Aktion.";
  if (state.status === "unauthenticated") return "Deine Sitzung ist abgelaufen.";
  return null;
}

function FormFeedback({
  state,
  clientError,
}: {
  state: PlanningStringEquipmentActionState;
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

export function PlanningStringEquipmentSection({
  workspaceId,
  projectId,
  strings,
  equipment,
  advisories,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  strings: PlanningStringEquipmentStringOption[];
  equipment: PlanningStringEquipmentListItem[];
  advisories: PlanningStringEquipmentAdvisory[];
  canWrite: boolean;
}) {
  const router = useRouter();
  const [saveState, saveDispatch] = useActionState(
    savePlanningStringEquipmentAction,
    initialEquipmentAction,
  );
  const [removeState, removeDispatch] = useActionState(
    removePlanningStringEquipmentAction,
    initialEquipmentAction,
  );
  const [equipmentError, setEquipmentError] = useState<string | null>(null);
  const [selectedStringId, setSelectedStringId] = useState<string>(strings[0]?.id ?? "");
  const [selectedScope, setSelectedScope] = useState<string>("string");

  useEffect(() => {
    if (saveState.status === "success" || removeState.status === "success") {
      router.refresh();
    }
  }, [saveState, removeState, router]);

  function handleEquipmentSubmit(event: FormEvent<HTMLFormElement>): void {
    const form = new FormData(event.currentTarget);
    const stringId = form.get("stringId");
    if (typeof stringId !== "string" || stringId === "") {
      event.preventDefault();
      setEquipmentError(EQUIPMENT_STRING_MESSAGE);
      return;
    }
    if (form.get("scope") === "panel") {
      const groupId = form.get("groupId");
      if (typeof groupId !== "string" || groupId === "") {
        event.preventDefault();
        setEquipmentError(EQUIPMENT_PANEL_MESSAGE);
        return;
      }
      const row = form.get("row");
      const col = form.get("col");
      const parsedRow = typeof row === "string" ? parseInteger(row) : Number.NaN;
      const parsedCol = typeof col === "string" ? parseInteger(col) : Number.NaN;
      if (
        !Number.isInteger(parsedRow)
        || parsedRow < 1
        || !Number.isInteger(parsedCol)
        || parsedCol < 1
      ) {
        event.preventDefault();
        setEquipmentError(EQUIPMENT_RANGE_MESSAGE);
        return;
      }
    }
    setEquipmentError(null);
  }

  // Gruppen-Optionen = Member-Gruppen des gewaehlten Strings (E2E-Vertrag).
  const selectedGroups =
    strings.find((entry) => entry.id === selectedStringId)?.memberGroups ?? [];

  return (
    <section
      data-testid="planning-string-equipment-section"
      aria-label="String-Equipment"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-900">String-Equipment</h2>
      <p className="mt-1 text-sm text-slate-600">
        Stufe-0 ohne Auto-Fill — Optimierer je String oder Panel, Mikro-Wechselrichter je Panel,
        Hinweise sind Warnungen.
      </p>

      {equipment.length === 0 ? (
        <p data-testid="planning-string-equipment-empty" className="mt-2 text-sm text-slate-600">
          Noch kein Equipment angelegt.
        </p>
      ) : null}
      <ul data-testid="planning-string-equipment-list" className="mt-2 grid gap-2">
        {equipment.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-3 py-2"
          >
            <span className="text-sm font-semibold text-slate-900">
              {planningStringEquipmentLabel(entry.equipment)}
            </span>
            <span className="text-sm text-slate-600">{entry.stringLabel}</span>
            {entry.scope === "panel" && entry.groupLabel ? (
              <span className="text-sm text-slate-500">
                {`Gruppe ${entry.groupLabel}, Zeile ${entry.row}, Spalte ${entry.col}`}
              </span>
            ) : null}
            {canWrite ? (
              <form action={removeDispatch} className="ml-auto">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="equipmentId" value={entry.id} />
                <button
                  type="submit"
                  data-testid="planning-string-equipment-delete"
                  className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                >
                  Entfernen
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {advisories.map((advisory, index) => (
        <p
          key={`${advisory.code}-${index}`}
          data-testid="planning-string-equipment-advisory"
          className="mt-2 text-sm font-semibold text-amber-700"
        >
          {advisory.message}
        </p>
      ))}
      {removeState.status !== "idle" ? (
        <FormFeedback state={removeState} clientError={null} />
      ) : null}
      {canWrite ? (
        <form
          data-testid="planning-string-equipment-form"
          action={saveDispatch}
          onSubmit={handleEquipmentSubmit}
          className="mt-3 border-t border-slate-100 pt-3"
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-sm text-slate-600">
              String
              <select
                name="stringId"
                data-testid="planning-string-equipment-string"
                defaultValue={strings[0]?.id ?? ""}
                onChange={(event) => {
                  setSelectedStringId(event.currentTarget.value);
                  setEquipmentError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              >
                <option value="">Bitte wählen</option>
                {strings.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm text-slate-600">
              Geltungsbereich
              <select
                name="scope"
                data-testid="planning-string-equipment-scope"
                defaultValue="string"
                onChange={(event) => {
                  setSelectedScope(event.currentTarget.value);
                  setEquipmentError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              >
                <option value="string">Ganzer String</option>
                <option value="panel">Einzelnes Panel</option>
              </select>
            </label>
            <label className="block text-sm text-slate-600">
              Equipment
              <select
                name="equipment"
                data-testid="planning-string-equipment-equipment"
                defaultValue="optimizer"
                onChange={() => setEquipmentError(null)}
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              >
                <option value="optimizer">Optimierer</option>
                <option value="micro_inverter">Mikro-WR</option>
              </select>
            </label>
            {selectedScope === "panel" ? (
              <>
                <label className="block text-sm text-slate-600">
                  Panel-Gruppe
                  <select
                    name="groupId"
                    data-testid="planning-string-equipment-group"
                    defaultValue=""
                    onChange={() => setEquipmentError(null)}
                    className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
                  >
                    <option value="">Bitte wählen</option>
                    {selectedGroups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {group.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm text-slate-600">
                  Zeile
                  <input
                    type="text"
                    name="row"
                    data-testid="planning-string-equipment-row"
                    inputMode="numeric"
                    autoComplete="off"
                    onChange={() => setEquipmentError(null)}
                    className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
                  />
                </label>
                <label className="block text-sm text-slate-600">
                  Spalte
                  <input
                    type="text"
                    name="col"
                    data-testid="planning-string-equipment-col"
                    inputMode="numeric"
                    autoComplete="off"
                    onChange={() => setEquipmentError(null)}
                    className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
                  />
                </label>
              </>
            ) : null}
          </div>
          <button
            type="submit"
            data-testid="planning-string-equipment-create"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Equipment speichern
          </button>
          <FormFeedback state={saveState} clientError={equipmentError} />
        </form>
      ) : null}
    </section>
  );
}
