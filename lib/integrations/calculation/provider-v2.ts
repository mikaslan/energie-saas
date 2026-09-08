/**
 * F4.1 v2-Providervertrag (Spec F4-01, Abschnitt "Providerabrufe"):
 * kanonische PVGIS-Queries, Aspect-Boundary und seriescalc-Parser.
 *
 * Alle Query-Parameter sind Spec-gepinnt (PVGIS-SARAH3, Jahr 2020,
 * components=1). Die kanonische Dezimalregel (kein Exponent, `-0` wird
 * `0`) nutzt die kuerzeste Roundtrip-Darstellung; die Stellenzahl ist im
 * Spec nicht gepinnt und daher als ESTIMATE markiert. Die
 * Aspekt-Spiegelung `±180 -> -179` ist Spec-ESTIMATE (PVGIS v5.3 spiegelt
 * angefragte `aspect=±180` als `-179`).
 *
 * Der Parser validiert exakt die Spec-Pflichtfelder; Zusatzfelder bleiben
 * fuer Vorwaertskompatibilitaet unangetastet. `Int` akzeptiert ganzzahlige
 * Floats (`0.0`/`1.0`, so liefert es die API) und normiert auf `0|1`.
 * Horizontale Snapshots verlangen exakt `Gr(i)==0` — geerdet in
 * 3x8784 echten PVGIS-Zeilen (Fixtures f401, live byte-identisch
 * reproduziert, SHA 4b9760..berlin). Geneigte Snapshots verlangen
 * zusaetzlich endliches `P` [W/kWp].
 *
 * Belegt (live, Jan/Mitte 2020): Im geneigten Abruf sind `Gb(i)/Gd(i)/
 * Gr(i)` bereits in-plane (z. B. Jan-12h: 374 vs. 142 horizontal).
 * Hay-Eingaenge muessen daher aus dem horizontalen Snapshot stammen;
 * geneigte Komponenten duerfen nie als B_h/D_h/R_h gelesen werden.
 *
 * Offen (kein Erfinden): printhorizon-Query/-Parser brauchen erst echte
 * API-Evidenz; Montage-/Modulmetadaten-Namen fuer Dach-Snapshots werden als
 * Spiegel durchgereicht, nicht validiert.
 */
import { createHash } from "node:crypto";

import { CALCULATION_V2_PROVIDER_RECIPE_VERSION } from "./versions-v2";

/** Gebundenes Providerrezept (Spec-Tupel, einzig erlaubter Wert). */
export const PROVIDER_RECIPE_VERSION = CALCULATION_V2_PROVIDER_RECIPE_VERSION;

const PVGIS_BASE = "https://re.jrc.ec.europa.eu/api/v5_3/seriescalc";
const PVGIS_PVCALC_BASE = "https://re.jrc.ec.europa.eu/api/v5_3/PVcalc";

export class F401ProviderError extends Error {
  readonly code = "provider_invalid_response" as const;

  constructor(readonly detail: string) {
    super(`f4.1 provider rejected input: ${detail}`);
  }
}

/** Groessenverletzung (Spec: nie truncaten, deterministisch). */
export class F401SizeError extends Error {
  readonly code = "contract_size_exceeded" as const;

  constructor(readonly detail: string) {
    super(`f4.1 provider oversize: ${detail}`);
  }
}

function providerError(detail: string): never {
  throw new F401ProviderError(detail);
}

function sizeError(detail: string): never {
  throw new F401SizeError(detail);
}

/**
 * Kanonische Dezimalzahl ohne Exponent; `-0` wird `0` [ESTIMATE:
 * Stellenzahl]. Fuer die Vertragsbereiche (Koordinaten ±180, Winkel,
 * Verluste 0..100) erzeugt die Roundtrip-Darstellung nie Exponenten.
 */
export function canonicalDecimal(value: number): string {
  if (!Number.isFinite(value)) providerError("Dezimalwert ist nicht endlich");
  const text = String(value);
  if (text.includes("e") || text.includes("E")) {
    providerError(`Dezimalwert braucht Exponentenschreibweise: ${text}`);
  }
  return Object.is(value, -0) ? "0" : text;
}

/** `normalizeToMinus180Plus180` mit PVGIS-Spiegelung `±180 -> -179`. */
export function providerAspectDeg(azimuthDeg: number): number {
  if (!Number.isFinite(azimuthDeg)) providerError("Azimut ist nicht endlich");
  const normalized = ((azimuthDeg + 180) % 360 + 360) % 360 - 180;
  return normalized === -180 ? -179 : normalized;
}

/** 48 kanonische Horizonthoehen -> komma-separierte Query-Form. */
export function serializeCanonicalHorizon(heights: readonly number[]): string {
  if (heights.length !== 48) {
    providerError(`kanonischer Horizont hat ${heights.length} statt 48 Punkte`);
  }
  for (const height of heights) {
    if (!Number.isFinite(height) || height < -90 || height > 90) {
      providerError("Horizonthoehe ausserhalb [-90,90]");
    }
  }
  return heights.map(canonicalDecimal).join(",");
}

function query(params: Array<[string, string]>): string {
  return params.map(([key, value]) => `${key}=${value}`).join("&");
}

export type SiteQuery = { latitude: number; longitude: number };

function siteParams(site: SiteQuery): Array<[string, string]> {
  if (
    !Number.isFinite(site.latitude) || site.latitude < -90 || site.latitude > 90
    || !Number.isFinite(site.longitude) || site.longitude < -180 || site.longitude > 180
  ) {
    providerError("Standort ausserhalb [-90,90]/[-180,180]");
  }
  return [
    ["lat", canonicalDecimal(site.latitude)],
    ["lon", canonicalDecimal(site.longitude)],
    ["raddatabase", "PVGIS-SARAH3"],
  ];
}

function tailParams(): Array<[string, string]> {
  return [
    ["outputformat", "json"],
    ["browser", "0"],
  ];
}

/** Horizontaler seriescalc (Spec-Abschnitt "Providerabrufe"). */
export function buildHorizontalSeriescalcUrl(site: SiteQuery): string {
  return `${PVGIS_BASE}?${query([
    ...siteParams(site),
    ["startyear", "2020"],
    ["endyear", "2020"],
    ["pvcalculation", "0"],
    ["trackingtype", "0"],
    ["angle", "0"],
    ["aspect", "0"],
    ["optimalinclination", "0"],
    ["optimalangles", "0"],
    ["components", "1"],
    ["usehorizon", "0"],
    ...tailParams(),
  ])}`;
}

export type RoofQuery = SiteQuery & {
  pvTechnology: string;
  mountingPlace: string;
  systemLossPercent: number;
  providerTiltDeg: number;
  providerAspectDeg: number;
  canonicalHorizon: readonly number[];
};

function roofParams(roof: RoofQuery): Array<[string, string]> {
  if (
    !Number.isFinite(roof.providerTiltDeg)
    || roof.providerTiltDeg < 0
    || roof.providerTiltDeg > 90
  ) {
    providerError("Dachneigung ausserhalb [0,90]");
  }
  if (
    !Number.isFinite(roof.systemLossPercent)
    || roof.systemLossPercent < 0
    || roof.systemLossPercent > 100
  ) {
    providerError("Systemverlust ausserhalb [0,100]");
  }
  if (roof.pvTechnology.length === 0 || roof.mountingPlace.length === 0) {
    providerError("Technologie/Montage fehlt");
  }
  return [
    ["peakpower", "1"],
    ["pvtechchoice", roof.pvTechnology],
    ["mountingplace", roof.mountingPlace],
    ["loss", canonicalDecimal(roof.systemLossPercent)],
    ["angle", canonicalDecimal(roof.providerTiltDeg)],
    ["aspect", canonicalDecimal(providerAspectDeg(roof.providerAspectDeg))],
    ["usehorizon", "1"],
    ["userhorizon", serializeCanonicalHorizon(roof.canonicalHorizon)],
  ];
}

/** Dachbezogener seriescalc (gleicher Geo-/Tech-/Verlust-/Horizontvertrag). */
export function buildRoofSeriescalcUrl(roof: RoofQuery): string {
  return `${PVGIS_BASE}?${query([
    ...siteParams(roof),
    ...roofParams(roof),
    ["startyear", "2020"],
    ["endyear", "2020"],
    ["pvcalculation", "1"],
    ["trackingtype", "0"],
    ["components", "1"],
    ["optimalinclination", "0"],
    ["optimalangles", "0"],
    ...tailParams(),
  ])}`;
}

/** Dachbezogener PVcalc (langjaehriger Jahresreferenzwert). */
export function buildRoofPVcalcUrl(roof: RoofQuery): string {
  return `${PVGIS_PVCALC_BASE}?${query([
    ...siteParams(roof),
    ...roofParams(roof),
    ["optimalinclination", "0"],
    ["optimalangles", "0"],
    ...tailParams(),
  ])}`;
}

export type SeriesHour = {
  time: string;
  gb: number;
  gd: number;
  gr: number;
  hSun: number;
  t2m: number;
  ws10m: number;
  int: 0 | 1;
  /** Nur Dach-Snapshots (pvcalculation=1): AC-Leistung [W/kWp]. */
  p: number | null;
};

export type ParsedSeriescalcSnapshot = {
  recipeVersion: typeof PROVIDER_RECIPE_VERSION;
  /** Exakter SHA-256 der empfangenen Rohbytes. */
  rawSha256: string;
  /** Gepruefter Eingabespiegel (Durchreiche fuer Bindung/Hash). */
  inputsMirror: unknown;
  site: { latitude: number; longitude: number; elevation: number };
  meteo: {
    radiationDb: string;
    meteoDb: string;
    yearMin: number;
    yearMax: number;
    useHorizon: boolean;
  };
  hours: SeriesHour[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredFinite(row: Record<string, unknown>, key: string, index: number): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    providerError(`Stunde ${index}: Feld ${key} fehlt oder ist nicht endlich`);
  }
  return value;
}

function requiredIntFlag(row: Record<string, unknown>, index: number): 0 | 1 {
  const value = row["Int"];
  if (typeof value !== "number" || !Number.isFinite(value) || (value !== 0 && value !== 1)) {
    providerError(`Stunde ${index}: Int ist nicht 0 oder 1`);
  }
  return value;
}

function parseHour(row: unknown, index: number, tilted: boolean): SeriesHour {
  if (!isRecord(row)) providerError(`Stunde ${index} ist kein Objekt`);
  const time = row["time"];
  if (typeof time !== "string" || !/^\d{8}:\d{4}$/.test(time)) {
    providerError(`Stunde ${index}: Zeitformat verletzt`);
  }
  const p = tilted ? requiredFinite(row, "P", index) : null;
  if (!tilted && row["P"] !== undefined) {
    providerError(`Stunde ${index}: horizontale Geometrie mit P-Spalte`);
  }
  return {
    time,
    gb: requiredFinite(row, "Gb(i)", index),
    gd: requiredFinite(row, "Gd(i)", index),
    gr: requiredFinite(row, "Gr(i)", index),
    hSun: requiredFinite(row, "H_sun", index),
    t2m: requiredFinite(row, "T2m", index),
    ws10m: requiredFinite(row, "WS10m", index),
    int: requiredIntFlag(row, index),
    p,
  };
}

/**
 * seriescalc-Rohtext -> gepruefter Snapshot. Fail-closed bei fehlenden
 * Feldern, nichtendlichen Zahlen, doppelten/ungeordneten Stunden,
 * abweichendem Rezeptspiegel (SARAH3/2020) und — nur horizontal —
 * `Gr(i)!=0`. `G_h=Gb(i)+Gd(i)+Gr(i)` ist Definition fuer k_t, kein Gate.
 */
export function parseSeriescalcSnapshot(
  rawText: string,
  options: { tilted: boolean },
): ParsedSeriescalcSnapshot {
  if (typeof rawText !== "string" || rawText.length === 0) {
    providerError("Antwort ist leer");
  }
  if (rawText.length > 2 * 1024 * 1024) {
    sizeError("seriescalc ueberschreitet 2 MiB");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    providerError("Antwort ist kein JSON");
  }
  if (!isRecord(parsed)) providerError("Antwort ist kein Objekt");
  const inputs = parsed["inputs"];
  const outputs = parsed["outputs"];
  if (!isRecord(inputs) || !isRecord(outputs)) {
    providerError("inputs/outputs fehlen");
  }
  const location = inputs["location"];
  const meteo = inputs["meteo_data"];
  if (!isRecord(location) || !isRecord(meteo)) {
    providerError("location/meteo_data fehlen");
  }
  const latitude = location["latitude"];
  const longitude = location["longitude"];
  const elevation = location["elevation"];
  if (
    typeof latitude !== "number" || !Number.isFinite(latitude)
    || typeof longitude !== "number" || !Number.isFinite(longitude)
    || typeof elevation !== "number" || !Number.isFinite(elevation)
  ) {
    providerError("Standortspiegel unvollstaendig");
  }
  if (
    meteo["radiation_db"] !== "PVGIS-SARAH3"
    || typeof meteo["meteo_db"] !== "string"
    || meteo["year_min"] !== 2020
    || meteo["year_max"] !== 2020
    || typeof meteo["use_horizon"] !== "boolean"
  ) {
    providerError("Rezeptspiegel ist nicht SARAH3/2020");
  }
  const hourly = outputs["hourly"];
  if (!Array.isArray(hourly) || hourly.length !== 8_784) {
    providerError("hourly hat nicht 8784 Zeilen");
  }
  const hours = hourly.map((row, index) => parseHour(row, index, options.tilted));
  for (let index = 1; index < hours.length; index += 1) {
    if (!(hours[index]!.time > hours[index - 1]!.time)) {
      providerError(`Stundenachse unstetig bei Index ${index}`);
    }
  }
  if (!options.tilted && hours.some((hour) => hour.gr !== 0)) {
    providerError("horizontales Gr(i) ist nicht null");
  }
  return {
    recipeVersion: PROVIDER_RECIPE_VERSION,
    rawSha256: createHash("sha256").update(rawText, "utf8").digest("hex"),
    inputsMirror: inputs,
    site: { latitude, longitude, elevation },
    meteo: {
      radiationDb: meteo["radiation_db"] as string,
      meteoDb: meteo["meteo_db"] as string,
      yearMin: meteo["year_min"] as number,
      yearMax: meteo["year_max"] as number,
      useHorizon: meteo["use_horizon"] as boolean,
    },
    hours,
  };
}
