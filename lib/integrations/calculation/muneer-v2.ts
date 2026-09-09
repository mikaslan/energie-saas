/**
 * F4.1B Clean-Room-Kern: Muneer-Diffus-Transposition auf geneigte Flaechen
 * (Spec F4-01-viertelstunden-simulation, Stand SPECIFIED).
 *
 * Implementiert die JRC/Muneer-1990-Gleichungen (K(β), N(k_b), S(β,N),
 * k_t'-Bedeckungsmass, JRC Eq. 28/29/30, pvgis53-shadow-reflection.v1),
 * dasselbe Modell, das PVGIS laut JRC-Dokumentation ("Data sources &
 * calculation methods": "The estimation model implemented in PVGIS is the
 * one developed by Muneer T. (1990)") fuer geneigte Flaechen nutzt.
 * Fruehere Code-Revisionen trugen das Label "Hay"; die Numerik war und ist
 * die normative Branch-Reihenfolge 1-5 der Spec (Hay-Davies ist ein anderes
 * Modell und wird nicht implementiert).
 *
 * Alle Winkel sind Radiant. Geometrie (α, γ_s, G_0h, AM, Horizont) kommt als
 * Eingabe herein und gehoert zur Geometrie-/Provider-Schicht; dieser Kern
 * enthaelt ausschliesslich die normative Branch-Reihenfolge 1-5 der Spec.
 * PVGIS-Azimut laeuft nach Nord im Uhrzeigersinn: γ_T = mod(A+180°,360°).
 */

export class F401MuneerError extends Error {
  readonly code = "f401_muneer_invalid_input" as const;

  constructor(readonly detail: string) {
    super(`f4.1 muneer rejected input: ${detail}`);
  }
}

function fail(detail: string): never {
  throw new F401MuneerError(detail);
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) fail(`${name} ist nicht endlich`);
}

/** Rauschregel der Spec: nur `[-1e-9,0)` darf als Nullrauschen gelten. */
const NOISE_FLOOR = -1e-9;

export function muneerSnapNoise(value: number, name: string): number {
  requireFinite(value, name);
  if (value < NOISE_FLOOR) fail(`${name} ist materiell negativ (${value})`);
  return value < 0 ? 0 : value;
}

/** `close(a,e,atol,rtol)` aus der Spec-Gate-Tabelle. */
export function muneerClose(a: number, e: number, atol: number, rtol: number): boolean {
  requireFinite(a, "a");
  requireFinite(e, "e");
  return Math.abs(a - e) <= Math.max(atol, rtol * Math.max(Math.abs(a), Math.abs(e)));
}

export type MuneerHourInput = {
  /** Direkte Horizontalkomponente B_h [W/m²]. */
  beamHorizontal: number;
  /** Diffuse Horizontalkomponente D_h [W/m²]. */
  diffuseHorizontal: number;
  /** Globale Horizontalkomponente G_h [W/m²]. */
  globalHorizontal: number;
  /** Bodenreflexion horizontal R_h [W/m²]. */
  groundHorizontal: number;
  /** Extraterrestrische Horizontalstrahlung G_0h [W/m²], aus Geometrie. */
  extraterrestrialHorizontal: number;
  /** Relative Air Mass (Meeresspiegel, Kasten-Young), aus Geometrie. */
  airMass: number;
  /** Sonnenhoehe α [rad], aus Geometrie (Stunden-Gate: PVGIS H_sun). */
  solarElevationRad: number;
  /** Sonnenazimut γ_s [rad, Nord/Uhrzeigersinn], aus Geometrie. */
  solarAzimuthRad: number;
  /** Horizonthoehe in Sonnenrichtung [rad], aus Horizontprofil. */
  horizonElevationRad: number;
};

export type MuneerSurface = {
  /** Neigung β [rad], 0..π/2. */
  tiltRad: number;
  /** Neigung [°], exakt zur Branchwahl (tiltDeg==0 liegt zuerst). */
  tiltDeg: number;
  /** Flaechenazimut γ_T [rad, Nord/Uhrzeigersinn]. */
  azimuthRad: number;
  /** Albedo ρ [0,1]; oeffentliche Fixtures pinnen 0.2. */
  albedo: number;
};

export type MuneerTiltedResult = {
  beamTilted: number;
  diffuseTilted: number;
  reflectedTilted: number;
  globalTilted: number;
};

function kBeta(tiltRad: number): number {
  return Math.sin(tiltRad) - tiltRad * Math.cos(tiltRad)
    - Math.PI * Math.sin(tiltRad / 2) ** 2;
}

function nOfKb(kb: number): number {
  return 0.00263 - 0.712 * kb - 0.6883 * kb * kb;
}

function sOfBetaN(tiltRad: number, n: number): number {
  return (1 + Math.cos(tiltRad)) / 2 + n * kBeta(tiltRad);
}

export function muneerTiltedIrradiance(
  hour: MuneerHourInput,
  surface: MuneerSurface,
): MuneerTiltedResult {
  for (const [name, value] of [
    ["beamHorizontal", hour.beamHorizontal],
    ["diffuseHorizontal", hour.diffuseHorizontal],
    ["globalHorizontal", hour.globalHorizontal],
    ["groundHorizontal", hour.groundHorizontal],
    ["extraterrestrialHorizontal", hour.extraterrestrialHorizontal],
    ["airMass", hour.airMass],
    ["solarElevationRad", hour.solarElevationRad],
    ["solarAzimuthRad", hour.solarAzimuthRad],
    ["horizonElevationRad", hour.horizonElevationRad],
    ["tiltRad", surface.tiltRad],
    ["tiltDeg", surface.tiltDeg],
    ["azimuthRad", surface.azimuthRad],
    ["albedo", surface.albedo],
  ] as const) {
    requireFinite(value, name);
  }
  for (const [name, value] of [
    ["beamHorizontal", hour.beamHorizontal],
    ["diffuseHorizontal", hour.diffuseHorizontal],
    ["globalHorizontal", hour.globalHorizontal],
    ["groundHorizontal", hour.groundHorizontal],
  ] as const) {
    if (value < 0) fail(`${name} ist negativ`);
  }
  if (!(surface.tiltRad >= 0 && surface.tiltRad <= Math.PI / 2)) {
    fail("tiltRad ausserhalb [0,π/2]");
  }
  if (!(surface.albedo >= 0 && surface.albedo <= 1)) {
    fail("albedo ausserhalb [0,1]");
  }

  const alpha = hour.solarElevationRad;
  const beta = surface.tiltRad;

  // Branch 1: α<=0 -> alles null.
  if (!(alpha > 0)) {
    return { beamTilted: 0, diffuseTilted: 0, reflectedTilted: 0, globalTilted: 0 };
  }
  if (!(hour.extraterrestrialHorizontal > 0)) {
    fail("extraterrestrialHorizontal fehlt bei Sonne ueber Horizont");
  }

  const cosXi = Math.sin(alpha) * Math.cos(beta)
    + Math.cos(alpha) * Math.sin(beta) * Math.cos(hour.solarAzimuthRad - surface.azimuthRad);
  const kb = hour.beamHorizontal / hour.extraterrestrialHorizontal;
  const kt = hour.globalHorizontal / hour.extraterrestrialHorizontal;
  const ktPrime = kt
    / (0.1 + 1.031 * Math.exp(-1.4 / (0.9 + (9.4 / hour.airMass))));

  // Branch 2: Grenzen (Gleichheit zaehlt zu Schatten/Rueckseite).
  const horizonShaded = alpha <= hour.horizonElevationRad;
  const rearSide = cosXi <= 0;
  const overcast = ktPrime < 0.3;

  // Branch 3: Beam und Reflexion (pvgis53-shadow-reflection.v1).
  const sinAlpha = Math.sin(alpha);
  const beamTilted = horizonShaded || rearSide
    ? 0
    : hour.beamHorizontal * (cosXi / sinAlpha);
  const groundRef = horizonShaded || rearSide
    ? hour.diffuseHorizontal
    : hour.globalHorizontal;
  const reflectedTilted = surface.albedo * groundRef * ((1 - Math.cos(beta)) / 2);

  // Branch 4: Diffuszweig, erste passende Regel gewinnt.
  let diffuseTilted: number;
  if (surface.tiltDeg === 0) {
    diffuseTilted = hour.diffuseHorizontal;
  } else if (horizonShaded || rearSide || overcast) {
    diffuseTilted = hour.diffuseHorizontal * sOfBetaN(beta, 0.25227);
  } else if (alpha > 0 && alpha < 0.1) {
    diffuseTilted = hour.diffuseHorizontal * (
      sOfBetaN(beta, nOfKb(kb)) * (1 - kb)
      + (kb * Math.sin(beta) * Math.cos(surface.azimuthRad - hour.solarAzimuthRad))
        / (0.1 - 0.008 * alpha)
    );
  } else {
    diffuseTilted = hour.diffuseHorizontal * (
      sOfBetaN(beta, nOfKb(kb)) * (1 - kb)
      + (kb * cosXi) / sinAlpha
    );
  }

  // Branch 5: G_T = B_T + D_T + R_T, mit Rauschregel.
  return {
    beamTilted: muneerSnapNoise(beamTilted, "beamTilted"),
    diffuseTilted: muneerSnapNoise(diffuseTilted, "diffuseTilted"),
    reflectedTilted: muneerSnapNoise(reflectedTilted, "reflectedTilted"),
    globalTilted: muneerSnapNoise(
      beamTilted + diffuseTilted + reflectedTilted,
      "globalTilted",
    ),
  };
}
