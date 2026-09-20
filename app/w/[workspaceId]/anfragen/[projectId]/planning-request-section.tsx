"use client";

import { useActionState } from "react";
import {
  checkPlanningOverdueAction,
  createPlanningRevisionAction,
  requestPlanningAction,
  setPlanningStatusAction,
  signPlanningRevisionAction,
  type PlanningRequestActionState,
} from "./planning-request-actions";
import type {
  PlanningDeadlineKind,
  PlanningRequestDto,
  PlanningRequestStatus,
} from "@/modules/planning-requests";

const initialState: PlanningRequestActionState = { status: "idle" };

// F13-14 Revisionsnotiz-Sicht: Teilmenge des Backend-DTOs
// PlanningRequestRevisionDto (id, planningRequestId, note, signedAt,
// createdAt) — das echte DTO ist hier zuweisbar, die Zählnummer (#1, #2 …)
// bildet die UI aus der chronologischen Listenposition (Backend liefert
// `order by created_at, id`). KEIN Preis (S1-Verbot).
export type PlanningRevisionNoteView = {
  id: string;
  planningRequestId: string;
  note: string;
  signedAt: string | null;
  createdAt: string;
};

// Backend-Regel (cleanNote): Notiz 1..2000 Zeichen, getrimmt.
const PLANNING_REVISION_NOTE_MAX = 2000;

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

function formatDay(value: string): string {
  return new Date(value).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

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

// F13-14 Feedback für Revisions- und Prüf-Aktionen: eigene Texte (u. a.
// Double-Sign als conflict), testId je Aktionspfad.
function RevisionFeedback({
  state,
  testId,
}: {
  state: PlanningRequestActionState;
  testId: string;
}) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" data-testid={testId} className="mt-3 text-sm font-semibold text-emerald-700">
        {state.message}
      </p>
    );
  }
  const message =
    state.status === "invalid"
      ? "Die Notiz ist ungültig."
      : state.status === "conflict"
        ? "Diese Notiz ist bereits signiert."
        : state.status === "not_found"
          ? "Die Notiz ist nicht mehr verfügbar."
          : state.status === "denied"
            ? "Dir fehlt die Berechtigung für diese Aktion."
            : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" data-testid={testId} className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

// F13-14 Einzelanfrage: F13-11-Bestand (Angebot, Status, Frist,
// Statuswechsel) plus Revisionsnotiz-Block (Liste chronologisch +
// Anlege-Formular + Signieren-Button je unsignierter Notiz),
// Revisionsfrist (Anfrage + 30 d, lesend), Überfällig-Badge (lesend) und
// manuellem Prüf-Button (keine Automatik). KEIN Preis-UI (S1-Verbot).
function PlanningRequestItem({
  workspaceId,
  projectId,
  request,
  revisions,
  overdue,
  canWrite,
  statusDispatch,
}: {
  workspaceId: string;
  projectId: string;
  request: PlanningRequestDto;
  revisions: readonly PlanningRevisionNoteView[];
  overdue: boolean;
  canWrite: boolean;
  statusDispatch: (formData: FormData) => void;
}) {
  const [createState, createDispatch] = useActionState(
    createPlanningRevisionAction,
    initialState,
  );
  const [signState, signDispatch] = useActionState(signPlanningRevisionAction, initialState);
  const [checkState, checkDispatch] = useActionState(checkPlanningOverdueAction, initialState);

  return (
    <li className="py-2">
      <span className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm text-slate-800">
          <span className="font-semibold">{request.offerNumber ?? "Angebot"}</span>
          <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
            {STATUS_LABELS[request.status]}
          </span>
          <span className="block text-xs text-slate-500" data-testid="planning-request-due">
            Frist: {DEADLINE_LABELS[request.deadlineKind]}
            {", "}
            {formatDay(request.deadlineAt)}
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
      </span>
      {overdue ? (
        <span
          role="status"
          data-testid="planning-request-overdue"
          className="mt-1 inline-block rounded bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800"
        >
          Überfällig
        </span>
      ) : null}
      {canWrite ? (
        <form action={checkDispatch} className="mt-1 inline">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="requestId" value={request.id} />
          <button
            type="submit"
            data-testid="planning-request-check-overdue"
            className="ml-2 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
          >
            Überfälligkeit prüfen
          </button>
        </form>
      ) : null}
      <RevisionFeedback state={checkState} testId="planning-request-check-feedback" />
      <div
        className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
        data-testid="planning-revision-block"
        data-request-id={request.id}
      >
        <h3 className="text-sm font-semibold text-slate-900">Revisionsnotizen</h3>
        {revisions.length === 0 ? (
          <p className="mt-1 text-sm text-slate-600">Noch keine Revisionsnotizen.</p>
        ) : (
          <ul data-testid="planning-revision-list" className="mt-2 divide-y divide-slate-200">
            {revisions.map((revision, index) => (
              <li
                key={revision.id}
                data-testid="planning-revision-item"
                className="flex flex-wrap items-center justify-between gap-2 py-2"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Notiz #{index + 1}
                  </span>
                  <span className="block text-sm text-slate-800">{revision.note}</span>
                </span>
                {revision.signedAt !== null ? (
                  <span
                    data-testid="planning-revision-signed"
                    className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800"
                  >
                    Signiert am {formatDay(revision.signedAt)}
                  </span>
                ) : canWrite ? (
                  <form action={signDispatch} className="inline">
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="projectId" value={projectId} />
                    <input type="hidden" name="revisionId" value={revision.id} />
                    <button
                      type="submit"
                      data-testid="planning-revision-sign"
                      className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                    >
                      Signieren
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canWrite ? (
          <form action={createDispatch} className="mt-2">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="planningRequestId" value={request.id} />
            <label className="grid gap-1 text-sm font-medium text-slate-700">
              Neue Revisionsnotiz
              <textarea
                name="note"
                required
                maxLength={PLANNING_REVISION_NOTE_MAX}
                rows={2}
                data-testid="planning-revision-body"
                placeholder="z. B. Bitte das Dachmaß prüfen."
                className="min-h-11 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
              />
            </label>
            <button
              type="submit"
              data-testid="planning-revision-create"
              className="mt-2 inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
            >
              Notiz anlegen
            </button>
          </form>
        ) : null}
        <RevisionFeedback state={createState} testId="planning-revision-create-feedback" />
        <RevisionFeedback state={signState} testId="planning-revision-sign-feedback" />
      </div>
    </li>
  );
}

// F13-11 Planungsservice: Liste + Anlegeformular (Angebot + Frist) +
// Statuswechsel. Reine Darstellung gespeicherter Anfragen.
// F13-14 Zusatz (optional, Owner-Verdrahtung in page.tsx ausstehend —
// siehe /tmp/f1314-G-TODO.md): Revisionsnotizen je Anfrage +
// Überfällig-Kennzeichen je Anfrage (lesend).
export function PlanningRequestSection({
  workspaceId,
  projectId,
  requests,
  offers,
  canWrite,
  revisionsByRequestId = {},
  overdueByRequestId = {},
}: {
  workspaceId: string;
  projectId: string;
  requests: PlanningRequestDto[];
  offers: readonly { id: string; label: string }[];
  canWrite: boolean;
  revisionsByRequestId?: Readonly<Record<string, readonly PlanningRevisionNoteView[]>>;
  overdueByRequestId?: Readonly<Record<string, boolean>>;
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
            <PlanningRequestItem
              key={request.id}
              workspaceId={workspaceId}
              projectId={projectId}
              request={request}
              revisions={revisionsByRequestId[request.id] ?? []}
              overdue={overdueByRequestId[request.id] ?? false}
              canWrite={canWrite}
              statusDispatch={statusDispatch}
            />
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
