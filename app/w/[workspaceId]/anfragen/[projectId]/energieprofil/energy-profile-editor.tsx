"use client";

import { useActionState, useEffect, useRef, useState, type FormEvent } from "react";
import type { ProjectEnergyProfileCandidate } from "@/modules/energy";
import {
  estimateHeatingLoadV1,
  SIZING_ESTIMATE_DISCLAIMER_V1,
} from "@/lib/integrations/heat-pump/sizing-estimate-v1";
import {
  saveProjectEnergyProfileAction,
  type SaveProjectEnergyProfileState,
} from "../../energy-actions";

type EnergyProfile = ProjectEnergyProfileCandidate["profile"];
type KnownOrUnknown = { status: "known"; value: unknown } | { status: "unknown" };

const initialState: SaveProjectEnergyProfileState = { status: "idle" };
const inputClass = "min-h-11 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-base text-slate-950 outline-none focus-visible:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500";
const labelClass = "grid min-w-0 gap-1.5 text-sm font-medium text-slate-800";

function fieldValue(field: KnownOrUnknown): string | number {
  return field.status === "known" && (
    typeof field.value === "string" || typeof field.value === "number"
  ) ? field.value : "";
}

// F4-04f Vergleichstarif-Feld (Gruppe, Key) -> Default (leer ohne Tarif;
// Speichern bleibt ein Roundtrip, Namen ungetrimmt wie gespeichert).
function comparisonTariffField(
  profile: EnergyProfile,
  group: number,
  key: "name" | "importPriceCtPerKwh" | "priceEscalationPct" | "baseFeeEuroPerYear" | "demandChargeEuroPerKw",
): string | number {
  const field = profile.consumption.comparisonTariffs ?? { status: "unknown" };
  if (field.status !== "known" || !Array.isArray(field.value)) return "";
  const entry = (field.value[group] ?? {}) as Record<string, unknown>;
  const value = entry[key];
  return typeof value === "string" || typeof value === "number" ? value : "";
}

// F4.2c CSV: bekannte kWh-Reihe -> Zeilentext (vollstaendig, damit
// Speichern ein Roundtrip bleibt), sonst leer.
function csvDefaultValue(field: KnownOrUnknown): string {
  if (field.status !== "known" || !Array.isArray(field.value)) return "";
  if (!field.value.every((entry) => typeof entry === "number")) return "";
  return (field.value as number[]).join("\n");
}

// F4.4b TOU: bekanntes 24-Preise-Array -> Komma-Text, sonst leer.
function touPriceListValue(field: KnownOrUnknown): string {
  if (field.status !== "known" || !Array.isArray(field.value)) return "";
  return field.value.every((entry) => typeof entry === "number")
    ? (field.value as number[]).join(", ")
    : "";
}

// F5-01 WP-Schätzung: rein lesende Orientierungsbox aus dem GESPEICHERTEN
// thermischen Bedarf. Keine Klasse im Profil -> beide Klassen nebeneinander;
// unbelegter Bedarf -> Hinweis statt Zahl (fail-closed, keine 0-kW-Zahl).
function HpSizingEstimateBox({ thermalField }: { thermalField: KnownOrUnknown }) {
  const annualThermalKwh =
    thermalField.status === "known" && typeof thermalField.value === "number"
      ? thermalField.value
      : null;
  let bestand: string | null = null;
  let neubau: string | null = null;
  if (annualThermalKwh !== null) {
    try {
      const b = estimateHeatingLoadV1({ annualThermalKwh, buildingClass: "bestand" });
      bestand = `${b.heatingLoadKw.toLocaleString("de-DE")} kW (Empfehlung ca. ${b.recommendedNominalKw.toLocaleString("de-DE")} kW)`;
    } catch {
      bestand = null;
    }
    try {
      const n = estimateHeatingLoadV1({ annualThermalKwh, buildingClass: "neubau" });
      neubau = `${n.heatingLoadKw.toLocaleString("de-DE")} kW (Empfehlung ca. ${n.recommendedNominalKw.toLocaleString("de-DE")} kW)`;
    } catch {
      neubau = null;
    }
  }
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800" data-testid="hp-sizing-estimate">
      <p className="font-medium">Wärmepumpen-Heizlast (Schätzung)</p>
      {bestand !== null && neubau !== null ? (
        <ul className="mt-1 list-disc pl-5">
          <li>Bestand: {bestand}</li>
          <li>Neubau: {neubau}</li>
        </ul>
      ) : (
        <p className="mt-1">Kein belegter thermischer Wärmebedarf — keine Schätzung.</p>
      )}
      <p className="mt-1 text-xs text-slate-600">{SIZING_ESTIMATE_DISCLAIMER_V1}</p>
    </div>
  );
}

const MONTH_NAMES_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];
const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => `${hour} Uhr`);

type CustomLoadProfileField = {
  status: "known";
  value: {
    monthlyKwh: readonly unknown[];
    weekdayHourlyKwh: readonly unknown[] | null;
    weekendHourlyKwh: readonly unknown[] | null;
  };
} | { status: string; value?: unknown };

function customArrayValue(field: CustomLoadProfileField, key: "monthlyKwh" | "weekdayHourlyKwh" | "weekendHourlyKwh", index: number): string | number {
  if (field.status !== "known" || field.value === undefined) return "";
  const list: unknown = (field.value as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return "";
  const entry = list[index];
  return typeof entry === "number" ? entry : "";
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
    case "packages_unsupported":
      return "Für dieses Projekt liegt keine Rechner-Anforderung vor, an die sich Zielpakete hängen ließen. Das Profil wurde nicht gespeichert.";
    default:
      return "";
  }
}

// F1-19 Eingabemodus- und Paket-Labels (Anzeige; Werte sind Contract-Enums).
const INPUT_MODE_OPTIONS = [
  { value: "consumption", label: "Verbrauch (Rechnerwerte)" },
  { value: "property", label: "Objekt-Schätzung" },
  { value: "roomwise", label: "Raumweise Erfassung" },
  { value: "manual", label: "Manuelle Eingabe" },
] as const;

const HEATING_TYPE_OPTIONS = [
  { value: "gas", label: "Gas" },
  { value: "oil", label: "Öl" },
  { value: "heat_pump", label: "Wärmepumpe" },
  { value: "district_heating", label: "Fernwärme" },
  { value: "direct_electric", label: "Direktstrom" },
  { value: "biomass", label: "Biomasse" },
  { value: "other", label: "Sonstige" },
] as const;

const ROOM_USAGE_OPTIONS = [
  { value: "living", label: "Wohnen" },
  { value: "bedroom", label: "Schlafen" },
  { value: "kitchen", label: "Küche" },
  { value: "bathroom", label: "Bad" },
  { value: "hallway", label: "Flur" },
  { value: "office", label: "Büro" },
  { value: "commercial", label: "Gewerbe" },
  { value: "storage", label: "Abstellraum" },
  { value: "other", label: "Sonstiges" },
] as const;

const PACKAGE_ROWS = [
  { key: "Solar", label: "Solar" },
  { key: "Storage", label: "Speicher" },
  { key: "Wallbox", label: "Wallbox" },
  { key: "Heating", label: "Heizung" },
] as const;

const PACKAGE_PAYMENT_OPTIONS = [
  { value: "purchase", label: "Kauf" },
  { value: "leasing", label: "Leasing" },
  { value: "financing", label: "Finanzierung" },
] as const;

type RoomDraft = { name: string; areaM2: string; usage: string; radiators: string };

function roomDraftsFromProfile(profile: EnergyProfile): RoomDraft[] {
  const rooms = profile.rooms ?? [];
  return rooms.map((room) => ({
    name: room.name,
    areaM2: String(room.areaM2),
    usage: room.usage,
    radiators: String(room.radiatorCount),
  }));
}

function AssetStatusSelect({
  id,
  name,
  label,
  defaultValue,
  onChange,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue: "unknown" | "known_absent" | "known_present";
  onChange?: (value: string) => void;
}) {
  return (
    <label htmlFor={id} className={labelClass}>
      {label}
      <select
        id={id}
        name={name}
        defaultValue={defaultValue}
        onChange={onChange === undefined ? undefined : (event) => onChange(event.currentTarget.value)}
        className={inputClass}
      >
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
  scope,
}: {
  workspaceId: string;
  projectId: string;
  addressRevision: number;
  expectedLatestRevision: number;
  profile: EnergyProfile;
  saveBlockedReason: string | null;
  // F4-02d Commercial-Gate: CSV-Option + Lastgang-Textarea nur bei
  // scope=commercial; residential oder fehlender Scope blendet beides
  // aus (fail-closed, kein leeres Gate-Element).
  scope?: "residential" | "commercial";
}) {
  const [state, formAction, pending] = useActionState(
    saveProjectEnergyProfileAction,
    initialState,
  );
  const formRef = useRef<HTMLFormElement | null>(null);
  // F1-19 Eingabemodus (kontrolliert: Wechsel verlangt Bestätigung, kein
  // stilles Verwerfen von Modus-Eingaben).
  const [mode, setMode] = useState<string>(profile.inputMode);
  const [roomDrafts, setRoomDrafts] = useState<RoomDraft[]>(() =>
    roomDraftsFromProfile(profile),
  );
  const modeChanged = mode !== profile.inputMode;
  const changeMode = (next: string) => {
    if (next === mode) return;
    if (
      next !== profile.inputMode
      && typeof window !== "undefined"
      && !window.confirm(
        "Eingabemodus wechseln? Modus-spezifische Eingaben anderer Modi gehen beim Speichern verloren.",
      )
    ) {
      return;
    }
    if (next === "roomwise") {
      setRoomDrafts((current) =>
        current.length === 0
          ? [{ name: "", areaM2: "", usage: "", radiators: "" }]
          : current,
      );
    }
    setMode(next);
  };
  const [loadProfile, setLoadProfile] = useState(() =>
    profile.consumption.loadProfile.status === "known"
      ? String(profile.consumption.loadProfile.value)
      : "",
  );
  // F4-03b Widerspruchshinweis (lesend): EV-km > 0 gegen E-Auto „Nicht
  // vorhanden" verweigert das Speichern serverseitig — der Hinweis zeigt
  // den Widerspruch vorab, ohne eine Seite still zu bevorzugen.
  const [evKm, setEvKm] = useState(() =>
    String(fieldValue(profile.consumption.evKmPerYear)),
  );
  const [evStatus, setEvStatus] = useState<string>(
    profile.existingAssets.ev.status,
  );
  const evContradiction = evStatus === "known_absent" && Number(evKm) > 0;
  const customProfile = (profile.consumption.customLoadProfile ?? {
    status: "unknown",
  }) as CustomLoadProfileField;
  const monthlySelected = loadProfile === "customer_monthly_hourly.v1";
  const csvSelected = loadProfile === "customer_csv.v1";
  const csvAllowed = scope === "commercial";
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
      <input type="hidden" name="roomCount" value={mode === "roomwise" ? roomDrafts.length : 0} />

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

      <fieldset className="min-w-0 rounded-lg border border-slate-200 p-4 sm:p-5" data-testid="input-mode-section">
        <legend className="px-1 text-base font-semibold text-slate-950">Eingabemodus</legend>
        <div className="mt-3 grid min-w-0 gap-4 sm:grid-cols-2">
          <label htmlFor="energy-input-mode" className={labelClass}>
            Erfassungsart
            <select
              id="energy-input-mode"
              name="inputMode"
              data-testid="input-mode"
              value={mode}
              onChange={(event) => changeMode(event.currentTarget.value)}
              className={inputClass}
            >
              {INPUT_MODE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
        {modeChanged ? (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-950" role="note">
            Moduswechsel: Beim Speichern ersetzt der neue Modus den bisherigen;
            Modus-Eingaben anderer Modi entfallen.
          </p>
        ) : null}
        {mode === "manual" ? (
          <p className="mt-3 text-sm leading-6 text-slate-600">
            Manuelle Eingabe: Das Profil wird mit der Provenance „manuell erfasst“
            gespeichert, nicht als Rechner-Import.
          </p>
        ) : null}
      </fieldset>

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

      {mode === "property" ? (
        <fieldset className="min-w-0 rounded-lg border border-slate-200 p-4 sm:p-5" data-testid="property-section">
          <legend className="px-1 text-base font-semibold text-slate-950">Objekt-Schätzung</legend>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Heizart und Bewohnerzahl sind im Objekt-Modus Pflicht (1–20 Bewohner).
          </p>
          <div className="mt-4 grid min-w-0 gap-4 sm:grid-cols-2">
            <label htmlFor="energy-heating-type" className={labelClass}>
              Heizart
              <select
                id="energy-heating-type"
                name="heatingType"
                data-testid="heating-type"
                defaultValue={profile.propertyEstimate?.heatingType ?? ""}
                className={inputClass}
              >
                <option value="">Bitte wählen</option>
                {HEATING_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label htmlFor="energy-resident-count" className={labelClass}>
              Bewohner (1–20)
              <input
                id="energy-resident-count"
                name="residentCount"
                data-testid="resident-count"
                type="number"
                inputMode="numeric"
                min="1"
                max="20"
                step="1"
                defaultValue={profile.propertyEstimate?.residentCount ?? ""}
                className={inputClass}
              />
            </label>
          </div>
        </fieldset>
      ) : null}

      {mode === "roomwise" ? (
        <fieldset className="min-w-0 rounded-lg border border-slate-200 p-4 sm:p-5" data-testid="rooms-section">
          <legend className="px-1 text-base font-semibold text-slate-950">Raumliste (1–40 Räume)</legend>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Je Raum sind Name, Fläche, Nutzung und Heizkörper-Anzahl Pflicht
            (0 = unbeheizt). Halb erfasste Räume verweigert das Speichern.
          </p>
          <div className="mt-4 grid min-w-0 gap-5">
            {roomDrafts.map((room, index) => (
              <fieldset
                key={`room-${index}`}
                className="min-w-0 rounded-md border border-slate-200 bg-slate-50 p-4"
              >
                <legend className="max-w-full break-words px-1 text-sm font-semibold text-slate-950">
                  Raum {index + 1}
                </legend>
                <div className="mt-2 grid min-w-0 gap-4 sm:grid-cols-2">
                  <label htmlFor={`room-${index}-name`} className={labelClass}>
                    Name
                    <input
                      id={`room-${index}-name`}
                      name={`room.${index}.name`}
                      type="text"
                      maxLength={64}
                      required
                      aria-required="true"
                      value={room.name}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setRoomDrafts((current) =>
                          current.map((draft, draftIndex) =>
                            draftIndex === index
                              ? { ...draft, name: value }
                              : draft,
                          ),
                        );
                      }}
                      className={inputClass}
                    />
                  </label>
                  <label htmlFor={`room-${index}-area`} className={labelClass}>
                    Fläche (m²)
                    <input
                      id={`room-${index}-area`}
                      name={`room.${index}.areaM2`}
                      type="number"
                      inputMode="decimal"
                      min="0.000001"
                      max="2000"
                      step="any"
                      required
                      aria-required="true"
                      value={room.areaM2}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setRoomDrafts((current) =>
                          current.map((draft, draftIndex) =>
                            draftIndex === index
                              ? { ...draft, areaM2: value }
                              : draft,
                          ),
                        );
                      }}
                      className={inputClass}
                    />
                  </label>
                  <label htmlFor={`room-${index}-usage`} className={labelClass}>
                    Nutzung
                    <select
                      id={`room-${index}-usage`}
                      name={`room.${index}.usage`}
                      required
                      aria-required="true"
                      value={room.usage}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setRoomDrafts((current) =>
                          current.map((draft, draftIndex) =>
                            draftIndex === index
                              ? { ...draft, usage: value }
                              : draft,
                          ),
                        );
                      }}
                      className={inputClass}
                    >
                      <option value="">Bitte wählen</option>
                      {ROOM_USAGE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                  <label htmlFor={`room-${index}-radiators`} className={labelClass}>
                    Heizkörper (0–50)
                    <input
                      id={`room-${index}-radiators`}
                      name={`room.${index}.radiators`}
                      type="number"
                      inputMode="numeric"
                      min="0"
                      max="50"
                      step="1"
                      required
                      aria-required="true"
                      value={room.radiators}
                      onChange={(event) => {
                        const value = event.currentTarget.value;
                        setRoomDrafts((current) =>
                          current.map((draft, draftIndex) =>
                            draftIndex === index
                              ? { ...draft, radiators: value }
                              : draft,
                          ),
                        );
                      }}
                      className={inputClass}
                    />
                  </label>
                </div>
                <button
                  type="button"
                  disabled={roomDrafts.length <= 1}
                  onClick={() => setRoomDrafts((current) => current.filter((_, draftIndex) => draftIndex !== index))}
                  className="mt-3 min-h-11 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
                >
                  Raum {index + 1} entfernen
                </button>
              </fieldset>
            ))}
          </div>
          <button
            type="button"
            disabled={roomDrafts.length >= 40}
            onClick={() => setRoomDrafts((current) => current.length >= 40
              ? current
              : [...current, { name: "", areaM2: "", usage: "", radiators: "" }])}
            className="mt-4 min-h-11 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 outline-none hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
          >
            Weiteren Raum erfassen
          </button>
        </fieldset>
      ) : null}

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
            <select id="energy-load-profile" name="loadProfile" defaultValue={fieldValue(profile.consumption.loadProfile)} onChange={(event) => setLoadProfile(event.currentTarget.value)} className={inputClass}>
              <option value="">Unbekannt</option>
              <option value="wmee_household_hourly.v1">Standard-Haushalt stündlich</option>
              <option value="customer_monthly_hourly.v1">Kunden-Monatsprofil stündlich</option>
              <option value="commercial_interval.v1">Gewerbliches Intervallprofil</option>
              {csvAllowed ? (
                <option value="customer_csv.v1">Lastgang-CSV (8760/35040 Werte)</option>
              ) : null}
            </select>
          </label>
          <label htmlFor="energy-ev-km" className={labelClass}>
            E-Auto-Fahrleistung (km/Jahr)
            <input id="energy-ev-km" name="evKmPerYear" type="number" inputMode="decimal" min="0" max="200000" step="any" defaultValue={fieldValue(profile.consumption.evKmPerYear)} onChange={(event) => setEvKm(event.currentTarget.value)} className={inputClass} />
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
          <label htmlFor="energy-ev-segment" className={labelClass}>
            Fahrzeugklasse E-Auto
            <select id="energy-ev-segment" name="evSegment" defaultValue={fieldValue(profile.consumption.evSegment ?? { status: "unknown" })} className={inputClass}>
              <option value="">Unbekannt</option>
              <option value="klein">Klein</option>
              <option value="mittel">Mittel</option>
              <option value="gross">Groß</option>
            </select>
          </label>
          <label htmlFor="energy-ev-model" className={labelClass}>
            Fahrzeugmodell E-Auto (Freitext, keine Verbrauchsableitung)
            <input id="energy-ev-model" name="evVehicleModel" type="text" maxLength={120} defaultValue={fieldValue(profile.consumption.evVehicleModel ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-wallbox-kw" className={labelClass}>
            Wallbox-Maximalleistung (kW, Vorschlag 11, leer = keine Kappung)
            <input id="energy-wallbox-kw" name="wallboxMaxKw" type="number" inputMode="decimal" min="1" max="43" step="any" placeholder="11" defaultValue={fieldValue(profile.consumption.wallboxMaxKw ?? { status: "unknown" })} className={inputClass} />
          </label>
          {evContradiction ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-6 text-amber-950 sm:col-span-2" role="note">
              Widerspruch: E-Auto-Fahrleistung über 0 km, aber E-Auto als „Nicht vorhanden“ markiert. Das Speichern wird verweigert — bitte abstimmen.
            </p>
          ) : null}
          <label htmlFor="energy-heat-pump" className={labelClass}>
            Wärmepumpe Strom (kWh/Jahr, ohne COP-Kennlinie)
            <input id="energy-heat-pump" name="heatPumpKwhPerYear" type="number" inputMode="decimal" min="0" max="100000" step="any" defaultValue={fieldValue(profile.consumption.heatPumpKwhPerYear)} className={inputClass} />
          </label>
          <label htmlFor="energy-heat-pump-thermal" className={labelClass}>
            Wärmepumpe Wärmebedarf (kWh/Jahr, thermisch, mit COP-Kennlinie)
            <input id="energy-heat-pump-thermal" name="heatPumpThermalKwhPerYear" type="number" inputMode="decimal" min="0" max="100000" step="any" defaultValue={fieldValue(profile.consumption.heatPumpThermalKwhPerYear ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-heat-pump-cop" className={labelClass}>
            WP-COP Nennwert bei 7 °C (1–8, Default 4,0)
            <input id="energy-heat-pump-cop" name="heatPumpCopNominal" type="number" inputMode="decimal" min="1" max="8" step="any" defaultValue={fieldValue(profile.consumption.heatPumpCopNominal ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-heat-pump-bivalence" className={labelClass}>
            WP-Bivalenzpunkt (°C, Default −6)
            <input id="energy-heat-pump-bivalence" name="heatPumpBivalenceTempC" type="number" inputMode="decimal" min="-25" max="15" step="any" defaultValue={fieldValue(profile.consumption.heatPumpBivalenceTempC ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-heat-pump-ww" className={labelClass}>
            WP-Warmwasseranteil (0–1, Default 0)
            <input id="energy-heat-pump-ww" name="heatPumpHotWaterShare" type="number" inputMode="decimal" min="0" max="1" step="any" defaultValue={fieldValue(profile.consumption.heatPumpHotWaterShare ?? { status: "unknown" })} className={inputClass} />
          </label>
          <HpSizingEstimateBox thermalField={profile.consumption.heatPumpThermalKwhPerYear ?? { status: "unknown" }} />
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
          <label htmlFor="energy-investment" className={labelClass}>
            Investition netto (€)
            <input id="energy-investment" name="investmentEuro" type="number" inputMode="decimal" min="0" max="10000000" step="any" defaultValue={fieldValue(profile.consumption.investmentEuro ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-feedin-tariff" className={labelClass}>
            Einspeisevergütung Override (Ct/kWh, leer = EEG-Default)
            <input id="energy-feedin-tariff" name="feedInTariffCtPerKwh" type="number" inputMode="decimal" min="0" max="100" step="any" defaultValue={fieldValue(profile.consumption.feedInTariffCtPerKwh ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-feedin-year" className={labelClass}>
            EEG-Inbetriebnahmejahr (Vergütungssatz, 1990–2100)
            <input id="energy-feedin-year" name="feedInCommissioningYear" type="number" inputMode="numeric" min="1990" max="2100" step="1" defaultValue={fieldValue(profile.consumption.feedInCommissioningYear ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-albedo" className={labelClass}>
            Boden-Albedo (0–1, leer = 0,2)
            <input id="energy-albedo" name="groundAlbedo" type="number" inputMode="decimal" min="0" max="1" step="any" defaultValue={fieldValue(profile.consumption.groundAlbedo ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-alt-tariff" className={labelClass}>
            Neutarif Vergleich (Ct/kWh, leer = kein Vergleich)
            <input id="energy-alt-tariff" name="alternativeImportPriceCtPerKwh" type="number" inputMode="decimal" min="1" max="200" step="any" defaultValue={fieldValue(profile.consumption.alternativeImportPriceCtPerKwh ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-alt-tariff-escalation" className={labelClass}>
            Neutarif Preissteigerung (% p. a., −10–25, leer = wie aktueller Tarif)
            <input id="energy-alt-tariff-escalation" name="alternativeImportPriceEscalationPct" type="number" inputMode="decimal" min="-10" max="25" step="any" defaultValue={fieldValue(profile.consumption.alternativeImportPriceEscalationPct ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-base-fee" className={labelClass}>
            Grundpreis aktueller Tarif (€/Jahr, leer = 0)
            <input id="energy-base-fee" name="baseFeeEuroPerYear" type="number" inputMode="decimal" min="0" max="100000" step="any" defaultValue={fieldValue(profile.consumption.baseFeeEuroPerYear ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-alt-base-fee" className={labelClass}>
            Grundpreis Neutarif (€/Jahr, leer = wie aktueller Tarif)
            <input id="energy-alt-base-fee" name="alternativeBaseFeeEuroPerYear" type="number" inputMode="decimal" min="0" max="100000" step="any" defaultValue={fieldValue(profile.consumption.alternativeBaseFeeEuroPerYear ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-demand-charge" className={labelClass}>
            Leistungspreis aktueller Tarif (€/kW, leer = 0)
            <input id="energy-demand-charge" name="demandChargeEuroPerKw" type="number" inputMode="decimal" min="0" max="10000" step="any" defaultValue={fieldValue(profile.consumption.demandChargeEuroPerKw ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-alt-demand-charge" className={labelClass}>
            Leistungspreis Neutarif (€/kW, leer = wie aktueller Tarif)
            <input id="energy-alt-demand-charge" name="alternativeDemandChargeEuroPerKw" type="number" inputMode="decimal" min="0" max="10000" step="any" defaultValue={fieldValue(profile.consumption.alternativeDemandChargeEuroPerKw ?? { status: "unknown" })} className={inputClass} />
          </label>
          {[0, 1, 2].map((group) => (
            <fieldset key={`cmp-${group}`} className="grid gap-3 rounded-md border border-slate-200 p-3 sm:grid-cols-2">
              <legend className="px-1 text-xs font-semibold text-slate-700">
                {`Vergleichstarif ${group + 1} (Name + Preis = Tarif, Rest leer = wie aktueller Tarif)`}
              </legend>
              <label htmlFor={`energy-cmp-${group}-name`} className={labelClass}>
                {`Vergleichstarif ${group + 1} Name (leer = kein Tarif)`}
                <input id={`energy-cmp-${group}-name`} name={`cmp${group}Name`} type="text" maxLength={40} defaultValue={comparisonTariffField(profile, group, "name")} className={inputClass} />
              </label>
              <label htmlFor={`energy-cmp-${group}-price`} className={labelClass}>
                {`Vergleichstarif ${group + 1} Preis (Ct/kWh, 1–200)`}
                <input id={`energy-cmp-${group}-price`} name={`cmp${group}Price`} type="number" inputMode="decimal" min="1" max="200" step="any" defaultValue={comparisonTariffField(profile, group, "importPriceCtPerKwh")} className={inputClass} />
              </label>
              <label htmlFor={`energy-cmp-${group}-escalation`} className={labelClass}>
                {`Vergleichstarif ${group + 1} Preissteigerung (% p. a., −10–25)`}
                <input id={`energy-cmp-${group}-escalation`} name={`cmp${group}Escalation`} type="number" inputMode="decimal" min="-10" max="25" step="any" defaultValue={comparisonTariffField(profile, group, "priceEscalationPct")} className={inputClass} />
              </label>
              <label htmlFor={`energy-cmp-${group}-base-fee`} className={labelClass}>
                {`Vergleichstarif ${group + 1} Grundpreis (€/Jahr)`}
                <input id={`energy-cmp-${group}-base-fee`} name={`cmp${group}BaseFee`} type="number" inputMode="decimal" min="0" max="100000" step="any" defaultValue={comparisonTariffField(profile, group, "baseFeeEuroPerYear")} className={inputClass} />
              </label>
              <label htmlFor={`energy-cmp-${group}-demand`} className={labelClass}>
                {`Vergleichstarif ${group + 1} Leistungspreis (€/kW)`}
                <input id={`energy-cmp-${group}-demand`} name={`cmp${group}Demand`} type="number" inputMode="decimal" min="0" max="10000" step="any" defaultValue={comparisonTariffField(profile, group, "demandChargeEuroPerKw")} className={inputClass} />
              </label>
            </fieldset>
          ))}
          <label htmlFor="energy-tou-prices" className={labelClass}>
            TOU-Stundenpreise (24 Werte Komma-getrennt, leer = kein TOU)
            <input id="energy-tou-prices" name="touImportPricesCt" type="text" inputMode="decimal" defaultValue={touPriceListValue(profile.consumption.touImportPricesCtPerKwh ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-tou-day-ahead" className={labelClass}>
            Day-ahead-Stundenpreise (8760 Werte, eine Zahl pro Zeile, leer = kein Day-ahead; schließt das 24-h-Profil aus)
            <textarea id="energy-tou-day-ahead" name="touDayAheadCsv" rows={6} className={inputClass} defaultValue={csvDefaultValue(profile.consumption.touDayAheadPricesCtPerKwh ?? { status: "unknown" })} />
          </label>
          <label htmlFor="energy-tou-base-fee" className={labelClass}>
            TOU-Grundpreis (€/Jahr, leer = nur Arbeitspreis)
            <input id="energy-tou-base-fee" name="touBaseFeeEuro" type="number" inputMode="decimal" min="0" max="100000" step="any" defaultValue={fieldValue(profile.consumption.touBaseFeeEuro ?? { status: "unknown" })} className={inputClass} />
          </label>
          <label htmlFor="energy-tou-demand" className={labelClass}>
            TOU-Leistungspreis (€/kW TOU-Spitze, leer = nur Arbeitspreis)
            <input id="energy-tou-demand" name="touDemandChargeEuroPerKw" type="number" inputMode="decimal" min="0" max="10000" step="any" defaultValue={fieldValue(profile.consumption.touDemandChargeEuroPerKw ?? { status: "unknown" })} className={inputClass} />
          </label>
        </div>
      </fieldset>

      {monthlySelected ? (
        <fieldset className="min-w-0 rounded-lg border border-slate-200 p-4 sm:p-5" data-energy-custom-profile="true">
          <legend className="px-1 text-base font-semibold text-slate-950">Custom-Lastprofil (Monatswerte)</legend>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Zwölf Monatsverbräuche in kWh (Pflicht, Summe &gt; 0). Optional je
            ein Tagesgang für Werktage und Wochenenden (je 24 Stunden, nur
            vollständig oder leer); ohne Tagesgang trägt die Stunde die
            H0-Tagesform.
          </p>
          <div className="mt-4 grid min-w-0 grid-cols-2 gap-4 sm:grid-cols-4" role="group" aria-label="Monatsverbräuche in kWh">
            {MONTH_NAMES_DE.map((month, index) => (
              <label key={month} className={labelClass}>
                {month}
                <input name={`customMonthly.${index}`} type="number" inputMode="decimal" min="0" max="100000" step="any" defaultValue={customArrayValue(customProfile, "monthlyKwh", index)} className={inputClass} />
              </label>
            ))}
          </div>
          <div className="mt-5 grid min-w-0 gap-5">
            {([
              ["customWeekday", "weekdayHourlyKwh", "Typischer Werktag (kWh je Stunde, optional)"],
              ["customWeekend", "weekendHourlyKwh", "Typisches Wochenende (kWh je Stunde, optional)"],
            ] as const).map(([prefix, key, legend]) => (
              <div key={prefix} className="min-w-0">
                <p className="text-sm font-medium text-slate-800">{legend}</p>
                <div className="mt-2 grid min-w-0 grid-cols-4 gap-2 sm:grid-cols-8" role="group" aria-label={legend}>
                  {HOUR_LABELS.map((hourLabel, hour) => (
                    <label key={hour} className="grid min-w-0 gap-1 text-xs font-medium text-slate-700">
                      {hourLabel}
                      <input name={`${prefix}.${hour}`} type="number" inputMode="decimal" min="0" max="100000" step="any" defaultValue={customArrayValue(customProfile, key, hour)} className="min-h-11 w-full rounded-md border border-slate-300 bg-white px-2 py-2 text-sm text-slate-950 outline-none focus-visible:border-brand-600 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-1" />
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
      ) : null}

      {csvSelected && csvAllowed ? (
        <fieldset className="min-w-0 rounded-lg border border-slate-200 p-4 sm:p-5" data-energy-csv-profile="true">
          <legend className="px-1 text-base font-semibold text-slate-950">Lastgang-CSV</legend>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Eine Zahl pro Zeile: 8.760 Stunden- oder 35.040
            Viertelstundenwerte in kWh (Pflicht, Summe &gt; 0).
          </p>
          <label htmlFor="energy-csv" className={labelClass}>
            Lastgang-Reihe (kWh je Zeile)
            <textarea id="energy-csv" name="loadProfileCsv" rows={6} className={inputClass} defaultValue={csvDefaultValue(profile.consumption.customCsvKwh ?? { status: "unknown" })} />
          </label>
        </fieldset>
      ) : null}

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
          <AssetStatusSelect id="energy-ev-status" name="evStatus" label="Vorhandenes E-Auto" defaultValue={profile.existingAssets.ev.status} onChange={setEvStatus} />
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

      <fieldset className="min-w-0 rounded-lg border border-slate-200 p-4 sm:p-5" data-testid="packages-section">
        <legend className="px-1 text-base font-semibold text-slate-950">Zielpakete (Kaufabsicht)</legend>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Qualifizierung ohne Rechen-Einfluss: „Ja“ verlangt eine Zahlart,
          „Nein“ löscht sie, „Unverändert“ lässt den gespeicherten Stand.
          Geänderte Pakete schreiben eine neue Anforderungsrevision.
        </p>
        <div className="mt-4 grid min-w-0 gap-5">
          {PACKAGE_ROWS.map((row) => (
            <fieldset
              key={row.key}
              className="min-w-0 rounded-md border border-slate-200 bg-slate-50 p-4"
            >
              <legend className="max-w-full break-words px-1 text-sm font-semibold text-slate-950">
                {row.label}
              </legend>
              <div className="mt-2 grid min-w-0 gap-4 sm:grid-cols-2">
                <label htmlFor={`energy-pkg-${row.key}-wanted`} className={labelClass}>
                  {row.label} gewünscht?
                  <select
                    id={`energy-pkg-${row.key}-wanted`}
                    name={`pkg${row.key}Wanted`}
                    data-testid={`pkg-${row.key.toLowerCase()}-wanted`}
                    defaultValue=""
                    className={inputClass}
                  >
                    <option value="">Unverändert</option>
                    <option value="true">Ja</option>
                    <option value="false">Nein</option>
                  </select>
                </label>
                <label htmlFor={`energy-pkg-${row.key}-payment`} className={labelClass}>
                  Zahlart bei „Ja“
                  <select
                    id={`energy-pkg-${row.key}-payment`}
                    name={`pkg${row.key}Payment`}
                    data-testid={`pkg-${row.key.toLowerCase()}-payment`}
                    defaultValue=""
                    className={inputClass}
                  >
                    <option value="">Unverändert</option>
                    {PACKAGE_PAYMENT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            </fieldset>
          ))}
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
          className="min-h-11 w-full rounded-md bg-brand-700 px-4 py-2.5 text-sm font-semibold text-white outline-none hover:bg-brand-800 focus-visible:ring-2 focus-visible:ring-brand-600 focus-visible:ring-offset-2 disabled:cursor-wait disabled:bg-slate-300 sm:w-auto sm:justify-self-start"
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
