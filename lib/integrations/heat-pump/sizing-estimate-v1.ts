/**
 * F5-01 Wärmepumpen-Schätzung (Spec F5-01): Heizlast-Orientierungswert aus
 * dem thermischen Jahreswärmebedarf — SCHÄTZVERFAHREN, keine zertifizierte
 * Normrechnung (DIN EN 12831). Reiner Builder, keine I/O, keine Permissions.
 *
 * Methode: Heizlast [kW] = Bedarf [kWh/a] / Volllaststunden [h/a].
 * Volllaststunden und Reservefaktor sind versionierte ESTIMATE-Konstanten
 * (Faustwert-Bandbreite VDI-4650-Praxis; exakter Reonic-Wert UNKNOWN).
 *
 * Fail-closed: kein bekannter Bedarf (> 0, endlich) -> Fehler statt 0 kW;
 * unbekannte Gebäudeklasse -> Fehler statt stillem Default.
 */

export const SIZING_ESTIMATE_V1_VERSION = "wmee-hp-sizing-estimate.v1" as const;
export const SIZING_ESTIMATE_V1_SOURCE_ID = "wmee-hp-sizing-estimate.v1" as const;

/** Einzige zulässige Gebäudeklassen — kein Default, Aufrufer entscheidet. */
export type BuildingClassV1 = "bestand" | "neubau";

/**
 * Volllaststunden [h/a] je Gebäudeklasse (ESTIMATE, versioniert).
 * Bestand (unsaniert/teilsaniert) braucht mehr Stunden als Neubau.
 */
export const FULL_LOAD_HOURS_V1: Record<BuildingClassV1, number> = {
  bestand: 2000,
  neubau: 1700,
};

/** Reserveaufschlag auf die geschätzte Heizlast (ESTIMATE, versioniert). */
export const SIZING_RESERVE_FACTOR_V1 = 1.1;

/** Rundungsraster der Empfehlungsgröße [kW] (ESTIMATE, versioniert). */
export const SIZING_ROUND_STEP_KW_V1 = 0.5;

export const SIZING_ESTIMATE_DISCLAIMER_V1 =
  "Schätzung (ESTIMATE) — ersetzt keine Heizlastberechnung nach DIN EN 12831." as const;

export class F501SizingError extends Error {
  constructor(detail: string) {
    super(`WP-Schätzung v1 verletzt: ${detail}`);
    this.name = "F501SizingError";
  }
}

function sizingError(detail: string): never {
  throw new F501SizingError(detail);
}

export interface SizingEstimateInputV1 {
  /** Thermischer Jahreswärmebedarf [kWh/a], muss endlich und > 0 sein. */
  annualThermalKwh: number;
  /** Gebäudeklasse — explizit, kein Default. */
  buildingClass: BuildingClassV1;
}

export interface SizingEstimateV1 {
  version: typeof SIZING_ESTIMATE_V1_VERSION;
  sourceId: typeof SIZING_ESTIMATE_V1_SOURCE_ID;
  method: "ESTIMATE";
  buildingClass: BuildingClassV1;
  fullLoadHoursPerYear: number;
  annualThermalKwh: number;
  /** Geschätzte Heizlast [kW], kaufmännisch auf 2 Stellen gerundet. */
  heatingLoadKw: number;
  /** Empfohlene Nennleistung [kW]: Last × Reserve, auf halbe kW aufgerundet. */
  recommendedNominalKw: number;
  disclaimer: typeof SIZING_ESTIMATE_DISCLAIMER_V1;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function estimateHeatingLoadV1(input: SizingEstimateInputV1): SizingEstimateV1 {
  const { annualThermalKwh, buildingClass } = input;
  if (typeof annualThermalKwh !== "number" || !Number.isFinite(annualThermalKwh)) {
    sizingError("Jahreswärmebedarf ist nicht endlich");
  }
  if (annualThermalKwh <= 0) {
    sizingError("Jahreswärmebedarf muss positiv sein — kein 0-kW-Ergebnis");
  }
  if (annualThermalKwh > 1_000_000) {
    sizingError("Jahreswärmebedarf ausserhalb des Schätzbereichs (> 1 Mio. kWh)");
  }
  const fullLoadHoursPerYear = FULL_LOAD_HOURS_V1[buildingClass];
  if (fullLoadHoursPerYear === undefined) {
    sizingError(`unbekannte Gebäudeklasse ${JSON.stringify(buildingClass)} — kein stiller Default`);
  }
  const heatingLoadKw = roundTo(annualThermalKwh / fullLoadHoursPerYear, 2);
  const recommendedNominalKw =
    Math.ceil((heatingLoadKw * SIZING_RESERVE_FACTOR_V1) / SIZING_ROUND_STEP_KW_V1) *
    SIZING_ROUND_STEP_KW_V1;
  return {
    version: SIZING_ESTIMATE_V1_VERSION,
    sourceId: SIZING_ESTIMATE_V1_SOURCE_ID,
    method: "ESTIMATE",
    buildingClass,
    fullLoadHoursPerYear,
    annualThermalKwh,
    heatingLoadKw,
    recommendedNominalKw,
    disclaimer: SIZING_ESTIMATE_DISCLAIMER_V1,
  };
}
