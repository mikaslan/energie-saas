import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hashPlanningCalculationInput,
  hashPlanningCalculationResult,
  validatePlanningCalculationRequest,
  validatePlanningCalculationResult,
  type PlanningCalculationRequestV1,
  type PlanningCalculationResultV1,
} from "@/lib/integrations/calculation/contract";
import { PLANNING_MODEL_SOURCE_REVISION } from
  "@/lib/integrations/calculation/versions";
import {
  createCalculationExecuteHandler,
  parseCalculationDispatchPayload,
} from "@/worker/calculation";

const DISPATCH_VERSION = "project-calculation-dispatch.v1";
const QUEUE_NAME = "calculation.execute";
const CLAIMED_AT = new Date("2026-08-29T12:00:00.000Z");
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "33333333-3333-4333-8333-333333333333";
const PG_BOSS_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const SITE_ID = "66666666-6666-4666-8666-666666666666";
const PROFILE_ID = "77777777-7777-4777-8777-777777777777";
const REQUIREMENT_ID = "88888888-8888-4888-8888-888888888888";
const SNAPSHOT_ID = "99999999-9999-4999-8999-999999999999";

type Dispatch = {
  schemaVersion: typeof DISPATCH_VERSION;
  workspaceId: string;
  jobId: string;
};

type StoredInput = {
  inputSha256: string;
  inputSnapshot: PlanningCalculationRequestV1;
  providerSnapshot: PlanningCalculationRequestV1["yieldSnapshots"];
};

type Claim = {
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
  startedAt: Date;
  attemptCount: number;
  providerRequest: Record<string, unknown> | null;
  input: StoredInput | null;
  preparation: {
    profile: unknown;
    requirements: unknown;
    sourceSnapshot: unknown;
  } | null;
};

const DISPATCH: Dispatch = {
  schemaVersion: DISPATCH_VERSION,
  workspaceId: WORKSPACE_ID,
  jobId: JOB_ID,
};

const INPUT_SNAPSHOT = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/planning-calculation.v1.new.request.json"),
  "utf8",
)) as PlanningCalculationRequestV1;
INPUT_SNAPSHOT.bindings = {
  workspaceId: WORKSPACE_ID,
  projectId: PROJECT_ID,
  siteId: SITE_ID,
  addressRevision: 1,
  pinConfirmedAddressRevision: 1,
  energyProfileId: PROFILE_ID,
  energyProfileRevision: 1,
  confirmedEnergyProfileRevision: 1,
  confirmedEnergyProfileAddressRevision: 1,
  projectRequirementId: REQUIREMENT_ID,
  projectRequirementRevision: 1,
  sourceCalculatorSnapshotId: SNAPSHOT_ID,
};
INPUT_SNAPSHOT.energyProfile.roofs = INPUT_SNAPSHOT.energyProfile.roofs.map((roof) => ({
  ...roof,
  source: "operator_reviewed" as const,
}));
const PROVIDER_SNAPSHOT = INPUT_SNAPSHOT.yieldSnapshots;
const PROVIDER_REQUEST = {
  latitude: INPUT_SNAPSHOT.site.latitude,
  longitude: INPUT_SNAPSHOT.site.longitude,
  roofs: INPUT_SNAPSHOT.energyProfile.roofs.map((roof) => ({
    roofId: roof.id,
    tiltDeg: roof.tiltDeg,
    azimuthDeg: roof.azimuthDeg,
  })),
};
const INPUT_SHA256 = hashPlanningCalculationInput(INPUT_SNAPSHOT);

const STORED_INPUT: StoredInput = {
  inputSha256: INPUT_SHA256,
  inputSnapshot: INPUT_SNAPSHOT,
  providerSnapshot: PROVIDER_SNAPSHOT,
};

const RESULT = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../contracts/examples/planning-calculation.v1.new.result.json"),
  "utf8",
)) as PlanningCalculationResultV1;
RESULT.inputSha256 = INPUT_SHA256;
RESULT.resultSha256 = hashPlanningCalculationResult(RESULT);

if (!validatePlanningCalculationRequest(INPUT_SNAPSHOT).ok) {
  throw new Error("M1-07 worker request fixture is invalid");
}
if (!validatePlanningCalculationResult(RESULT).ok) {
  throw new Error("M1-07 worker result fixture is invalid");
}

function bossJob(data: unknown) {
  return { id: PG_BOSS_ID, name: QUEUE_NAME, data };
}

function claimed(input: StoredInput | null = null): Claim {
  return {
    workspaceId: WORKSPACE_ID,
    jobId: JOB_ID,
    projectId: PROJECT_ID,
    siteId: SITE_ID,
    addressRevision: INPUT_SNAPSHOT.bindings.addressRevision,
    pinConfirmedAddressRevision: INPUT_SNAPSHOT.bindings.pinConfirmedAddressRevision,
    energyProfileId: PROFILE_ID,
    energyProfileRevision: INPUT_SNAPSHOT.bindings.energyProfileRevision,
    confirmedEnergyProfileRevision:
      INPUT_SNAPSHOT.bindings.confirmedEnergyProfileRevision,
    confirmedEnergyProfileAddressRevision:
      INPUT_SNAPSHOT.bindings.confirmedEnergyProfileAddressRevision,
    projectRequirementId: REQUIREMENT_ID,
    projectRequirementRevision: INPUT_SNAPSHOT.bindings.projectRequirementRevision,
    sourceCalculatorSnapshotId: SNAPSHOT_ID,
    contractVersion: INPUT_SNAPSHOT.contractVersion,
    providerRecipeVersion: "pvgis-5.3-sarah3-2020.v1",
    modelId: "wmee-solar",
    modelVersion: "1.0.0",
    sourceRevision: PLANNING_MODEL_SOURCE_REVISION,
    defaultsVersion: "wmee-planning-defaults.v1",
    leaseToken: LEASE_TOKEN,
    startedAt: CLAIMED_AT,
    attemptCount: 1,
    providerRequest: PROVIDER_REQUEST,
    input,
    preparation: {
      profile: INPUT_SNAPSHOT.energyProfile,
      requirements: INPUT_SNAPSHOT.projectRequirements,
      sourceSnapshot: {},
    },
  };
}

function createHarness(options: {
  claim?: Claim | null;
  providerError?: unknown;
  engineError?: unknown;
  successError?: unknown;
} = {}) {
  let databaseOperationOpen = false;
  const order: string[] = [];

  const inDatabaseOperation = async <T>(label: string, value: T): Promise<T> => {
    expect(databaseOperationOpen, "DB-Operationen duerfen nicht verschachtelt werden").toBe(false);
    databaseOperationOpen = true;
    order.push(`${label}:start`);
    await Promise.resolve();
    order.push(`${label}:end`);
    databaseOperationOpen = false;
    return value;
  };

  const claimResult = options.claim === undefined ? claimed() : options.claim;
  const database = {
    claim: vi.fn(async (input: Record<string, unknown>) => {
      expect(input).toEqual({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        leaseToken: LEASE_TOKEN,
      });
      return inDatabaseOperation("claim", claimResult);
    }),
    persistInput: vi.fn(async (input: Record<string, unknown>) => {
      expect(input).toMatchObject({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        leaseToken: LEASE_TOKEN,
        attemptCount: 1,
        inputSha256: INPUT_SHA256,
        inputSnapshot: INPUT_SNAPSHOT,
        providerSnapshot: PROVIDER_SNAPSHOT,
      });
      // The returned row is authoritative. A same-hash race may have stored
      // the equal canonical snapshot between provider I/O and this CAS.
      return inDatabaseOperation("persist", structuredClone(STORED_INPUT));
    }),
    finalizeSuccess: vi.fn(async (input: Record<string, unknown>) => {
      expect(input).toMatchObject({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        leaseToken: LEASE_TOKEN,
        attemptCount: 1,
        result: RESULT,
      });
      if (options.successError !== undefined) throw options.successError;
      return inDatabaseOperation("success", {
        revisionId: "66666666-6666-4666-8666-666666666666",
        revision: 1,
        replayed: false,
      });
    }),
    finalizeFailure: vi.fn(async (input: Record<string, unknown>) =>
      inDatabaseOperation("failure", {
        ...input,
        state: input.retryable === true ? "retry_wait" : "failed_final",
      })),
  };

  const provider = {
    fetch: vi.fn(async (request: Record<string, unknown>) => {
      expect(databaseOperationOpen, "Provider-I/O lief in einer DB-Operation").toBe(false);
      expect(request).toEqual(PROVIDER_REQUEST);
      order.push("provider");
      if (options.providerError !== undefined) throw options.providerError;
      return structuredClone(PROVIDER_SNAPSHOT);
    }),
  };
  const buildInput = vi.fn(async (input: Record<string, unknown>) => {
    expect(databaseOperationOpen).toBe(false);
    expect(input).toMatchObject({
      claim: claimResult,
      providerSnapshot: PROVIDER_SNAPSHOT,
    });
    order.push("build-input");
    return structuredClone(STORED_INPUT);
  });
  const engine = {
    calculate: vi.fn(async (input: Record<string, unknown>) => {
      expect(databaseOperationOpen, "Engine lief in einer DB-Operation").toBe(false);
      expect(input).toEqual(INPUT_SNAPSHOT);
      order.push("engine");
      if (options.engineError !== undefined) throw options.engineError;
      return structuredClone(RESULT);
    }),
  };
  const handler = createCalculationExecuteHandler({
    database,
    provider,
    engine,
    buildInput,
    createLeaseToken: () => LEASE_TOKEN,
  });

  return { handler, database, provider, engine, buildInput, order };
}

async function captureError(operation: Promise<unknown>): Promise<Error & Record<string, unknown>> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error & Record<string, unknown>;
  }
  throw new Error("expected operation to reject");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("M1-07 calculation.execute dispatch contract", () => {
  it("accepts only the exact, versioned, ID-only payload", () => {
    const parsed = parseCalculationDispatchPayload(structuredClone(DISPATCH));

    expect(parsed).toEqual(DISPATCH);
    expect(Object.keys(parsed).sort()).toEqual([
      "jobId",
      "schemaVersion",
      "workspaceId",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("reservation");
  });

  it.each([
    null,
    [],
    {},
    { ...DISPATCH, schemaVersion: "project-calculation-dispatch.v2" },
    { ...DISPATCH, workspaceId: "not-a-uuid" },
    { ...DISPATCH, jobId: "not-a-uuid" },
    { ...DISPATCH, reservationKey: "11".repeat(32) },
    { ...DISPATCH, profile: { householdKwhPerYear: 4_200 } },
    { ...DISPATCH, address: "Workerweg 7" },
  ])("rejects a malformed or expanded payload before claiming: %j", async (payload) => {
    const secret = JSON.stringify(payload);
    const harness = createHarness();
    const error = await captureError(harness.handler([bossJob(payload)]));

    expect(error).toMatchObject({ code: "invalid_dispatch_payload" });
    expect(Object.keys(error).sort()).toEqual(["code"]);
    expect(String(error)).not.toContain(secret);
    expect(harness.database.claim).not.toHaveBeenCalled();
    expect(harness.provider.fetch).not.toHaveBeenCalled();
    expect(harness.engine.calculate).not.toHaveBeenCalled();
  });
});

describe("M1-07 calculation.execute orchestration", () => {
  it("closes claim/persist transactions before provider and engine, then finalizes by claim CAS", async () => {
    const harness = createHarness();

    await harness.handler([bossJob(DISPATCH)]);

    expect(harness.order).toEqual([
      "claim:start",
      "claim:end",
      "provider",
      "build-input",
      "persist:start",
      "persist:end",
      "engine",
      "success:start",
      "success:end",
    ]);
    expect(harness.database.claim).toHaveBeenCalledTimes(1);
    expect(harness.database.persistInput).toHaveBeenCalledTimes(1);
    expect(harness.database.finalizeSuccess).toHaveBeenCalledTimes(1);
    expect(harness.database.finalizeFailure).not.toHaveBeenCalled();
  });

  it("reuses the byte-identical persisted input on retry without fresh provider I/O", async () => {
    const persisted = structuredClone(STORED_INPUT);
    const harness = createHarness({ claim: claimed(persisted) });

    await harness.handler([bossJob(DISPATCH)]);

    expect(harness.provider.fetch).not.toHaveBeenCalled();
    expect(harness.buildInput).not.toHaveBeenCalled();
    expect(harness.database.persistInput).not.toHaveBeenCalled();
    expect(harness.engine.calculate).toHaveBeenCalledWith(persisted.inputSnapshot);
    expect(harness.database.finalizeSuccess).toHaveBeenCalledWith(expect.objectContaining({
      result: RESULT,
    }));
  });

  it("does nothing when an atomic claim reports not-due, terminal, foreign, or already leased", async () => {
    const harness = createHarness({ claim: null });

    await harness.handler([bossJob(DISPATCH)]);

    expect(harness.database.claim).toHaveBeenCalledTimes(1);
    expect(harness.provider.fetch).not.toHaveBeenCalled();
    expect(harness.engine.calculate).not.toHaveBeenCalled();
    expect(harness.database.finalizeSuccess).not.toHaveBeenCalled();
    expect(harness.database.finalizeFailure).not.toHaveBeenCalled();
  });

  it("fails unsupported provider/engine pins before external I/O", async () => {
    const unsupported = claimed();
    unsupported.modelVersion = "9.9.9";
    const harness = createHarness({ claim: unsupported });

    await expect(harness.handler([bossJob(DISPATCH)])).resolves.toBeUndefined();

    expect(harness.provider.fetch).not.toHaveBeenCalled();
    expect(harness.buildInput).not.toHaveBeenCalled();
    expect(harness.engine.calculate).not.toHaveBeenCalled();
    expect(harness.database.finalizeFailure).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "engine_invalid",
      retryable: false,
      retryAfterMs: undefined,
    });
  });

  it("fails a legacy job without immutable preparation before provider I/O", async () => {
    const legacy = claimed();
    legacy.preparation = null;
    legacy.providerRequest = null;
    const harness = createHarness({ claim: legacy });

    await expect(harness.handler([bossJob(DISPATCH)])).resolves.toBeUndefined();

    expect(harness.provider.fetch).not.toHaveBeenCalled();
    expect(harness.buildInput).not.toHaveBeenCalled();
    expect(harness.engine.calculate).not.toHaveBeenCalled();
    expect(harness.database.finalizeFailure).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "engine_invalid",
      retryable: false,
      retryAfterMs: undefined,
    });
  });

  it.each([
    [
      "provider_rate_limited",
      true,
      120_000,
      "rate_limited",
      true,
      120_000,
    ],
    [
      "provider_invalid_response",
      false,
      undefined,
      "provider_invalid",
      false,
      undefined,
    ],
    [
      "provider_unavailable",
      true,
      300_000,
      "provider_unavailable",
      true,
      300_000,
    ],
    [
      "provider_http_error",
      false,
      120_000,
      "provider_invalid",
      false,
      undefined,
    ],
  ] as const)(
    "maps %s to a closed domain failure without provider details",
    async (providerCode, retryable, retryAfterMs, errorCode, expectedRetryable, expectedRetryAfter) => {
      const secret = "https://provider.invalid/?lat=49.28463&body=customer-secret";
      const providerError = Object.assign(new Error(secret), {
        code: providerCode,
        retryable,
        retryAfterMs,
        responseBody: secret,
      });
      const harness = createHarness({ providerError });
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await expect(harness.handler([bossJob(DISPATCH)])).resolves.toBeUndefined();

      expect(harness.database.finalizeFailure).toHaveBeenCalledWith({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        leaseToken: LEASE_TOKEN,
        attemptCount: 1,
        errorCode,
        retryable: expectedRetryable,
        retryAfterMs: expectedRetryAfter,
      });
      expect(JSON.stringify(harness.database.finalizeFailure.mock.calls)).not.toContain(secret);
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    },
  );

  it("sanitizes engine failures and treats a lost finalization CAS as an ownership no-op", async () => {
    const secret = "stack includes customer@example.test and complete calculation result";
    const engineError = Object.assign(new Error(secret), {
      code: "engine_invalid_response",
      retryable: false,
      result: { customer: secret },
    });
    let harness = createHarness({ engineError });

    await harness.handler([bossJob(DISPATCH)]);

    expect(harness.database.finalizeFailure).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "engine_invalid",
      retryable: false,
      retryAfterMs: undefined,
    });
    expect(JSON.stringify(harness.database.finalizeFailure.mock.calls)).not.toContain(secret);

    harness = createHarness({
      successError: Object.assign(new Error(secret), { code: "stale", retryable: false }),
    });
    await expect(harness.handler([bossJob(DISPATCH)])).resolves.toBeUndefined();
    expect(harness.database.finalizeFailure).not.toHaveBeenCalled();
  });

  it("does not trust or forward pg-boss metadata outside the exact data payload", async () => {
    const harness = createHarness();

    await expect(harness.handler([
      { ...bossJob(DISPATCH), reservationKey: "do-not-forward", data: DISPATCH },
    ])).resolves.toBeUndefined();

    expect(harness.database.claim).toHaveBeenCalledTimes(1);
    expect(harness.database.claim.mock.calls[0]?.[0]).toMatchObject({
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    });
    expect(JSON.stringify(harness.database.claim.mock.calls)).not.toContain("do-not-forward");
  });
});

describe("M1-07 calculation.execute production wiring", () => {
  it("registers the real calculation handler on the pinned pg-boss queue", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../worker/index.ts"),
      "utf8",
    );
    const executableSource = source
      .replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*\/\/.*$/gmu, "");

    expect(executableSource).toContain("createCalculationExecuteHandler");
    expect(executableSource).toMatch(/boss\.work\(\s*CALCULATION_QUEUE\b/u);
  });
});
