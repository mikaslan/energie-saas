"use client";

import { useActionState } from "react";
import { SUBSIDY_CHAT_BODY_MAX } from "@/lib/integrations/subsidies/chat-contract";
import type { SubsidyChatMessage } from "@/modules/subsidy-cases";
import {
  postSubsidyMessageAction,
  type SubsidyCaseActionState,
} from "./subsidy-case-actions";

const initialState: SubsidyCaseActionState = { status: "idle" };

function Feedback({ state }: { state: SubsidyCaseActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" data-testid="subsidy-chat-feedback" className="mt-3 text-sm font-semibold text-emerald-700">
        {state.message}
      </p>
    );
  }
  const message =
    state.status === "invalid"
      ? "Die Nachricht ist ungültig (1–2000 Zeichen, kein Leertext)."
      : state.status === "not_found"
        ? "Der Vorgang ist nicht mehr verfügbar."
        : state.status === "denied"
          ? "Dir fehlt die Berechtigung für diese Aktion."
          : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" data-testid="subsidy-chat-feedback" className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

// F13-10 Chat zur Förderakte (intern): Verlauf mit Seiten-Kennzeichnung
// plus Antwortfeld (canWrite; Action prüft zusätzlich).
export function SubsidyChatBlock({
  workspaceId,
  projectId,
  caseId,
  messages,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  caseId: string;
  messages: SubsidyChatMessage[];
  canWrite: boolean;
}) {
  const [chatState, chatDispatch] = useActionState(postSubsidyMessageAction, initialState);
  return (
    <div className="mt-1 border-t border-slate-200 pt-3" data-testid="subsidy-chat-block">
      <h3 className="text-sm font-semibold text-slate-900">Chat zur Förderakte</h3>
      {messages.length === 0 ? (
        <p className="mt-1 text-sm text-slate-600">Noch keine Nachrichten.</p>
      ) : (
        <ul className="mt-2 divide-y divide-slate-200 rounded-md border border-slate-200">
          {messages.map((message, index) => (
            <li key={`${message.at}-${index}`} className="px-3 py-2">
              <span className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                {message.side === "customer" ? "Kunde" : "Intern"}
              </span>
              <span className="block text-sm text-slate-800">{message.body}</span>
            </li>
          ))}
        </ul>
      )}
      {canWrite ? (
        <form action={chatDispatch} className="mt-2 flex flex-wrap items-end gap-2">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="caseId" value={caseId} />
          <label className="grid min-w-52 flex-1 gap-1 text-sm font-medium text-slate-700">
            Nachricht an den Kunden
            <textarea
              name="body"
              required
              maxLength={SUBSIDY_CHAT_BODY_MAX}
              rows={2}
              data-testid="subsidy-chat-body"
              placeholder="z. B. Die BzA ist eingereicht."
              className="min-h-11 rounded-md border border-slate-300 bg-white px-2 py-2 text-sm outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200"
            />
          </label>
          <button
            type="submit"
            data-testid="subsidy-chat-send"
            className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
          >
            Senden
          </button>
        </form>
      ) : null}
      <Feedback state={chatState} />
    </div>
  );
}
