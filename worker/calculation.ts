import { z } from "zod";

import {
  PLANNING_DEFAULTS_VERSION,
  PLANNING_MODEL_ID,
  PLANNING_MODEL_SOURCE_REVISION,
  PLANNING_MODEL_VERSION,
  PLANNING_PROVIDER_RECIPE_VERSION,
} from "../lib/integrations/calculation/versions";
import { PLANNING_CALCULATION_CONTRACT_VERSION } from
  "../lib/integrations/calculation/contract";

export const CALCULATION_DISPATCH_SCHEMA_VERSION =
  "project-calculation-dispatch.v1" as const;

const calculationDispatchPayloadSchema = z.strictObject({
  schemaVersion: z.literal(CALCULATION_DISPATCH_SCHEMA_VERSION),
  workspaceId: z.uuid(),
  jobId: z.uuid(),
});

export type CalculationDispatchPayload = z.infer<
  typeof calculationDispatchPayloadSchema
>;

class CalculationDispatchError extends Error {
  constructor(public readonly code: "invalid_dispatch_payload") {
    super("calculation dispatch payload is invalid");
  }
}

export function parseCalculationDispatchPayload(
  value: unknown,
): CalculationDispatchPayload {
  const parsed = calculationDispatchPayloadSchema.safeParse(value);
  if (!parsed.success) throw new CalculationDispatchError("invalid_dispatch_payload");
  return parsed.data;
}

export type StoredCalculationInput = {
  inputSha256: string;
  inputSnapshot: Record<string, unknown>;
  providerSnapshot: Record<string, unknown> | unknown[];
};

export type CalculationClaim = {
  workspaceId: string;
  jobId: string;
  projectId: string;
  siteId: string;
  addressRevision: number;
  pinConfirmedAddressRevision: number;
  energyProfileId: string;
  energyProfileRevision: number;
  confirmedEnergyProfileRevision: number;
  confirmedEnergyProfileAddressRevision: number;
  projectRequirementId: string;
  projectRequirementRevision: number;
  sourceCalculatorSnapshotId: string | null;
  contractVersion: string;
  providerRecipeVersion: string;
  modelId: string;
  modelVersion: string;
  sourceRevision: string;
  defaultsVersion: string;
  leaseToken: string;
  startedAt: Date | string;
  attemptCount: number;
  providerRequest: Record<string, unknown> | null;
  input: StoredCalculationInput | null;
  preparation: {
    schemaVersion?: unknown;
    profile: unknown;
    requirements: unknown;
    sourceSnapshot: unknown;
  } | null;
  [key: string]: unknown;
};

export type CalculationDatabase = {
  claim(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
  }): Promise<CalculationClaim | null>;
  persistInput(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
    attemptCount: number;
    inputSha256: string;
    inputSnapshot: Record<string, unknown>;
    providerSnapshot: Record<string, unknown> | unknown[];
  }): Promise<StoredCalculationInput & { replayed?: boolean }>;
  finalizeSuccess(input: {
    workspaceId: string;
    jobId: string;
    leaseToken: string;
    attemptCount: number;
    result: Record<string, unknown>;
  }): Promise<unknown>;
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

type CalculationExecuteDependencies = {
  database: CalculationDatabase;
  provider: {
    fetch(request: Record<string, unknown>): Promise<Record<string, unknown> | unknown[]>;
  };
  engine: {
    calculate(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  buildInput(input: {
    claim: CalculationClaim;
    providerSnapshot: Record<string, unknown> | unknown[];
  }): Promise<StoredCalculationInput> | StoredCalculationInput;
  createLeaseToken(): string;
};

type SanitizedFailure = {
  errorCode: string;
  retryable: boolean;
  retryAfterMs: number | undefined;
};

function safeRetryAfterMs(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), 60 * 60_000)
    : undefined;
}

function errorCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : null;
}

function providerFailure(error: unknown): SanitizedFailure {
  const code = errorCode(error);
  if (code === "provider_rate_limited") {
    return {
      errorCode: "rate_limited",
      retryable: true,
      retryAfterMs: safeRetryAfterMs(error),
    };
  }
  if (code === "provider_invalid_response" || code === "provider_invalid") {
    return { errorCode: "provider_invalid", retryable: false, retryAfterMs: undefined };
  }
  if (
    code === "provider_configuration"
    || code === "provider_invalid_request"
    || code === "provider_http_error"
    || code === "unsupported_source"
  ) {
    return { errorCode: "provider_invalid", retryable: false, retryAfterMs: undefined };
  }
  return {
    errorCode: "provider_unavailable",
    retryable: true,
    retryAfterMs: safeRetryAfterMs(error),
  };
}

function engineFailure(error: unknown): SanitizedFailure {
  const code = errorCode(error);
  if (code === "stale") {
    return { errorCode: "stale", retryable: false, retryAfterMs: undefined };
  }
  if (code === "retry_conflict") {
    return { errorCode: "retry_conflict", retryable: false, retryAfterMs: undefined };
  }
  if (code === "engine_invalid_response" || code === "engine_invalid") {
    return { errorCode: "engine_invalid", retryable: false, retryAfterMs: undefined };
  }
  return {
    errorCode: "engine_unavailable",
    retryable: true,
    retryAfterMs: safeRetryAfterMs(error),
  };
}

function supportsClaimPins(claim: CalculationClaim): boolean {
  return claim.sourceCalculatorSnapshotId !== null
    && (claim.input !== null
      || (claim.preparation !== null && claim.providerRequest !== null))
    && claim.contractVersion === PLANNING_CALCULATION_CONTRACT_VERSION
    && claim.providerRecipeVersion === PLANNING_PROVIDER_RECIPE_VERSION
    && claim.modelId === PLANNING_MODEL_ID
    && claim.modelVersion === PLANNING_MODEL_VERSION
    && claim.sourceRevision === PLANNING_MODEL_SOURCE_REVISION
    && claim.defaultsVersion === PLANNING_DEFAULTS_VERSION;
}

async function recordFailure(
  database: CalculationDatabase,
  claim: CalculationClaim,
  failure: SanitizedFailure,
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

export function createCalculationExecuteHandler(
  dependencies: CalculationExecuteDependencies,
): (jobs: unknown[]) => Promise<void> {
  return async (jobs) => {
    for (const job of jobs) {
      // pg-boss metadata is deliberately ignored. Only the closed payload is
      // allowed to select a tenant/domain job.
      const dispatch = parseCalculationDispatchPayload(
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
      if (!supportsClaimPins(claim)) {
        await recordFailure(dependencies.database, claim, {
          errorCode: "engine_invalid",
          retryable: false,
          retryAfterMs: undefined,
        });
        continue;
      }

      let storedInput = claim.input;
      if (storedInput === null) {
        let providerSnapshot: Record<string, unknown> | unknown[];
        try {
          providerSnapshot = await dependencies.provider.fetch(
            claim.providerRequest as Record<string, unknown>,
          );
        } catch (error) {
          await recordFailure(
            dependencies.database,
            claim,
            providerFailure(error),
          );
          continue;
        }

        try {
          const prepared = await dependencies.buildInput({ claim, providerSnapshot });
          storedInput = await dependencies.database.persistInput({
            workspaceId: claim.workspaceId,
            jobId: claim.jobId,
            leaseToken: claim.leaseToken,
            attemptCount: claim.attemptCount,
            inputSha256: prepared.inputSha256,
            inputSnapshot: prepared.inputSnapshot,
            providerSnapshot: prepared.providerSnapshot,
          });
        } catch (error) {
          await recordFailure(
            dependencies.database,
            claim,
            engineFailure(error),
          );
          continue;
        }
      }

      let result: Record<string, unknown>;
      try {
        result = await dependencies.engine.calculate(storedInput.inputSnapshot);
      } catch (error) {
        await recordFailure(
          dependencies.database,
          claim,
          engineFailure(error),
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
        await recordFailure(
          dependencies.database,
          claim,
          engineFailure(error),
        );
      }
    }
  };
}
