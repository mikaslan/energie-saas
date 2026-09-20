"use client";

import { useActionState, useState } from "react";
import type { PortalFinancing } from "@/lib/integrations/portal/portal-contract";
import {
  requestPortalFinancingAction,
  type FinancingCaseActionState,
} from "../../w/[workspaceId]/anfragen/[projectId]/financing-case-actions";

const initialState: FinancingCaseActionState = { status: "idle" };

// TODO(F13-15/Owner): durch portal-language-Worte (de/en/cs/el) ersetzen;
// bis dahin deutsch (portal-language ist Owner-Besitz). 6er-Wortschatz ohne
// storniert (storniert blendet der DEFINER als null aus, kein Block/Formular).
const PORTAL_FINANCING_STATUS_LABEL: Record<PortalFinancing["status"], string> = {
  beantragt: "Beantragt",
  bonitaet: "In Prüfung",
  entschieden: "Entschieden",
  ausgezahlt: "Ausgezahlt",
  abgeschlossen: "Abgeschlossen",
  abgelehnt: "Abgelehnt",
};

const PORTAL_FINANCING_PRODUKTTYP_LABEL: Record<PortalFinancing["produkttyp"], string> = {
  ratenkauf: "Ratenkauf",
  kredit: "Kredit",
};

const DISCLAIMER =
  "Wir vermitteln keine Finanzierung und beraten nicht — wir leiten Ihre Anfrage nur an den Partner weiter und zeigen den Stand an.";

function Feedback({ state }: { state: FinancingCaseActionState }) {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return (
      <p
        role="status"
        data-testid="portal-financing-feedback"
        className="mt-2 text-sm font-semibold text-emerald-700"
      >
        {state.message}
      </p>
    );
  }
  const message =
    state.status === "invalid"
      ? "Die Eingabe ist ungültig. Bitte prüfen Sie Produkttyp, Laufzeit und Volumen."
      : state.status === "not_found"
        ? "Der Antrag ist nicht mehr verfügbar."
        : "Der Antrag ist derzeit nicht möglich.";
  return (
    <p
      role="alert"
      data-testid="portal-financing-feedback"
      className="mt-2 text-sm font-semibold text-red-700"
    >
      {message}
    </p>
  );
}

function formatDate(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// F13-15 §4 Portal: Status-Block lesend (grober Stand) ODER Antragsformular
// (Produkttyp + Wunschlaufzeit + Wunschvolumen, ohne Signaturbindung),
// immer mit §5-Disclaimer. Mount durch Owner (siehe /tmp/f1315-J-TODO.md).
// KEIN Chat (deferred F13-15b).
export function PortalFinancingSection({
  token,
  financing,
}: {
  token: string;
  financing: PortalFinancing | null;
}) {
  const [requestState, requestDispatch] = useActionState(
    requestPortalFinancingAction,
    initialState,
  );
  const [produkttyp, setProdukttyp] = useState("ratenkauf");
  const isRatenkauf = produkttyp === "ratenkauf";
  const entschiedenAm = financing === null ? null : formatDate(financing.entschiedenAt);
  const ausgezahltAm = financing === null ? null : formatDate(financing.ausgezahltAt);

  return (
    <div className="mt-6" data-testid="portal-financing-section">
      <h2 className="text-lg font-semibold text-slate-950">Finanzierung</h2>
      <p className="mt-1 text-sm leading-6 text-slate-600" data-testid="portal-financing-disclaimer">
        {DISCLAIMER}
      </p>
      {financing === null ? (
        <form
          action={requestDispatch}
          data-testid="portal-financing-form"
          className="mt-2 flex flex-wrap items-end gap-2"
        >
          <input type="hidden" name="token" value={token} />
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Produkttyp
            <select
              name="produkttyp"
              value={produkttyp}
              onChange={(event) => setProdukttyp(event.target.value)}
              data-testid="portal-financing-produkttyp"
              className="min-h-11 min-w-36 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
            >
              <option value="ratenkauf">Ratenkauf</option>
              <option value="kredit">Kredit</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Wunschlaufzeit (Jahre)
            <input
              type="number"
              name="laufzeitJahre"
              required
              min={1}
              max={isRatenkauf ? 25 : undefined}
              step={1}
              data-testid="portal-financing-laufzeit"
              className="min-h-11 min-w-28 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium text-slate-700">
            Wunschvolumen (€)
            <input
              type="number"
              name="volumenEur"
              required
              min={1}
              max={isRatenkauf ? 70000 : undefined}
              step={1}
              data-testid="portal-financing-volumen"
              className="min-h-11 min-w-28 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
            />
          </label>
          <button
            type="submit"
            data-testid="portal-financing-submit"
            className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
          >
            Finanzierung anfragen
          </button>
          <p className="w-full text-sm text-slate-500">
            Ratenkauf: 1–25 Jahre, bis 70.000 €. Entwurf ohne Unterschrift.
          </p>
        </form>
      ) : (
        <dl className="mt-2 space-y-2 text-sm leading-6 text-slate-600">
          <div className="flex gap-2">
            <dt className="font-semibold text-slate-800">Status</dt>
            <dd data-testid="portal-financing-status">
              {PORTAL_FINANCING_STATUS_LABEL[financing.status]}
              {` (${PORTAL_FINANCING_PRODUKTTYP_LABEL[financing.produkttyp]})`}
              {entschiedenAm ? ` · entschieden am ${entschiedenAm}` : null}
              {ausgezahltAm ? ` · ausgezahlt am ${ausgezahltAm}` : null}
            </dd>
          </div>
        </dl>
      )}
      <Feedback state={requestState} />
    </div>
  );
}
