"use client";

import { useActionState } from "react";
import {
  linkDepositAction,
  unlinkDepositAction,
  type InvoicingUiActionState,
} from "../../actions";
import { formatEuro } from "../../labels";
import type {
  CommercialDocumentDetailV1,
  CommercialDocumentLinkedDepositV1,
} from "@/lib/integrations/invoicing/contract";

const initialState: InvoicingUiActionState = { status: "idle" };

function errorText(state: InvoicingUiActionState): string | null {
  switch (state.status) {
    case "invalid": return "Die Eingabe ist ungültig.";
    case "not_found": return "Der Beleg wurde nicht gefunden.";
    case "conflict": return "Diese Anrechnung ist nicht möglich (Status, Kette oder bereits angerechnet).";
    case "precondition": return "Vorbedingungen sind nicht erfüllt.";
    case "denied": return "Dir fehlt die Berechtigung für diese Aktion.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen.";
    default: return null;
  }
}

// F8-01 · Anrechnung ausgestellter Anzahlungen (Voll-Brutto, genau eine
// Stufe). Server-renderte Liste + Restbetrag; Formulare nur mit
// Schreibrecht (Server-Action bleibt die Sicherheitsgrenze).
export function DepositLinkPanel({
  workspaceId,
  detail,
  candidates,
}: {
  workspaceId: string;
  detail: CommercialDocumentDetailV1;
  candidates: CommercialDocumentLinkedDepositV1[];
}) {
  const [linkState, linkDispatch] = useActionState(linkDepositAction, initialState);
  const [unlinkState, unlinkDispatch] = useActionState(unlinkDepositAction, initialState);
  const { document, linkedDeposits, remainingCents } = detail;
  const canWrite = document.permissions.canWrite;
  const linkError = errorText(linkState) ?? errorText(unlinkState);

  return (
    <section
      aria-label="Anrechnung"
      data-invoice-detail="deposits"
      className="mt-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
    >
      <h2 className="text-base font-semibold text-slate-950">Anrechnung</h2>
      {linkError ? (
        <p role="alert" className="mt-2 text-sm font-semibold text-red-700">
          {linkError}
        </p>
      ) : null}
      {linkedDeposits.length === 0 ? (
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Keine Anzahlungen angerechnet.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {linkedDeposits.map((deposit) => (
            <li key={deposit.id} className="flex items-center justify-between gap-4 py-2 text-sm">
              <span className="text-slate-800">
                {deposit.number ?? deposit.name}
                <span className="block text-xs text-slate-500">
                  {deposit.number ? `${deposit.name} · ` : ""}{formatEuro(deposit.grossCents)}
                </span>
              </span>
              <span className="flex items-center gap-3">
                <span className="font-semibold tabular-nums text-slate-900">
                  −{formatEuro(deposit.grossCents)}
                </span>
                {canWrite ? (
                  <form action={unlinkDispatch} className="inline">
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="finalId" value={document.id} />
                    <input type="hidden" name="depositId" value={deposit.id} />
                    <button
                      type="submit"
                      aria-label={`Anrechnung ${deposit.number ?? deposit.name} entfernen`}
                      className="inline-flex min-h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                    >
                      Entfernen
                    </button>
                  </form>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {remainingCents !== null ? (
        <dl className="mt-3 border-t border-slate-100 pt-3 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-slate-600">Offener Restbetrag</dt>
            <dd className="font-semibold tabular-nums text-slate-900">{formatEuro(remainingCents)}</dd>
          </div>
        </dl>
      ) : null}
      {canWrite && document.status !== "voided" ? (
        candidates.length === 0 ? (
          <p className="mt-3 text-sm leading-6 text-slate-500">
            Keine anrechenbaren Anzahlungen vorhanden (nur ausgestellte, noch nicht angerechnete Rechnungen).
          </p>
        ) : (
          <form action={linkDispatch} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="finalId" value={document.id} />
            <label className="block">
              <span className="block text-sm font-semibold text-slate-800">Anzahlung</span>
              <select
                name="depositId"
                required
                className="mt-1 min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-600/30"
              >
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.number ?? candidate.name} · {formatEuro(candidate.grossCents)}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              className="inline-flex min-h-11 items-center rounded-md bg-blue-700 px-4 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
            >
              Anrechnen
            </button>
          </form>
        )
      ) : null}
    </section>
  );
}
