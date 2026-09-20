// F3-03b Dach-Sperrzonen: Projekt-Sektion (Client). UI-Vertrag aus
// tests/e2e/f3-03b-restrictions.spec.ts — Testids exakt einhalten.
// Client-Validierung ueber den Batch-Contract
// (@/lib/integrations/planning/contracts): Rechteck-Form ohne Server-Reject,
// Rechteck-in-Polygon serverseitig (Action). Viewer read-only.
// F3-04c: Kollisions-Warnbadge je betroffener Zeile (advisory-only,
// symmetrisch zur Gruppen-Liste); Quick blendet die Sektion aus
// (F3-01-Regel).
"use client";

import { useActionState, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { planningRoofRestrictionRectV1Schema } from "@/lib/integrations/planning/contracts";
import {
  removePlanningRoofRestrictionAction,
  savePlanningRoofRestrictionAction,
  type PlanningRoofRestrictionActionState,
} from "./planning-roof-restriction-actions";
import {
  PLANNING_ROOF_RESTRICTION_KIND_LABELS,
  type PlanningRoofRestrictionCollidingGroup,
  type PlanningRoofRestrictionDto,
} from "./planning-roof-restriction-model";

// F3-04c: Badge-Text enthaelt „ueberlappt" + Gegenueber-Labels
// (E2E-Vertrag tests/e2e/f3-04c-collision.spec.ts).
function collisionBadgeText(groups: PlanningRoofRestrictionCollidingGroup[]): string {
  const labels = groups.map((group) => group.label).join(", ");
  const noun = groups.length === 1 ? "Panel-Gruppe" : "Panel-Gruppen";
  return `Überlappt ${noun} ${labels} — Zellen in der Gruppe abwählen`;
}

const initialAction: PlanningRoofRestrictionActionState = { status: "idle" };
const RECT_MESSAGE = "Das Rechteck ist ungültig (endliche Zahlen, Breite/Höhe > 0).";

function parseDecimal(raw: string): number {
  if (raw.trim() === "") return Number.NaN;
  return Number.parseFloat(raw.replace(",", "."));
}

function Feedback({ state }: { state: PlanningRoofRestrictionActionState }) {
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
      ? "Die Sperrzone wurde nicht gefunden."
      : state.status === "denied"
        ? "Dir fehlt die Berechtigung für diese Aktion."
        : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

export function PlanningRoofRestrictionSection({
  workspaceId,
  projectId,
  roofId,
  initialRestrictions,
  canWrite,
  planningMode,
}: {
  workspaceId: string;
  projectId: string;
  roofId: string | null;
  initialRestrictions: PlanningRoofRestrictionDto[];
  canWrite: boolean;
  planningMode?: "quick" | "2d" | "3d";
}) {
  const router = useRouter();
  const [saveState, saveDispatch] = useActionState(savePlanningRoofRestrictionAction, initialAction);
  const [removeState, removeDispatch] = useActionState(
    removePlanningRoofRestrictionAction,
    initialAction,
  );
  const [rectX, setRectX] = useState("");
  const [rectY, setRectY] = useState("");
  const [rectWidth, setRectWidth] = useState("");
  const [rectHeight, setRectHeight] = useState("");
  const [clientError, setClientError] = useState<string | null>(null);

  useEffect(() => {
    if (saveState.status === "success" || removeState.status === "success") {
      router.refresh();
    }
  }, [saveState, removeState, router]);

  if (planningMode === "quick") return null;

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    const parsed = planningRoofRestrictionRectV1Schema.safeParse({
      x: parseDecimal(rectX),
      y: parseDecimal(rectY),
      width: parseDecimal(rectWidth),
      height: parseDecimal(rectHeight),
    });
    if (parsed.success) {
      setClientError(null);
      return;
    }
    event.preventDefault();
    setClientError(RECT_MESSAGE);
  }

  return (
    <section
      data-testid="planning-roof-restrictions-section"
      aria-label="Dachsperrzonen"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-900">Dachsperrzonen</h2>
      <p className="mt-1 text-sm text-slate-600">
        Rechtecke je Dach (Schornstein, Fenster, Sonstige) — Stufe-0 ohne Schattenwurf-Modell.
      </p>
      {roofId === null ? (
        <p className="mt-2 text-sm font-semibold text-amber-700">
          Bitte zuerst ein Dach anlegen.
        </p>
      ) : null}
      {initialRestrictions.length === 0 && roofId !== null ? (
        <p className="mt-2 text-sm text-slate-600">Noch keine Sperrzonen angelegt.</p>
      ) : null}
      <ul className="mt-2 grid gap-2">
        {initialRestrictions.map((restriction) => (
          <li
            key={restriction.id}
            data-testid="planning-roof-restrictions-item"
            className="flex flex-wrap items-center gap-2 rounded-md border border-slate-100 px-3 py-2"
          >
            <span className="text-sm font-semibold text-slate-900">{restriction.label}</span>
            <span className="text-sm text-slate-600">
              {PLANNING_ROOF_RESTRICTION_KIND_LABELS[restriction.kind]}
            </span>
            <span className="text-sm text-slate-500">
              {`x ${restriction.rect.x.toFixed(4)}, y ${restriction.rect.y.toFixed(4)}, ${restriction.rect.width.toFixed(4)} × ${restriction.rect.height.toFixed(4)}`}
              {restriction.heightM !== null ? `, Höhe ${restriction.heightM} m` : ""}
            </span>
            {restriction.collidingGroups.length > 0 ? (
              <p
                data-testid="planning-panel-collision-badge"
                className="w-full text-sm font-semibold text-amber-700"
              >
                {collisionBadgeText(restriction.collidingGroups)}
              </p>
            ) : null}
            {canWrite ? (
              <form action={removeDispatch} className="ml-auto">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="restrictionId" value={restriction.id} />
                <button
                  type="submit"
                  data-testid="planning-roof-restrictions-remove"
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
          action={saveDispatch}
          onSubmit={handleSubmit}
          className="mt-3 border-t border-slate-100 pt-3"
        >
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="roofId" value={roofId} />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block text-sm text-slate-600">
              Art
              <select
                name="kind"
                defaultValue="chimney"
                className="mt-1 block w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              >
                <option value="chimney">Schornstein</option>
                <option value="window">Fenster</option>
                <option value="other">Sonstige</option>
              </select>
            </label>
            <label className="block text-sm text-slate-600">
              Bezeichnung
              <input
                type="text"
                name="label"
                autoComplete="off"
                maxLength={120}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              X (m)
              <input
                type="text"
                name="rectX"
                inputMode="decimal"
                autoComplete="off"
                value={rectX}
                onChange={(event) => {
                  setRectX(event.target.value);
                  setClientError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Y (m)
              <input
                type="text"
                name="rectY"
                inputMode="decimal"
                autoComplete="off"
                value={rectY}
                onChange={(event) => {
                  setRectY(event.target.value);
                  setClientError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Breite (m)
              <input
                type="text"
                name="rectWidth"
                inputMode="decimal"
                autoComplete="off"
                value={rectWidth}
                onChange={(event) => {
                  setRectWidth(event.target.value);
                  setClientError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Höhe (m)
              <input
                type="text"
                name="rectHeight"
                inputMode="decimal"
                autoComplete="off"
                value={rectHeight}
                onChange={(event) => {
                  setRectHeight(event.target.value);
                  setClientError(null);
                }}
                className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <label className="block text-sm text-slate-600">
              Höhe über Dach (m, optional)
              <input
                type="text"
                name="heightM"
                inputMode="decimal"
                autoComplete="off"
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
            data-testid="planning-roof-restrictions-save"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Sperrzone speichern
          </button>
        </form>
      ) : null}
      <Feedback state={saveState} />
      {removeState.status !== "idle" ? <Feedback state={removeState} /> : null}
    </section>
  );
}
