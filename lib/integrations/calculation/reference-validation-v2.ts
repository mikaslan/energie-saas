/**
 * F4-01d PVGIS-Referenzvalidierungs-Gate (Spec
 * docs/spec/F4-01d-pvgis-referenzvalidierung-gate.md, Contract
 * contracts/pvgis-reference-validation.v1.schema.json): Punktgate-Statistik
 * ueber die Muneer-Transposition gegen oeffentliche PVGIS-Referenzen.
 *
 * Das Gate formalisiert Toleranzen, deviationCounter und den Report
 * `validation-report.v1`. Es aktiviert nichts: `validationStatus` bleibt
 * Sache der F4-01-Vertragskette, bis alle vier Spec-Nachweise
 * (Monats-Amendment, Punkt-Statistik, Live-Smoke, Review) vorliegen.
 * Jede Gate-Ueberschreitung zaehlt im deviationCounter und schlaegt
 * fail-closed fehl; stille Defaults gibt es nicht.
 *
 * Muster nach lib/integrations/geocoding/geoapify.ts: eigene Error-Klasse
 * mit Code-Union, zod-Envelope, gedeckelte Beleglisten.
 */
import { z } from "zod";

import { muneerClose } from "./muneer-v2";
import {
  CALCULATION_V2_MUNEER_TOLERANCES_VERSION,
  CALCULATION_V2_REFERENCE_VALIDATION_VERSION,
  CALCULATION_V2_SOLAR_GEOMETRY_VERSION,
} from "./versions-v2";

/** Gate-Version des Referenzvalidierungs-Gates (Pin aus versions-v2). */
export const REFERENCE_VALIDATION_VERSION =
  CALCULATION_V2_REFERENCE_VALIDATION_VERSION;
export type ReferenceValidationVersion = typeof REFERENCE_VALIDATION_VERSION;

/**
 * Version der versionierten Toleranz-Evidenz (Monats-Amendment 2.0/3%,
 * Pin aus versions-v2).
 */
export const MUNEER_TOLERANCES_VERSION = CALCULATION_V2_MUNEER_TOLERANCES_VERSION;
export type MuneerTolerancesVersion = typeof MUNEER_TOLERANCES_VERSION;

export type ReferenceValidationGateName =
  | "point_hourly"
  | "monthly"
  | "annual"
  | "night"
  | "energy";

export type ReferenceValidationTolerance = {
  readonly atol: number;
  readonly rtol: number;
};

/**
 * Spec-Gates (F4-01d): point_hourly `1 W/m2 / 0.005`, monthly
 * `2.0 kWh/m2 / 0.03` (ESTIMATE-Amendment unter
 * muneer-validation-tolerances.v1), annual `0.10 / 0.0025`, night exakt
 * `0 / 0`, energy (Stunde -> 4 Slots) `1e-9 / 1e-9`.
 */
export const REFERENCE_VALIDATION_TOLERANCES = {
  point_hourly: { atol: 1, rtol: 0.005 },
  monthly: { atol: 2, rtol: 0.03 },
  annual: { atol: 0.1, rtol: 0.0025 },
  night: { atol: 0, rtol: 0 },
  energy: { atol: 1e-9, rtol: 1e-9 },
} as const satisfies Record<
  ReferenceValidationGateName,
  ReferenceValidationTolerance
>;

export type F401dReferenceValidationErrorCode =
  | "point_gate_failed"
  | "monthly_gate_failed"
  | "annual_gate_failed"
  | "night_gate_failed"
  | "energy_gate_failed"
  | "invalid_input"
  | "invalid_report";

export class F401dReferenceValidationError extends Error {
  constructor(
    public readonly code: F401dReferenceValidationErrorCode,
    detail: string,
  ) {
    super(`f4-01d reference validation ${code}: ${detail}`);
    this.name = "F401dReferenceValidationError";
  }
}

function fail(
  code: F401dReferenceValidationErrorCode,
  detail: string,
): never {
  throw new F401dReferenceValidationError(code, detail);
}

/** deviationCounter-Staende je Gate (Spec-Schluessel). */
export type ReferenceValidationDeviationCounter = {
  point: number;
  monthly: number;
  annual: number;
  night: number;
  energy: number;
};

export function createDeviationCounter(): ReferenceValidationDeviationCounter {
  return { point: 0, monthly: 0, annual: 0, night: 0, energy: 0 };
}

const GATE_COUNTER_KEY: Record<
  ReferenceValidationGateName,
  keyof ReferenceValidationDeviationCounter
> = {
  point_hourly: "point",
  monthly: "monthly",
  annual: "annual",
  night: "night",
  energy: "energy",
};

const GATE_ERROR_CODE: Record<
  ReferenceValidationGateName,
  F401dReferenceValidationErrorCode
> = {
  point_hourly: "point_gate_failed",
  monthly: "monthly_gate_failed",
  annual: "annual_gate_failed",
  night: "night_gate_failed",
  energy: "energy_gate_failed",
};

/** Ein Vergleichspaar: eigene Muneer-Rechnung gegen PVGIS-Referenz. */
export type ReferenceValidationSample = {
  readonly actual: number;
  readonly expected: number;
};

/** Gedeckelte Abweichungsbelege (kein unbegrenztes Anwachsen). */
export const MAX_DEVIATION_EVIDENCE = 50;

export type ReferenceValidationDeviationEvidence = {
  readonly index: number;
  readonly actual: number;
  readonly expected: number;
  readonly absDeviation: number;
};

export type ReferenceValidationGateStatistics = {
  readonly gate: ReferenceValidationGateName;
  readonly count: number;
  readonly deviations: number;
  readonly p99: number;
  readonly max: number;
  readonly evidence: ReadonlyArray<ReferenceValidationDeviationEvidence>;
};

function requireGate(gate: string): ReferenceValidationGateName {
  if (!Object.hasOwn(REFERENCE_VALIDATION_TOLERANCES, gate)) {
    fail("invalid_input", `unbekanntes Gate '${gate}'`);
  }
  return gate as ReferenceValidationGateName;
}

function requireSamplePair(
  sample: ReferenceValidationSample,
  index: number,
): void {
  if (
    typeof sample.actual !== "number"
    || !Number.isFinite(sample.actual)
    || typeof sample.expected !== "number"
    || !Number.isFinite(sample.expected)
  ) {
    fail("invalid_input", `Sample ${index} ist nicht endlich`);
  }
}

/**
 * Reine Gate-Statistik ohne Zaehler/Throw bei Abweichung: p99/max der
 * absoluten Abweichungen plus gedeckelte Belegliste. Leere oder
 * nicht-endliche Eingaben sind fail-closed ungueltig (kein stiller
 * Default). Nacht-Samples brauchen Referenz exakt 0 und muessen exakt
 * uebereinstimmen.
 */
export function evaluateReferenceGate(
  gate: ReferenceValidationGateName,
  samples: ReadonlyArray<ReferenceValidationSample>,
): ReferenceValidationGateStatistics {
  const checked = requireGate(gate);
  if (samples.length === 0) fail("invalid_input", "Sample-Liste ist leer");
  const tolerance = REFERENCE_VALIDATION_TOLERANCES[checked];
  const absDeviations = new Array<number>(samples.length);
  const evidence: ReferenceValidationDeviationEvidence[] = [];
  let deviations = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    requireSamplePair(sample, index);
    if (checked === "night" && sample.expected !== 0) {
      fail("invalid_input", `Nacht-Referenz ${index} ist nicht exakt 0`);
    }
    const within = checked === "night"
      ? sample.actual === sample.expected
      : muneerClose(sample.actual, sample.expected, tolerance.atol, tolerance.rtol);
    const absDeviation = Math.abs(sample.actual - sample.expected);
    absDeviations[index] = absDeviation;
    if (!within) {
      deviations += 1;
      if (evidence.length < MAX_DEVIATION_EVIDENCE) {
        evidence.push({
          index,
          actual: sample.actual,
          expected: sample.expected,
          absDeviation,
        });
      }
    }
  }
  const sorted = [...absDeviations].sort((left, right) => left - right);
  const rank = Math.ceil(0.99 * sorted.length) - 1;
  return {
    gate: checked,
    count: samples.length,
    deviations,
    p99: sorted[Math.max(0, rank)]!,
    max: sorted[sorted.length - 1]!,
    evidence,
  };
}

function requireCounter(
  counter: ReferenceValidationDeviationCounter,
  gate: ReferenceValidationGateName,
): void {
  const key = GATE_COUNTER_KEY[gate];
  const value = (counter as Record<string, unknown>)[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    fail("invalid_input", `deviationCounter.${key} ist ungueltig`);
  }
}

/**
 * Gate-Enforcement: wertet aus, addiert die Ueberschreitungen auf den
 * deviationCounter und wirft bei jeder Ueberschreitung fail-closed
 * (F401dReferenceValidationError mit Gate-Code).
 */
export function assertReferenceGate(
  gate: ReferenceValidationGateName,
  samples: ReadonlyArray<ReferenceValidationSample>,
  counter: ReferenceValidationDeviationCounter,
): ReferenceValidationGateStatistics {
  const statistics = evaluateReferenceGate(gate, samples);
  requireCounter(counter, statistics.gate);
  counter[GATE_COUNTER_KEY[statistics.gate]] += statistics.deviations;
  if (statistics.deviations > 0) {
    fail(
      GATE_ERROR_CODE[statistics.gate],
      `${statistics.deviations}/${statistics.count} Samples ausserhalb `
        + `atol=${REFERENCE_VALIDATION_TOLERANCES[statistics.gate].atol} `
        + `rtol=${REFERENCE_VALIDATION_TOLERANCES[statistics.gate].rtol}`,
    );
  }
  return statistics;
}

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * zod-Envelope `validation-report.v1`: Gate-/Toleranz-/Geometrieversion,
 * Inputs-SHA, Fixture-SHAs, Monatsbelege (Bias je Site und Monat),
 * p99/max-Punktstatistik, deviationCounter-Staende, Provenienz, Ergebnis,
 * Erzeugungszeitpunkt und Commit. Alle Felder Pflicht, alle Listen
 * gedeckelt, keine Defaults.
 */
export const ValidationReportV1Schema = z.strictObject({
  reportVersion: z.literal("validation-report.v1"),
  gateVersion: z.literal(CALCULATION_V2_REFERENCE_VALIDATION_VERSION),
  toleranceVersion: z.literal(CALCULATION_V2_MUNEER_TOLERANCES_VERSION),
  geometryVersion: z.literal(CALCULATION_V2_SOLAR_GEOMETRY_VERSION),
  inputsSha256: sha256Schema,
  fixtureSha256s: z.array(sha256Schema).min(1).max(64),
  monthlyEvidence: z.array(z.strictObject({
    site: z.string().min(1).max(64),
    month: z.int().min(1).max(12),
    biasKwhPerM2: z.number().finite(),
  })).min(1).max(36),
  pointStatistics: z.strictObject({
    count: z.int().min(1),
    deviations: z.int().min(0),
    p99: z.number().finite().min(0),
    max: z.number().finite().min(0),
  }),
  deviationCounter: z.strictObject({
    point: z.int().min(0),
    monthly: z.int().min(0),
    annual: z.int().min(0),
    night: z.int().min(0),
    energy: z.int().min(0),
  }),
  provenance: z.array(z.string().min(1).max(128)).min(1).max(8),
  result: z.enum(["pass", "fail"]),
  createdAt: z.iso.datetime(),
  commit: z.string().min(1).max(128),
});

export type ValidationReportV1 = z.infer<typeof ValidationReportV1Schema>;

/** Fail-closed Report-Parse: Schema-Verletzung wirft `invalid_report`. */
export function parseValidationReportV1(value: unknown): ValidationReportV1 {
  const parsed = ValidationReportV1Schema.safeParse(value);
  if (!parsed.success) {
    fail("invalid_report", "Report verletzt validation-report.v1");
  }
  return parsed.data;
}

export type BuildValidationReportV1Input = {
  readonly inputsSha256: string;
  readonly fixtureSha256s: ReadonlyArray<string>;
  readonly monthlyEvidence: ReadonlyArray<{
    readonly site: string;
    readonly month: number;
    readonly biasKwhPerM2: number;
  }>;
  readonly pointStatistics: {
    readonly count: number;
    readonly deviations: number;
    readonly p99: number;
    readonly max: number;
  };
  readonly deviationCounter: ReferenceValidationDeviationCounter;
  readonly provenance: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly commit: string;
};

/**
 * Baut einen Report aus Pflicht-Eingaben (keine Defaults). `result` ist
 * abgeleitet: `pass` genau dann, wenn alle deviationCounter-Staende 0
 * sind — ein `fail`-Report ist ein legitimes Beleg-Artefakt und wirft
 * nicht; nur Schema-Verletzungen werfen `invalid_report`.
 */
export function buildValidationReportV1(
  input: BuildValidationReportV1Input,
): ValidationReportV1 {
  const counter = input.deviationCounter;
  const total = counter.point + counter.monthly + counter.annual
    + counter.night + counter.energy;
  return parseValidationReportV1({
    reportVersion: "validation-report.v1",
    gateVersion: CALCULATION_V2_REFERENCE_VALIDATION_VERSION,
    toleranceVersion: CALCULATION_V2_MUNEER_TOLERANCES_VERSION,
    geometryVersion: CALCULATION_V2_SOLAR_GEOMETRY_VERSION,
    inputsSha256: input.inputsSha256,
    fixtureSha256s: [...input.fixtureSha256s],
    monthlyEvidence: input.monthlyEvidence.map((entry) => ({ ...entry })),
    pointStatistics: { ...input.pointStatistics },
    deviationCounter: { ...counter },
    provenance: [...input.provenance],
    result: total === 0 ? "pass" : "fail",
    createdAt: input.createdAt,
    commit: input.commit,
  });
}

/**
 * Run-Provenienz des Gates: nur die Gate-Version, bewusst kein
 * Validierungs-Status (fail-closed bis alle vier Spec-Nachweise
 * vorliegen — das Gate behauptet kein `f4_public_reference_validated`).
 */
export type ReferenceValidationProvenance = {
  readonly version: typeof CALCULATION_V2_REFERENCE_VALIDATION_VERSION;
};

export function referenceValidationProvenance(): ReferenceValidationProvenance {
  return { version: CALCULATION_V2_REFERENCE_VALIDATION_VERSION };
}

/**
 * Haengt die Gate-Provenienz an ein v2-Resultat an. Nicht-enumerierbar:
 * das Result-Schema ist strikt und bytegepinnt
 * (CALCULATION_V2_SCHEMA_SHA256, Nachbar-Suite fordert `extra: 1` ab),
 * daher darf kein aufzaehlbarer Schluessel dazukommen. Direkter
 * Eigenschaftszugriff (`result.referenceValidation`) funktioniert;
 * Spread/JSON-Snapshots bleiben stabil.
 */
export function attachReferenceValidationProvenance<T extends object>(
  result: T,
): T & { readonly referenceValidation: ReferenceValidationProvenance } {
  Object.defineProperty(result, "referenceValidation", {
    value: referenceValidationProvenance(),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return result as T & { readonly referenceValidation: ReferenceValidationProvenance };
}
