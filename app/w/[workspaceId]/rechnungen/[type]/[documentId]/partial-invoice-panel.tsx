"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  createPartialInvoiceAction,
  type PartialInvoiceActionState,
} from "../../actions";
import { formatEuro } from "../../labels";
import type { PartialChain } from "@/modules/invoicing";

const initialState: PartialInvoiceActionState = { status: "idle" };

function Feedback({
  state,
  workspaceId,
}: {
  state: PartialInvoiceActionState;
  workspaceId: string;
}) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p role="status" data-testid="partial-invoice-success" className="mt-3 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
        Teilrechnungs-Entwurf angelegt —{" "}
        <Link
          href={`/w/${workspaceId}/rechnungen/invoice/${state.invoiceId}`}
          className="font-semibold underline underline-offset-2"
        >
          Rechnung öffnen
        </Link>
      </p>
    );
  }
  const message =
    state.status === "invalid"
      ? "Eingabe ungültig (Modus, Prozent oder Positionen prüfen)."
      : state.status === "not_found"
        ? "Beleg nicht gefunden."
        : state.status === "conflict"
          ? "Kette übersteigt den Auftragswert oder Positionen sind verbraucht (Storno gibt frei)."
          : state.status === "denied"
            ? "Keine Berechtigung."
            : "Bitte erneut anmelden.";
  return (
    <p role="alert" className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      {message}
    </p>
  );
}

/**
 * F8-05 · Teilrechnung zum Auftrag (Modi Prozent/Positionen, Kette mit
 * Restbetrag). Reine Darstellung gespeicherter Kette + Summen.
 */
export function PartialInvoicePanel({
  workspaceId,
  documentId,
  chain,
  canWrite,
}: {
  workspaceId: string;
  documentId: string;
  chain: PartialChain;
  canWrite: boolean;
}) {
  const [state, dispatch] = useActionState(createPartialInvoiceAction, initialState);
  const [mode, setMode] = useState<"percent" | "lines">("percent");
  const selectable = chain.orderLines.filter((line) => !line.consumed);

  return (
    <section
      aria-label="Teilrechnungen"
      data-invoice-detail="partial"
      className="mt-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 className="text-base font-semibold text-slate-950">Teilrechnungen</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600" data-testid="partial-chain-summary">
        {chain.partials.length === 0
          ? `Noch keine Teilrechnung zu ${chain.order.number ?? chain.order.name}.`
          : `${chain.partials.length} ${chain.partials.length === 1 ? "Teilrechnung" : "Teilrechnungen"} gestellt.`}{" "}
        Rest: {formatEuro(chain.remainingGrossCents)} von {formatEuro(chain.order.grossCents)}.
      </p>
      {chain.partials.length > 0 ? (
        <ul className="mt-3 grid gap-2" aria-label="Gestellte Teilrechnungen">
          {chain.partials.map((entry) => (
            <li key={entry.partialId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-sm">
              <span>
                <span className="font-semibold">Nr. {entry.ordinal}</span>
                {" · "}{entry.mode === "percent" ? `${(entry.percentBps ?? 0) / 100} %` : "Positionen"}
                {" · "}{formatEuro(entry.grossCents)}
                {entry.status === "voided" ? " · storniert" : null}
              </span>
              <Link
                href={`/w/${workspaceId}/rechnungen/invoice/${entry.invoiceId}`}
                className="font-semibold text-brand-800 underline underline-offset-2"
              >
                {entry.number ?? entry.name}
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {canWrite ? (
        <form action={dispatch} data-testid="partial-invoice-panel" className="mt-4 grid gap-3 border-t border-slate-100 pt-4">
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="documentId" value={documentId} />
          <fieldset className="grid gap-2">
            <legend className="text-sm font-semibold text-slate-800">Modus</legend>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="radio"
                name="mode"
                value="percent"
                checked={mode === "percent"}
                onChange={() => setMode("percent")}
                className="h-4 w-4"
              />
              Prozent vom Auftragswert (eine Sammellinie)
            </label>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input
                type="radio"
                name="mode"
                value="lines"
                checked={mode === "lines"}
                onChange={() => setMode("lines")}
                disabled={selectable.length === 0}
                className="h-4 w-4"
              />
              Einzelne Auftragspositionen
              {selectable.length === 0 ? " (alle verbraucht)" : null}
            </label>
          </fieldset>
          {mode === "percent" ? (
            <label className="grid max-w-48 gap-1 text-sm font-medium text-slate-700">
              Anteil in %
              <input
                type="number"
                name="percent"
                min="0.01"
                max="100"
                step="0.01"
                required
                defaultValue="30"
                data-testid="partial-percent"
                className="min-h-11 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
              />
            </label>
          ) : (
            <fieldset className="grid gap-1.5">
              <legend className="text-sm font-semibold text-slate-800">Positionen</legend>
              {chain.orderLines.map((line) => (
                <label key={line.id} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    name="lineIds"
                    value={line.id}
                    disabled={line.consumed}
                    className="h-4 w-4"
                  />
                  <span className={line.consumed ? "text-slate-400 line-through" : undefined}>
                    Pos. {line.position} — {line.name} ({formatEuro(line.grossCents)}
                    {line.consumed ? ", verbraucht" : null})
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <div>
            <button
              type="submit"
              data-testid="partial-invoice-submit"
              className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
            >
              Teilrechnung anlegen
            </button>
          </div>
        </form>
      ) : null}
      <Feedback state={state} workspaceId={workspaceId} />
    </section>
  );
}
