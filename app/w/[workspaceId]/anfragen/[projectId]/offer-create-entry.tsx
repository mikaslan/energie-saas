"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";
import {
  createOfferFromRequestAction,
  type OfferActionState,
} from "@/app/w/[workspaceId]/angebote/actions";
import offerThemeStyles from "../../angebote/offer-theme.module.css";
import {
  euroForecastToCents,
  type OfferCreateEntryView,
} from "./offer-create-view";

function retryDateLabel(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "zu einem späteren Zeitpunkt";
  return new Intl.DateTimeFormat("de-DE", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(parsed);
}

function blockedOfferCopy(code: string): { title: string; detail: string } {
  const copies: Record<string, { title: string; detail: string }> = {
    address_not_confirmed: {
      title: "Anlagenstandort erneut prüfen",
      detail: "Die bestätigte Kundenadresse ist nicht mehr aktuell.",
    },
    calculation_not_current: {
      title: "Berechnung aktualisieren",
      detail: "Die aktuelle Berechnung passt nicht mehr zur Angebotsgrundlage.",
    },
    resolution_not_current: {
      title: "Produktauswahl aktualisieren",
      detail: "Die aufgelöste Produktauswahl ist nicht mehr aktuell.",
    },
    catalog_pricing_missing: {
      title: "Katalogpreise vervollständigen",
      detail: "Mindestens ein benötigter Produktpreis fehlt.",
    },
    offer_pricing_out_of_range: {
      title: "Produktpreise prüfen",
      detail: "Mindestens ein Preis liegt außerhalb des zulässigen Bereichs.",
    },
    installation_site_changed: {
      title: "Standortänderung prüfen",
      detail: "Der Anlagenstandort wurde seit der letzten Prüfung verändert.",
    },
  };
  return copies[code] ?? {
    title: "Angebotsgrundlage erneut prüfen",
    detail: "Eine serverseitige Voraussetzung ist nicht mehr erfüllt.",
  };
}

export function OfferCreateFeedback({
  state,
}: {
  state: OfferActionState;
}) {
  if (state.status === "idle") return null;
  if (state.status === "pending") {
    return (
      <p role="status" className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold text-blue-950">
        Angebotsentwurf wird serverseitig erstellt …
      </p>
    );
  }

  const sharedClass = "rounded-md border px-4 py-3 text-sm leading-6";
  if (state.status === "invalid") {
    return (
      <div role="alert" tabIndex={-1} className={`${sharedClass} border-rose-300 bg-rose-50 text-rose-950`}>
        <p className="font-semibold">Eingaben prüfen</p>
        <p className="mt-1">
          Mindestens eine Voraussetzung oder Bestätigung ist nicht mehr gültig.
          Deine Eingaben bleiben erhalten; prüfe die Auswahl und versuche es erneut.
        </p>
      </div>
    );
  }
  if (state.status === "denied") {
    return (
      <div role="alert" tabIndex={-1} className={`${sharedClass} border-rose-300 bg-rose-50 text-rose-950`}>
        <p className="font-semibold">Berechtigung nicht mehr vorhanden</p>
        <p className="mt-1">Der Angebotsentwurf wurde nicht erstellt. Deine Eingaben bleiben lokal erhalten.</p>
      </div>
    );
  }
  if (state.status === "blocked") {
    const copy = blockedOfferCopy(state.code);
    return (
      <div role="alert" tabIndex={-1} className={`${sharedClass} border-amber-300 bg-amber-50 text-amber-950`}>
        <p className="font-semibold">{copy.title}</p>
        <p className="mt-1">{copy.detail} Es wurde nichts erstellt; deine Eingaben bleiben lokal erhalten.</p>
      </div>
    );
  }
  if (state.status === "conflict") {
    return (
      <div role="alert" tabIndex={-1} className={`${sharedClass} border-amber-300 bg-amber-50 text-amber-950`}>
        <p className="font-semibold">Der Projektstand hat sich geändert</p>
        <p className="mt-1">
          Es wurde nichts erstellt. Lade die Projektakte bewusst neu und prüfe die
          aktuellen Planungs- und Produktrevisionen.
        </p>
      </div>
    );
  }
  if (state.status === "unavailable") {
    return (
      <div role="alert" tabIndex={-1} className={`${sharedClass} border-amber-300 bg-amber-50 text-amber-950`}>
        <p className="font-semibold">Angebotsaktionen sind vorübergehend ausgeschöpft</p>
        <p className="mt-1">
          Versuche es nach {retryDateLabel(state.retryAfter)} erneut. Es startet kein automatischer Versuch.
        </p>
      </div>
    );
  }
  return (
    <div role="alert" tabIndex={-1} className={`${sharedClass} border-amber-300 bg-amber-50 text-amber-950`}>
      <p className="font-semibold">Deine Sitzung ist abgelaufen</p>
      <p className="mt-1">Der Angebotsentwurf wurde nicht erstellt. Deine Eingaben bleiben bis zur Navigation erhalten.</p>
      <Link
        href="/login"
        className="mt-3 inline-flex min-h-11 items-center rounded-md border border-amber-300 bg-white px-4 font-semibold outline-none"
      >
        Erneut anmelden
      </Link>
    </div>
  );
}

function OfferCreateForm({
  view,
}: {
  view: Extract<OfferCreateEntryView, { state: "ready" }>;
}) {
  const [actionState, formAction, isPending] = useActionState(
    createOfferFromRequestAction,
    { status: "idle" },
  );
  const [forecastEuro, setForecastEuro] = useState("");
  const [taxTreatment, setTaxTreatment] = useState("");
  const [b2cConfirmed, setB2cConfirmed] = useState(false);
  const [zeroConfirmed, setZeroConfirmed] = useState(false);
  const [retryClock, setRetryClock] = useState(0);
  const feedbackRef = useRef<HTMLDivElement>(null);
  const forecastCents = euroForecastToCents(forecastEuro);
  const feedbackState: OfferActionState = isPending
    ? { status: "pending" }
    : actionState;

  useEffect(() => {
    if (actionState.status !== "unavailable") return;
    const retryAt = Date.parse(actionState.retryAfter);
    if (!Number.isFinite(retryAt)) return;
    const timer = window.setInterval(() => setRetryClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [actionState]);

  useEffect(() => {
    if (actionState.status !== "idle" && actionState.status !== "pending") {
      feedbackRef.current?.focus();
    }
  }, [actionState]);

  const retryBlocked = actionState.status === "unavailable"
    && (
      !Number.isFinite(Date.parse(actionState.retryAfter))
      || retryClock < Date.parse(actionState.retryAfter)
    );
  const actionBlocked = actionState.status === "conflict"
    || actionState.status === "blocked"
    || actionState.status === "denied"
    || actionState.status === "unauthenticated"
    || retryBlocked;

  return (
    <form action={formAction} aria-busy={isPending} className="mt-6 grid gap-6">
      <input type="hidden" name="workspaceId" value={view.workspaceId} />
      <input type="hidden" name="projectId" value={view.projectId} />
      <input
        type="hidden"
        name="expectedRequirementRevision"
        value={view.input.expectedRequirementRevision}
      />
      <input
        type="hidden"
        name="expectedCalculationRevision"
        value={view.input.expectedCalculationRevision}
      />
      <input
        type="hidden"
        name="expectedResolutionRevision"
        value={view.input.expectedResolutionRevision}
      />
      <input type="hidden" name="forecastValueNetCents" value={forecastCents ?? ""} />
      <input type="hidden" name="priceAudience" value="b2c" />
      <input
        type="hidden"
        name="priceAudienceConfirmation.code"
        value="b2c_operator_confirmed"
      />

      <fieldset disabled={isPending} className="grid gap-6">
        <legend className="sr-only">Angebotsentwurf qualifizieren und erstellen</legend>

        <dl className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <div className="min-w-0">
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Kunde</dt>
            <dd className="mt-1 break-words text-sm font-semibold text-slate-950">{view.customerDisplayName}</dd>
          </div>
          <div className="min-w-0">
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Anlagenstandort</dt>
            <dd className="mt-1 break-words text-sm font-semibold text-slate-950">{view.installationSiteLabel}</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Anlagenart</dt>
            <dd className="mt-1 text-sm font-semibold text-slate-950">Wohngebäude (residential)</dd>
          </div>
          <div>
            <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">Serverstand</dt>
            <dd className="mt-1 text-sm font-semibold tabular-nums text-slate-950">
              Bedarf {view.input.expectedRequirementRevision} · Rechnung {view.input.expectedCalculationRevision} · Produkte {view.input.expectedResolutionRevision}
            </dd>
          </div>
        </dl>

        <div className="grid gap-5 md:grid-cols-2 md:items-start">
          <div>
            <label htmlFor="offer-forecast-euro" className="block text-sm font-semibold text-slate-900">
              Forecast netto in Euro (optional)
            </label>
            <input
              id="offer-forecast-euro"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={forecastEuro}
              onChange={(event) => setForecastEuro(event.currentTarget.value)}
              aria-describedby="offer-forecast-help offer-forecast-error"
              aria-invalid={forecastCents === null}
              className="mt-2 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base tabular-nums text-slate-950 outline-none"
              placeholder="z. B. 25.000,00"
            />
            <p id="offer-forecast-help" className="mt-2 text-sm leading-6 text-slate-600">
              Reine Vertriebsprognose. Sie verändert keine Position und keine Kundensumme.
            </p>
            {forecastCents === null ? (
              <p id="offer-forecast-error" role="alert" className="mt-2 text-sm font-semibold text-rose-800">
                Gib einen nicht negativen Eurobetrag mit höchstens zwei Nachkommastellen ein.
              </p>
            ) : null}
          </div>

          <div>
            <label htmlFor="offer-tax-treatment" className="block text-sm font-semibold text-slate-900">
              Steuerentwurf
            </label>
            <select
              id="offer-tax-treatment"
              name="taxTreatment"
              required
              value={taxTreatment}
              onChange={(event) => {
                const nextTreatment = event.currentTarget.value;
                setTaxTreatment(nextTreatment);
                if (nextTreatment !== "zero_operator_confirmed") {
                  setZeroConfirmed(false);
                }
              }}
              aria-describedby="offer-tax-help"
              className="mt-2 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-950 outline-none"
            >
              <option value="">Bitte ausdrücklich auswählen</option>
              <option value="standard_19">19 % · Standard-Entwurf</option>
              <option value="zero_operator_confirmed">0 % · nach eigener Prüfung</option>
            </select>
            <p id="offer-tax-help" className="mt-2 text-sm leading-6 text-slate-600">
              Keine Steuerbehandlung wird aus Adresse oder Produkten abgeleitet.
              Den 0-%-Steuerentwurf musst du zusätzlich ausdrücklich bestätigen.
            </p>
          </div>
        </div>

        <label className="flex min-h-11 items-start gap-3 rounded-md border border-slate-300 bg-white px-4 py-3 text-sm leading-6 text-slate-800">
          <input
            type="checkbox"
            name="priceAudienceConfirmation.confirmed"
            value="true"
            required
            checked={b2cConfirmed}
            onChange={(event) => setB2cConfirmed(event.currentTarget.checked)}
            className="mt-1 size-5 shrink-0 accent-emerald-800"
          />
          <span>
            <strong className="block text-slate-950">B2C-Preiszielgruppe ausdrücklich bestätigen</strong>
            Ich habe geprüft, dass dieses Angebot für private Endkundschaft bestimmt ist.
          </span>
        </label>

        {taxTreatment === "zero_operator_confirmed" ? (
          <label className="flex min-h-11 items-start gap-3 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
            <input
              type="hidden"
              name="zeroConfirmation.code"
              value="zero_tax_draft_operator_confirmed"
            />
            <input
              type="checkbox"
              name="zeroConfirmation.confirmed"
              value="true"
              required
              checked={zeroConfirmed}
              onChange={(event) => setZeroConfirmed(event.currentTarget.checked)}
              className="mt-1 size-5 shrink-0 accent-emerald-800"
            />
            <span>
              <strong className="block">0-%-Steuerentwurf ausdrücklich bestätigen</strong>
              Ich habe den 0-%-Entwurf für diesen Vorgang selbst geprüft. Das ist noch keine steuerliche Festschreibung.
            </span>
          </label>
        ) : null}

        <div
          ref={feedbackRef}
          tabIndex={actionState.status === "idle" ? undefined : -1}
          aria-live="polite"
          aria-atomic="true"
        >
          <OfferCreateFeedback state={feedbackState} />
        </div>

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          {actionState.status === "conflict" || actionState.status === "blocked" ? (
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex min-h-11 items-center justify-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-800 outline-none"
            >
              Projektakte bewusst neu laden
            </button>
          ) : <span />}
          <button
            type="submit"
            disabled={isPending || actionBlocked || forecastCents === null || taxTreatment === ""}
            className="inline-flex min-h-11 items-center justify-center rounded-md bg-slate-950 px-5 py-3 text-sm font-semibold text-white outline-none hover:bg-slate-800"
          >
            {isPending ? "Wird erstellt …" : "Angebot erstellen"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}

export function OfferCreateEntry({ view }: { view: OfferCreateEntryView }) {
  if (view.state === "read_only") {
    return (
      <section
        data-offer-create-state="read_only"
        data-wmee-scope="offer"
        aria-labelledby="offer-create-heading"
        className={`${offerThemeStyles.offerTheme} rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6`}
      >
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-blue-700">Angebotsphase</p>
        <h2 id="offer-create-heading" className="mt-2 text-lg font-semibold text-slate-950">Angebotsentwurf erstellen</h2>
        <div role="status" className="mt-4 rounded-md border border-slate-200 bg-slate-50 px-4 py-3">
          <p className="text-sm font-semibold text-slate-950">Nur Lesezugriff</p>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            Du kannst die Angebotsbereitschaft sehen, aber keine Anfrage konvertieren.
          </p>
        </div>
      </section>
    );
  }

  if (view.state === "converted") {
    return (
      <section
        data-offer-create-state="converted"
        data-wmee-scope="offer"
        aria-labelledby="offer-create-heading"
        className={`${offerThemeStyles.offerTheme} rounded-lg border border-emerald-200 bg-white p-5 shadow-sm sm:p-6`}
      >
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">Angebotsphase</p>
        <h2 id="offer-create-heading" className="mt-2 text-lg font-semibold text-slate-950">Angebot ist bereits angelegt</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Das Projekt befindet sich nicht mehr in der Anfragephase.
        </p>
        <Link href={view.offersHref} className="mt-4 inline-flex min-h-11 items-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none">
          Angebotsübersicht öffnen
        </Link>
      </section>
    );
  }

  if (view.state === "blocked") {
    return (
      <section
        data-offer-create-state="blocked"
        data-wmee-scope="offer"
        aria-labelledby="offer-create-heading"
        className={`${offerThemeStyles.offerTheme} rounded-lg border border-amber-300 bg-white p-5 shadow-sm sm:p-6`}
      >
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-amber-800">Noch nicht bereit</p>
        <h2 id="offer-create-heading" className="mt-2 text-lg font-semibold text-slate-950">Angebotsentwurf erstellen</h2>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Schließe die folgenden Voraussetzungen. Der Server prüft sie bei der Konvertierung erneut.
        </p>
        <ul role="alert" className="mt-5 grid gap-3">
          {view.blockers.map((blocker) => (
            <li key={blocker.code} className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3">
              <p className="text-sm font-semibold text-amber-950">{blocker.label}</p>
              <Link href={blocker.href} className="mt-2 inline-flex min-h-11 items-center text-sm font-semibold text-blue-900 underline decoration-2 underline-offset-4 outline-none">
                {blocker.actionLabel}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section
      data-offer-create-state="ready"
      data-wmee-scope="offer"
      aria-labelledby="offer-create-heading"
      className={`${offerThemeStyles.offerTheme} rounded-lg border border-emerald-200 bg-white p-5 shadow-sm sm:p-6`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">Bereit für die Angebotsphase</p>
          <h2 id="offer-create-heading" className="mt-2 text-xl font-semibold tracking-tight text-slate-950">Angebotsentwurf erstellen</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600">
            Der Server kopiert den aktuellen Kunden-, Standort-, Planungs- und Produktstand in eine unveränderliche erste Variante. Browserwerte werden nicht als Preiswahrheit übernommen.
          </p>
        </div>
        <span className="inline-flex min-h-8 shrink-0 items-center self-start rounded-full border border-emerald-300 bg-emerald-50 px-3 text-xs font-semibold text-emerald-950">
          Serverstand aktuell
        </span>
      </div>
      <OfferCreateForm view={view} />
    </section>
  );
}
