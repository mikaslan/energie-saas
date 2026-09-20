// F13-15 Finanzierungs-Intake (Katalog F13.4): reiner Client-/Server-
// Vertrag (Statusworte, Labels, Produkttypen, Provider, Folgezustände,
// Katalogschranken, DTO-Form — keine Imports, kein I/O).
// Muster lib/subsidy-case.ts: Sektion (Client) und Service (Server)
// teilen sich diese Datei, ohne Server-Code ins Client-Bundle zu ziehen.
// Spec: docs/spec/F13-15-finanzierung-intake.md §1/§2.
export const financingCaseStatuses = [
  "beantragt",
  "bonitaet",
  "entschieden",
  "ausgezahlt",
  "abgeschlossen",
  "abgelehnt",
  "storniert",
] as const;
export type FinancingCaseStatus = (typeof financingCaseStatuses)[number];

export const FINANCING_CASE_STATUS_LABEL: Record<FinancingCaseStatus, string> = {
  beantragt: "Beantragt",
  bonitaet: "Bonitätsprüfung",
  entschieden: "Entschieden",
  ausgezahlt: "Ausgezahlt",
  abgeschlossen: "Abgeschlossen",
  abgelehnt: "Abgelehnt",
  storniert: "Storniert",
};

export const financingProdukttypen = ["ratenkauf", "kredit"] as const;
export type FinancingProdukttyp = (typeof financingProdukttypen)[number];

export const FINANCING_PRODUKTTYP_LABEL: Record<FinancingProdukttyp, string> = {
  ratenkauf: "Ratenkauf",
  kredit: "Kredit",
};

export const financingProviders = ["bees_bears", "psd_bank"] as const;
export type FinancingProvider = (typeof financingProviders)[number];

export const FINANCING_PROVIDER_LABEL: Record<FinancingProvider, string> = {
  bees_bears: "Bees & Bears",
  psd_bank: "PSD Bank",
};

// Maschine §2: beantragt → bonitaet → entschieden → ausgezahlt →
// abgeschlossen; abgelehnt/storniert aus beantragt/bonitaet/entschieden.
// abgelehnt/storniert/abgeschlossen terminal; Reopen nur via neuen Vorgang
// (Historie bleibt ehrlich, F13-01-Präzedenz).
export const financingTransitions: Record<FinancingCaseStatus, FinancingCaseStatus[]> = {
  beantragt: ["bonitaet", "abgelehnt", "storniert"],
  bonitaet: ["entschieden", "abgelehnt", "storniert"],
  entschieden: ["ausgezahlt", "abgelehnt", "storniert"],
  ausgezahlt: ["abgeschlossen"],
  abgeschlossen: [],
  abgelehnt: [],
  storniert: [],
};

export function nextFinancingCaseStatuses(from: FinancingCaseStatus): FinancingCaseStatus[] {
  return financingTransitions[from] ?? [];
}

export function isAllowedFinancingCaseTransition(from: FinancingCaseStatus, to: FinancingCaseStatus): boolean {
  return (financingTransitions[from] ?? []).includes(to);
}

// F13-00 §6 Übergangs-Events: `.transition` (Naming-Doktrin); Payload
// `{caseId, from, to}`. Details-Politik: nur IDs + Status, nie
// Volumen/Laufzeit/Referenz/Titel.
export const FINANCING_CASE_TRANSITION_EVENT = "financing_case.transition" as const;

export class FinancingCaseNotFoundError extends Error {
  constructor(public readonly caseId: string) {
    super(`financing case not found: ${caseId}`);
    this.name = "FinancingCaseNotFoundError";
  }
}

export class FinancingCaseValidationError extends Error {
  constructor(message = "financing case validation failed") {
    super(message);
    this.name = "FinancingCaseValidationError";
  }
}

// Katalogwahrheit §1 (Service-Guard fail-closed): Ratenkauf 1–25 Jahre,
// Volumen ≤ 70.000 € (7000000 Cent), Provider bees_bears. PSD-Kredit bis
// zur Bank-Vorgabe freitextlich (nur positiv und ganzzahlig — Schranken
// folgen per Amendment, nie erfunden). Produkttyp↔Provider-Paarung
// geschlossen (ratenkauf↔bees_bears, kredit↔psd_bank).
export const FINANCING_RATENKAUF_MIN_LAUFZEIT_JAHRE = 1;
export const FINANCING_RATENKAUF_MAX_LAUFZEIT_JAHRE = 25;
export const FINANCING_RATENKAUF_MAX_VOLUMEN_EUR_CENTS = 7_000_000;

export type FinancingTerms = {
  produkttyp: FinancingProdukttyp;
  laufzeitJahre: number;
  volumenEurCents?: number;
  provider: FinancingProvider;
};

export function validateFinancingTerms(terms: FinancingTerms): void {
  if (!financingProdukttypen.includes(terms.produkttyp)) {
    throw new FinancingCaseValidationError(`unknown produkttyp: ${String(terms.produkttyp)}`);
  }
  if (!financingProviders.includes(terms.provider)) {
    throw new FinancingCaseValidationError(`unknown provider: ${String(terms.provider)}`);
  }
  if (!Number.isInteger(terms.laufzeitJahre)) {
    throw new FinancingCaseValidationError("laufzeit must be an integer");
  }
  if (terms.volumenEurCents !== undefined && !Number.isInteger(terms.volumenEurCents)) {
    throw new FinancingCaseValidationError("volumen must be an integer");
  }
  if (terms.produkttyp === "ratenkauf") {
    if (terms.provider !== "bees_bears") {
      throw new FinancingCaseValidationError("ratenkauf requires provider bees_bears");
    }
    if (
      terms.laufzeitJahre < FINANCING_RATENKAUF_MIN_LAUFZEIT_JAHRE ||
      terms.laufzeitJahre > FINANCING_RATENKAUF_MAX_LAUFZEIT_JAHRE
    ) {
      throw new FinancingCaseValidationError(
        `ratenkauf laufzeit out of range 1-25: ${terms.laufzeitJahre}`,
      );
    }
    if (
      terms.volumenEurCents !== undefined &&
      (terms.volumenEurCents < 0 ||
        terms.volumenEurCents > FINANCING_RATENKAUF_MAX_VOLUMEN_EUR_CENTS)
    ) {
      throw new FinancingCaseValidationError(
        `ratenkauf volumen out of range 0-7000000: ${terms.volumenEurCents}`,
      );
    }
    return;
  }
  if (terms.provider !== "psd_bank") {
    throw new FinancingCaseValidationError("kredit requires provider psd_bank");
  }
  if (terms.laufzeitJahre < 1) {
    throw new FinancingCaseValidationError("kredit laufzeit must be positive");
  }
  if (terms.volumenEurCents !== undefined && terms.volumenEurCents < 1) {
    throw new FinancingCaseValidationError("kredit volumen must be positive");
  }
}

export type FinancingCaseDto = {
  id: string;
  projectId: string;
  produkttyp: FinancingProdukttyp;
  laufzeitJahre: number;
  volumenEurCents: number;
  provider: FinancingProvider;
  providerReferenz: string | null;
  status: FinancingCaseStatus;
  beantragtAt: string | null;
  entschiedenAt: string | null;
  ausgezahltAt: string | null;
  abgeschlossenAt: string | null;
  createdAt: string;
  updatedAt: string;
  permissions: { canWrite: boolean };
};
