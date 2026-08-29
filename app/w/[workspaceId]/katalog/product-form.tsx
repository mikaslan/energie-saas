"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type {
  CatalogComponentType,
  CatalogComponentViewV1,
} from "@/lib/integrations/catalog/contract";
import {
  createCatalogComponentAction,
  reviseCatalogDetailsAction,
  type CatalogActionState,
} from "./actions";

const typeLabels: Record<CatalogComponentType, string> = {
  module: "PV-Modul",
  inverter: "Wechselrichter",
  battery: "Speicher",
  wallbox: "Wallbox",
  heat_pump: "Wärmepumpe",
  mounting: "Montagesystem",
  other: "Sonstiges",
};

const fieldClass =
  "min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-950 outline-none focus:border-blue-600 focus:ring-2 focus:ring-blue-200 disabled:bg-slate-100 disabled:text-slate-500";
const labelClass = "grid gap-1.5 text-sm font-medium text-slate-800";

function messageFor(state: CatalogActionState): { tone: "good" | "bad"; text: string } | null {
  if (state.status === "idle") return null;
  if (state.status === "success") {
    return {
      tone: "good",
      text: `Revision ${state.revision} wurde gespeichert. Der Produktstatus ist jetzt Entwurf.`,
    };
  }
  if (state.status === "invalid") return { tone: "bad", text: "Prüfe die markierten Pflichtfelder und Zahlenformate." };
  if (state.status === "unauthenticated") return { tone: "bad", text: "Deine Sitzung ist abgelaufen. Melde dich erneut an." };
  if (state.status === "denied") return { tone: "bad", text: "Dir fehlt die Berechtigung für diese Änderung." };
  if (state.status === "conflict") return { tone: "bad", text: "Das Produkt wurde zwischenzeitlich geändert. Lade die Seite neu." };
  if (state.status === "not_found") return { tone: "bad", text: "Das Produkt ist nicht mehr verfügbar." };
  if (state.status === "state_error") {
    return { tone: "bad", text: "Der aktuelle Produktstatus erlaubt diese Änderung nicht." };
  }
  return { tone: "bad", text: "Die Änderung konnte sicher nicht gespeichert werden. Versuche es erneut." };
}

function TechnicalFields({
  componentType,
  value,
}: {
  componentType: CatalogComponentType;
  value?: CatalogComponentViewV1["technicalData"];
}) {
  if (componentType === "module") {
    return (
      <label className={labelClass}>
        Nennleistung in Watt
        <input
          className={fieldClass}
          name="nominalPowerWatts"
          type="number"
          min="1"
          max="10000"
          step="1"
          required
          defaultValue={value?.schemaVersion === "module.v1" ? value.nominalPowerWatts : ""}
        />
      </label>
    );
  }
  if (componentType === "inverter") {
    const current = value?.schemaVersion === "inverter.v1" ? value : null;
    return (
      <>
        <label className={labelClass}>
          AC-Nennleistung in Watt
          <input className={fieldClass} name="nominalAcPowerWatts" type="number" min="1" max="10000000" step="1" required defaultValue={current?.nominalAcPowerWatts ?? ""} />
        </label>
        <label className={labelClass}>
          Phasen
          <select className={fieldClass} name="phaseCount" defaultValue={current?.phaseCount ?? 3}>
            <option value="1">1-phasig</option>
            <option value="3">3-phasig</option>
          </select>
        </label>
        <label className={labelClass}>
          MPPT-Tracker
          <input className={fieldClass} name="mpptTrackerCount" type="number" min="1" max="100" step="1" required defaultValue={current?.mpptTrackerCount ?? ""} />
        </label>
      </>
    );
  }
  if (componentType === "battery") {
    const current = value?.schemaVersion === "battery.v1" ? value : null;
    return (
      <>
        <label className={labelClass}>
          Nominale Kapazität in Wh
          <input className={fieldClass} name="nominalCapacityWh" type="number" min="1" max="100000000" step="1" required defaultValue={current?.nominalCapacityWh ?? ""} />
        </label>
        <label className={labelClass}>
          Nutzbare Kapazität in Wh
          <input className={fieldClass} name="usableCapacityWh" type="number" min="1" max="100000000" step="1" required defaultValue={current?.usableCapacityWh ?? ""} />
        </label>
        <label className={labelClass}>
          Dauerleistung in Watt
          <input className={fieldClass} name="maxContinuousPowerWatts" type="number" min="1" max="100000000" step="1" required defaultValue={current?.maxContinuousPowerWatts ?? ""} />
        </label>
        <label className={labelClass}>
          Roundtrip-Wirkungsgrad in Prozent
          <input className={fieldClass} name="roundTripEfficiencyPercent" type="number" min="0.01" max="100" step="0.01" required defaultValue={current ? current.roundTripEfficiencyBasisPoints / 100 : ""} />
        </label>
        <label className={labelClass}>
          Ersatzstromfähigkeit
          <select className={fieldClass} name="backupCapability" defaultValue={current?.backupCapability ?? "unknown"}>
            <option value="unknown">Unbekannt</option>
            <option value="known_supported">Nachweislich unterstützt</option>
            <option value="known_unsupported">Nachweislich nicht unterstützt</option>
          </select>
        </label>
      </>
    );
  }
  if (componentType === "wallbox") {
    const current = value?.schemaVersion === "wallbox.v1" ? value : null;
    return (
      <>
        <label className={labelClass}>
          Maximale Ladeleistung in Watt
          <input className={fieldClass} name="maxChargingPowerWatts" type="number" min="1" max="1000000" step="1" required defaultValue={current?.maxChargingPowerWatts ?? ""} />
        </label>
        <label className={labelClass}>
          Phasen
          <select className={fieldClass} name="phaseCount" defaultValue={current?.phaseCount ?? 3}>
            <option value="1">1-phasig</option>
            <option value="3">3-phasig</option>
          </select>
        </label>
        <label className={labelClass}>
          Anschluss
          <select className={fieldClass} name="connector" defaultValue={current?.connector ?? "type2_cable"}>
            <option value="type2_cable">Typ-2-Kabel</option>
            <option value="type2_socket">Typ-2-Dose</option>
            <option value="other">Sonstiger Anschluss</option>
          </select>
        </label>
        <label className={labelClass}>
          Bidirektionale Fähigkeit
          <select className={fieldClass} name="bidirectionalCapability" defaultValue={current?.bidirectionalCapability ?? "unknown"}>
            <option value="unknown">Unbekannt</option>
            <option value="known_supported">Nachweislich unterstützt</option>
            <option value="known_unsupported">Nachweislich nicht unterstützt</option>
          </select>
        </label>
      </>
    );
  }
  if (componentType === "heat_pump") {
    const current = value?.schemaVersion === "heat_pump.v1" ? value : null;
    return (
      <>
        <label className={labelClass}>
          Heiz-Nennleistung in Watt
          <input className={fieldClass} name="nominalHeatingPowerWatts" type="number" min="1" max="10000000" step="1" required defaultValue={current?.nominalHeatingPowerWatts ?? ""} />
        </label>
        <label className={labelClass}>
          SCOP
          <input className={fieldClass} name="scop" type="number" min="0.01" max="20" step="0.01" required defaultValue={current ? current.scopHundredths / 100 : ""} />
        </label>
      </>
    );
  }
  if (componentType === "mounting") {
    const current = value?.schemaVersion === "mounting.v1" ? value : null;
    return (
      <>
        <label className={labelClass}>
          Systemname
          <input className={fieldClass} name="systemName" required maxLength={200} defaultValue={current?.systemName ?? ""} />
        </label>
        <label className={labelClass}>
          Dacharten, kommagetrennt
          <input className={fieldClass} name="roofTypes" required placeholder="pitched, flat" defaultValue={current?.roofTypes.join(", ") ?? ""} />
          <span className="text-xs font-normal text-slate-500">Erlaubt: pitched, flat, facade, ground</span>
        </label>
      </>
    );
  }
  const current = value?.schemaVersion === "other.v1" ? value : null;
  return (
    <label className={`${labelClass} sm:col-span-2`}>
      Attribute, je Zeile Name=Wert
      <textarea className={`${fieldClass} min-h-28 resize-y`} name="attributes" defaultValue={current?.attributes.map((entry) => `${entry.name}=${entry.value}`).join("\n") ?? ""} />
    </label>
  );
}

export function ProductForm({
  workspaceId,
  value,
}: {
  workspaceId: string;
  value?: CatalogComponentViewV1;
}) {
  const mode = value ? "revise" : "create";
  const [componentType, setComponentType] = useState<CatalogComponentType>(
    value?.identity.componentType ?? "module",
  );
  const [state, action, pending] = useActionState(
    mode === "create" ? createCatalogComponentAction : reviseCatalogDetailsAction,
    { status: "idle" } satisfies CatalogActionState,
  );
  const message = messageFor(state);
  const provenance = value?.technicalProvenance;
  const fixedPiece = componentType !== "mounting" && componentType !== "other";

  return (
    <form action={action} className="grid gap-6">
      <input type="hidden" name="workspaceId" value={workspaceId} />
      {value ? (
        <>
          <input type="hidden" name="componentId" value={value.identity.componentId} />
          <input type="hidden" name="expectedRevision" value={value.identity.revision} />
          <input type="hidden" name="componentType" value={componentType} />
        </>
      ) : null}

      {message ? (
        <div
          role={message.tone === "bad" ? "alert" : "status"}
          aria-live="polite"
          className={message.tone === "good"
            ? "rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-950"
            : "rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-900"}
        >
          {message.text}
          {state.status === "success" && mode === "create" ? (
            <Link className="ml-2 underline underline-offset-2" href={`/w/${workspaceId}/katalog/${state.componentId}`}>
              Produkt öffnen
            </Link>
          ) : null}
        </div>
      ) : null}

      <fieldset className="grid gap-4" disabled={pending}>
        <legend className="mb-3 text-sm font-semibold text-slate-950">Identität und Darstellung</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          {!value ? (
            <label className={labelClass}>
              Interne SKU
              <input className={fieldClass} name="internalSku" required maxLength={64} autoComplete="off" placeholder="PV-440-BLK" />
            </label>
          ) : null}
          {!value ? (
            <label className={labelClass}>
              Produkttyp
              <select
                className={fieldClass}
                name="componentType"
                value={componentType}
                onChange={(event) => setComponentType(event.target.value as CatalogComponentType)}
              >
                {Object.entries(typeLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
              </select>
            </label>
          ) : (
            <p className="grid gap-1.5 text-sm text-slate-600">
              Produkttyp
              <span className="font-semibold text-slate-950">{typeLabels[componentType]}</span>
            </p>
          )}
          <label className={labelClass}>
            Anzeigename
            <input className={fieldClass} name="displayName" required maxLength={200} defaultValue={value?.presentation.displayName ?? ""} />
          </label>
          <label className={labelClass}>
            Hersteller
            <input className={fieldClass} name="manufacturer" required maxLength={200} defaultValue={value?.presentation.manufacturer ?? ""} />
          </label>
          <label className={labelClass}>
            Modell
            <input className={fieldClass} name="model" required maxLength={200} defaultValue={value?.presentation.model ?? ""} />
          </label>
          {fixedPiece ? (
            <>
              <input type="hidden" name="unit" value="piece" />
              <p className="grid gap-1.5 text-sm text-slate-600">
                Einheit
                <span className="font-semibold text-slate-950">Stück</span>
              </p>
            </>
          ) : (
            <label className={labelClass}>
              Einheit
              <select className={fieldClass} name="unit" defaultValue={value?.presentation.unit ?? "set"}>
                <option value="piece">Stück</option>
                <option value="set">Set</option>
                <option value="meter">Meter</option>
              </select>
            </label>
          )}
          <label className={`${labelClass} sm:col-span-2`}>
            Kernaussagen, höchstens sechs Zeilen
            <textarea className={`${fieldClass} min-h-24 resize-y`} name="keyPoints" maxLength={1450} defaultValue={value?.presentation.keyPoints.join("\n") ?? ""} />
          </label>
        </div>
      </fieldset>

      <fieldset className="grid gap-4" disabled={pending}>
        <legend className="mb-3 text-sm font-semibold text-slate-950">Technische Daten</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <TechnicalFields componentType={componentType} value={value?.technicalData} />
        </div>
      </fieldset>

      <fieldset className="grid gap-4" disabled={pending}>
        <legend className="mb-3 text-sm font-semibold text-slate-950">Technische Quelle und Rechte</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className={labelClass}>
            Quellenart
            <select className={fieldClass} name="technicalSourceKind" defaultValue={provenance?.sourceKind ?? "manufacturer_datasheet"}>
              <option value="manufacturer_datasheet">Herstellerdatenblatt</option>
              <option value="supplier_price_list">Lieferantenpreisliste</option>
              <option value="supplier_quote">Lieferantenangebot</option>
              <option value="workspace_pricing">Eigene Preisermittlung</option>
              <option value="workspace_manual">Eigene manuelle Quelle</option>
              <option value="csv_import">CSV-Import</option>
              <option value="customer_provided">Vom Kunden bereitgestellt</option>
            </select>
          </label>
          <label className={labelClass}>
            Quellenreferenz
            <input className={fieldClass} name="technicalReference" required maxLength={240} defaultValue={provenance?.reference ?? ""} />
          </label>
          <label className={labelClass}>
            Beobachtet am
            <input className={fieldClass} name="technicalObservedOn" type="date" required defaultValue={provenance?.observedOn ?? ""} />
          </label>
          <label className={labelClass}>
            Rechtebasis
            <select className={fieldClass} name="technicalRightsBasis" defaultValue={provenance?.rightsBasis ?? "manufacturer_published"}>
              <option value="manufacturer_published">Vom Hersteller veröffentlicht</option>
              <option value="supplier_authorized">Vom Lieferanten autorisiert</option>
              <option value="workspace_owned">Workspace-eigene Daten</option>
              <option value="customer_provided">Vom Kunden bereitgestellt</option>
            </select>
          </label>
          <label className={`${labelClass} sm:col-span-2`}>
            Dokument-SHA-256, optional
            <input className={`${fieldClass} font-mono text-xs`} name="technicalDocumentSha256" pattern="[0-9a-f]{64}" maxLength={64} defaultValue={provenance?.sourceDocumentSha256 ?? ""} />
          </label>
        </div>
      </fieldset>

      {mode === "revise" ? (
        <div role="note" className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950">
          <span className="font-semibold">Vor dem Speichern:</span> Jede Änderung
          erzeugt Revision N+1, setzt das Produkt auf Entwurf und markiert
          betroffene Projektauflösungen als veraltet.
        </div>
      ) : (
        <p className="text-sm leading-6 text-slate-600">
          Das Produkt wird als Entwurf ohne Preis angelegt. EK, VK und deren
          Quellen werden anschließend getrennt auf der Produktseite erfasst.
        </p>
      )}

      <button
        type="submit"
        disabled={pending}
        className="min-h-11 w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-slate-700 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:justify-self-start"
      >
        {pending ? "Wird gespeichert …" : mode === "create" ? "Produktentwurf anlegen" : "Neue Revision speichern"}
      </button>
    </form>
  );
}
