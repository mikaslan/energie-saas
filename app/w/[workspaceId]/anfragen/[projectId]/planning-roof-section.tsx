// F3-03 Dach-Minimal: Projekt-Sektion (Client). UI-Vertrag aus
// tests/e2e/f3-03-roofs.spec.ts — Testids exakt einhalten. Client-Validierung
// über den Batch-Contract (@/lib/integrations/planning/contracts): Selbstschnitt und
// tilt-Range werden ohne Server-Reject abgewiesen. Viewer read-only, Quick
// blendet die Sektion aus (F3-01-Regel).
// Verdrahtung (page.tsx, Fremdverantwortung): sourceId = jüngste Quelle des
// Projekts, initialRoof = jüngstes Dach je Projekt, canWrite aus dem
// project.write-Gate, planningMode der aktiven Angebotsvariante.
"use client";

import { useActionState, useEffect, useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  PLANNING_ROOF_CONTRACT_VERSION,
  planningRoofCreateV1Schema,
  planningRoofPolygonV1Schema,
} from "@/lib/integrations/planning/contracts";
import { savePlanningRoofAction, type PlanningRoofActionState } from "./planning-roof-actions";
import { PlanningRoofMap } from "./planning-roof-map";
import type { PlanningRoofDto, PlanningRoofPoint } from "./planning-roof-model";

const initialAction: PlanningRoofActionState = { status: "idle" };
const DEFAULT_TILT = "30";
const SELF_INTERSECTION_MESSAGE =
  "Das Dachpolygon enthält einen Selbstschnitt – bitte Punkte neu setzen.";
const MIN_POINTS_MESSAGE = "Mindestens 3 Punkte zeichnen, um das Dach zu speichern.";
const TILT_RANGE_MESSAGE = "Neigung muss zwischen 0–90° liegen.";

function parseDegrees(raw: string): number {
  return Number.parseFloat(raw.replace(",", "."));
}

function Feedback({ state }: { state: PlanningRoofActionState }) {
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
      ? "Die Dachquelle wurde nicht gefunden."
      : state.status === "denied"
        ? "Dir fehlt die Berechtigung für diese Aktion."
        : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

export function PlanningRoofSection({
  workspaceId,
  projectId,
  sourceId,
  initialRoof,
  canWrite,
  planningMode,
}: {
  workspaceId: string;
  projectId: string;
  sourceId: string | null;
  initialRoof: PlanningRoofDto | null;
  canWrite: boolean;
  planningMode?: "quick" | "2d" | "3d";
}) {
  const router = useRouter();
  const [saveState, saveDispatch] = useActionState(savePlanningRoofAction, initialAction);
  const [drawing, setDrawing] = useState(false);
  const [points, setPoints] = useState<PlanningRoofPoint[]>(() => initialRoof?.polygon ?? []);
  const [tiltMode, setTiltMode] = useState<"flat" | "per_edge">(() =>
    initialRoof?.flatSingleTilt !== null && initialRoof?.flatSingleTilt !== undefined
      ? "flat"
      : "per_edge",
  );
  const [tilts, setTilts] = useState<string[]>(() =>
    initialRoof?.tiltPerEdge
      ? initialRoof.tiltPerEdge.map((tilt) => String(tilt))
      : (initialRoof?.polygon ?? []).map(() => DEFAULT_TILT),
  );
  const [flatTilt, setFlatTilt] = useState<string>(() =>
    initialRoof?.flatSingleTilt !== null && initialRoof?.flatSingleTilt !== undefined
      ? String(initialRoof.flatSingleTilt)
      : DEFAULT_TILT,
  );
  const [drawError, setDrawError] = useState<string | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);

  const polygonCheck = useMemo(() => planningRoofPolygonV1Schema.safeParse(points), [points]);
  const saveBlocked =
    drawing || points.length < 3 || !polygonCheck.success || sourceId === null;

  useEffect(() => {
    if (saveState.status === "success") router.refresh();
  }, [saveState, router]);

  if (planningMode === "quick") return null;

  function handleAddPoint(point: PlanningRoofPoint): void {
    if (!drawing || !canWrite || points.length >= 64) return;
    setPoints((current) => [...current, point]);
    setTilts((current) => [...current, DEFAULT_TILT]);
    setDrawError(null);
  }

  function handleDrawStart(): void {
    setPoints([]);
    setTilts([]);
    setDrawError(null);
    setClientError(null);
    setDrawing(true);
  }

  function handleDrawFinish(): void {
    setDrawing(false);
    const result = planningRoofPolygonV1Schema.safeParse(points);
    if (result.success) {
      setDrawError(null);
    } else if (points.length < 3) {
      setDrawError(MIN_POINTS_MESSAGE);
    } else {
      setDrawError(SELF_INTERSECTION_MESSAGE);
    }
    setTilts((current) => points.map((_, index) => current[index] ?? DEFAULT_TILT));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    const parsed = planningRoofCreateV1Schema.safeParse({
      schemaVersion: PLANNING_ROOF_CONTRACT_VERSION,
      polygon: points,
      ...(tiltMode === "flat"
        ? { flatSingleTilt: parseDegrees(flatTilt) }
        : { tiltPerEdge: tilts.slice(0, points.length).map(parseDegrees) }),
    });
    if (parsed.success) {
      setClientError(null);
      return;
    }
    event.preventDefault();
    const paths = parsed.error.issues.map((issue) => String(issue.path[0] ?? ""));
    if (paths.includes("polygon")) {
      setClientError(points.length < 3 ? MIN_POINTS_MESSAGE : SELF_INTERSECTION_MESSAGE);
    } else {
      setClientError(TILT_RANGE_MESSAGE);
    }
  }

  return (
    <section
      data-testid="planning-roofs-section"
      aria-label="Dachplanung"
      className="rounded-lg border border-slate-200 bg-white p-4"
    >
      <h2 className="text-sm font-semibold text-slate-900">Dachplanung</h2>
      <p className="mt-1 text-sm text-slate-600">
        Randabstand: Standardwert — fehlende Kantenabstände fallen auf den Default zurück
        (MARGIN_UNIFORM_FALLBACK).
      </p>
      {sourceId === null ? (
        <p className="mt-2 text-sm font-semibold text-amber-700">
          Lege zuerst eine Dachquelle (Selbstzeichnung) an, um ein Dach zu zeichnen.
        </p>
      ) : null}
      <div className="mt-3">
        <PlanningRoofMap
          points={points}
          drawing={drawing && canWrite}
          disabled={!canWrite}
          onAddPoint={handleAddPoint}
        />
      </div>
      <p data-testid="roof-point-count" className="mt-2 text-sm text-slate-600">
        {points.length}
        {` `}
        {points.length === 1 ? "Punkt" : "Punkte"}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="roof-draw-start"
          disabled={!canWrite || drawing}
          onClick={handleDrawStart}
          className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Zeichnen starten
        </button>
        <button
          type="button"
          data-testid="roof-draw-finish"
          disabled={!canWrite || !drawing}
          onClick={handleDrawFinish}
          className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Zeichnen beenden
        </button>
      </div>
      {drawError ? (
        <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
          {drawError}
        </p>
      ) : null}
      <form action={saveDispatch} onSubmit={handleSubmit} className="mt-3 border-t border-slate-100 pt-3">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="projectId" value={projectId} />
        <input type="hidden" name="sourceId" value={sourceId ?? ""} />
        <input type="hidden" name="roofId" value={initialRoof?.id ?? ""} />
        <input type="hidden" name="polygon" value={JSON.stringify(points)} />
        <input type="hidden" name="tiltMode" value={tiltMode} />
        <input type="hidden" name="flatTilt" value={flatTilt} />
        <input type="hidden" name="tilts" value={JSON.stringify(tilts)} />
        <label className="flex min-h-11 items-center gap-2 text-sm font-semibold text-slate-800">
          <input
            type="checkbox"
            checked={tiltMode === "flat"}
            disabled={!canWrite}
            onChange={(event) => {
              setTiltMode(event.target.checked ? "flat" : "per_edge");
              setClientError(null);
            }}
            className="size-5 accent-slate-900"
          />
          Flachdach (eine Neigung für alle Kanten)
        </label>
        {tiltMode === "flat" ? (
          <label className="mt-2 block text-sm text-slate-600">
            Neigung Flachdach (°)
            <input
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={flatTilt}
              disabled={!canWrite}
              onChange={(event) => {
                setFlatTilt(event.target.value);
                setClientError(null);
              }}
              className="mt-1 block w-full max-w-40 rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30 disabled:bg-slate-50"
            />
          </label>
        ) : (
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {points.map((point, index) => (
              <label key={`${point.x}:${point.y}:${index}`} className="block text-sm text-slate-600">
                {`Neigung Kante ${index + 1} (°)`}
                <input
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={tilts[index] ?? DEFAULT_TILT}
                  disabled={!canWrite}
                  onChange={(event) => {
                    const next = event.target.value;
                    setTilts((current) =>
                      current.map((tilt, tiltIndex) => (tiltIndex === index ? next : tilt)),
                    );
                    setClientError(null);
                  }}
                  className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30 disabled:bg-slate-50"
                />
              </label>
            ))}
          </div>
        )}
        {tiltMode === "per_edge" && points.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">
            Nach dem Zeichnen erscheint je Kante ein Neigungsfeld.
          </p>
        ) : null}
        {clientError ? (
          <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
            {clientError}
          </p>
        ) : null}
        {canWrite ? (
          <button
            type="submit"
            data-testid="roof-save"
            disabled={saveBlocked}
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Dach speichern
          </button>
        ) : null}
      </form>
      <Feedback state={saveState} />
    </section>
  );
}
