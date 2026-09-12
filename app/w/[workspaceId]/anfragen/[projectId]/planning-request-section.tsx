"use client";

import { useActionState } from "react";
import {
  requestPlanningAction,
  setPlanningStatusAction,
  type PlanningRequestActionState,
} from "./planning-request-actions";
import type {
  PlanningDeadlineKind,
  PlanningRequestDto,
  PlanningRequestStatus,
} from "@/modules/planning-requests";

const initialState: PlanningRequestActionState = { status: "idle" };

const STATUS_LABELS: Record<PlanningRequestStatus, string> = {
  requested: "Angefragt",
  in_progress: "In Arbeit",
  finished: "Fertig",
  accepted: "Abgenommen",
};

const NEXT_ACTIONS: Record<PlanningRequestStatus, readonly PlanningRequestStatus[]> = {
  requested: ["in_progress"],
  in_progress: ["finished"],
  finished: ["accepted"],
  accepted: [],
};

const NEXT_LABELS: Record<PlanningRequestStatus, string> = {
  requested: "Angefragt",
  in_progress: "Starten",
  finished: "Fertigstellen",
  accepted: "Abnehmen",
};

const DEADLINE_LABELS: Record<PlanningDeadlineKind, string> = {
  express_24h: "Express (24 h)",
  standard_48h: "Standard (48 h)",
  date: "Wunschtermin",
};

function Feedback({ state }: { state: PlanningRequestActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" className="mt-3 text-sm font-semibold text-emerald-700">
        {state.message}
      </p>
    );
  }
  const message =
    state.status === "invalid"
      ? "Die Eingabe ist ungültig."
      : state.status === "conflict"
        ? "Zu diesem Angebot existiert bereits eine Planungsanfrage."
        : state.status === "not_found"
          ? "Das Angebot wurde nicht gefunden."
          : state.status === "denied"
            ? "Dir fehlt die Berechtigung für diese Aktion."
            : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

// F13-11 Planungsservice: Liste + Anlegeformular (Angebot + Frist) +
// Statuswechsel. Reine Darstellung gespeicherter Anfragen.
export function PlanningRequestSection({
  workspaceId,
  projectId,
  requests,
  offers,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  requests: PlanningRequestDto[];
  offers: readonly { id: string; label: string }[];
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(requestPlanningAction, initialState);
  const [statusState, statusDispatch] = useActionState(setPlanningStatusAction, initialState);

  return (
    <section
      aria-label="Planungsservice"
      data-planning-requests="true"
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 className="text-base font-semibold text-slate-950">Planungsservice</h2>
      {requests.length === 0 ? (
        <p className="mt-2 text-sm leading-6 text-slate-600">Keine Planungsanfragen gestellt.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {requests.map((request) => (
            <li key={request.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
              <span className="text-sm text-slate-800">
                <span className="font-semibold">{request.offerNumber ?? "Angebot"}</span>
                <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                  {STATUS_LABELS[request.status]}
                </span>
                <span className="block text-xs text-slate-500">
                  Frist: {DEADLINE_LABELS[request.deadlineKind]}
                  {", "}
                  {new Date(request.deadlineAt).toLocaleDateString("de-DE", {
                    day: "2-digit",
                    month: "2-digit",
                    year: "numeric",
                  })}
                </span>
              </span>
              {canWrite && NEXT_ACTIONS[request.status].length > 0 ? (
                <span className="flex gap-2">
                  {NEXT_ACTIONS[request.status].map((next) => (
                    <form key={next} action={statusDispatch} className="inline">
                      <input type="hidden" name="workspaceId" value={workspaceId} />
                      <input type="hidden" name="projectId" value={projectId} />
                      <input type="hidden" name="id" value={request.id} />
                      <input type="hidden" name="status" value={next} />
                      <button
                        type="submit"
                        className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                      >
                        {NEXT_LABELS[next]}
                      </button>
                    </form>
                  ))}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite && offers.length > 0 ? (
        <form action={createDispatch} className="mt-4 border-t border-slate-100 pt-4">
          <h3 className="text-sm font-semibold text-slate-950">Neue Planungsanfrage</h3>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Angebot</span>
            <select
              name="offerId"
              required
              data-testid="planning-request-offer"
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            >
              {offers.map((offer) => (
                <option key={offer.id} value={offer.id}>
                  {offer.label}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="mt-2">
            <legend className="text-sm font-semibold text-slate-800">Frist</legend>
            <label className="mt-1 flex items-center gap-2 text-sm text-slate-800">
              <input type="radio" name="deadlineKind" value="express_24h" />
              Express (24 h)
            </label>
            <label className="mt-1 flex items-center gap-2 text-sm text-slate-800">
              <input type="radio" name="deadlineKind" value="standard_48h" defaultChecked />
              Standard (48 h)
            </label>
            <label className="mt-1 flex items-center gap-2 text-sm text-slate-800">
              <input type="radio" name="deadlineKind" value="date" />
              Wunschtermin
            </label>
          </fieldset>
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">
              Wunschtermin (nur bei Wunschtermin)
            </span>
            <input
              type="date"
              name="deadlineDate"
              data-testid="planning-request-date"
              className="mt-1 min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            />
          </label>
          <button
            type="submit"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Anfrage stellen
          </button>
        </form>
      ) : null}
      <Feedback state={createState} />
      <Feedback state={statusState} />
    </section>
  );
}
