/**
 * F4.1 v2-Horizont (Spec F4-01, Abschnitt "Providerabrufe"): printhorizon-
 * Abruf und kanonischer 48-Punkt-Horizont.
 *
 * Beobachtete API-Evidenz (live, Berlin 52.52/13.41): `outputs.
 * horizon_profile` enthaelt exakt 49 Zeilen `{"A","H_hor"}` von
 * `-180°..+180°` in 7,5°-Schritten; die letzte ist der duplizierte
 * Ringschluss mit gleicher Hoehe. Der Parser prueft gleiche Hoehe an
 * beiden Endpunkten, hasht die Rohbytes unveraendert und entfernt erst
 * danach `+180°`. Der kanonische Horizont enthaelt exakt 48 endliche
 * Hoehen in `[-90°,90°]`.
 *
 * Die printhorizon-Query ist im Spec nicht gepinnt; der Builder nutzt die
 * beobachtete, mit HTTP 200 verifizierte Form und ist als OBSERVED
 * markiert. Die zirkulaer-lineare Interpolation zwischen den 7,5°-Punkten
 * ist Spec-ESTIMATE.
 */
import { createHash } from "node:crypto";

import { canonicalDecimal, F401ProviderError, F401SizeError } from "./provider-v2";

const PRINTHORIZON_BASE = "https://re.jrc.ec.europa.eu/api/v5_3/printhorizon";
const RAW_POINTS = 49;
const CANONICAL_POINTS = 48;
const STEP_DEG = 7.5;

export type CanonicalHorizon = {
  /** Exakter SHA-256 der empfangenen Rohbytes. */
  rawSha256: string;
  /** 48 Hoehen fuer A=-180,-172.5,...,172.5 (Nord = -180). */
  heights: number[];
  horizonDb: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Beobachtete, mit HTTP 200 verifizierte Abrufform [OBSERVED]. */
export function buildPrinthorizonUrl(site: { latitude: number; longitude: number }): string {
  return `${PRINTHORIZON_BASE}?lat=${canonicalDecimal(site.latitude)}`
    + `&lon=${canonicalDecimal(site.longitude)}&outputformat=json&browser=0`;
}

export function parsePrinthorizon(rawText: string): CanonicalHorizon {
  if (typeof rawText !== "string" || rawText.length === 0) {
    throw new F401ProviderError("Horizontantwort ist leer");
  }
  if (rawText.length > 64 * 1024) {
    throw new F401SizeError("printhorizon ueberschreitet 64 KiB");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new F401ProviderError("Horizontantwort ist kein JSON");
  }
  if (!isRecord(parsed)) throw new F401ProviderError("Horizontantwort ist kein Objekt");
  const inputs = parsed["inputs"];
  const outputs = parsed["outputs"];
  if (!isRecord(inputs) || !isRecord(outputs)) {
    throw new F401ProviderError("inputs/outputs fehlen");
  }
  const location = inputs["location"];
  if (
    !isRecord(location)
    || typeof location["latitude"] !== "number"
    || typeof location["longitude"] !== "number"
    || typeof location["elevation"] !== "number"
  ) {
    throw new F401ProviderError("Standortspiegel unvollstaendig");
  }
  const horizonDb = inputs["horizon_db"];
  if (typeof horizonDb !== "string") {
    throw new F401ProviderError("horizon_db fehlt");
  }
  const profile = outputs["horizon_profile"];
  if (!Array.isArray(profile) || profile.length !== RAW_POINTS) {
    throw new F401ProviderError("horizon_profile hat nicht 49 Zeilen");
  }
  const heights: number[] = [];
  for (let index = 0; index < profile.length; index += 1) {
    const row = profile[index];
    if (!isRecord(row)) throw new F401ProviderError(`Zeile ${index} ist kein Objekt`);
    const expectedA = -180 + index * STEP_DEG;
    if (typeof row["A"] !== "number" || Math.abs(row["A"] - expectedA) > 1e-9) {
      throw new F401ProviderError(`Zeile ${index}: A ist nicht ${expectedA}`);
    }
    const height = row["H_hor"];
    if (typeof height !== "number" || !Number.isFinite(height) || height < -90 || height > 90) {
      throw new F401ProviderError(`Zeile ${index}: H_hor ausserhalb [-90,90]`);
    }
    heights.push(height);
  }
  if (heights[0] !== heights[heights.length - 1]) {
    throw new F401ProviderError("Ringschluss ungleich");
  }
  return {
    rawSha256: createHash("sha256").update(rawText, "utf8").digest("hex"),
    heights: heights.slice(0, CANONICAL_POINTS),
    horizonDb,
  };
}

/**
 * Horizonthoehe ueber beliebigem Azimut (Nord, im Uhrzeigersinn, Grad
 * [0,360)): zirkulaer-lineare Interpolation zwischen den 7,5°-Punkten
 * [ESTIMATE]. PVGIS-`A=-180°` entspricht Nord:
 * `azimuthNorthClockwise = mod(A+180°,360°)`.
 */
export function interpolateHorizonElevation(
  heights: readonly number[],
  azimuthNorthClockwiseDeg: number,
): number {
  if (heights.length !== CANONICAL_POINTS) {
    throw new F401ProviderError("Horizont hat nicht 48 Punkte");
  }
  if (
    !Number.isFinite(azimuthNorthClockwiseDeg)
    || azimuthNorthClockwiseDeg < 0
    || azimuthNorthClockwiseDeg >= 360
  ) {
    throw new F401ProviderError("Azimut ausserhalb [0,360)");
  }
  for (const height of heights) {
    if (!Number.isFinite(height)) throw new F401ProviderError("Hoehe ist nicht endlich");
  }
  const position = azimuthNorthClockwiseDeg / STEP_DEG;
  const lower = Math.floor(position) % CANONICAL_POINTS;
  const upper = (lower + 1) % CANONICAL_POINTS;
  const fraction = position - Math.floor(position);
  return heights[lower]! * (1 - fraction) + heights[upper]! * fraction;
}
