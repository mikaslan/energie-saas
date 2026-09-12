"use client";

import { useActionState } from "react";
import {
  postOrderPartMessageAction,
  requestOrderPartAction,
  setOrderPartStatusAction,
  type OrderPartActionState,
} from "./order-part-actions";
import type { OrderPartDto, OrderPartStatus } from "@/modules/order-parts";

const initialState: OrderPartActionState = { status: "idle" };

const STATUS_LABELS: Record<OrderPartStatus, string> = {
  open: "Offen",
  ordered: "Bestellt",
  delivered: "Geliefert",
  cancelled: "Storniert",
};

const NEXT_ACTIONS: Record<OrderPartStatus, readonly { status: OrderPartStatus; label: string }[]> = {
  open: [
    { status: "ordered", label: "Bestellen" },
    { status: "cancelled", label: "Stornieren" },
  ],
  ordered: [
    { status: "delivered", label: "Geliefert" },
    { status: "cancelled", label: "Stornieren" },
  ],
  delivered: [],
  cancelled: [],
};

function Feedback({ state }: { state: OrderPartActionState }) {
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
      : state.status === "not_found"
        ? "Die Position wurde nicht gefunden."
        : state.status === "denied"
          ? "Dir fehlt die Berechtigung für diese Aktion."
          : "Deine Sitzung ist abgelaufen.";
  return (
    <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
      {message}
    </p>
  );
}

// F7-12 Order Parts: Nachbestellungen mit Message-Thread je Zeile.
// Reine Darstellung gespeicherter Anfragen + Nachrichten.
export function OrderPartSection({
  workspaceId,
  projectId,
  installationId,
  parts,
  lines,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  installationId: string;
  parts: OrderPartDto[];
  lines: readonly { lineDomainId: string; label: string }[];
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(requestOrderPartAction, initialState);
  const [messageState, messageDispatch] = useActionState(postOrderPartMessageAction, initialState);
  const [statusState, statusDispatch] = useActionState(setOrderPartStatusAction, initialState);

  return (
    <section
      aria-label="Nachbestellungen"
      data-order-parts="true"
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 className="text-base font-semibold text-slate-950">Nachbestellungen</h2>
      {parts.length === 0 ? (
        <p className="mt-2 text-sm leading-6 text-slate-600">Keine Nachbestellungen vorhanden.</p>
      ) : (
        <ul className="mt-3 space-y-4">
          {parts.map((part) => (
            <li key={part.id} className="rounded-md border border-slate-100 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-sm text-slate-800">
                  <span className="font-semibold">{part.lineLabel}</span>
                  <span className="ml-2 text-slate-600">× {part.quantityUnits} Stk.</span>
                  <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                    {STATUS_LABELS[part.status]}
                  </span>
                  {part.note ? (
                    <span className="block text-xs text-slate-500">{part.note}</span>
                  ) : null}
                </span>
                {canWrite && NEXT_ACTIONS[part.status].length > 0 ? (
                  <span className="flex gap-2">
                    {NEXT_ACTIONS[part.status].map((next) => (
                      <form key={next.status} action={statusDispatch} className="inline">
                        <input type="hidden" name="workspaceId" value={workspaceId} />
                        <input type="hidden" name="projectId" value={projectId} />
                        <input type="hidden" name="id" value={part.id} />
                        <input type="hidden" name="status" value={next.status} />
                        <button
                          type="submit"
                          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600"
                        >
                          {next.label}
                        </button>
                      </form>
                    ))}
                  </span>
                ) : null}
              </div>
              {part.messages.length > 0 ? (
                <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2">
                  {part.messages.map((message) => (
                    <li key={message.id} className="text-sm leading-6 text-slate-700">
                      {message.body}
                    </li>
                  ))}
                </ul>
              ) : null}
              {canWrite ? (
                <form action={messageDispatch} className="mt-2 flex gap-2">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="id" value={part.id} />
                  <label className="sr-only" htmlFor={`order-part-message-${part.id}`}>
                    Nachricht
                  </label>
                  <input
                    id={`order-part-message-${part.id}`}
                    name="body"
                    type="text"
                    required
                    maxLength={2000}
                    placeholder="Nachricht zum Thread"
                    className="min-h-11 flex-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
                  />
                  <button
                    type="submit"
                    className="inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                  >
                    Senden
                  </button>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canWrite && lines.length > 0 ? (
        <form action={createDispatch} className="mt-4 border-t border-slate-100 pt-4">
          <h3 className="text-sm font-semibold text-slate-950">Neue Nachbestellung</h3>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="installationId" value={installationId} />
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Position</span>
            <select
              name="lineDomainId"
              required
              data-testid="order-part-line"
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            >
              {lines.map((line) => (
                <option key={line.lineDomainId} value={line.lineDomainId}>
                  {line.label}
                </option>
              ))}
            </select>
          </label>
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Stückzahl</span>
            <input
              type="number"
              name="quantityUnits"
              required
              min={1}
              max={1000000}
              step={1}
              defaultValue={1}
              data-testid="order-part-quantity"
              className="mt-1 min-h-11 w-32 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            />
          </label>
          <label className="mt-2 block">
            <span className="block text-sm font-semibold text-slate-800">Notiz (optional)</span>
            <input
              type="text"
              name="note"
              maxLength={500}
              className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
            />
          </label>
          <button
            type="submit"
            className="mt-3 inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Anfordern
          </button>
        </form>
      ) : null}
      <Feedback state={createState} />
      <Feedback state={messageState} />
      <Feedback state={statusState} />
    </section>
  );
}
