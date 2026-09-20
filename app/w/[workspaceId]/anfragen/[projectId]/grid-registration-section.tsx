"use client";

import { useActionState } from "react";
import {
  GRID_REGISTRATION_EDITABLE_STATUSES,
  GRID_REGISTRATION_STATUS_LABEL,
  nextGridRegistrationStatuses,
  type GridRegistrationDto,
} from "@/modules/grid-registration";
import {
  ensureGridRegistrationAction,
  setGridRegistrationAddonsAction,
  setGridRegistrationDetailsAction,
  transitionGridRegistrationAction,
  type GridRegistrationActionState,
} from "./grid-registration-actions";

const initialState: GridRegistrationActionState = { status: "idle" };

// F13-12 §3: Datei-Slot-Titel als Textvorgabe (Ordner-Ersatz bis zum
// Mappen-Generator; Verknüpfung per Titel-Präfix, keine Automatik).
const FILE_SLOT_STAGE_1 = ["Netz-Vollmacht", "Netz-Zählerfoto", "Netz-Planungs-PDF"] as const;
const FILE_SLOT_STAGE_2 = "Netz-Fertigmeldungs-Fotos";

const ADDON_PRODUKT_LABEL: Record<string, string> = {
  pv: "PV-Anlage",
  wp: "Wärmepumpe",
};

function Feedback({ state, testId }: { state: GridRegistrationActionState; testId: string }) {
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

function formatDue(value: string): string {
  return new Date(value).toLocaleDateString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

function formatBetrag(cents: number): string {
  return (cents / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
}

// F13-02 Netzanmeldung: Anlage (idempotent), Betreiber/Zähler pflegen,
// Statusmaschine per Folge-Buttons. Reine Darstellung gespeicherter Werte.
// F13-12: Details-Sperre §6 (Muster subsidy-case detailsFrozen), Frist §4
// (lesend), Add-ons §5 (eigenes Formular, ohne Sperre), Datei-Slot-Titel
// §3 als Textvorgaben.
export function GridRegistrationSection({
  workspaceId,
  projectId,
  registration,
  canWrite,
}: {
  workspaceId: string;
  projectId: string;
  registration: GridRegistrationDto | null;
  canWrite: boolean;
}) {
  const [ensureState, ensureDispatch] = useActionState(ensureGridRegistrationAction, initialState);
  const [detailsState, detailsDispatch] = useActionState(setGridRegistrationDetailsAction, initialState);
  const [addonsState, addonsDispatch] = useActionState(setGridRegistrationAddonsAction, initialState);
  const [transitionState, transitionDispatch] = useActionState(transitionGridRegistrationAction, initialState);
  const next = registration === null ? [] : nextGridRegistrationStatuses(registration.status);
  const detailsFrozen =
    registration !== null &&
    !(GRID_REGISTRATION_EDITABLE_STATUSES as readonly string[]).includes(registration.status);
  const due = registration?.fertigmeldungDue ?? null;
  const overdue = due !== null && new Date(due).getTime() < new Date().setHours(0, 0, 0, 0);
  const addonNames: string[] = [];
  if (registration?.mastrAddon === true) addonNames.push("MaStR-Service");
  if (registration?.wallboxAddon === true) addonNames.push("Wallbox-Mitmeldung");

  return (
    <section aria-label="Netzanmeldung" className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">Netzanmeldung</h2>
      {registration === null ? (
        <div className="mt-2">
          <p className="text-sm text-slate-600" data-testid="grid-registration-current">
            Noch keine Netzanmeldung für dieses Projekt.
          </p>
          {canWrite ? (
            <form action={ensureDispatch} className="mt-3">
              <input type="hidden" name="workspaceId" value={workspaceId} />
              <input type="hidden" name="projectId" value={projectId} />
              <button
                type="submit"
                data-testid="grid-registration-create"
                className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
              >
                Netzanmeldung anlegen
              </button>
            </form>
          ) : null}
          <Feedback state={ensureState} testId="grid-registration-feedback" />
        </div>
      ) : (
        <div className="mt-2 grid gap-3">
          <p className="text-sm text-slate-700" data-testid="grid-registration-current">
            Status: <span className="font-semibold">{GRID_REGISTRATION_STATUS_LABEL[registration.status]}</span>
            {registration.operatorName ? ` · ${registration.operatorName}` : null}
            {registration.meterNumber ? ` · Zähler ${registration.meterNumber}` : null}
          </p>
          {due !== null ? (
            <p className="text-sm text-slate-700" data-testid="grid-registration-due">
              Fertigmeldung fällig: <span className="font-semibold">{formatDue(due)}</span>
              {overdue ? (
                <span
                  data-testid="grid-registration-overdue"
                  className="ml-2 inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-800"
                >
                  Überfällig
                </span>
              ) : null}
            </p>
          ) : null}
          <p className="text-sm text-slate-700" data-testid="grid-registration-addons">
            {addonNames.length === 0
              ? "Keine Add-ons vorgemerkt."
              : `Add-ons: ${addonNames.join(", ")}${registration.addonProdukt ? ` · ${ADDON_PRODUKT_LABEL[registration.addonProdukt] ?? registration.addonProdukt}` : ""}${typeof registration.addonBetragCents === "number" ? ` · ${formatBetrag(registration.addonBetragCents)}` : ""}`}
          </p>
          <div
            className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2"
            data-testid="grid-registration-file-slots"
          >
            <p className="text-sm font-medium text-slate-800">Datei-Slots (Titel-Vorgaben)</p>
            <ul className="mt-1 list-disc pl-5 text-sm text-slate-600">
              {FILE_SLOT_STAGE_1.map((title) => (
                <li key={title}>
                  {title} <span className="text-slate-500">(Einreichung, je eine Anfrage)</span>
                </li>
              ))}
              <li>
                {FILE_SLOT_STAGE_2}{" "}
                <span className="text-slate-500">(Fertigmeldung, Sammelanfrage, mind. 16 Fotos)</span>
              </li>
            </ul>
            <p className="mt-1 text-sm text-slate-500">
              Als Datei-Anfrage mit diesem Titel anlegen; die Verknüpfung läuft über den Titel.
            </p>
          </div>
          {canWrite ? (
            <>
              {detailsFrozen ? (
                <p className="text-sm text-slate-600" data-testid="grid-registration-frozen-hint">
                  Eingereicht — Betreiber und Zählernummer sind gesperrt (nur noch
                  Statuswechsel; in Rückfrage wieder editierbar).
                </p>
              ) : null}
              <form action={detailsDispatch} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="projectId" value={projectId} />
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Netzbetreiber
                  <input
                    type="text"
                    name="operatorName"
                    maxLength={160}
                    defaultValue={registration.operatorName ?? ""}
                    disabled={detailsFrozen}
                    data-testid="grid-registration-operator"
                    className="min-h-11 min-w-44 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200 disabled:bg-slate-100 disabled:text-slate-500"
                  />
                </label>
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Zählernummer
                  <input
                    type="text"
                    name="meterNumber"
                    maxLength={64}
                    defaultValue={registration.meterNumber ?? ""}
                    disabled={detailsFrozen}
                    data-testid="grid-registration-meter"
                    className="min-h-11 min-w-36 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200 disabled:bg-slate-100 disabled:text-slate-500"
                  />
                </label>
                <button
                  type="submit"
                  disabled={detailsFrozen}
                  data-testid="grid-registration-save"
                  className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:bg-slate-400"
                >
                  Speichern
                </button>
              </form>
              <Feedback state={detailsState} testId="grid-registration-details-feedback" />
              <form action={addonsDispatch} className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="workspaceId" value={workspaceId} />
                <input type="hidden" name="projectId" value={projectId} />
                <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-700">
                  <input
                    type="checkbox"
                    name="mastrAddon"
                    value="on"
                    defaultChecked={registration.mastrAddon === true}
                    data-testid="grid-registration-addon-mastr"
                    className="h-4 w-4 rounded border-slate-300 accent-slate-900"
                  />
                  MaStR-Service
                </label>
                <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-slate-700">
                  <input
                    type="checkbox"
                    name="wallboxAddon"
                    value="on"
                    defaultChecked={registration.wallboxAddon === true}
                    data-testid="grid-registration-addon-wallbox"
                    className="h-4 w-4 rounded border-slate-300 accent-slate-900"
                  />
                  Wallbox-Mitmeldung
                </label>
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Add-on-Produkt
                  <select
                    name="addonProdukt"
                    defaultValue={registration.addonProdukt ?? ""}
                    data-testid="grid-registration-addon-produkt"
                    className="min-h-11 min-w-32 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                  >
                    <option value="">—</option>
                    <option value="pv">PV-Anlage</option>
                    <option value="wp">Wärmepumpe</option>
                  </select>
                </label>
                <label className="grid gap-1 text-sm font-medium text-slate-700">
                  Add-on-Betrag (Cent)
                  <input
                    type="number"
                    name="addonBetragCents"
                    min={0}
                    step={1}
                    defaultValue={typeof registration.addonBetragCents === "number" ? registration.addonBetragCents : ""}
                    data-testid="grid-registration-addon-betrag"
                    className="min-h-11 min-w-28 rounded-md border border-slate-300 bg-white px-2 text-sm outline-none focus:border-brand-600 focus:ring-2 focus:ring-brand-200"
                  />
                </label>
                <button
                  type="submit"
                  data-testid="grid-registration-addons-save"
                  className="inline-flex min-h-11 items-center rounded-md bg-slate-900 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                >
                  Add-ons speichern
                </button>
              </form>
              <Feedback state={addonsState} testId="grid-registration-addons-feedback" />
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
                      data-testid={`grid-registration-to-${status}`}
                      className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2"
                    >
                      {GRID_REGISTRATION_STATUS_LABEL[status]}
                    </button>
                  ))}
                </form>
              ) : null}
              <Feedback state={transitionState} testId="grid-registration-transition-feedback" />
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}
