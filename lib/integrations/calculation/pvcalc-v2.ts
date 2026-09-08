/**
 * F4.1 v2-PVcalc (Spec F4-01, Abschnitte "Providerabrufe" und
 * "AC-Leistungsstrategie"): Parser fuer den dachbezogenen PVcalc-Abruf
 * (langjaehriger Jahresreferenzwert `E_y` [kWh/kWp]).
 *
 * Beobachtete API-Evidenz (live, Berlin, 30°/Sued, crystSi, building,
 * 14 %): `outputs.monthly.fixed` (12 Monate mit `E_d/E_m/H(i)_d/H(i)_m/
 * SD_m`), `outputs.totals.fixed` (`E_y`, `H(i)_y`, Verluste `l_aoi/l_tg/
 * l_total`; `l_spec` liefert die API als String und wird als Spiegel
 * durchgereicht). Der Spiegel normalisiert beobachtet `building ->
 * building-integrated` und `crystSi -> c-Si`; die Spiegelpruefung kennt
 * nur diese belegten Paare und lehnt unbekannte Kombinationen nicht ab,
 * sondern reicht sie durch (kein Erfinden von Mappings).
 *
 * PVcalc nutzt das langjaehrige Klima (beobachtet 2005..2023); der Parser
 * verlangt ganze Jahre mit `year_min < year_max`, pinnt aber keine
 * Jahreszahlen (DB-Updates veraendern sie).
 */
import { createHash } from "node:crypto";

import { F401ProviderError } from "./provider-v2";

export type PVcalcMonthly = {
  month: number;
  energyKwhPerKwpDay: number;
  energyKwhPerKwpMonth: number;
  irradiationKwhPerM2Day: number;
  irradiationKwhPerM2Month: number;
  stdDevMonth: number;
};

export type ParsedPVcalcSnapshot = {
  /** Exakter SHA-256 der empfangenen Rohbytes. */
  rawSha256: string;
  /** Gepruefter Eingabespiegel (Durchreiche fuer Bindung/Hash). */
  inputsMirror: unknown;
  site: { latitude: number; longitude: number; elevation: number };
  meteo: { radiationDb: string; meteoDb: string; yearMin: number; yearMax: number };
  mounting: { tiltDeg: number; aspectDeg: number; place: string };
  module: { technology: string; peakPowerKwp: number; systemLossPercent: number };
  monthly: PVcalcMonthly[];
  /** Jahresreferenz `E_y` [kWh/kWp] fuer die AC-Skalierung. */
  annualReferenceKwhPerKwp: number;
  annualIrradiationKwhPerM2: number;
  losses: { aoi: number; spectral: unknown; thermalGain: number; total: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pvcalcError(detail: string): never {
  throw new F401ProviderError(detail);
}

function finiteField(row: Record<string, unknown>, key: string, what: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    pvcalcError(`${what}: Feld ${key} fehlt oder ist nicht endlich`);
  }
  return value;
}

export function parsePVcalcSnapshot(rawText: string): ParsedPVcalcSnapshot {
  if (typeof rawText !== "string" || rawText.length === 0) {
    pvcalcError("PVcalc-Antwort ist leer");
  }
  if (rawText.length > 256 * 1024) pvcalcError("PVcalc ueberschreitet 256 KiB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    pvcalcError("PVcalc-Antwort ist kein JSON");
  }
  if (!isRecord(parsed)) pvcalcError("PVcalc-Antwort ist kein Objekt");
  const inputs = parsed["inputs"];
  const outputs = parsed["outputs"];
  if (!isRecord(inputs) || !isRecord(outputs)) pvcalcError("inputs/outputs fehlen");
  const location = inputs["location"];
  const meteo = inputs["meteo_data"];
  const mounting = inputs["mounting_system"];
  const pvModule = inputs["pv_module"];
  if (!isRecord(location) || !isRecord(meteo) || !isRecord(mounting) || !isRecord(pvModule)) {
    pvcalcError("Eingabespiegel unvollstaendig");
  }
  const site = {
    latitude: finiteField(location, "latitude", "Standort"),
    longitude: finiteField(location, "longitude", "Standort"),
    elevation: finiteField(location, "elevation", "Standort"),
  };
  const radiationDb: unknown = meteo["radiation_db"];
  const meteoDb: unknown = meteo["meteo_db"];
  const yearMin: unknown = meteo["year_min"];
  const yearMax: unknown = meteo["year_max"];
  if (
    radiationDb !== "PVGIS-SARAH3"
    || typeof meteoDb !== "string"
    || !Number.isInteger(yearMin)
    || !Number.isInteger(yearMax)
    || !((yearMin as number) < (yearMax as number))
  ) {
    pvcalcError("Klimaspiegel ist nicht SARAH3/langjaehrig");
  }
  const yearMinInt = yearMin as number;
  const yearMaxInt = yearMax as number;
  const fixed = isRecord(mounting) ? mounting["fixed"] : undefined;
  if (!isRecord(fixed)) pvcalcError("mounting_system.fixed fehlt");
  const slope = isRecord(fixed["slope"]) ? fixed["slope"]["value"] : undefined;
  const azimuth = isRecord(fixed["azimuth"]) ? fixed["azimuth"]["value"] : undefined;
  const place = fixed["type"];
  if (typeof slope !== "number" || !Number.isFinite(slope)) {
    pvcalcError("Neigungsspiegel fehlt");
  }
  if (typeof azimuth !== "number" || !Number.isFinite(azimuth)) {
    pvcalcError("Azimutspiegel fehlt");
  }
  if (typeof place !== "string") pvcalcError("Montagespiegel fehlt");
  const technology = pvModule["technology"];
  const peakPower = pvModule["peak_power"];
  const systemLoss = pvModule["system_loss"];
  if (typeof technology !== "string") pvcalcError("Technologiespiegel fehlt");
  if (typeof peakPower !== "number" || !(peakPower > 0)) {
    pvcalcError("Peakleistungsspiegel fehlt");
  }
  if (typeof systemLoss !== "number" || !Number.isFinite(systemLoss)) {
    pvcalcError("Verlustspiegel fehlt");
  }
  const monthly = isRecord(outputs) ? outputs["monthly"] : undefined;
  const totals = isRecord(outputs) ? outputs["totals"] : undefined;
  const fixedMonths = isRecord(monthly) ? monthly["fixed"] : undefined;
  const fixedTotals = isRecord(totals) ? totals["fixed"] : undefined;
  if (!Array.isArray(fixedMonths) || fixedMonths.length !== 12) {
    pvcalcError("Monatsreihe hat nicht 12 Monate");
  }
  if (!isRecord(fixedTotals)) pvcalcError("Totals fehlen");
  const months: PVcalcMonthly[] = fixedMonths.map((row, index) => {
    if (!isRecord(row)) pvcalcError(`Monat ${index} ist kein Objekt`);
    if (row["month"] !== index + 1) pvcalcError(`Monatsnummer ${index} verletzt`);
    const entry = {
      month: index + 1,
      energyKwhPerKwpDay: finiteField(row, "E_d", `Monat ${index + 1}`),
      energyKwhPerKwpMonth: finiteField(row, "E_m", `Monat ${index + 1}`),
      irradiationKwhPerM2Day: finiteField(row, "H(i)_d", `Monat ${index + 1}`),
      irradiationKwhPerM2Month: finiteField(row, "H(i)_m", `Monat ${index + 1}`),
      stdDevMonth: finiteField(row, "SD_m", `Monat ${index + 1}`),
    };
    for (const value of Object.values(entry)) {
      if (typeof value === "number" && !(value >= 0)) {
        pvcalcError(`Monat ${index + 1} ist negativ`);
      }
    }
    return entry;
  });
  const annualReferenceKwhPerKwp = finiteField(fixedTotals, "E_y", "Totals");
  const annualIrradiationKwhPerM2 = finiteField(fixedTotals, "H(i)_y", "Totals");
  if (!(annualReferenceKwhPerKwp >= 0) || !(annualIrradiationKwhPerM2 >= 0)) {
    pvcalcError("Jahreswerte sind negativ");
  }
  return {
    rawSha256: createHash("sha256").update(rawText, "utf8").digest("hex"),
    inputsMirror: inputs,
    site,
    meteo: {
      radiationDb,
      meteoDb,
      yearMin: yearMinInt,
      yearMax: yearMaxInt,
    },
    mounting: { tiltDeg: slope, aspectDeg: azimuth, place },
    module: { technology, peakPowerKwp: peakPower, systemLossPercent: systemLoss },
    monthly: months,
    annualReferenceKwhPerKwp,
    annualIrradiationKwhPerM2,
    losses: {
      aoi: finiteField(fixedTotals, "l_aoi", "Totals"),
      spectral: fixedTotals["l_spec"],
      thermalGain: finiteField(fixedTotals, "l_tg", "Totals"),
      total: finiteField(fixedTotals, "l_total", "Totals"),
    },
  };
}
