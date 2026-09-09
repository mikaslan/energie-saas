/**
 * F4.1 v2-Sonnengeometrie (Geometrie-Slice, Spec F4-01 "Solarposition"):
 * reine TypeScript-Sonnenposition je Viertelstunden-Auswertezeitpunkt —
 * kein Python-Sidecar zur Laufzeit. Die Gleichungen sind die
 * oeffentlichen NOAA-Niedrigpraezisionsformeln (NOAA Global Monitoring
 * Laboratory, "Solar Calculation Details", US-public-domain) plus
 * Spencer-Exzentrizitaet (1971, feste Koeffizienten, wie pvlib
 * `get_extra_radiation(method="nrel")`) und Kasten-Young-1989-Air-Mass
 * (exakte Koeffizienten des Sidecars).
 *
 * Bewusste, versionierte Naeherungen (alle in der Validierung vermessen):
 * - Delta-T (TT = UTC + 69 s im Jahr 2020 -> 0.29° Stundenwinkel)
 *   ueber das Espenak/Meeus-Polynom 2005-2050 (Restfehler < 3 s).
 * - Meeresspiegel statt Standorthoehe (Berlin 47 m -> ~0.001°).
 * - Standard-Refraktion statt Druck-/Temperaturprofil.
 * Die Fixture-Validierung (`solar-geometry-v2.test.ts`, 3 x 35.040
 * SPA-Viertel) beweist die Huelle; der Muneer-Monatsvergleich mit
 * TS-Geometrie bleibt in der F4.1B-Huelle.
 */
import { CALCULATION_V2_SOLAR_GEOMETRY_VERSION } from "./versions-v2";

export const SOLAR_GEOMETRY_V2_VERSION = CALCULATION_V2_SOLAR_GEOMETRY_VERSION;

/** Solarkonstante [W/m²] wie der SPA-Sidecar (pvlib, NREL-Methode). */
const SOLAR_CONSTANT = 1366.1;

const DEG = Math.PI / 180;

export class F401SolarGeometryError extends Error {
  readonly code = "f401_solar_geometry_invalid_input" as const;

  constructor(readonly detail: string) {
    super(`f4.1 solar geometry rejected input: ${detail}`);
  }
}

function fail(detail: string): never {
  throw new F401SolarGeometryError(detail);
}

export type SolarQuarterGeometry = {
  /**
   * Geometrische Sonnenhoehe [°] ohne Refraktion (PVGIS-H_sun-
   * Konvention, wie die SPA-Fixtures). Die Standard-Refraktion fliesst
   * nur in den scheinbaren Zenit fuer die Air Mass ein.
   */
  elevationDeg: number;
  /** Sonnenazimut [°, Nord/Uhrzeigersinn, 0..360). */
  azimuthDegNorth: number;
  /** Kasten-Young-AM (Meeresspiegel), null bei Sonne unter Horizont. */
  airMass: number | null;
  /** Extraterrestrische Horizontalstrahlung [W/m²]. */
  extraterrestrialHorizontal: number;
};

function sinDeg(value: number): number {
  return Math.sin(value * DEG);
}

function cosDeg(value: number): number {
  return Math.cos(value * DEG);
}

function tanDeg(value: number): number {
  return Math.tan(value * DEG);
}

function asinDeg(value: number): number {
  return Math.asin(value) / DEG;
}

function atan2Deg(y: number, x: number): number {
  return Math.atan2(y, x) / DEG;
}

/** Spencer-Exzentrizitaetskorrektur E0 (dimensionslos, Tageswinkel B). */
function spencerEccentricity(dayOfYear: number): number {
  const angle = (2 * Math.PI * (dayOfYear - 1)) / 365;
  return 1.00011
    + 0.034221 * Math.cos(angle)
    + 0.00128 * Math.sin(angle)
    + 0.000719 * Math.cos(2 * angle)
    + 0.000077 * Math.sin(2 * angle);
}

/** Standard-Refraktionskorrektur [°] fuer die geometrische Hoehe. */
function refractionCorrectionDeg(elevationNoRefraction: number): number {
  if (elevationNoRefraction > 85) return 0;
  if (elevationNoRefraction > 5) {
    const tangent = tanDeg(elevationNoRefraction);
    return (58.1 / tangent - 0.07 / tangent ** 3 + 0.000086 / tangent ** 5) / 3600;
  }
  if (elevationNoRefraction > -0.575) {
    const elevation = elevationNoRefraction;
    return (1735
      + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)))
    ) / 3600;
  }
  return (-20.774 / tanDeg(elevationNoRefraction)) / 3600;
}

/** Kasten-Young-1989-AM aus scheinbarem Zenit [°] (Sidecar-Koeffizienten). */
function airMassKastenYoung(apparentZenithDeg: number): number {
  return 1 / (
    cosDeg(apparentZenithDeg)
    + 0.50572 * (96.07995 - apparentZenithDeg) ** -1.6364
  );
}

/**
 * Sonnengeometrie fuer einen UTC-Auswertezeitpunkt (ms seit Epoche).
 * Fail-closed bei unendlichen/unplausiblen Eingaben; intern nie NaN
 * (Horror-Faelle wie exakt 90° Zenit werden geklemmt statt NaN).
 */
export function solarQuarterGeometryUtc(
  instantMsUtc: number,
  latitude: number,
  longitude: number,
): SolarQuarterGeometry {
  if (!Number.isFinite(instantMsUtc)) fail("Auswertezeitpunkt ist nicht endlich");
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    fail("Breite ausserhalb [-90,90]");
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    fail("Laenge ausserhalb [-180,180]");
  }
  const instant = new Date(instantMsUtc);
  if (!Number.isFinite(instant.getTime())) fail("Auswertezeitpunkt ist kein Datum");

  // Delta-T nach Espenak/Meeus (2005-2050, t = Jahr-2000 mit Bruchteil):
  // Terrestrische Zeit fuer das Julianische Jahrhundert.
  const yearFraction = instant.getUTCFullYear()
    + (instantMsUtc - Date.UTC(instant.getUTCFullYear(), 0, 1)) / 31_556_952_000;
  const deltaTSeconds = 62.92
    + 0.32217 * (yearFraction - 2000)
    + 0.005589 * (yearFraction - 2000) ** 2;
  const julianDay = (instantMsUtc + deltaTSeconds * 1000) / 86_400_000 + 2_440_587.5;
  const century = (julianDay - 2_451_545) / 36_525;

  const meanLongitude = (280.46646 + century * (36_000.76983 + century * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + century * (35_999.05029 - 0.0001537 * century);
  const eccentricity = 0.016708634 - century * (0.000042037 + 0.0000001267 * century);
  const equationOfCenter = sinDeg(meanAnomaly) * (1.914602 - century * (0.004817 + 0.000014 * century))
    + sinDeg(2 * meanAnomaly) * (0.019993 - 0.000101 * century)
    + sinDeg(3 * meanAnomaly) * 0.000289;
  const trueLongitude = meanLongitude + equationOfCenter;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * sinDeg(125.04 - 1934.136 * century);
  const meanObliquity = 23
    + (26 + (21.448 - century * (46.815 + century * (0.00059 - century * 0.001813))) / 60) / 60;
  const obliquityCorrection = meanObliquity + 0.00256 * cosDeg(125.04 - 1934.136 * century);
  const declination = asinDeg(sinDeg(obliquityCorrection) * sinDeg(apparentLongitude));

  const y = tanDeg(obliquityCorrection / 2) ** 2;
  // Die Klammer ist ein Bogenmass-Quantum: erst rad->deg, dann Minuten.
  const equationOfTime = (4 / DEG) * (
    y * sinDeg(2 * meanLongitude)
    - 2 * eccentricity * sinDeg(meanAnomaly)
    + 4 * eccentricity * y * sinDeg(meanAnomaly) * cosDeg(2 * meanLongitude)
    - 0.5 * y * y * sinDeg(4 * meanLongitude)
    - 1.25 * eccentricity * eccentricity * sinDeg(2 * meanAnomaly)
  );
  const minutesUtc = instant.getUTCHours() * 60 + instant.getUTCMinutes()
    + instant.getUTCSeconds() / 60 + instant.getUTCMilliseconds() / 60_000;
  let trueSolarMinutes = (minutesUtc + equationOfTime + 4 * longitude) % 1440;
  if (trueSolarMinutes < 0) trueSolarMinutes += 1440;
  let hourAngle = trueSolarMinutes / 4 - 180;
  if (hourAngle < -180) hourAngle += 360;

  const cosZenith = sinDeg(latitude) * sinDeg(declination)
    + cosDeg(latitude) * cosDeg(declination) * cosDeg(hourAngle);
  const clamped = Math.min(1, Math.max(-1, cosZenith));
  const trueZenithDeg = Math.acos(clamped) / DEG;
  // Geometrisch (Fixture-/H_sun-Konvention); Refraktion nur fuer AM.
  const elevationDeg = 90 - trueZenithDeg;
  const apparentZenithDeg = 90
    - (elevationDeg + refractionCorrectionDeg(elevationDeg));

  // Azimut: bei exaktem Zenit ist die Richtung undefiniert; Nord
  // klemmen statt NaN (Gewicht dort ohnehin cosXi-symmetrisch klein).
  const azimuthRaw = hourAngle === 0 && Math.abs(latitude - declination) < 1e-9
    ? 180
    : atan2Deg(
      Math.sin(hourAngle * DEG),
      Math.cos(hourAngle * DEG) * sinDeg(latitude) - tanDeg(declination) * cosDeg(latitude),
    ) + 180;
  const azimuthDegNorth = ((azimuthRaw % 360) + 360) % 360;

  const startOfYear = Date.UTC(instant.getUTCFullYear(), 0, 1);
  const dayOfYear = Math.floor((instantMsUtc - startOfYear) / 86_400_000) + 1;
  const extraterrestrialNormal = SOLAR_CONSTANT * spencerEccentricity(dayOfYear);
  const extraterrestrialHorizontal = Math.max(0, extraterrestrialNormal * clamped);

  const airMass = elevationDeg > 0
    ? airMassKastenYoung(apparentZenithDeg)
    : null;

  for (const [name, value] of [
    ["elevationDeg", elevationDeg],
    ["azimuthDegNorth", azimuthDegNorth],
    ["extraterrestrialHorizontal", extraterrestrialHorizontal],
  ] as const) {
    if (!Number.isFinite(value)) fail(`${name} ist nicht endlich`);
  }
  if (airMass !== null && !Number.isFinite(airMass)) fail("airMass ist nicht endlich");

  return { elevationDeg, azimuthDegNorth, airMass, extraterrestrialHorizontal };
}
