"use client";

import { useActionState, useState } from "react";
import {
  FINANCING_CASE_STATUS_LABEL,
  FINANCING_PRODUKTTYP_LABEL,
  FINANCING_PROVIDER_LABEL,
  nextFinancingCaseStatuses,
  type FinancingCaseDto,
  type FinancingProdukttyp,
} from "@/lib/financing-case";
import {
  createFinancingCaseAction,
  setFinancingCaseStatusAction,
  type FinancingCaseActionState,
} from "./financing-case-actions";

const initialState: FinancingCaseActionState = { status: "idle" };

// F13-15 §5: exakter Spec-Wortlaut (sinngemäß gefordert, wörtlich übernommen).
const DISCLAIMER =
  "Wir vermitteln keine Finanzierung und beraten nicht — wir leiten Ihre Anfrage nur an den Partner weiter und zeigen den Stand an.";

function Feedback({ state, testId }: { state: FinancingCaseActionState; testId: string }) {
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

function formatVolumenEur(volumenEurCents: number): string {
  return (volumenEurCents / 100).toLocaleString("de-DE", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });
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

// F13-15 Finanzierungs-Intake: Anlege-Formular (Produkttyp/Laufzeit/Volumen/
// Provider/Referenz, Ratenkauf-Schranken), Statuskette per Folge-Buttons,
// manueller Editor-Pfad §3 (Referenz + Status per Hand), Historie lesend,
// §5-Disclaimer. KEIN Preis-UI, KEINE Beratungstexte, KEIN Chat (F13-15b).
export function FinancingCaseSection({
  workspaceId,
  projectId,
  activeCase,
  history,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  activeCase: FinancingCaseDto | null;
  history: FinancingCaseDto[];
  canWrite: boolean;
}) {
  const [createState, createDispatch] = useActionState(createFinancingCaseAction, initialState);
  const [transitionState, transitionDispatch] = useActionState(
    setFinancingCaseStatusAction,
    initialState,
  );
  const [produkttyp, setProdukttyp] = useState<FinancingProdukttyp>("ratenkauf");
  const next = activeCase === null ? [] : nextFinancingCaseStatuses(activeCase.status);
  const isRatenkauf = produkttyp === "ratenkauf";
  const beantragtAm = activeCase === null ? null : formatDate(activeCase.beantragtAt ?? null);

  return (
    <section aria-label="Finanzierung" className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Finanzierung</h2>
      <p className="mt-1 text-sm text-slate-600" data-testid="financing-case-disclaimer">
        {DISCLAIMER}
      </p>
      {activeCase === null ? (
        <div className="mt-2">
          <p className="text-sm text-slate-600" data-testid="financing-case-current">
            Noch kein Finanzierungsvorgang für dieses Projekt.
          </p>
          {canWrite ? (
            <form action={createDispatch} className="mt-3 flex flex-wrap items-end gap-2">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <label className="grid gap-1 text-sm font-medium text-slate-700">
                Produkttyp
                <select
                  name="produkttyp"
                  value={produkttyp}
                  onChange={(event) => setProdukttyp(event.target.value as FinancingProdukttyp)}
                  data-testid="financing-case-produkttyp"
                  className="min-h-11 min-w-36 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                >
                  <option value="ratenkauf">Ratenkauf</option>
                  <option value="kredit">Kredit</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm font-medium text-slate-700">
                Laufzeit (Jahre)
                <input
                  type="number"
                  name="laufzeitJahre"
                  required
                  min={1}
                  max={isRatenkauf ? 25 : undefined}
                  step={1}
                  data-testid="financing-case-laufzeit"
                  className="min-h-11 min-w-28 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium text-slate-700">
                Volumen (€)
                <input
                  type="number"
                  name="volumenEur"
                  required
                  min={1}
                  max={isRatenkauf ? 70000 : undefined}
                  step={1}
                  data-testid="financing-case-volumen"
                  className="min-h-11 min-w-28 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                />
              </label>
              <label className="grid gap-1 text-sm font-medium text-slate-700">
                Partner
                <select
                  name="provider"
                  defaultValue="bees_bears"
                  data-testid="financing-case-provider"
                  className="min-h-11 min-w-36 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                >
                  <option value="bees_bears">Bees &amp; Bears</option>
                  <option value="psd_bank">PSD Bank</option>
                </select>
              </label>
              <label className="grid gap-1 text-sm font-medium text-slate-700">
                Provider-Referenz (optional)
                <input
                  type="text"
                  name="providerReferenz"
                  maxLength={200}
                  data-testid="financing-case-referenz"
                  className="min-h-11 min-w-36 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                />
              </label>
              <button
                type="submit"
                data-testid="financing-case-create"
                className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
              >
                Finanzierungsvorgang anlegen
              </button>
              <p className="w-full text-sm text-slate-500">
                Ratenkauf: 1–25 Jahre, bis 70.000 €, nur Bees &amp; Bears.
              </p>
            </form>
          ) : null}
          <Feedback state={createState} testId="financing-case-feedback" />
        </div>
      ) : (
        <div className="mt-2 grid gap-3">
          <p className="text-sm text-slate-700" data-testid="financing-case-current">
            Status:{" "}
            <span className="font-semibold">
              {FINANCING_CASE_STATUS_LABEL[activeCase.status]}
            </span>
            {` · ${FINANCING_PRODUKTTYP_LABEL[activeCase.produkttyp]}`}
            {` · ${activeCase.laufzeitJahre} Jahre`}
            {` · ${formatVolumenEur(activeCase.volumenEurCents)}`}
            {` · ${FINANCING_PROVIDER_LABEL[activeCase.provider]}`}
            {activeCase.providerReferenz ? ` · Ref. ${activeCase.providerReferenz}` : null}
            {beantragtAm ? ` · beantragt am ${beantragtAm}` : null}
          </p>
          {canWrite ? (
            <>
              {next.length > 0 ? (
                <form action={transitionDispatch} className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="workspaceId" value={workspaceId} />
                  <input type="hidden" name="projectId" value={projectId} />
                  <input type="hidden" name="id" value={activeCase.id} />
                  <label className="grid gap-1 text-sm font-medium text-slate-700">
                    Provider-Referenz (manuell, §3)
                    <input
                      type="text"
                      name="providerReferenz"
                      maxLength={200}
                      defaultValue={activeCase.providerReferenz ?? ""}
                      data-testid="financing-case-reference"
                      className="min-h-11 min-w-36 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                    />
                  </label>
                  {next.map((status) => (
                    <button
                      key={status}
                      type="submit"
                      name="status"
                      value={status}
                      data-testid={`financing-case-to-${status}`}
                      className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                    >
                      {FINANCING_CASE_STATUS_LABEL[status]}
                    </button>
                  ))}
                </form>
              ) : null}
              <Feedback state={transitionState} testId="financing-case-transition-feedback" />
            </>
          ) : null}
        </div>
      )}
      {history.length > 0 ? (
        <div className="mt-3 border-t border-slate-200 pt-3" data-testid="financing-case-history">
          <h3 className="text-sm font-semibold text-slate-900">Abgeschlossene Vorgänge</h3>
          <ul className="mt-1 space-y-1 text-sm text-slate-600">
            {history.map((entry) => (
              <li key={entry.id}>
                {FINANCING_CASE_STATUS_LABEL[entry.status]}
                {` · ${FINANCING_PRODUKTTYP_LABEL[entry.produkttyp]}`}
                {` · ${entry.laufzeitJahre} Jahre`}
                {` · ${formatVolumenEur(entry.volumenEurCents)}`}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
