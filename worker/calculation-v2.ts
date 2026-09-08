/**
 * F4.1 v2-Workerbausteine (Spec F4-01): Dispatch-Payload, Claim-Pin-Pruefung
 * und Fehlertaxonomie fuer planning-calculation.v2. Additiv neben
 * worker/calculation.ts; der v1-Handler lehnt v2-Claims bereits ab
 * (fremde contractVersion -> engine_invalid).
 *
 * Bewusst noch kein Execute-Handler: Der braucht die Serien-Persistenz-
 * und Reservierungsentscheidung (eigener Slice mit Migration). Diese
 * reinen Bausteine sind seine exakten kuenftigen Importe. Ketten-
 * Aktivierung (Spec: v2-Runs erst nach atomarer Aktivierung der gesamten
 * Kette) bleibt bis dahin verweigert — es existiert kein Pfad, der einen
 * v2-Job erzeugt oder abarbeitet.
 */
import { z } from "zod";

import {
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_DEFAULTS_VERSION,
  CALCULATION_V2_MODEL_ID,
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
} from "../lib/integrations/calculation/versions-v2";

export const CALCULATION_V2_DISPATCH_SCHEMA_VERSION =
  "project-calculation-dispatch.v2" as const;

const calculationDispatchV2PayloadSchema = z.strictObject({
  schemaVersion: z.literal(CALCULATION_V2_DISPATCH_SCHEMA_VERSION),
  workspaceId: z.uuid(),
  jobId: z.uuid(),
});

export type CalculationDispatchV2Payload = z.infer<
  typeof calculationDispatchV2PayloadSchema
>;

export class CalculationDispatchV2Error extends Error {
  constructor(public readonly code: "invalid_dispatch_payload") {
    super("calculation v2 dispatch payload is invalid");
  }
}

export function parseCalculationDispatchV2Payload(
  value: unknown,
): CalculationDispatchV2Payload {
  const parsed = calculationDispatchV2PayloadSchema.safeParse(value);
  if (!parsed.success) throw new CalculationDispatchV2Error("invalid_dispatch_payload");
  return parsed.data;
}

export type V2ClaimPins = {
  sourceCalculatorSnapshotId: string | null;
  contractVersion: string;
  providerRecipeVersion: string;
  modelId: string;
  modelVersion: string;
  sourceRevision: string;
  defaultsVersion: string;
};

/**
 * Exaktes v2-Tupel (Spec: einzige erlaubte Kombination; alles andere ist
 * unbekannt und wird von Runtime, DB-CHECK und CAS verweigert). Die
 * Quell-Snapshot-Bindung ist optional (v2-Claims ohne Rechnerherkunft).
 */
export function supportsV2ClaimPins(claim: V2ClaimPins): boolean {
  return claim.contractVersion === CALCULATION_V2_CONTRACT_VERSION
    && claim.providerRecipeVersion === CALCULATION_V2_PROVIDER_RECIPE_VERSION
    && claim.modelId === CALCULATION_V2_MODEL_ID
    && claim.modelVersion === CALCULATION_V2_MODEL_VERSION
    && claim.sourceRevision === CALCULATION_V2_SOURCE_REVISION
    && claim.defaultsVersion === CALCULATION_V2_DEFAULTS_VERSION;
}

export type SanitizedV2Failure = {
  errorCode: "provider_invalid" | "provider_unavailable" | "engine_invalid" | "engine_unavailable" | "rate_limited" | "stale" | "retry_conflict";
  retryable: boolean;
  retryAfterMs: number | undefined;
};

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
}

function safeRetryAfterMs(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), 60 * 60_000)
    : undefined;
}

/**
 * Deterministische f401-Fehler sind nie retryable (Wiederholung wuerde
 * denselben Abbruch erzeugen); Transport-/Verfuegbarkeitsfehler schon.
 * `stale`/`retry_conflict` sind Lease-Zustaende, keine Provider-/Engine-
 * Fehler, und werden unveraendert durchgereicht.
 */
export function sanitizeV2ProviderFailure(error: unknown): SanitizedV2Failure {
  const code = errorCode(error);
  if (code === "stale") {
    return { errorCode: "stale", retryable: false, retryAfterMs: undefined };
  }
  if (code === "retry_conflict") {
    return { errorCode: "retry_conflict", retryable: false, retryAfterMs: undefined };
  }
  if (code === "provider_rate_limited") {
    return {
      errorCode: "rate_limited",
      retryable: true,
      retryAfterMs: safeRetryAfterMs(error),
    };
  }
  if (code === "provider_invalid_response" || code === "contract_size_exceeded") {
    return { errorCode: "provider_invalid", retryable: false, retryAfterMs: undefined };
  }
  return {
    errorCode: "provider_unavailable",
    retryable: true,
    retryAfterMs: safeRetryAfterMs(error),
  };
}

export function sanitizeV2EngineFailure(error: unknown): SanitizedV2Failure {
  const code = errorCode(error);
  if (code === "stale") {
    return { errorCode: "stale", retryable: false, retryAfterMs: undefined };
  }
  if (code === "retry_conflict") {
    return { errorCode: "retry_conflict", retryable: false, retryAfterMs: undefined };
  }
  if (
    code === "f401_engine_invalid_input"
    || code === "f401_axis_invalid_input"
    || code === "f401_load_invalid_input"
    || code === "engine_invalid_response"
    || code === "engine_invalid"
  ) {
    return { errorCode: "engine_invalid", retryable: false, retryAfterMs: undefined };
  }
  return {
    errorCode: "engine_unavailable",
    retryable: true,
    retryAfterMs: safeRetryAfterMs(error),
  };
}
