"use client";

import { useActionState, useState } from "react";
import type { CatalogComponentViewV1 } from "@/lib/integrations/catalog/contract";
import {
  reviseCatalogPricingAction,
  type CatalogActionState,
} from "../actions";

const fieldClass =
  "min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200";
const labelClass = "grid gap-1.5 text-sm font-medium text-slate-800";

function euroValue(cents: number | undefined): string {
  if (cents === undefined) return "";
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}
function stateText(state: CatalogActionState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "success") return `Preisrevision ${state.revision} wurde als Entwurf gespeichert.`;
  if (state.status === "conflict") return "Der Preisstand ist veraltet. Lade die Seite neu.";
  if (state.status === "denied") return "Dir fehlt die Berechtigung für Preisänderungen.";
  if (state.status === "state_error") return "Ein archiviertes Produkt kann nicht neu bepreist werden.";
  if (state.status === "unauthenticated") return "Deine Sitzung ist abgelaufen.";
  return "Der Preisstand konnte nicht sicher gespeichert werden. Prüfe alle Pflichtfelder.";
}

export function PricingForm({
  workspaceId,
  component,
}: {
  workspaceId: string;
  component: CatalogComponentViewV1;
}) {
  const [mode, setMode] = useState<"complete" | "none">(
    component.commercial ? "complete" : "none",
  );
  const [state, action, pending] = useActionState(
    reviseCatalogPricingAction,
    { status: "idle" } satisfies CatalogActionState,
  );
  const commercial = component.commercial;
  const purchase = commercial && "purchasePriceNetCents" in commercial
    ? commercial.purchasePriceNetCents
    : undefined;
  const purchaseProvenance = commercial && "purchaseProvenance" in commercial
    ? commercial.purchaseProvenance
    : undefined;
  const message = stateText(state);

  return (
    <form action={action} className="grid gap-5">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="componentId" value={component.identity.componentId} />
      <input type="hidden" name="expectedRevision" value={component.identity.revision} />

      {message ? (
        <p
          role={state.status === "success" ? "status" : "alert"}
          aria-live="polite"
          className={state.status === "success"
            ? "rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-950"
            : "rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-900"}
        >
          {message}
        </p>
      ) : null}

      {!purchaseProvenance && commercial ? (
        <p role="note" className="rounded-md border border-blue-200 bg-blue-50 px-4 py-3 text-sm leading-6 text-blue-950">
          Der bestehende Einkaufspreis ist für deine Rolle ausgeblendet. Für
          eine neue Preisrevision musst du EK und EK-Quelle bewusst neu eingeben.
        </p>
      ) : null}

      <label className={labelClass}>
        Preisstand
        <select className={fieldClass} name="pricingMode" value={mode} onChange={(event) => setMode(event.target.value as "complete" | "none")}>
          <option value="complete">Vollständiger Netto-Preisstand</option>
          <option value="none">Preise entfernen und als Entwurf führen</option>
        </select>
      </label>

      <fieldset className="grid gap-4" disabled={pending}>
        <legend className="mb-3 text-sm font-semibold text-slate-950">Preise · EUR netto</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>
            Einkaufspreis
            <input className={fieldClass} name="purchasePriceEuro" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:[.,][0-9]{1,2})?" required={mode === "complete"} defaultValue={euroValue(purchase)} />
          </label>
          <label className={labelClass}>
            Verkaufspreis
            <input className={fieldClass} name="salesPriceEuro" inputMode="decimal" pattern="(?:0|[1-9][0-9]*)(?:[.,][0-9]{1,2})?" required={mode === "complete"} defaultValue={euroValue(commercial?.salesPriceNetCents)} />
          </label>
        </div>
      </fieldset>

      <fieldset className="grid gap-4" disabled={pending}>
        <legend className="mb-3 text-sm font-semibold text-slate-950">Einkaufsquelle</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>Quellenart
            <select className={fieldClass} name="purchaseSourceKind" defaultValue={purchaseProvenance?.sourceKind ?? "supplier_price_list"}>
              <option value="supplier_price_list">Lieferantenpreisliste</option>
              <option value="supplier_quote">Lieferantenangebot</option>
              <option value="workspace_pricing">Eigene Preisermittlung</option>
              <option value="workspace_manual">Eigene manuelle Quelle</option>
              <option value="manufacturer_datasheet">Herstellerunterlage</option>
              <option value="csv_import">CSV-Import</option>
              <option value="customer_provided">Vom Kunden bereitgestellt</option>
            </select>
          </label>
          <label className={labelClass}>Referenz
            <input className={fieldClass} name="purchaseReference" maxLength={240} required={mode === "complete"} defaultValue={purchaseProvenance?.reference ?? ""} />
          </label>
          <label className={labelClass}>Beobachtet am
            <input className={fieldClass} name="purchaseObservedOn" type="date" required={mode === "complete"} defaultValue={purchaseProvenance?.observedOn ?? ""} />
          </label>
          <label className={labelClass}>Rechtebasis
            <select className={fieldClass} name="purchaseRightsBasis" defaultValue={purchaseProvenance?.rightsBasis ?? "supplier_authorized"}>
              <option value="supplier_authorized">Vom Lieferanten autorisiert</option>
              <option value="workspace_owned">Workspace-eigene Daten</option>
              <option value="manufacturer_published">Vom Hersteller veröffentlicht</option>
              <option value="customer_provided">Vom Kunden bereitgestellt</option>
            </select>
          </label>
          <label className={`${labelClass} sm:col-span-2`}>Dokument-SHA-256, optional
            <input className={`${fieldClass} font-mono text-xs`} name="purchaseDocumentSha256" pattern="[0-9a-f]{64}" maxLength={64} defaultValue={purchaseProvenance?.sourceDocumentSha256 ?? ""} />
          </label>
        </div>
      </fieldset>

      <fieldset className="grid gap-4" disabled={pending}>
        <legend className="mb-3 text-sm font-semibold text-slate-950">Verkaufsquelle</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>Quellenart
            <select className={fieldClass} name="salesSourceKind" defaultValue={commercial?.salesProvenance.sourceKind ?? "workspace_pricing"}>
              <option value="workspace_pricing">Eigene Preisermittlung</option>
              <option value="workspace_manual">Eigene manuelle Quelle</option>
              <option value="supplier_price_list">Lieferantenpreisliste</option>
              <option value="supplier_quote">Lieferantenangebot</option>
              <option value="manufacturer_datasheet">Herstellerunterlage</option>
              <option value="csv_import">CSV-Import</option>
              <option value="customer_provided">Vom Kunden bereitgestellt</option>
            </select>
          </label>
          <label className={labelClass}>Referenz
            <input className={fieldClass} name="salesReference" maxLength={240} required={mode === "complete"} defaultValue={commercial?.salesProvenance.reference ?? ""} />
          </label>
          <label className={labelClass}>Beobachtet am
            <input className={fieldClass} name="salesObservedOn" type="date" required={mode === "complete"} defaultValue={commercial?.salesProvenance.observedOn ?? ""} />
          </label>
          <label className={labelClass}>Rechtebasis
            <select className={fieldClass} name="salesRightsBasis" defaultValue={commercial?.salesProvenance.rightsBasis ?? "workspace_owned"}>
              <option value="workspace_owned">Workspace-eigene Daten</option>
              <option value="supplier_authorized">Vom Lieferanten autorisiert</option>
              <option value="manufacturer_published">Vom Hersteller veröffentlicht</option>
              <option value="customer_provided">Vom Kunden bereitgestellt</option>
            </select>
          </label>
          <label className={`${labelClass} sm:col-span-2`}>Dokument-SHA-256, optional
            <input className={`${fieldClass} font-mono text-xs`} name="salesDocumentSha256" pattern="[0-9a-f]{64}" maxLength={64} defaultValue={commercial?.salesProvenance.sourceDocumentSha256 ?? ""} />
          </label>
        </div>
      </fieldset>

      <div role="note" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
        Eine Preisänderung erzeugt Revision N+1 und setzt das Produkt zurück
        auf Entwurf. Bestehende Snapshots bleiben unverändert.
      </div>
      <button type="submit" disabled={pending} className="min-h-11 w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:opacity-60 sm:w-auto sm:justify-self-start">
        {pending ? "Wird gespeichert …" : mode === "complete" ? "Neue Preisrevision speichern" : "Preise entfernen"}
      </button>
    </form>
  );
}
