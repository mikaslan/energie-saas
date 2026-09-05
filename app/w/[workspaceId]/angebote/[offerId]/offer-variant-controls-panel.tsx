"use client";

import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";

import { formatCentsToEuroInput } from "@/lib/integrations/offers/variant-controls";
import {
  setPrimaryVariantEditorAction,
  setTotalOverrideEditorAction,
  setVariantBundlesEditorAction,
} from "../variant-actions";
import {
  SET_PRIMARY_VARIANT_INITIAL_STATE,
  SET_TOTAL_OVERRIDE_INITIAL_STATE,
  SET_VARIANT_BUNDLES_INITIAL_STATE,
  type SetPrimaryVariantEditorState,
  type SetTotalOverrideEditorState,
  type SetVariantBundlesEditorState,
} from "../variant-action-state";
import { formatOfferCents } from "./offer-format";

export interface VariantControlEntry {
  id: string;
  name: string;
  revision: number;
  active?: boolean;
  isPrimary?: boolean;
  bundles?: readonly { name: string; position: number }[];
}

function primaryFeedback(state: SetPrimaryVariantEditorState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return state.alreadyPrimary
      ? "Diese Variante war bereits die primäre Variante."
      : "Die primäre Variante wurde umgeschaltet.";
  }
  if (state.status === "invalid") return "Die Anforderung war ungültig. Lade die Seite neu und versuche es erneut.";
  if (state.status === "unauthenticated") return "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  if (state.status === "denied") return "Du darfst die primäre Variante nicht umschalten.";
  if (state.status === "not_found") return "Die gewählte Variante ist nicht mehr verfügbar.";
  return "Das Umschalten ist vorübergehend nicht möglich. Versuche es später erneut.";
}

function overrideFeedback(state: SetTotalOverrideEditorState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    if (!state.changed) return "Der gespeicherte Deal-Wert war bereits aktuell.";
    return state.cleared
      ? "Der Deal-Override wurde zurückgesetzt; es gilt wieder die Snapshot-Summe."
      : "Der Deal-Override wurde gespeichert.";
  }
  if (state.status === "invalid") return "Der Betrag ist ungültig. Nutze Euro mit höchstens zwei Nachkommastellen.";
  if (state.status === "unauthenticated") return "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  if (state.status === "denied") return "Du darfst den Deal-Wert nicht ändern.";
  if (state.status === "not_found") return "Das Angebot ist nicht mehr verfügbar.";
  return "Das Speichern ist vorübergehend nicht möglich. Versuche es später erneut.";
}

function bundlesFeedback(state: SetVariantBundlesEditorState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return state.changed
      ? "Die optionalen Bundles wurden gespeichert."
      : "Die Bundle-Liste war bereits aktuell.";
  }
  if (state.status === "invalid") {
    return "Die Bundle-Liste ist ungültig: je Bundle ein Name (1–120 Zeichen) und eine eindeutige Position (0–999), höchstens 50 Bundles.";
  }
  if (state.status === "unauthenticated") return "Deine Anmeldung ist abgelaufen. Melde dich erneut an.";
  if (state.status === "denied") return "Du darfst optionale Bundles nicht ändern.";
  if (state.status === "not_found") return "Die Variante ist nicht mehr verfügbar.";
  return "Das Speichern ist vorübergehend nicht möglich. Versuche es später erneut.";
}

function SubmitButton({ label, pendingLabel }: { label: string; pendingLabel: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="inline-flex min-h-11 items-center justify-center rounded-md bg-slate-950 px-4 text-sm font-semibold text-white outline-none hover:bg-slate-800 focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-500"
    >
      {pending ? pendingLabel : label}
    </button>
  );
}

function FeedbackLine({ message, error }: { message: string | null; error: boolean }) {
  if (!message) return null;
  return (
    <p role={error ? "alert" : "status"} className={error ? "mt-2 text-sm font-semibold text-rose-800" : "mt-2 text-sm text-slate-700"}>
      {message}
    </p>
  );
}

function PromoteForm({ workspaceId, offerId, variant }: {
  workspaceId: string;
  offerId: string;
  variant: VariantControlEntry;
}) {
  const [state, formAction] = useActionState(
    setPrimaryVariantEditorAction,
    SET_PRIMARY_VARIANT_INITIAL_STATE,
  );
  const feedback = primaryFeedback(state);
  return (
    <div>
      <form action={formAction} className="inline">
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="offerId" value={offerId} />
        <input type="hidden" name="variantId" value={variant.id} />
        <SubmitButton
          label={`„${variant.name}“ als primär festlegen`}
          pendingLabel="Wird umgeschaltet …"
        />
      </form>
      <FeedbackLine message={feedback} error={state.status !== "idle" && state.status !== "success"} />
    </div>
  );
}

function OverrideForms({ workspaceId, offerId, currentCents }: {
  workspaceId: string;
  offerId: string;
  currentCents: number | null;
}) {
  const [state, formAction] = useActionState(
    setTotalOverrideEditorAction,
    SET_TOTAL_OVERRIDE_INITIAL_STATE,
  );
  const feedback = overrideFeedback(state);
  return (
    <div className="grid gap-3">
      <form action={formAction} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <div>
          <label htmlFor="deal-override-euros" className="text-sm font-semibold text-slate-800">
            Deal-Override netto in Euro (optional)
          </label>
          <input
            id="deal-override-euros"
            name="overrideEuros"
            inputMode="decimal"
            placeholder="Kein Override"
            defaultValue={formatCentsToEuroInput(currentCents)}
            key={String(currentCents)}
            className="mt-1 min-h-11 w-full rounded-md border border-slate-300 px-3 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
          />
        </div>
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="offerId" value={offerId} />
        <SubmitButton label="Override speichern" pendingLabel="Wird gespeichert …" />
      </form>
      {currentCents !== null ? (
        <form action={formAction}>
          <input type="hidden" name="workspaceId" value={workspaceId} />
          <input type="hidden" name="offerId" value={offerId} />
          <input type="hidden" name="overrideEuros" value="" />
          <SubmitButton label="Override zurücksetzen" pendingLabel="Wird zurückgesetzt …" />
        </form>
      ) : null}
      <FeedbackLine message={feedback} error={state.status !== "idle" && state.status !== "success"} />
    </div>
  );
}

function BundlesForm({ workspaceId, offerId, variant }: {
  workspaceId: string;
  offerId: string;
  variant: VariantControlEntry;
}) {
  const [state, formAction] = useActionState(
    setVariantBundlesEditorAction,
    SET_VARIANT_BUNDLES_INITIAL_STATE,
  );
  const [rows, setRows] = useState(() =>
    (variant.bundles ?? []).map((bundle) => ({ name: bundle.name, position: String(bundle.position) })),
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const feedback = bundlesFeedback(state);

  return (
    <div className="grid gap-3">
      <form
        action={formAction}
        className="grid gap-3"
        onSubmit={(event) => {
          const parsed = rows.map((row) => ({
            name: row.name.trim(),
            position: Number(row.position),
          }));
          if (parsed.some((row) => row.name.length === 0 || !Number.isInteger(row.position))) {
            event.preventDefault();
            setLocalError("Je Bundle werden ein Name und eine ganzzahlige Position benötigt.");
          } else {
            setLocalError(null);
          }
        }}
      >
        <input type="hidden" name="workspaceId" value={workspaceId} />
        <input type="hidden" name="offerId" value={offerId} />
        <input type="hidden" name="variantId" value={variant.id} />
        <input type="hidden" name="bundlesJson" value={JSON.stringify(rows.map((row) => ({ name: row.name.trim(), position: Number(row.position) })))} />
        {rows.length === 0 ? (
          <p className="text-sm text-slate-600">Noch keine optionalen Bundles hinterlegt.</p>
        ) : (
          <ul className="grid list-none gap-2">
            {rows.map((row, index) => (
              <li key={index} className="grid gap-2 rounded-md border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto]">
                <div>
                  <label htmlFor={`bundle-name-${index}`} className="text-sm font-semibold text-slate-800">
                    Bundle-Name {index + 1}
                  </label>
                  <input
                    id={`bundle-name-${index}`}
                    value={row.name}
                    onChange={(event) => setRows((current) => current.map((entry, entryIndex) => (
                      entryIndex === index ? { ...entry, name: event.target.value } : entry
                    )))}
                    className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
                  />
                </div>
                <div>
                  <label htmlFor={`bundle-position-${index}`} className="text-sm font-semibold text-slate-800">
                    Position {index + 1}
                  </label>
                  <input
                    id={`bundle-position-${index}`}
                    value={row.position}
                    inputMode="numeric"
                    onChange={(event) => setRows((current) => current.map((entry, entryIndex) => (
                      entryIndex === index ? { ...entry, position: event.target.value } : entry
                    )))}
                    className="mt-1 min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-right tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-emerald-700"
                  />
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    aria-label={`Bundle ${row.name || index + 1} entfernen`}
                    onClick={() => setRows((current) => current.filter((_, entryIndex) => entryIndex !== index))}
                    className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2"
                  >
                    Entfernen
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setRows((current) => (
              current.length >= 50
                ? current
                : [...current, { name: "", position: String(current.length) }]
            ))}
            className="inline-flex min-h-11 items-center rounded-md border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-emerald-700 focus-visible:ring-offset-2"
          >
            Bundle hinzufügen
          </button>
          <SubmitButton label="Bundles speichern" pendingLabel="Wird gespeichert …" />
        </div>
      </form>
      <FeedbackLine message={localError ?? feedback} error={(localError ?? feedback) !== null && (localError !== null || (state.status !== "idle" && state.status !== "success"))} />
    </div>
  );
}

export function OfferVariantControlsPanel({ workspaceId, offer, variants, activeVariantId, canEdit, canEditPrice }: {
  workspaceId: string;
  offer: {
    id: string;
    totalPriceOverrideNetCents?: number | null;
    overrideActive?: boolean;
    displayTotalNetCents?: number | null;
  };
  variants: readonly VariantControlEntry[];
  activeVariantId: string;
  canEdit: boolean;
  canEditPrice: boolean;
}) {
  const primary = variants.find((variant) => variant.isPrimary) ?? null;
  const active = variants.find((variant) => variant.id === activeVariantId) ?? null;
  const overrideCents = offer.totalPriceOverrideNetCents ?? null;

  return (
    <section aria-labelledby="offer-variant-controls-title" className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-emerald-800">F2.2 Steuerung</p>
      <h2 id="offer-variant-controls-title" className="mt-1 text-lg font-semibold text-slate-950">
        Primärvariante und Deal-Wert
      </h2>
      <p className="mt-1 text-sm leading-6 text-slate-600">
        {primary ? (
          <>Primärvariante: <strong>{primary.name}</strong>. </>
        ) : (
          <>Keine Primärvariante gesetzt. </>
        )}
        {offer.overrideActive === true ? (
          <>Deal-Override aktiv: <strong className="tabular-nums">{overrideCents === null ? "—" : formatOfferCents(overrideCents)} netto</strong> (Brutto folgt in der Signaturstrecke).</>
        ) : (
          <>Es gilt die Snapshot-Summe{offer.displayTotalNetCents === null || offer.displayTotalNetCents === undefined ? "" : <>: <strong className="tabular-nums">{formatOfferCents(offer.displayTotalNetCents)} netto</strong></>}.</>
        )}
      </p>

      <div className="mt-4 grid gap-5">
        <div>
          <h3 className="text-base font-semibold text-slate-950">Primärvariante umschalten</h3>
          {canEdit ? (
            <div className="mt-2 grid gap-2">
              {variants.filter((variant) => !variant.isPrimary).map((variant) => (
                <PromoteForm key={variant.id} workspaceId={workspaceId} offerId={offer.id} variant={variant} />
              ))}
              {variants.every((variant) => variant.isPrimary) ? (
                <p className="text-sm text-slate-600">Alle Varianten sind primär markiert — ein inkonsistenter Stand, bitte melden.</p>
              ) : null}
            </div>
          ) : (
            <p className="mt-2 text-sm text-slate-600">Nur Lesezugriff: Die Primärvariante kann nicht umgeschaltet werden.</p>
          )}
        </div>

        <div>
          <h3 className="text-base font-semibold text-slate-950">Deal-Override (Offer-Ebene)</h3>
          {canEditPrice ? (
            <div className="mt-2">
              <OverrideForms workspaceId={workspaceId} offerId={offer.id} currentCents={overrideCents} />
            </div>
          ) : (
            <p className="mt-2 text-sm text-slate-600">Nur Lesezugriff: Der Deal-Wert kann nicht geändert werden.</p>
          )}
        </div>

        <div>
          <h3 className="text-base font-semibold text-slate-950">
            Optionale Bundles{active ? ` · ${active.name}` : ""}
          </h3>
          {active && (active.bundles ?? []).length > 0 && !canEdit ? (
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-700">
              {active.bundles!.map((bundle, index) => (
                <li key={`${bundle.position}-${index}`}>{bundle.name} (Position {bundle.position})</li>
              ))}
            </ul>
          ) : null}
          {canEdit && active ? (
            <div className="mt-2">
              <BundlesForm workspaceId={workspaceId} offerId={offer.id} variant={active} />
            </div>
          ) : null}
          {!canEdit && (!active || (active.bundles ?? []).length === 0) ? (
            <p className="mt-2 text-sm text-slate-600">Keine optionalen Bundles hinterlegt.</p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
