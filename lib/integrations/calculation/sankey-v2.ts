/**
 * F4.5b Energiefluss-Sankey (Spec F4-05b): Jahresfluesse aus der
 * Annual-Form als Knoten/Kanten. Rein darstellend (kein Vertragswechsel,
 * keine Geldrechnung); die Kantenbilanz ist exakt energieerhaltend, weil
 * der zyklische SoC nichts beitraegt:
 * Speicherladung = Entladung + Verlust (folgt aus eta_c*Ladung =
 * Entladung/eta_d bei SoC-Start == SoC-Ende).
 */

import { F401EngineError, neumaierSum } from "./engine-v2";

export type SankeyNodeName =
  | "PV-Erzeugung"
  | "Netzbezug"
  | "Speicher"
  | "Verbrauch"
  | "Einspeisung"
  | "Verlust";

export type SankeyLink = {
  source: SankeyNodeName;
  target: SankeyNodeName;
  valueKwh: number;
};

export type SankeyAnnualInput = {
  directConsumptionKwh: number;
  fromStorageKwh: number;
  feedInKwh: number;
  gridImportKwh: number;
  storageLossKwh: number;
};

function sankeyError(detail: string): never {
  throw new F401EngineError(`Sankey v2 verletzt: ${detail}`);
}

/**
 * Jahresfluesse -> 6 Kanten. Fail-closed bei ungueltigen Eingaben.
 * Erhaltung: PV-Knoten, Speicherknoten und Verbrauchsknoten gehen exakt
 * auf (Neumaier-Summe der Kanten pro Knoten, siehe Unit-Test).
 */
export function annualSankeyLinks(annual: SankeyAnnualInput): SankeyLink[] {
  for (const [name, value] of Object.entries(annual)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      sankeyError(`Jahreswert ${name} ist ungueltig`);
    }
  }
  // Zyklische Speicherbilanz: Ladung = Entladung + Verlust.
  const chargeInKwh = neumaierSum([annual.fromStorageKwh, annual.storageLossKwh]);
  return [
    { source: "PV-Erzeugung", target: "Verbrauch", valueKwh: annual.directConsumptionKwh },
    { source: "PV-Erzeugung", target: "Speicher", valueKwh: chargeInKwh },
    { source: "PV-Erzeugung", target: "Einspeisung", valueKwh: annual.feedInKwh },
    { source: "Speicher", target: "Verbrauch", valueKwh: annual.fromStorageKwh },
    { source: "Speicher", target: "Verlust", valueKwh: annual.storageLossKwh },
    { source: "Netzbezug", target: "Verbrauch", valueKwh: annual.gridImportKwh },
  ];
}
