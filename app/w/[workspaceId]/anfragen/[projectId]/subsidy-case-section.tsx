"use client";

import { useActionState } from "react";
import {
  SUBSIDY_CASE_PROGRAM_LABEL,
  SUBSIDY_CASE_STATUS_LABEL,
  isSubsidyCaseBelegState,
  nextSubsidyCaseStatuses,
  subsidyCasePrograms,
  type SubsidyCaseDto,
} from "@/lib/subsidy-case";
import type { SubsidyProgramSuggestion } from "@/lib/subsidy-case";
import { FILE_REQUEST_STATUS_LABEL, type FileRequestDto } from "@/lib/file-request";
import type { SubsidyChatMessage } from "@/modules/subsidy-cases";
import {
  createSubsidyBelegAction,
  ensureSubsidyCaseAction,
  setSubsidyCaseDetailsAction,
  transitionSubsidyCaseAction,
  type SubsidyCaseActionState,
} from "./subsidy-case-actions";
import { SubsidyChatBlock } from "./subsidy-chat-block";

const initialState: SubsidyCaseActionState = { status: "idle" };

function Feedback({ state, testId }: { state: SubsidyCaseActionState; testId: string }) {
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
      ? "Die Eingabe ist ungültig."
      : state.status === "conflict"
        ? "Dieser Übergang ist nicht zulässig."
        : state.status === "not_found"
          ? "Der Vorgang ist nicht mehr verfügbar."
          : state.status === "denied"
            ? "Dir fehlt die Berechtigung für diese Aktion."
            : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" data-testid={testId} className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

// F13-03 Förderakte: Anlage (idempotent), Programm/BzA-Nummer pflegen,
// Statusmaschine per Folge-Buttons. Reine Darstellung gespeicherter Werte.
export function SubsidyCaseSection({
  workspaceId,
  projectId,
  subsidyCase,
  canWrite,
  belege,
  suggestion,
  messages,
}: {
  workspaceId: string;
  projectId: string;
  subsidyCase: SubsidyCaseDto | null;
  canWrite: boolean;
  belege: FileRequestDto[];
  suggestion: SubsidyProgramSuggestion;
  messages: SubsidyChatMessage[];
}) {
  const [ensureState, ensureDispatch] = useActionState(ensureSubsidyCaseAction, initialState);
  const [detailsState, detailsDispatch] = useActionState(setSubsidyCaseDetailsAction, initialState);
  const [transitionState, transitionDispatch] = useActionState(
    transitionSubsidyCaseAction,
    initialState,
  );
  const [belegState, belegDispatch] = useActionState(createSubsidyBelegAction, initialState);
  const next = subsidyCase === null ? [] : nextSubsidyCaseStatuses(subsidyCase.status);
  // F13-07: Beleg-Block nur in Beleg-Phasen; Leser sehen die Liste,
  // das Formular verlangt canWrite (Action prüft zusätzlich).
  const showBelege =
    subsidyCase !== null &&
    isSubsidyCaseBelegState(subsidyCase.status) &&
    (canWrite || belege.length > 0);

  return (
    <section aria-label="Förderakte" className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Förderakte (KfW/BAFA)</h2>
      {subsidyCase === null ? (
        <div className="mt-2">
          <p className="text-sm text-slate-600" data-testid="subsidy-case-current">
            Noch keine Förderakte für dieses Projekt.
          </p>
          {canWrite ? (
            <form action={ensureDispatch} className="mt-3">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <button
                type="submit"
                data-testid="subsidy-case-create"
                className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
              >
                Förderakte anlegen
              </button>
            </form>
          ) : null}
          <Feedback state={ensureState} testId="subsidy-case-feedback" />
        </div>
      ) : (
        <div className="mt-2 grid gap-3">
          <p className="text-sm text-slate-700" data-testid="subsidy-case-current">
            Status: <span className="font-semibold">{SUBSIDY_CASE_STATUS_LABEL[subsidyCase.status]}</span>
            {subsidyCase.program ? ` · ${SUBSIDY_CASE_PROGRAM_LABEL[subsidyCase.program]}` : null}
            {subsidyCase.bzaNumber ? ` · BzA ${subsidyCase.bzaNumber}` : null}
          </p>
          <div
            className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
            data-testid="subsidy-suggestion-block"
          >
            <p className="text-sm text-slate-700" data-testid="subsidy-suggestion-text">
              {suggestion.outcome === "suggested" ? (
                <>
                  Programm-Vorschlag (Näherung, bitte prüfen):{" "}
                  <span className="font-semibold">
                    {SUBSIDY_CASE_PROGRAM_LABEL[suggestion.program]}
                  </span>{" "}
                  — {suggestion.reasons.join("; ")} (Regeln {suggestion.rulesVersion}).
                </>
              ) : (
                <>
                  Kein Programm-Vorschlag: {suggestion.reasons.join("; ")} (Regeln{" "}
                  {suggestion.rulesVersion}).
                </>
              )}
            </p>
            {suggestion.outcome === "suggested" && canWrite ? (
              <form action={detailsDispatch} className="mt-2">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="projectId" value={projectId} />
                <input type="hidden" name="program" value={suggestion.program} />
                <input type="hidden" name="bzaNumber" value={subsidyCase.bzaNumber ?? ""} />
                <button
                  type="submit"
                  data-testid="subsidy-suggestion-apply"
                  className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                >
                  Vorschlag übernehmen
                </button>
              </form>
            ) : null}
          </div>
          {canWrite ? (
            <>
              <form action={detailsDispatch} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="projectId" value={projectId} />
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Programm
                  <select
                    name="program"
                    defaultValue={
                      subsidyCase.program
                        ?? (suggestion.outcome === "suggested" ? suggestion.program : "")
                    }
                    data-testid="subsidy-case-program"
                    className="min-h-11 min-w-36 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200"
                  >
                    <option value="">—</option>
                    {subsidyCasePrograms.map((program) => (
                      <option key={program} value={program}>
                        {SUBSIDY_CASE_PROGRAM_LABEL[program]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  BzA-Nummer
                  <input
                    type="text"
                    name="bzaNumber"
                    maxLength={64}
                    defaultValue={subsidyCase.bzaNumber ?? ""}
                    data-testid="subsidy-case-bza-number"
                    className="min-h-11 min-w-36 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200"
                  />
                </label>
                <button
                  type="submit"
                  data-testid="subsidy-case-save"
                  className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                >
                  Speichern
                </button>
              </form>
              <Feedback state={detailsState} testId="subsidy-case-details-feedback" />
              {next.length > 0 ? (
                <form action={transitionDispatch} className="flex flex-wrap items-center gap-2">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="projectId" value={projectId} />
                  {next.map((status) => (
                    <button
                      key={status}
                      type="submit"
                      name="status"
                      value={status}
                      data-testid={`subsidy-case-to-${status}`}
                      className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                    >
                      {SUBSIDY_CASE_STATUS_LABEL[status]}
                    </button>
                  ))}
                </form>
              ) : null}
              <Feedback state={transitionState} testId="subsidy-case-transition-feedback" />
            </>
          ) : null}
          {showBelege ? (
            <div className="mt-1 border-t border-slate-200 pt-3" data-testid="subsidy-beleg-block">
              <h3 className="text-sm font-semibold text-slate-900">BnD-Belege</h3>
              {belege.length === 0 ? (
                <p className="mt-1 text-sm text-slate-600">Noch keine Belege angefordert.</p>
              ) : (
                <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200">
                  {belege.map((beleg) => (
                    <li key={beleg.id} className="px-3 py-2">
                      <span className="block text-sm font-medium text-slate-800">{beleg.title}</span>
                      <span className="block text-sm text-slate-500">
                        {FILE_REQUEST_STATUS_LABEL[beleg.status]}
                        {beleg.status === "erledigt" ? " · Beleg erhalten" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {canWrite ? (
                <form action={belegDispatch} className="mt-2 flex flex-wrap items-end gap-2">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="projectId" value={projectId} />
                  <label className="grid gap-1 text-sm font-medium text-slate-700">
                    Beleg-Titel
                    <input
                      type="text"
                      name="title"
                      maxLength={160}
                      defaultValue="BnD-Beleg"
                      data-testid="subsidy-beleg-title"
                      className="min-h-11 min-w-36 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200"
                    />
                  </label>
                  <button
                    type="submit"
                    data-testid="subsidy-beleg-create"
                    className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                  >
                    Beleg anfordern
                  </button>
                </form>
              ) : null}
              <Feedback state={belegState} testId="subsidy-beleg-feedback" />
            </div>
          ) : null}
          <SubsidyChatBlock
            workspaceId={workspaceId}
            projectId={projectId}
            caseId={subsidyCase.id}
            messages={messages}
            canWrite={canWrite}
          />
        </div>
      )}
    </section>
  );
}
