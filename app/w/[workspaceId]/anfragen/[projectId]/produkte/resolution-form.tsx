"use client";

import { useActionState, useMemo, useState } from "react";
import type { CatalogComponentViewV1 } from "@/lib/integrations/catalog/contract";
import {
  deriveCatalogSelectionPreview,
  type CatalogSelectionAcknowledgement,
  type CatalogSelectionBlocker,
  type RequestedCatalogSelectionCoverage,
} from "@/lib/integrations/catalog/selection";
import {
  resolveProjectCatalogAction,
  type ResolutionActionState,
} from "../../../katalog/actions";

const MAX_QUANTITY = 100_000;

export type ResolutionSelectableComponent = {
  id: string;
  revision: number;
  sku: string;
  name: string;
  manufacturer: string;
  model: string;
  componentType: CatalogComponentViewV1["identity"]["componentType"];
  technicalData: CatalogComponentViewV1["technicalData"];
  salesPriceNetCents: number;
  purchasePriceNetCents?: number;
};

const typeLabels: Record<ResolutionSelectableComponent["componentType"], string> = {
  module: "PV-Module", inverter: "Wechselrichter", battery: "Speicher",
  wallbox: "Wallboxen", heat_pump: "Wärmepumpen", mounting: "Montage", other: "Sonstiges",
};
const ackLabels: Record<CatalogSelectionAcknowledgement, string> = {
  pv_capacity_differs: "Die gewählte PV-Modulleistung weicht vom berechneten Ziel ab.",
  storage_capacity_differs: "Die gewählte nutzbare Speicherkapazität weicht vom berechneten Ziel ab.",
  backup_compatibility_unverified: "Die Ersatzstrom-Kompatibilität ist technisch noch nicht verifiziert.",
  bidirectional_compatibility_unverified: "Die bidirektionale Lade-Kompatibilität ist technisch noch nicht verifiziert.",
  cross_component_compatibility_unverified: "Die Kompatibilität der gewählten Komponenten untereinander ist technisch noch nicht verifiziert.",
};
const blockerLabels: Record<CatalogSelectionBlocker, string> = {
  no_selection: "Wähle mindestens ein Produkt aus.",
  missing_module: "Für die Neuanlage fehlt mindestens ein PV-Modul.",
  missing_inverter: "Für die Neuanlage fehlt mindestens ein Wechselrichter.",
  missing_battery: "Für Speicherziel oder Ersatzstrom fehlt ein Speicher.",
  missing_wallbox: "Für den Wallboxwunsch fehlt eine Wallbox.",
  backup_known_unsupported: "Ein gewählter Speicher unterstützt Ersatzstrom nachweislich nicht.",
  bidirectional_known_unsupported: "Eine gewählte Wallbox unterstützt bidirektionales Laden nachweislich nicht.",
  missing_pricing: "Ein gewähltes Produkt hat keinen vollständigen Preisstand.",
};

function formatCents(value: number): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(value / 100);
}

function checkedMoneyTotal(
  components: ResolutionSelectableComponent[],
  selected: Record<string, boolean>,
  quantities: Record<string, number>,
): number {
  let total = 0;
  for (const component of components) {
    if (!selected[component.id]) continue;
    const quantity = quantities[component.id] ?? 1;
    const purchasePrice = component.purchasePriceNetCents;
    if (purchasePrice === undefined) continue;
    const lineTotal = purchasePrice * quantity;
    if (!Number.isSafeInteger(lineTotal) || lineTotal < 0) {
      throw new TypeError("EK-Summe ueberschreitet den sicheren Ganzzahlbereich.");
    }
    total += lineTotal;
    if (!Number.isSafeInteger(total) || total < 0) {
      throw new TypeError("EK-Summe ueberschreitet den sicheren Ganzzahlbereich.");
    }
  }
  return total;
}

function actionMessage(state: ResolutionActionState): string | null {
  if (state.status === "idle") return null;
  if (state.status === "success") return `Projektauflösung Revision ${state.revision} wurde revisionssicher bestätigt.`;
  if (state.status === "conflict") return "Ein gebundener Stand wurde zwischenzeitlich geändert. Lade die Seite neu; deine Auswahl wurde nicht übernommen.";
  if (state.status === "denied") return "Dir fehlt die Berechtigung zum Bestätigen der Produktauswahl.";
  if (state.status === "unauthenticated") return "Deine Sitzung ist abgelaufen.";
  if (state.status === "blocked") return "Die Projektauflösung ist inzwischen blockiert. Prüfe Planung und Produktstände erneut.";
  if (state.status === "unavailable") return "Die Auflösung konnte sicher nicht gespeichert werden. Es entstand kein Teilstand.";
  if (state.status === "invalid" && state.field === "quantity") return "Mindestens eine ausgewählte Produktmenge ist ungültig. Prüfe das markierte Mengenfeld.";
  if (state.status === "invalid" && state.field === "selection") return "Die Produktauswahl ist unvollständig oder veraltet. Prüfe die markierte Auswahl und lade sie bei Bedarf neu.";
  if (state.status === "invalid" && state.field === "acknowledgements") return "Bestätige exakt die aktuell angezeigten Abweichungen.";
  return "Prüfe Auswahl, Mengen und alle erforderlichen Bestätigungen.";
}

function technicalLabel(component: ResolutionSelectableComponent): string {
  const data = component.technicalData;
  if (data.schemaVersion === "module.v1") return `${data.nominalPowerWatts.toLocaleString("de-DE")} W`;
  if (data.schemaVersion === "inverter.v1") return `${data.nominalAcPowerWatts.toLocaleString("de-DE")} W AC`;
  if (data.schemaVersion === "battery.v1") return `${data.usableCapacityWh.toLocaleString("de-DE")} Wh nutzbar`;
  if (data.schemaVersion === "wallbox.v1") return `${data.maxChargingPowerWatts.toLocaleString("de-DE")} W`;
  if (data.schemaVersion === "heat_pump.v1") return `${data.nominalHeatingPowerWatts.toLocaleString("de-DE")} W`;
  if (data.schemaVersion === "mounting.v1") return data.systemName;
  return `${data.attributes.length} Attribute`;
}

export function ResolutionForm({
  workspaceId,
  projectId,
  expectedResolutionRevision,
  expectedRequirementRevision,
  expectedCalculationRevision,
  requested,
  components,
  initialSelections,
}: {
  workspaceId: string;
  projectId: string;
  expectedResolutionRevision: number;
  expectedRequirementRevision: number;
  expectedCalculationRevision: number;
  requested: RequestedCatalogSelectionCoverage;
  components: ResolutionSelectableComponent[];
  initialSelections: Record<string, number>;
}) {
  const [selected, setSelected] = useState<Record<string, boolean>>(() => (
    Object.fromEntries(components.map((component) => [
      component.id,
      initialSelections[component.id] !== undefined,
    ]))
  ));
  const [quantities, setQuantities] = useState<Record<string, number>>(() => (
    Object.fromEntries(components.map((component) => [
      component.id,
      initialSelections[component.id] ?? 1,
    ]))
  ));
  const [state, action, pending] = useActionState(
    resolveProjectCatalogAction,
    { status: "idle" } satisfies ResolutionActionState,
  );
  const previewResult = useMemo(() => {
    try {
      const preview = deriveCatalogSelectionPreview(
        components.filter((component) => selected[component.id]).map((component) => ({
          componentId: component.id,
          componentType: component.componentType,
          quantity: quantities[component.id] ?? 1,
          salesPriceNetCents: component.salesPriceNetCents,
          technicalData: component.technicalData,
        })),
        requested,
      );
      return {
        ok: true as const,
        preview,
        purchaseTotal: checkedMoneyTotal(components, selected, quantities),
      };
    } catch {
      return {
        ok: false as const,
        preview: deriveCatalogSelectionPreview([], requested),
        purchaseTotal: 0,
      };
    }
  }, [components, quantities, requested, selected]);
  const canShowPurchaseTotal = components.length > 0 && components.every((component) => (
    component.purchasePriceNetCents !== undefined
  ));
  const message = actionMessage(state);
  const actionErrorId = state.status === "invalid" ? "resolution-action-error" : undefined;

  const { preview, purchaseTotal } = previewResult;
  const acknowledgementFingerprint = components
    .filter((component) => selected[component.id])
    .map((component) => `${component.id}:${component.revision}:${quantities[component.id] ?? 1}`)
    .concat(preview.requiredAcknowledgements)
    .join("|");
  const liveSummary = !previewResult.ok
    ? "Die Auswahl überschreitet den sicher verarbeitbaren Zahlenbereich."
    : preview.blockers.length > 0
      ? `${preview.blockers.length} Auswahlblocker. PV ${preview.selected.pvModulePowerWatts} von ${requested.pvPeakPowerWatts} Watt. Speicher ${preview.selected.storageUsableCapacityWh} von ${requested.storageCapacityWh} Wattstunden. VK-Summe ${formatCents(preview.salesPriceNetCents)}. Erforderliche Bestätigungen: ${preview.requiredAcknowledgements.length > 0 ? preview.requiredAcknowledgements.map((code) => ackLabels[code]).join(" ") : "keine"}.`
      : `Auswahl vollständig. PV ${preview.selected.pvModulePowerWatts} von ${requested.pvPeakPowerWatts} Watt. Speicher ${preview.selected.storageUsableCapacityWh} von ${requested.storageCapacityWh} Wattstunden. VK-Summe ${formatCents(preview.salesPriceNetCents)}. Erforderliche Bestätigungen: ${preview.requiredAcknowledgements.length > 0 ? preview.requiredAcknowledgements.map((code) => ackLabels[code]).join(" ") : "keine"}.`;

  return (
    <form action={action} className="grid gap-6">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="expectedResolutionRevision" value={expectedResolutionRevision} />
      <input type="hidden" name="expectedRequirementRevision" value={expectedRequirementRevision} />
      <input type="hidden" name="expectedCalculationRevision" value={expectedCalculationRevision} />
      <input type="hidden" name="componentCount" value={components.length} />

      {message ? (
        <p id={actionErrorId} role={state.status === "success" ? "status" : "alert"} aria-live="polite" className={state.status === "success" ? "rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-950" : "rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-900"}>
          {message}
        </p>
      ) : null}

      <fieldset
        disabled={pending}
        aria-describedby={state.status === "invalid" && state.field === "selection" ? actionErrorId : undefined}
        className="grid gap-5"
      >
        <legend className="mb-1 text-base font-semibold text-slate-950">Aktive Produkte auswählen</legend>
        {Object.entries(typeLabels).map(([componentType, groupLabel]) => {
          const group = components.filter((component) => component.componentType === componentType);
          if (group.length === 0) return null;
          return (
            <section key={componentType} aria-labelledby={`group-${componentType}`} className="grid gap-3">
              <h3 id={`group-${componentType}`} className="text-sm font-semibold text-slate-700">{groupLabel}</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                {group.map((component) => {
                  const index = components.findIndex((candidate) => candidate.id === component.id);
                  return (
                    <div key={component.id} className={selected[component.id] ? "rounded-lg border border-blue-300 bg-blue-50 p-4" : "rounded-lg border border-slate-200 bg-white p-4"}>
                      <input type="hidden" name={`selection.${index}.componentId`} value={component.id} />
                      <input type="hidden" name={`selection.${index}.revision`} value={component.revision} />
                      <label className="flex min-h-11 cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          name={`selection.${index}.selected`}
                          value="yes"
                          checked={selected[component.id] ?? false}
                          aria-invalid={state.status === "invalid" && state.field === "selection"
                            && (state.selectionIndex === undefined || state.selectionIndex === index)}
                          onChange={(event) => setSelected((current) => ({ ...current, [component.id]: event.target.checked }))}
                          className="mt-1 h-5 w-5 rounded border-slate-300 text-blue-700 focus:ring-blue-600"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-slate-950">{component.name}</span>
                          <span className="mt-0.5 block truncate font-mono text-xs text-slate-600">{component.sku} · Rev. {component.revision}</span>
                          <span className="mt-1 block text-xs text-slate-600">{component.manufacturer} · {component.model}</span>
                          <span className="mt-1 block text-xs font-medium tabular-nums text-slate-800">{technicalLabel(component)} · {formatCents(component.salesPriceNetCents)} VK</span>
                        </span>
                      </label>
                      <label className="mt-3 grid gap-1 text-xs font-semibold text-slate-700">
                        Menge für {component.name}
                        <input
                          name={`selection.${index}.quantity`}
                          type="number"
                          min="1"
                          max={MAX_QUANTITY}
                          step="1"
                          required
                          value={quantities[component.id] ?? 1}
                          aria-invalid={state.status === "invalid" && state.field === "quantity"
                            && (state.selectionIndex === undefined || state.selectionIndex === index)}
                          aria-describedby={state.status === "invalid" && state.field === "quantity"
                            && (state.selectionIndex === undefined || state.selectionIndex === index)
                            ? actionErrorId
                            : undefined}
                          onChange={(event) => {
                            const next = Number(event.target.value);
                            setQuantities((current) => ({
                              ...current,
                              [component.id]: Number.isSafeInteger(next) && next >= 1
                                ? Math.min(next, MAX_QUANTITY)
                                : 1,
                            }));
                          }}
                          className="min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 text-sm tabular-nums outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200"
                        />
                      </label>
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </fieldset>

      <p className="sr-only" aria-live="polite" aria-atomic="true">{liveSummary}</p>

      <section aria-labelledby="coverage-preview" className="rounded-lg border border-slate-200 bg-slate-50 p-4 sm:p-5">
        <h3 id="coverage-preview" className="text-sm font-semibold text-slate-950">Deckungsvorschau</h3>
        {!previewResult.ok ? (
          <div role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm leading-6 text-red-900">
            Die gewählte Menge oder Preissumme überschreitet den sicher
            verarbeitbaren Bereich. Reduziere eine Menge; es wurde nichts gespeichert.
          </div>
        ) : (
          <>
            <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-slate-500">PV-Auswahl / Ziel</dt><dd className="mt-0.5 font-semibold tabular-nums text-slate-950">{preview.selected.pvModulePowerWatts.toLocaleString("de-DE")} / {requested.pvPeakPowerWatts.toLocaleString("de-DE")} W</dd></div>
              <div><dt className="text-slate-500">Speicher-Auswahl / Ziel</dt><dd className="mt-0.5 font-semibold tabular-nums text-slate-950">{preview.selected.storageUsableCapacityWh.toLocaleString("de-DE")} / {requested.storageCapacityWh.toLocaleString("de-DE")} Wh</dd></div>
              <div><dt className="text-slate-500">Module · WR · Speicher · Wallbox</dt><dd className="mt-0.5 font-semibold tabular-nums text-slate-950">{preview.selected.moduleCount} · {preview.selected.inverterCount} · {preview.selected.batteryCount} · {preview.selected.wallboxCount}</dd></div>
              <div><dt className="text-slate-500">VK-Summe netto</dt><dd className="mt-0.5 font-semibold tabular-nums text-slate-950">{formatCents(preview.salesPriceNetCents)}</dd></div>
              {canShowPurchaseTotal ? <div><dt className="text-slate-500">EK-Summe netto</dt><dd className="mt-0.5 font-semibold tabular-nums text-slate-950">{formatCents(purchaseTotal)}</dd></div> : null}
            </dl>
            {preview.blockers.length > 0 ? <ul className="mt-4 grid gap-2" aria-label="Auswahlblocker">{preview.blockers.map((blocker) => <li key={blocker} className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">{blockerLabels[blocker]}</li>)}</ul> : <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-semibold text-emerald-950">Die Mindestkategorien sind vollständig ausgewählt.</p>}
          </>
        )}
      </section>

      {previewResult.ok && preview.requiredAcknowledgements.length > 0 ? (
        <fieldset
          key={acknowledgementFingerprint}
          className="grid gap-3"
          disabled={pending}
          aria-describedby={state.status === "invalid" && state.field === "acknowledgements" ? actionErrorId : undefined}
        >
          <legend className="text-base font-semibold text-slate-950">Abweichungen bewusst bestätigen</legend>
          <p className="text-sm leading-6 text-slate-600">Diese Punkte werden strukturiert im Snapshot gespeichert. Sie verändern nicht die Qualität der Planungsrechnung.</p>
          {preview.requiredAcknowledgements.map((code) => (
            <label key={code} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
              <input type="checkbox" name={`ack.${code}`} value="yes" required aria-invalid={state.status === "invalid" && state.field === "acknowledgements"} className="mt-0.5 h-5 w-5 rounded border-amber-400 text-blue-700 focus:ring-blue-600" />
              <span>{ackLabels[code]}</span>
            </label>
          ))}
        </fieldset>
      ) : null}

      <button type="submit" disabled={pending || !previewResult.ok || preview.blockers.length > 0} className="min-h-11 w-full rounded-md bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto sm:justify-self-start">
        {pending ? "Wird revisionssicher bestätigt …" : "Projektauflösung bestätigen"}
      </button>
    </form>
  );
}
