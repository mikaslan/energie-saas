// F3-04a Panel-Gruppen: Projekt-Sektion (Client). UI-Vertrag aus dem
// F304a-Auftrag — Testids exakt einhalten (E2E-Partner nutzt dieselben).
// Client-Validierung lokal (Contract-Ranges aus
// @/lib/integrations/planning/contracts/panel-group): Raster-Form ohne
// Server-Reject, Gruppen-Rechteck-in-Polygon serverseitig (Action).
// Viewer read-only (Muster: planning-roof-restriction-section.tsx).
// F3-04c: Kollisions-Warnbadge je betroffener Zeile (advisory-only) +
// Deselect-Hinweis; Quick blendet die Sektion aus (F3-01-Regel).
"use client";

import { useActionState, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  removePlanningPanelGroupAction,
  savePlanningPanelGroupAction,
  type PlanningPanelGroupActionState,
} from "./planning-panel-group-actions";
import {
  PLANNING_PANEL_GROUP_KIND_LABELS,
  type PlanningPanelGroupCollision,
  type PlanningPanelGroupDto,
} from "./planning-panel-group-model";

// F3-04c: Badge-Text enthaelt „ueberlappt" + Gegenueber-Labels
// (E2E-Vertrag tests/e2e/f3-04c-collision.spec.ts).
function collisionBadgeText(collisions: PlanningPanelGroupCollision[]): string {
  const labels = collisions.map((collision) => collision.label).join(", ");
  const noun = collisions.length === 1 ? "Sperrzone" : "Sperrzonen";
  return `Überlappt ${noun} ${labels} — Zellen abwählen`;
}

// F3-04c: Hinweis nach Abwahlen — Text enthaelt „abgewaehlt", Badge
// bleibt daneben sichtbar (Rechteck-Ebene, kein Reject).
function collisionHintText(deselectedCount: number): string {
  return deselectedCount === 1
    ? "1 Zelle abgewählt — Warnung bleibt auf Rechteck-Ebene bestehen."
    : `${deselectedCount} Zellen abgewählt — Warnung bleibt auf Rechteck-Ebene bestehen.`;
}

const initialAction: PlanningPanelGroupActionState = { status: "idle" };
const GRID_MESSAGE = "Zeilen/Spalten müssen ganze Zahlen von 1–200 sein.";
const ORIGIN_MESSAGE = "Der Ursprung ist ungültig (endliche Zahlen erwartet).";
const MODULE_MESSAGE = "Die Modulmaße müssen zwischen 0,1–5 m liegen.";
const GAP_MESSAGE = "Die Lücke muss zwischen 0–2 m liegen.";
const TILT_MESSAGE = "Die Neigung muss zwischen 0–90° liegen (oder leer).";

function parseDecimal(raw: string): number {
  if (raw.trim() === "") return Number.NaN;
  return Number.parseFloat(raw.replace(",", "."));
}

function parseInteger(raw: string): number {
  if (raw.trim() === "") return Number.NaN;
  return Number.parseInt(raw.trim(), 10);
}

function Feedback({ state }: { state: PlanningPanelGroupActionState }) {
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
  const message =
    state.status === "not_found"
      ? "Die Panel-Gruppe wurde nicht gefunden."
      : state.status === "denied"
        ? "Dir fehlt die Berechtigung für diese Aktion."
        : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

export function PlanningPanelGroupSection({
  workspaceId,
  projectId,
  roofId,
  initialGroups,
  canWrite,
  planningMode,
}: {
  workspaceId: string;
  projectId: string;
  roofId: string | null;
  initialGroups: PlanningPanelGroupDto[];
  canWrite: boolean;
  planningMode?: "quick" | "2d" | "3d";
}) {
  const router = useRouter();
  const [saveState, saveDispatch] = useActionState(savePlanningPanelGroupAction, initialAction);
  const [removeState, removeDispatch] = useActionState(
    removePlanningPanelGroupAction,
    initialAction,
  );
  const [originX, setOriginX] = useState("");
  const [originY, setOriginY] = useState("");
  const [rows, setRows] = useState("");
  const [cols, setCols] = useState("");
  const [moduleWM, setModuleWM] = useState("");
  const [moduleHM, setModuleHM] = useState("");
  const [gapM, setGapM] = useState("");
  const [tiltDeg, setTiltDeg] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);

  useEffect(() => {
    if (saveState.status === "success" || removeState.status === "success") {
      router.refresh();
    }
  }, [saveState, removeState, router]);

  if (planningMode === "quick") return null;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    const parsedRows = parseInteger(rows);
    const parsedCols = parseInteger(cols);
    if (
      !Number.isInteger(parsedRows)
      || parsedRows < 1
      || parsedRows > 200
      || !Number.isInteger(parsedCols)
      || parsedCols < 1
      || parsedCols > 200
    ) {
      event.preventDefault();
      setClientError(GRID_MESSAGE);
      return;
    }
    const parsedOriginX = parseDecimal(originX);
    const parsedOriginY = parseDecimal(originY);
    if (!Number.isFinite(parsedOriginX) || !Number.isFinite(parsedOriginY)) {
      event.preventDefault();
      setClientError(ORIGIN_MESSAGE);
      return;
    }
    const parsedModuleW = parseDecimal(moduleWM);
    const parsedModuleH = parseDecimal(moduleHM);
    if (
      !Number.isFinite(parsedModuleW)
      || parsedModuleW < 0.1
      || parsedModuleW > 5
      || !Number.isFinite(parsedModuleH)
      || parsedModuleH < 0.1
      || parsedModuleH > 5
    ) {
      event.preventDefault();
      setClientError(MODULE_MESSAGE);
      return;
    }
    const parsedGap = parseDecimal(gapM);
    if (!Number.isFinite(parsedGap) || parsedGap < 0 || parsedGap > 2) {
      event.preventDefault();
      setClientError(GAP_MESSAGE);
      return;
    }
    if (tiltDeg.trim() !== "") {
      const parsedTilt = parseDecimal(tiltDeg);
      if (!Number.isFinite(parsedTilt) || parsedTilt < 0 || parsedTilt > 90) {
        event.preventDefault();
        setClientError(TILT_MESSAGE);
        return;
      }
    }
    setClientError(null);
  }

  return (
    <section
      data-testid="planning-panel-groups-section"
      aria-label="Panel-Gruppen"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-900">Panel-Gruppen</h2>
      <p className="mt-1 text-sm text-slate-600">
        Rechteck-Raster je Dach (horizontal/vertikal) — Stufe-0 ohne Auto-Fill und Katalog-Join.
      </p>
      {roofId === null ? (
        <p className="mt-2 text-sm font-semibold text-amber-700">
          Bitte zuerst ein Dach anlegen.
        </p>
      ) : null}
      {initialGroups.length === 0 && roofId !== null ? (
        <p data-testid="planning-panel-groups-empty" className="mt-2 text-sm text-slate-600">
          Noch keine Panel-Gruppen angelegt.
        </p>
      ) : null}
      <ul data-testid="planning-panel-groups-list" className="mt-2 grid gap-2">
        {initialGroups.map((group) => (
          <li
            key={group.id}
            data-testid="planning-panel-groups-item"
            className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-3 py-2"
          >
            <span className="text-sm font-semibold text-slate-900">{group.label}</span>
            <span className="text-sm text-slate-600">
              {PLANNING_PANEL_GROUP_KIND_LABELS[group.kind]}
            </span>
            <span className="text-sm text-slate-500">
              {`${group.rows} × ${group.cols}, Modul ${group.moduleWM} × ${group.moduleHM} m`}
              {`, Lücke ${group.gapM} m`}
              {group.tiltDeg !== null ? `, Neigung ${group.tiltDeg}°` : ""}
            </span>
            {group.collisions.length > 0 ? (
              <p
                data-testid="planning-panel-collision-badge"
                className="w-full text-sm font-semibold text-amber-700"
              >
                {collisionBadgeText(group.collisions)}
              </p>
            ) : null}
            {group.collisions.length > 0 && group.deselectedCount > 0 ? (
              <p
                data-testid="planning-panel-collision-hint"
                className="w-full text-sm text-slate-600"
              >
                {collisionHintText(group.deselectedCount)}
              </p>
            ) : null}
            {canWrite ? (
              <form action={removeDispatch} className="ml-auto">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="groupId" value={group.id} />
                <button
                  type="submit"
                  data-testid="planning-panel-groups-delete"
                  className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                >
                  Entfernen
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {canWrite && roofId !== null ? (
        <form
          data-testid="planning-panel-groups-form"
          action={saveDispatch}
          onSubmit={handleSubmit}
          className="mt-3 border-t border-slate-100 pt-3"
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="roofId" value={roofId} />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-sm text-slate-600">
              Ausrichtung
              <select
                name="kind"
                data-testid="planning-panel-groups-kind"
                defaultValue="h"
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              >
                <option value="h">Horizontal</option>
                <option value="v">Vertikal</option>
              </select>
            </label>
            <label className="block text-sm text-slate-600">
              Bezeichnung
              <input
                type="text"
                name="label"
                data-testid="planning-panel-groups-label"
                autoComplete="off"
                maxLength={120}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Ursprung X (m)
              <input
                type="text"
                name="originX"
                data-testid="planning-panel-groups-origin-x"
                inputMode="decimal"
                autoComplete="off"
                value={originX}
                onChange={(event) => {
                  setOriginX(event.target.value);
                  setClientError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Ursprung Y (m)
              <input
                type="text"
                name="originY"
                data-testid="planning-panel-groups-origin-y"
                inputMode="decimal"
                autoComplete="off"
                value={originY}
                onChange={(event) => {
                  setOriginY(event.target.value);
                  setClientError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Zeilen
              <input
                type="text"
                name="rows"
                data-testid="planning-panel-groups-rows"
                inputMode="numeric"
                autoComplete="off"
                value={rows}
                onChange={(event) => {
                  setRows(event.target.value);
                  setClientError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Spalten
              <input
                type="text"
                name="cols"
                data-testid="planning-panel-groups-cols"
                inputMode="numeric"
                autoComplete="off"
                value={cols}
                onChange={(event) => {
                  setCols(event.target.value);
                  setClientError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Modulbreite (m)
              <input
                type="text"
                name="moduleWM"
                data-testid="planning-panel-groups-module-w"
                inputMode="decimal"
                autoComplete="off"
                value={moduleWM}
                onChange={(event) => {
                  setModuleWM(event.target.value);
                  setClientError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Modulhöhe (m)
              <input
                type="text"
                name="moduleHM"
                data-testid="planning-panel-groups-module-h"
                inputMode="decimal"
                autoComplete="off"
                value={moduleHM}
                onChange={(event) => {
                  setModuleHM(event.target.value);
                  setClientError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Lücke (m)
              <input
                type="text"
                name="gapM"
                data-testid="planning-panel-groups-gap"
                inputMode="decimal"
                autoComplete="off"
                value={gapM}
                onChange={(event) => {
                  setGapM(event.target.value);
                  setClientError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Neigung (°) (optional)
              <input
                type="text"
                name="tiltDeg"
                data-testid="planning-panel-groups-tilt"
                inputMode="decimal"
                autoComplete="off"
                value={tiltDeg}
                onChange={(event) => {
                  setTiltDeg(event.target.value);
                  setClientError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
          </div>
          {clientError ? (
            <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
              {clientError}
            </p>
          ) : null}
          <button
            type="submit"
            data-testid="planning-panel-groups-create"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Panel-Gruppe speichern
          </button>
        </form>
      ) : null}
      <Feedback state={saveState} />
      {removeState.status !== "idle" ? <Feedback state={removeState} /> : null}
    </section>
  );
}
