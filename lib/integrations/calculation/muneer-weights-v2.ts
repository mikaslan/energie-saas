/**
 * F4.1 v2-Muneer-Gewichte (Geometrie-Slice, Spec F4-01 "Solarposition" +
 * "Viertelstunden-Rekonstruktion"): je normalisierter Stunde die vier
 * geneigten Gewichte `G_T,q` [W/m²] aus stündlichen Horizontal-
 * komponenten und viertelstündlicher TS-Geometrie.
 *
 * Rezept je Stunde (identisch zur validierten F4.1B-Monatsmethodik):
 * 1. `Gb_h`/`Gd_h` [Wh/m², horizontaler seriescalc, standortweit] über
 *    solare Gewichte (`directWeight`/`diffuseWeight`, Spec-ESTIMATE) mit
 *    `reconstructQuarters` energieerhaltend auf Viertel verteilen.
 *    Positive Stundenenergie ohne Gewicht bricht fail-closed ab (Spec).
 * 2. Je Viertel `muneerTiltedIrradiance` mit Viertelgeometrie
 *    (Elevation/Azimut/AM/G0h aus `solar-geometry-v2`), Bodenreflexion
 *    null (PVGIS-Rezept: `Gr(i)=0` horizontal, Parser-gepinnt) und
 *    Horizont in Sonnenrichtung (`interpolateHorizonElevation`).
 * 3. `globalTilted` je Viertel ist das Gewicht `G_T,q`; die Summe
 *    steuert nur die Substundenform in `p-distribute-v2` (dort
 *    energieerhaltend normalisiert).
 *
 * Albedo ist fixture-gepinnt 0.2 (kein Profil-/Katalogfeld vorhanden;
 * Upgrade: dachgebundene Albedo als Planungseingabe). Nachtstunden
 * (`Gb=Gd=0`) liefern `[0,0,0,0]`; meldet der Provider dort `P*_h>0`,
 * bricht die Verteilung fail-closed ab statt flach zu verteilen.
 */
import { diffuseWeight, directWeight, reconstructQuarters } from "./engine-v2";
import { muneerTiltedIrradiance, type MuneerSurface } from "./muneer-v2";
import { interpolateHorizonElevation } from "./horizon-v2";
import { F401ProviderError } from "./provider-v2";
import {
  solarQuarterGeometryUtc,
  type SolarQuarterGeometry,
} from "./solar-geometry-v2";
import { CALCULATION_V2_SUBHOUR_VERSION } from "./versions-v2";

export const MUNEER_WEIGHTS_V2_VERSION = CALCULATION_V2_SUBHOUR_VERSION;

/** Fixture-gepinnte Albedo (oeffentliche PVGIS-Fixtures: 0.2). */
export const MUNEER_WEIGHTS_ALBEDO = 0.2;

const D2R = Math.PI / 180;

function weightsError(detail: string): never {
  throw new F401ProviderError(`Muneer-Gewichte v2 verletzt: ${detail}`);
}

export type MuneerWeightsSurface = {
  /** Dachneigung [°], 0..90. */
  tiltDeg: number;
  /** Dachazimut [°, Nord/Uhrzeigersinn, Spec-Geometrie]. */
  azimuthDegNorth: number;
  /**
   * Boden-Albedo ρ [0,1], optional (Default fixture-gepinnt 0.2;
   * Profilfeld `groundAlbedo` überschreibt je Berechnung).
   */
  albedo?: number;
};

export type MuneerWeightsHourInput = {
  /** Horizontale Direktkomponente der Stunde [Wh/m²]. */
  beamHourWhPerM2: number;
  /** Horizontale Diffuskomponente der Stunde [Wh/m²]. */
  diffuseHourWhPerM2: number;
  /** Viertelgeometrie [4 Slots, Achsenreihenfolge]. */
  quarterGeometry: readonly [
    SolarQuarterGeometry,
    SolarQuarterGeometry,
    SolarQuarterGeometry,
    SolarQuarterGeometry,
  ];
  /** Standort-Horizont (48 Hoehen [°], Nord/Uhrzeigersinn). */
  horizonHeights48: readonly number[];
  surface: MuneerWeightsSurface;
};

function requireHourFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) weightsError(`${name} ist nicht endlich`);
  if (value < 0) weightsError(`${name} ist negativ`);
}

/**
 * Vier Muneer-Gewichte `G_T,q` [W/m²] fuer eine Stunde. Alle Eingaben
 * fail-closed; das Ergebnis ist nichtnegativ und endlich.
 */
export function muneerQuarterWeightsV2(
  input: MuneerWeightsHourInput,
): [number, number, number, number] {
  requireHourFinite(input.beamHourWhPerM2, "Gb_h");
  requireHourFinite(input.diffuseHourWhPerM2, "Gd_h");
  if (!Array.isArray(input.horizonHeights48) || input.horizonHeights48.length !== 48) {
    weightsError("Horizont hat nicht 48 Hoehen");
  }
  for (const height of input.horizonHeights48) {
    if (!Number.isFinite(height)) weightsError("Horizonthoehe ist nicht endlich");
  }
  const { tiltDeg, azimuthDegNorth } = input.surface;
  if (!Number.isFinite(tiltDeg) || tiltDeg < 0 || tiltDeg > 90) {
    weightsError("Dachneigung ausserhalb [0,90]");
  }
  if (!Number.isFinite(azimuthDegNorth) || azimuthDegNorth < 0 || azimuthDegNorth >= 360) {
    weightsError("Dachazimut ausserhalb [0,360)");
  }
  const albedo = input.surface.albedo ?? MUNEER_WEIGHTS_ALBEDO;
  if (!Number.isFinite(albedo) || albedo < 0 || albedo > 1) {
    weightsError("Albedo ausserhalb [0,1]");
  }
  const surface: MuneerSurface = {
    tiltRad: tiltDeg * D2R,
    tiltDeg,
    azimuthRad: azimuthDegNorth * D2R,
    albedo,
  };
  const direct = input.quarterGeometry.map((geo) => directWeight(geo.elevationDeg * D2R)) as [
    number, number, number, number,
  ];
  const diffuse = input.quarterGeometry.map((geo) => diffuseWeight(geo.elevationDeg * D2R)) as [
    number, number, number, number,
  ];
  let beamQuarters: [number, number, number, number];
  let diffuseQuarters: [number, number, number, number];
  try {
    beamQuarters = reconstructQuarters(input.beamHourWhPerM2, direct);
    diffuseQuarters = reconstructQuarters(input.diffuseHourWhPerM2, diffuse);
  } catch {
    weightsError("Stundenenergie ohne solares Gewicht");
  }
  const weights = [0, 0, 0, 0] as [number, number, number, number];
  for (let quarter = 0; quarter < 4; quarter += 1) {
    const geo = input.quarterGeometry[quarter]!;
    const azimuthNorth = ((geo.azimuthDegNorth % 360) + 360) % 360;
    let tilted: { globalTilted: number };
    try {
      tilted = muneerTiltedIrradiance(
        {
          beamHorizontal: beamQuarters[quarter]!,
          diffuseHorizontal: diffuseQuarters[quarter]!,
          globalHorizontal: beamQuarters[quarter]! + diffuseQuarters[quarter]!,
          groundHorizontal: 0,
          extraterrestrialHorizontal: geo.extraterrestrialHorizontal,
          airMass: geo.airMass ?? 1,
          solarElevationRad: Math.max(0, geo.elevationDeg) * D2R,
          solarAzimuthRad: geo.azimuthDegNorth * D2R,
          horizonElevationRad:
            interpolateHorizonElevation(input.horizonHeights48, azimuthNorth) * D2R,
        },
        surface,
      );
    } catch {
      weightsError(`Muneer-Ablehnung im Viertel ${quarter}`);
    }
    weights[quarter] = tilted.globalTilted;
  }
  return weights;
}

export type MuneerWeightsSiteInput = {
  latitude: number;
  longitude: number;
  /** ISO-Auswertezeitpunkte der 4 Viertel (Achsenreihenfolge). */
  quarterInstantsUtc: readonly [string, string, string, string];
};

/**
 * Viertelgeometrie fuer eine Stunde aus Standort + Achsenzeitpunkten
 * (duenne Huelle um `solarQuarterGeometryUtc`, Fehlerklasse des Aufrufers).
 */
export function quarterGeometryForHourV2(
  input: MuneerWeightsSiteInput,
): [
  SolarQuarterGeometry,
  SolarQuarterGeometry,
  SolarQuarterGeometry,
  SolarQuarterGeometry,
] {
  return [
    solarQuarterGeometryUtc(Date.parse(input.quarterInstantsUtc[0]!), input.latitude, input.longitude),
    solarQuarterGeometryUtc(Date.parse(input.quarterInstantsUtc[1]!), input.latitude, input.longitude),
    solarQuarterGeometryUtc(Date.parse(input.quarterInstantsUtc[2]!), input.latitude, input.longitude),
    solarQuarterGeometryUtc(Date.parse(input.quarterInstantsUtc[3]!), input.latitude, input.longitude),
  ];
}
