"use client";

import { useActionState, useState } from "react";
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

// F8-03 Split: Cent → EUR-Text für die Betragsvorbelegung (deutsches
// Dezimalkomma, wie parseEuroCents es liest).
function centsToEurInput(cents: number): string {
  return (cents / 100).toFixed(2).replace(".", ",");
}

function errorText(state: InvoicingUiActionState): string | null {
  switch (state.status) {
    case "invalid": return "Die Eingabe ist ungültig.";
    case "not_found": return "Der Beleg wurde nicht gefunden.";
    case "conflict": return "Diese Anrechnung ist nicht möglich (Status, Kette, Betrag oder bereits angerechnet).";
    case "precondition": return "Vorbedingungen sind nicht erfüllt.";
    case "denied": return "Dir fehlt die Berechtigung für diese Aktion.";
    case "unauthenticated": return "Deine Sitzung ist abgelaufen.";
    default: return null;
  }
}

// F8-01 · Anrechnung ausgestellter Anzahlungen (genau eine Stufe).
// F8-02 · optionaler Teilbetrag je Link (Default = volles Brutto).
// F8-03 · Split: Kandidaten mit verfügbarem Rest, Vorbelegung
// min(Rest Anzahlung, Rest Schlussrechnung); Anzahlungs-Detail zeigt
// Allokationen je Schlussrechnung. Server-renderte Listen + Restbetrag;
// Formulare nur mit Schreibrecht (Server-Action bleibt die
// Sicherheitsgrenze).
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
  const [selectedDepositId, setSelectedDepositId] = useState<string | null>(null);
  const { document, linkedDeposits, remainingCents, allocatedFinals, allocatedRestCents } = detail;
  const canWrite = document.permissions.canWrite;
  const linkError = errorText(linkState) ?? errorText(unlinkState);
  const selectedCandidate = candidates.find((candidate) => candidate.id === selectedDepositId)
    ?? candidates[0]
    ?? null;
  const suggestedCents = selectedCandidate === null || remainingCents === null
    ? null
    : Math.min(selectedCandidate.appliedCents, remainingCents);

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
                  {deposit.number ? `${deposit.name} · ` : ""}
                  {deposit.appliedCents === deposit.grossCents
                    ? formatEuro(deposit.grossCents)
                    : `${formatEuro(deposit.appliedCents)} von ${formatEuro(deposit.grossCents)}`}
                </span>
              </span>
              <span className="flex items-center gap-3">
                <span className="font-semibold tabular-nums text-slate-900">
                  −{formatEuro(deposit.appliedCents)}
                </span>
                {canWrite ? (
                  <form action={unlinkDispatch} className="inline">
                    <input type="hidden" name="workspaceId" value={workspaceId} />
                    <input type="hidden" name="finalId" value={document.id} />
                    <input type="hidden" name="depositId" value={deposit.id} />
                    <button
                      type="submit"
                      aria-label={`Anrechnung ${deposit.number ?? deposit.name} entfernen`}
                      className="inline-flex min-h-9 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
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
      {allocatedFinals.length > 0 ? (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <h3 className="text-sm font-semibold text-slate-800">Auf Schlussrechnungen verteilt</h3>
          <ul className="mt-2 divide-y divide-slate-100">
            {allocatedFinals.map((final) => (
              <li key={final.id} className="flex items-center justify-between gap-4 py-2 text-sm">
                <span className="text-slate-800">
                  {final.number ?? final.name}
                  <span className="block text-xs text-slate-500">
                    {final.number ? `${final.name} · ` : ""}
                    {formatEuro(final.appliedCents)} von {formatEuro(final.grossCents)}
                  </span>
                </span>
                <span className="font-semibold tabular-nums text-slate-900">
                  −{formatEuro(final.appliedCents)}
                </span>
              </li>
            ))}
          </ul>
          {allocatedRestCents !== null ? (
            <p className="mt-2 text-sm text-slate-600">
              Noch verfügbar: <span className="font-semibold tabular-nums text-slate-900">{formatEuro(allocatedRestCents)}</span>
            </p>
          ) : null}
        </div>
      ) : null}
      {canWrite && document.status !== "voided" && document.type === "invoice" ? (
        candidates.length === 0 ? (
          <p className="mt-3 text-sm leading-6 text-slate-500">
            Keine anrechenbaren Anzahlungen vorhanden (nur ausgestellte, noch nicht angerechnete Rechnungen).
          </p>
        ) : (
          <form action={linkDispatch} key={selectedCandidate?.id ?? "none"} className="mt-3 flex flex-wrap items-end gap-2">
            <input type="hidden" name="workspaceId" value={workspaceId} />
            <input type="hidden" name="finalId" value={document.id} />
            <label className="block">
              <span className="block text-sm font-semibold text-slate-800">Anzahlung / Gutschrift</span>
              <select
                name="depositId"
                required
                value={selectedCandidate?.id ?? ""}
                onChange={(event) => setSelectedDepositId(event.target.value)}
                className="mt-1 min-h-11 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              >
                {candidates.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.number ?? candidate.name} · {formatEuro(candidate.grossCents)}
                    {candidate.kind === "credit" ? " · Gutschrift" : ""}
                    {candidate.appliedCents < candidate.grossCents
                      ? ` · noch ${formatEuro(candidate.appliedCents)} verfügbar`
                      : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="block text-sm font-semibold text-slate-800">Betrag in EUR (optional)</span>
              <input
                name="appliedEur"
                type="text"
                inputMode="decimal"
                placeholder="volles Brutto"
                defaultValue={suggestedCents === null ? undefined : centsToEurInput(suggestedCents)}
                className="mt-1 min-h-11 w-36 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-600/30"
              />
            </label>
            <button
              type="submit"
              className="inline-flex min-h-11 items-center rounded-md bg-brand-700 px-4 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
            >
              Anrechnen
            </button>
          </form>
        )
      ) : null}
    </section>
  );
}
