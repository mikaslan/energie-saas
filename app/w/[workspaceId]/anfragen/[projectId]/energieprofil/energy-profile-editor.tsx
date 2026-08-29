"use client";

import { useActionState, useEffect, useRef, type FormEvent } from "react";
import type { ProjectEnergyProfileCandidate } from "@/modules/energy";
import {
  saveProjectEnergyProfileAction,
  type SaveProjectEnergyProfileState,
} from "../../energy-actions";

type EnergyProfile = ProjectEnergyProfileCandidate["profile"];
type KnownOrUnknown = { status: "known"; value: unknown } | { status: "unknown" };

const initialState: SaveProjectEnergyProfileState = { status: "idle" };
const inputClass = "min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-950 outline-none focus-visible:border-blue-600 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500";
const labelClass = "grid min-w-0 gap-1.5 text-sm font-medium text-slate-800";

function fieldValue(field: KnownOrUnknown): string | number {
  return field.status === "known" && (
    typeof field.value === "string" || typeof field.value === "number"
  ) ? field.value : "";
}

function assetStatusLabel(value: string): string {
  if (value === "known_present") return "Vorhanden";
  if (value === "known_absent") return "Nicht vorhanden";
  return "Unbekannt";
}

function sourceLabel(value: string): string {
  if (value === "operator_reviewed") return "Bereits manuell geprüft";
  if (value === "default") return "Ungeprüfte Default-Geometrie";
  if (value === "user_drawn") return "Im Rechner eingezeichnet, noch ungeprüft";
  if (value === "lod2") return "Aus Gebäudedaten übernommen, noch ungeprüft";
  if (value === "osm") return "Aus offenen Kartendaten übernommen, noch ungeprüft";
  return "Importiert, noch ungeprüft";
}

function messageFor(state: SaveProjectEnergyProfileState): string {
  switch (state.status) {
    case "success":
      if (!state.changed) return `Profilrevision ${state.revision} war bereits unverändert gespeichert.`;
      return `Profilrevision ${state.revision} wurde gespeichert. Prüfe sie anschließend getrennt und bestätige erst dann die Eingaben.`;
    case "invalid":
      return "Mindestens ein Feld ist ungültig. Prüfe Wertebereiche und lade die Seite neu, falls der Fehler bleibt.";
    case "unauthenticated":
      return "Deine Sitzung ist abgelaufen. Bitte lade die Seite neu und melde dich erneut an.";
    case "denied":
      return "Für das Speichern fehlt dir die Berechtigung.";
    case "stale":
      return "Adresse oder Profil wurden in einem anderen Tab geändert. Deine Eingaben bleiben erhalten; gleiche sie vor dem erneuten Speichern mit dem aktuellen Stand ab.";
    case "address_not_ready":
      return "Die aktuelle Hausadresse und der Planungs-Pin müssen zuerst bestätigt sein.";
    case "profile_missing":
      return "Die Rechnerquelle für dieses Projekt ist nicht mehr verfügbar.";
    case "roof_review_required":
      return "Prüfe jedes veränderte Dach. Eine Default-Geometrie muss als bewusst neue Ersatzgeometrie erfasst werden.";
    case "unsupported_source":
      return "Die Rechnerquelle kann für dieses Energieprofil nicht verlässlich verarbeitet werden.";
    default:
      return "";
  }
}

function AssetStatusSelect({
  id,
  name,
  label,
  defaultValue,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue: "unknown" | "known_absent" | "known_present";
}) {
  return (
    <label htmlFor={id} className={labelClass}>
      {label}
      <select id={id} name={name} defaultValue={defaultValue} className={inputClass}>
        {(["unknown", "known_absent", "known_present"] as const).map((value) => (
          <option key={value} value={value}>{assetStatusLabel(value)}</option>
        ))}
      </select>
    </label>
  );
}

export function EnergyProfileEditor({
  workspaceId,
  projectId,
  addressRevision,
  expectedLatestRevision,
  profile,
  saveBlockedReason,
}: {
  workspaceId: string;
  projectId: string;
  addressRevision: number;
  expectedLatestRevision: number;
  profile: EnergyProfile;
  saveBlockedReason: string | null;
}) {
  const [state, formAction, pending] = useActionState(
    saveProjectEnergyProfileAction,
    initialState,
  );
  const formRef = useRef<HTMLFormElement | null>(null);
  const statusRef = useRef<HTMLParagraphElement | null>(null);
  const message = messageFor(state);
  const failed = state.status !== "idle" && state.status !== "success";

  useEffect(() => {
    if (state.status === "idle") return;
    if (state.status === "roof_review_required") {
      const defaultReplacement = [
        ...formRef.current?.querySelectorAll<HTMLSelectElement>(
          'select[name$=".replaceDefault"]',
        ) ?? [],
      ].find((control) => control.value !== "true");
      const unreviewedRoof = [
        ...formRef.current?.querySelectorAll<HTMLSelectElement>(
          'select[name$=".reviewed"]',
        ) ?? [],
      ].find((control) => control.value !== "true");
      const target = defaultReplacement ?? unreviewedRoof;
      if (target) {
        target.focus();
        return;
      }
    }
    statusRef.current?.focus();
  }, [state]);

  const validateConditionalAssets = (event: FormEvent<HTMLFormElement>) => {
    const form = event.currentTarget;
    const pvStatus = form.elements.namedItem("pvStatus") as HTMLSelectElement | null;
    const pvPower = form.elements.namedItem("pvPeakPowerKwp") as HTMLInputElement | null;
    const pvYear = form.elements.namedItem("pvCommissioningYear") as HTMLInputElement | null;
    const storageStatus = form.elements.namedItem("storageStatus") as HTMLSelectElement | null;
    const storageCapacity = form.elements.namedItem("storageCapacityKwh") as HTMLInputElement | null;

    for (const control of [pvPower, pvYear, storageCapacity]) {
      control?.setCustomValidity("");
    }
    if (pvStatus?.value === "known_present") {
      if (!pvPower?.value) pvPower?.setCustomValidity("Gib die vorhandene PV-Leistung an.");
      if (!pvYear?.value) pvYear?.setCustomValidity("Gib das Inbetriebnahmejahr an.");
    }
    if (storageStatus?.value === "known_present" && !storageCapacity?.value) {
      storageCapacity?.setCustomValidity("Gib die vorhandene Speicherkapazität an.");
    }
    if (!form.checkValidity()) {
      event.preventDefault();
      form.reportValidity();
    }
  };

  return (
    <form
      ref={formRef}
      action={formAction}
      onSubmit={validateConditionalAssets}
      aria-busy={pending}
      className="grid min-w-0 gap-7"
    >
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="expectedAddressRevision" value={addressRevision} />
      <input type="hidden" name="expectedLatestRevision" value={expectedLatestRevision} />
      <input type="hidden" name="roofCount" value={profile.roofs.length} />

      <div
        role="note"
        className="rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
      >
        <p className="font-semibold">Importierte Rechner-Eingaben – ungeprüft</p>
        <p className="mt-1">
          Unbekannte Werte bleiben unbekannt. Das importierte Rechner-Ergebnis,
          Marktpreise, Investition und Amortisation sind kein Bestandteil
          dieses Profils und werden hier nicht als Serverwahrheit übernommen.
        </p>
      </div>

      <fieldset className="min-w-0 rounded-lg border border-slate-200 p-4 sm:p-5">
        <legend className="px-1 text-base font-semibold text-slate-950">Gebäude</legend>
        <div className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2">
          <label htmlFor="energy-building-type" className={labelClass}>
            Gebäudetyp
            <select
              id="energy-building-type"
              name="buildingType"
              defaultValue={fieldValue(profile.building.type)}
              className={inputClass}
            >
              <option value="">Unbekannt</option>
              <option value="single_family">Einfamilienhaus</option>
              <option value="two_family">Zweifamilienhaus</option>
              <option value="multi_family">Mehrfamilienhaus</option>
              <option value="commercial">Gewerbe</option>
            </select>
          </label>
          <label htmlFor="energy-building-year" className={labelClass}>
            Baujahr
            <input
              id="energy-building-year"
              name="buildingYear"
              type="number"
              inputMode="numeric"
              min="1800"
              max="2200"
              step="1"
              defaultValue={fieldValue(profile.building.year)}
              className={inputClass}
            />
          </label>
          <label htmlFor="energy-heated-area" className={labelClass}>
            Beheizte Fläche (m²)
            <input
              id="energy-heated-area"
              name="heatedAreaM2"
              type="number"
              inputMode="decimal"
              min="0"
              max="10000"
              step="any"
              defaultValue={fieldValue(profile.building.heatedAreaM2)}
              className={inputClass}
            />
          </label>
        </div>
      </fieldset>

      <fieldset className="min-w-0 rounded-lg border border-slate-200 p-4 sm:p-5">
        <legend className="px-1 text-base font-semibold text-slate-950">
          Verbrauch und Lastprofil
        </legend>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Leere Felder werden ausdrücklich als unbekannt gespeichert, nicht als null Kilowattstunden.
        </p>
        <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
          <label htmlFor="energy-household" className={labelClass}>
            Haushaltsverbrauch (kWh/Jahr)
            <input id="energy-household" name="householdKwhPerYear" type="number" inputMode="decimal" min="0" max="100000" step="any" defaultValue={fieldValue(profile.consumption.householdKwhPerYear)} className={inputClass} />
          </label>
          <label htmlFor="energy-electricity-price" className={labelClass}>
            Kundentarif (ct/kWh)
            <input id="energy-electricity-price" name="electricityPriceCentsPerKwh" type="number" inputMode="decimal" min="1" max="200" step="any" defaultValue={fieldValue(profile.consumption.electricityPriceCentsPerKwh)} className={inputClass} />
          </label>
          <label htmlFor="energy-price-increase" className={labelClass}>
            Angegebene Preisänderung (%/Jahr)
            <input id="energy-price-increase" name="annualPriceIncreasePercent" type="number" inputMode="decimal" min="-10" max="25" step="any" defaultValue={fieldValue(profile.consumption.annualPriceIncreasePercent)} className={inputClass} />
          </label>
          <label htmlFor="energy-load-profile" className={labelClass}>
            Lastprofil
            <select id="energy-load-profile" name="loadProfile" defaultValue={fieldValue(profile.consumption.loadProfile)} className={inputClass}>
              <option value="">Unbekannt</option>
              <option value="wmee_household_hourly.v1">Standard-Haushalt stündlich</option>
              <option value="customer_monthly_hourly.v1">Kunden-Monatsprofil stündlich</option>
              <option value="commercial_interval.v1">Gewerbliches Intervallprofil</option>
            </select>
          </label>
          <label htmlFor="energy-ev-km" className={labelClass}>
            E-Auto-Fahrleistung (km/Jahr)
            <input id="energy-ev-km" name="evKmPerYear" type="number" inputMode="decimal" min="0" max="200000" step="any" defaultValue={fieldValue(profile.consumption.evKmPerYear)} className={inputClass} />
          </label>
          <label htmlFor="energy-ev-pattern" className={labelClass}>
            Ladezeitpunkt E-Auto
            <select id="energy-ev-pattern" name="evChargingPattern" defaultValue={fieldValue(profile.consumption.evChargingPattern)} className={inputClass}>
              <option value="">Unbekannt</option>
              <option value="evening">Überwiegend abends</option>
              <option value="daytime">Überwiegend tagsüber</option>
              <option value="away">Überwiegend außer Haus</option>
            </select>
          </label>
          <label htmlFor="energy-heat-pump" className={labelClass}>
            Wärmepumpe (kWh/Jahr)
            <input id="energy-heat-pump" name="heatPumpKwhPerYear" type="number" inputMode="decimal" min="0" max="100000" step="any" defaultValue={fieldValue(profile.consumption.heatPumpKwhPerYear)} className={inputClass} />
          </label>
          <label htmlFor="energy-cooling" className={labelClass}>
            Klimakühlung (kWh/Jahr)
            <input id="energy-cooling" name="coolingKwhPerYear" type="number" inputMode="decimal" min="0" max="100000" step="any" defaultValue={fieldValue(profile.consumption.coolingKwhPerYear)} className={inputClass} />
          </label>
          <label htmlFor="energy-heating-ac" className={labelClass}>
            Klimaheizung (kWh/Jahr)
            <input id="energy-heating-ac" name="heatingAcKwhPerYear" type="number" inputMode="decimal" min="0" max="100000" step="any" defaultValue={fieldValue(profile.consumption.heatingAcKwhPerYear)} className={inputClass} />
          </label>
          <label htmlFor="energy-hot-water" className={labelClass}>
            Elektrisches Warmwasser (kWh/Jahr)
            <input id="energy-hot-water" name="hotWaterKwhPerYear" type="number" inputMode="decimal" min="0" max="20000" step="any" defaultValue={fieldValue(profile.consumption.hotWaterKwhPerYear)} className={inputClass} />
          </label>
        </div>
      </fieldset>

      <fieldset className="min-w-0 rounded-lg border border-slate-200 p-4 sm:p-5">
        <legend className="px-1 text-base font-semibold text-slate-950">Bestandsanlagen</legend>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          „Unbekannt“, „nicht vorhanden“ und „vorhanden“ bleiben drei getrennte Zustände.
        </p>
        <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
          <AssetStatusSelect id="energy-pv-status" name="pvStatus" label="Bestands-PV" defaultValue={profile.existingAssets.pv.status} />
          <label htmlFor="energy-pv-kwp" className={labelClass}>
            Bestands-PV-Leistung bei „vorhanden“ (kWp)
            <input id="energy-pv-kwp" name="pvPeakPowerKwp" type="number" inputMode="decimal" min="0.000001" max="1000" step="any" defaultValue={profile.existingAssets.pv.status === "known_present" ? profile.existingAssets.pv.peakPowerKwp : ""} className={inputClass} />
          </label>
          <label htmlFor="energy-pv-year" className={labelClass}>
            Inbetriebnahmejahr bei „vorhanden“
            <input id="energy-pv-year" name="pvCommissioningYear" type="number" inputMode="numeric" min="1900" max="2200" step="1" defaultValue={profile.existingAssets.pv.status === "known_present" ? profile.existingAssets.pv.commissioningYear : ""} className={inputClass} />
          </label>
          <AssetStatusSelect id="energy-storage-status" name="storageStatus" label="Bestandsspeicher" defaultValue={profile.existingAssets.storage.status} />
          <label htmlFor="energy-storage-capacity" className={labelClass}>
            Bestandsspeicher bei „vorhanden“ (kWh)
            <input id="energy-storage-capacity" name="storageCapacityKwh" type="number" inputMode="decimal" min="0.000001" max="1000" step="any" defaultValue={profile.existingAssets.storage.status === "known_present" ? profile.existingAssets.storage.capacityKwh : ""} className={inputClass} />
          </label>
          <AssetStatusSelect id="energy-wallbox-status" name="wallboxStatus" label="Vorhandene Wallbox" defaultValue={profile.existingAssets.wallbox.status} />
          <AssetStatusSelect id="energy-ev-status" name="evStatus" label="Vorhandenes E-Auto" defaultValue={profile.existingAssets.ev.status} />
        </div>
      </fieldset>

      <fieldset className="min-w-0 rounded-lg border border-slate-200 p-4 sm:p-5">
        <legend className="px-1 text-base font-semibold text-slate-950">Dachflächen</legend>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Jede Fläche muss für den aktuellen Standort bewusst geprüft sein. Eine
          Default-Geometrie kann nicht durch bloßes Abhaken bestätigt werden.
        </p>
        <div className="mt-4 grid min-w-0 gap-5">
          {profile.roofs.map((roof, index) => {
            const prefix = `roof.${index}`;
            const headingId = `energy-roof-${index}-title`;
            return (
              <fieldset
                key={roof.id}
                aria-labelledby={headingId}
                className="min-w-0 rounded-md border border-slate-200 bg-slate-50 p-4"
              >
                <legend id={headingId} className="max-w-full break-words px-1 text-sm font-semibold text-slate-950">
                  Dachfläche {index + 1}
                </legend>
                <input type="hidden" name={`${prefix}.id`} value={roof.id} />
                <p className="mt-2 break-words text-xs leading-5 text-slate-600">
                  Herkunft: {sourceLabel(roof.source)} · ID: <code className="break-all font-mono">{roof.id}</code>
                </p>
                <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
                  <label htmlFor={`${prefix}-area`} className={labelClass}>
                    Fläche (m²)
                    <input id={`${prefix}-area`} name={`${prefix}.areaM2`} type="number" inputMode="decimal" min="0.000001" max="2000" step="any" required aria-required="true" defaultValue={roof.areaM2} className={inputClass} />
                  </label>
                  <label htmlFor={`${prefix}-azimuth`} className={labelClass}>
                    Azimut (−180° bis 180°)
                    <input id={`${prefix}-azimuth`} name={`${prefix}.azimuthDeg`} type="number" inputMode="decimal" min="-180" max="180" step="any" required aria-required="true" defaultValue={roof.azimuthDeg} className={inputClass} />
                  </label>
                  <label htmlFor={`${prefix}-tilt`} className={labelClass}>
                    Neigung (0° bis 90°)
                    <input id={`${prefix}-tilt`} name={`${prefix}.tiltDeg`} type="number" inputMode="decimal" min="0" max="90" step="any" required aria-required="true" defaultValue={roof.tiltDeg} className={inputClass} />
                  </label>
                  <label htmlFor={`${prefix}-type`} className={labelClass}>
                    Dachtyp
                    <select id={`${prefix}-type`} name={`${prefix}.type`} defaultValue={roof.type} className={inputClass}>
                      <option value="pitched">Geneigtes Dach</option>
                      <option value="flat">Flachdach</option>
                    </select>
                  </label>
                  <label htmlFor={`${prefix}-shading`} className={labelClass}>
                    Verschattung
                    <select id={`${prefix}-shading`} name={`${prefix}.shading`} defaultValue={fieldValue(roof.shading)} className={inputClass}>
                      <option value="">Unbekannt</option>
                      <option value="none">Keine</option>
                      <option value="light">Leicht</option>
                      <option value="medium">Mittel</option>
                      <option value="strong">Stark</option>
                    </select>
                  </label>
                  <label htmlFor={`${prefix}-reviewed`} className={labelClass}>
                    Für den aktuellen Standort geprüft?
                    <select id={`${prefix}-reviewed`} name={`${prefix}.reviewed`} defaultValue={roof.source === "operator_reviewed" ? "true" : "false"} className={inputClass}>
                      <option value="false">Noch nicht geprüft</option>
                      <option value="true">Ja, bewusst geprüft</option>
                    </select>
                  </label>
                  {roof.source === "default" ? (
                    <label htmlFor={`${prefix}-replace-default`} className={`${labelClass} sm:col-span-2`}>
                      Default-Dach durch diese neu erfasste Ersatzgeometrie ersetzen?
                      <select id={`${prefix}-replace-default`} name={`${prefix}.replaceDefault`} defaultValue="false" className={inputClass}>
                        <option value="false">Nein, als ungeprüften Entwurf behalten</option>
                        <option value="true">Ja, bewusst als neue Ersatzgeometrie erfassen</option>
                      </select>
                    </label>
                  ) : (
                    <input type="hidden" name={`${prefix}.replaceDefault`} value="false" />
                  )}
                </div>
              </fieldset>
            );
          })}
        </div>
      </fieldset>

      {saveBlockedReason ? (
        <div
          role="note"
          className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
        >
          <span className="font-semibold">Speichern blockiert: </span>
          {saveBlockedReason}
        </div>
      ) : (
        <button
          type="submit"
          disabled={pending}
          className="min-h-11 w-full rounded-md bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-blue-800 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-300 sm:w-auto sm:justify-self-start"
        >
          {pending ? "Profil wird gespeichert …" : "Profil speichern"}
        </button>
      )}

      <p
        ref={statusRef}
        tabIndex={-1}
        role={failed ? "alert" : "status"}
        aria-live={failed ? "assertive" : "polite"}
        aria-atomic="true"
        className={
          message
            ? failed
              ? "rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950 outline-none focus-visible:ring-2 focus-visible:ring-amber-600"
              : "rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-950 outline-none focus-visible:ring-2 focus-visible:ring-emerald-600"
            : "sr-only"
        }
      >
        {message}
      </p>
    </form>
  );
}
