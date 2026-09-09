/**
 * F4.1 v2-Execute-Handler (Spec F4-01): arbeitet Jobs der eigenen Queue
 * `calculation.execute.v2` ab — Claim, Pin-Pruefung, Provider-Serien,
 * Persist, Engine-Lauf, Finalize. Additiv neben worker/calculation.ts; der
 * v1-Handler lehnt v2-Claims bereits ab (fremde contractVersion ->
 * engine_invalid), dieser Handler finalisiert v1-Zeilen nie (Pin-Gate).
 *
 * Noch nicht aktiviert: Die Subscription in worker/index.ts folgt erst mit
 * dem Fetch-Slice (echter provider.fetch); bis dahin arbeitet kein Pfad
 * v2-Jobs ab (Spec: atomare Ketten-Aktivierung).
 */
import { z } from "zod";

import type { PlanningCalculationResultV2 } from "../lib/integrations/calculation/contract-v2";
import type {
  PlanningCalculationProviderRequestV2,
  PlanningCalculationProviderSeriesV2,
  PreparedPlanningCalculationPersistV2,
} from "../lib/integrations/calculation/prepare-v2";
import {
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_DEFAULTS_VERSION,
  CALCULATION_V2_MODEL_ID,
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
} from "../lib/integrations/calculation/versions-v2";
import type {
  PersistedProjectCalculationInputV2,
  ProjectCalculationClaim,
  StoredCalculationInputV2,
} from "../modules/energy/calculation-service";

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
  if (
    code === "provider_invalid_response"
    || code === "contract_size_exceeded"
    || code === "provider_configuration"
  ) {
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

export type CalculationV2Database = {
  claim(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
  }): Promise<ProjectCalculationClaim | null>;
  persistInput(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
    attemptCount: number;
    inputSnapshot: PreparedPlanningCalculationPersistV2["inputSnapshot"];
    pvKwh: unknown;
    loadKwh: unknown;
    providerEstimate: boolean;
    existingPvKwh: PreparedPlanningCalculationPersistV2["existingPvKwh"];
  }): Promise<PersistedProjectCalculationInputV2>;
  finalizeSuccess(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
    attemptCount: number;
    result: PlanningCalculationResultV2;
  }): Promise<{ revisionId: string; revision: number; replayed: boolean }>;
  finalizeFailure(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
    attemptCount: number;
    errorCode: string;
    retryable: boolean;
    retryAfterMs: number | undefined;
  }): Promise<unknown>;
};

export type CalculationV2ExecuteDependencies = {
  database: CalculationV2Database;
  provider: {
    fetch(
      request: PlanningCalculationProviderRequestV2,
    ): Promise<PlanningCalculationProviderSeriesV2>;
  };
  engine: {
    calculate(input: {
      request: PreparedPlanningCalculationPersistV2["inputSnapshot"];
      pvKwh: number[];
      loadKwh: number[];
      providerEstimate: boolean;
      existingPvKwh?: number[] | null;
    }): Promise<PlanningCalculationResultV2>;
  };
  buildInput(input: {
    claim: ProjectCalculationClaim;
    providerSeries: PlanningCalculationProviderSeriesV2;
  }): Promise<PreparedPlanningCalculationPersistV2> | PreparedPlanningCalculationPersistV2;
  createLeaseToken(): string;
};

/**
 * Versionsreinheit des gespeicherten Inputs: Ein Claim, der das exakte
 * v2-Tupel traegt, kann laut parseStoredInput nur null oder v2-foermigen
 * Input tragen (alles andere wirft dort invalid_input). Traegt er dennoch
 * v1-foermigen Input, ist das ein unbekannter Zustand -> engine_invalid,
 * nie ein stiller Cross-Version-Lauf.
 */
function storedInputV2(
  input: StoredCalculationInputV2 | { inputSnapshot: { contractVersion: string } } | null,
): StoredCalculationInputV2 | null {
  if (input === null) return null;
  if (
    "inputSnapshot" in input
    && input.inputSnapshot !== null
    && typeof input.inputSnapshot === "object"
    && (input.inputSnapshot as { contractVersion?: unknown }).contractVersion
      === CALCULATION_V2_CONTRACT_VERSION
  ) {
    return input as StoredCalculationInputV2;
  }
  return null;
}

function storedInputVersionMismatch(
  input: ProjectCalculationClaim["input"],
): boolean {
  return input !== null && storedInputV2(input) === null;
}

async function recordV2Failure(
  database: CalculationV2Database,
  claim: ProjectCalculationClaim,
  failure: SanitizedV2Failure,
): Promise<void> {
  try {
    await database.finalizeFailure({
      workspaceId: claim.workspaceId,
      jobId: claim.jobId,
      leaseToken: claim.leaseToken,
      attemptCount: claim.attemptCount,
      ...failure,
    });
  } catch (error) {
    // Ist die Lease inzwischen verloren oder der fachliche Abschluss bereits
    // von einem anderen Worker committed, besitzt dieser Handler nichts mehr,
    // das er fehlerhaft markieren dürfte. Das ist ein idempotenter No-op und
    // kein neuer pg-boss-Fehler mit möglicherweise rohen DB-Details.
    const code = errorCode(error);
    if (code === "stale" || code === "retry_conflict") return;
    throw error;
  }
}

export function createCalculationExecuteV2Handler(
  dependencies: CalculationV2ExecuteDependencies,
): (jobs: unknown[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      // pg-boss metadata is deliberately ignored. Only the closed payload is
      // allowed to select a tenant/domain job.
      const dispatch = parseCalculationDispatchV2Payload(
        job !== null && typeof job === "object" && "data" in job
          ? (job as { data?: unknown }).data
          : undefined,
      );
      const claim = await dependencies.database.claim({
        workspaceId: dispatch.workspaceId,
        jobId: dispatch.jobId,
        leaseToken: dependencies.createLeaseToken(),
      });
      if (claim === null) continue;
      if (!supportsV2ClaimPins(claim) || storedInputVersionMismatch(claim.input)) {
        await recordV2Failure(dependencies.database, claim, {
          errorCode: "engine_invalid",
          retryable: false,
          retryAfterMs: undefined,
        });
        continue;
      }

      const claimedInput = storedInputV2(claim.input);
      let effectiveInput: StoredCalculationInputV2;
      if (claimedInput !== null) {
        effectiveInput = claimedInput;
      } else {
        // Ohne hash-echte v2-Provenienz gibt es weder eine Provider-Anfrage
        // noch einen Request: fail-closed, kein Fetch ins Blaue.
        if (claim.providerRequestV2 === null || claim.preparationV2 === null) {
          await recordV2Failure(dependencies.database, claim, {
            errorCode: "engine_invalid",
            retryable: false,
            retryAfterMs: undefined,
          });
          continue;
        }
        let providerSeries: PlanningCalculationProviderSeriesV2;
        try {
          providerSeries = await dependencies.provider.fetch(
            claim.providerRequestV2,
          );
        } catch (error) {
          await recordV2Failure(
            dependencies.database,
            claim,
            sanitizeV2ProviderFailure(error),
          );
          continue;
        }

        try {
          const prepared = await dependencies.buildInput({ claim, providerSeries });
          const persisted = await dependencies.database.persistInput({
            workspaceId: claim.workspaceId,
            jobId: claim.jobId,
            leaseToken: claim.leaseToken,
            attemptCount: claim.attemptCount,
            inputSnapshot: prepared.inputSnapshot,
            pvKwh: prepared.pvKwh,
            loadKwh: prepared.loadKwh,
            providerEstimate: prepared.providerEstimate,
            existingPvKwh: prepared.existingPvKwh,
          });
          effectiveInput = {
            inputSha256: persisted.inputSha256,
            inputSnapshot: persisted.inputSnapshot,
            providerSnapshot: persisted.providerSeries,
          };
        } catch (error) {
          await recordV2Failure(
            dependencies.database,
            claim,
            sanitizeV2EngineFailure(error),
          );
          continue;
        }
      }

      let result: PlanningCalculationResultV2;
      try {
        result = await dependencies.engine.calculate({
          request: effectiveInput.inputSnapshot,
          pvKwh: effectiveInput.providerSnapshot.pvKwh,
          loadKwh: effectiveInput.providerSnapshot.loadKwh,
          providerEstimate: effectiveInput.providerSnapshot.providerEstimate,
          existingPvKwh: effectiveInput.providerSnapshot.existingPvKwh ?? null,
        });
      } catch (error) {
        await recordV2Failure(
          dependencies.database,
          claim,
          sanitizeV2EngineFailure(error),
        );
        continue;
      }

      try {
        await dependencies.database.finalizeSuccess({
          workspaceId: claim.workspaceId,
          jobId: claim.jobId,
          leaseToken: claim.leaseToken,
          attemptCount: claim.attemptCount,
          result,
        });
      } catch (error) {
        const code = errorCode(error);
        if (code === "stale" || code === "retry_conflict") continue;
        await recordV2Failure(
          dependencies.database,
          claim,
          sanitizeV2EngineFailure(error),
        );
      }
    }
  };
}
