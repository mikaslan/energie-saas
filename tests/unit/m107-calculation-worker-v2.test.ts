import { describe, expect, it, vi } from "vitest";

import type {
  PlanningCalculationRequestV2,
  PlanningCalculationResultV2,
} from "@/lib/integrations/calculation/contract-v2";
import type { ProjectCalculationPreparationV2 } from
  "@/lib/integrations/calculation/preparation-v2";
import {
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_DEFAULTS_VERSION,
  CALCULATION_V2_MODEL_ID,
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  CALCULATION_V2_RESULT_CONTRACT_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
} from "@/lib/integrations/calculation/versions-v2";
import type { ProjectCalculationClaim } from
  "@/modules/energy/calculation-service";
import {
  CalculationDispatchV2Error,
  createCalculationExecuteV2Handler,
  parseCalculationDispatchV2Payload,
  sanitizeV2EngineFailure,
  sanitizeV2ProviderFailure,
  supportsV2ClaimPins,
  type CalculationV2ExecuteDependencies,
} from "@/worker/calculation-v2";

// F4.1 v2-Workerbausteine: Dispatch-Payload, exakte Tupel-Pins,
// deterministische Fehlertaxonomie (kein Handler vor Persistenz).

const PINS = {
  sourceCalculatorSnapshotId: null,
  contractVersion: CALCULATION_V2_CONTRACT_VERSION,
  providerRecipeVersion: CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  modelId: CALCULATION_V2_MODEL_ID,
  modelVersion: CALCULATION_V2_MODEL_VERSION,
  sourceRevision: CALCULATION_V2_SOURCE_REVISION,
  defaultsVersion: CALCULATION_V2_DEFAULTS_VERSION,
};

describe("F4.1 v2 worker dispatch", () => {
  it("parst v2-Payloads und weist v1/fremde Schemata ab", () => {
    expect(parseCalculationDispatchV2Payload({
      schemaVersion: "project-calculation-dispatch.v2",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      jobId: "22222222-2222-4222-8222-222222222222",
    })).toMatchObject({ jobId: "22222222-2222-4222-8222-222222222222" });
    expect(() => parseCalculationDispatchV2Payload({
      schemaVersion: "project-calculation-dispatch.v1",
      workspaceId: "11111111-1111-4111-8111-111111111111",
      jobId: "22222222-2222-4222-8222-222222222222",
    })).toThrow(CalculationDispatchV2Error);
    expect(() => parseCalculationDispatchV2Payload(null)).toThrow(
      CalculationDispatchV2Error,
    );
  });
});

describe("F4.1 v2 claim pins", () => {
  it("akzeptiert das exakte v2-Tupel", () => {
    expect(supportsV2ClaimPins(PINS)).toBe(true);
    expect(supportsV2ClaimPins({
      ...PINS,
      sourceCalculatorSnapshotId: "66666666-6666-4666-8666-666666666666",
    })).toBe(true);
  });

  it("verweigert jedes einzeln abweichende Tupelfeld", () => {
    const fields = [
      "contractVersion",
      "providerRecipeVersion",
      "modelId",
      "modelVersion",
      "sourceRevision",
      "defaultsVersion",
    ] as const;
    for (const field of fields) {
      expect(supportsV2ClaimPins({ ...PINS, [field]: "unbekannt" })).toBe(false);
    }
    expect(supportsV2ClaimPins({ ...PINS, contractVersion: "planning-calculation.v1" })).toBe(
      false,
    );
  });
});

describe("F4.1 v2 failure taxonomy", () => {
  it("mappt deterministische f401-Fehler auf nicht-retryable", () => {
    for (const code of [
      "f401_engine_invalid_input",
      "f401_axis_invalid_input",
      "f401_load_invalid_input",
    ]) {
      const error = new Error("x") as Error & { code: string };
      error.code = code;
      expect(sanitizeV2EngineFailure(error)).toMatchObject({
        errorCode: "engine_invalid",
        retryable: false,
      });
    }
    for (const code of [
      "provider_invalid_response",
      "contract_size_exceeded",
      "provider_configuration",
    ]) {
      const error = new Error("x") as Error & { code: string };
      error.code = code;
      expect(sanitizeV2ProviderFailure(error)).toMatchObject({
        errorCode: "provider_invalid",
        retryable: false,
      });
    }
  });

  it("reicht stale/retry_conflict durch und re-trys Unbekanntes", () => {
    const stale = new Error("x") as Error & { code: string };
    stale.code = "stale";
    expect(sanitizeV2EngineFailure(stale).errorCode).toBe("stale");
    expect(sanitizeV2ProviderFailure(stale).errorCode).toBe("stale");
    const conflict = new Error("x") as Error & { code: string };
    conflict.code = "retry_conflict";
    expect(sanitizeV2EngineFailure(conflict).retryable).toBe(false);
    expect(sanitizeV2EngineFailure(new Error("boom"))).toMatchObject({
      errorCode: "engine_unavailable",
      retryable: true,
    });
    expect(sanitizeV2ProviderFailure(new Error("boom"))).toMatchObject({
      errorCode: "provider_unavailable",
      retryable: true,
    });
    const limited = new Error("x") as Error & { code: string; retryAfterMs: number };
    limited.code = "provider_rate_limited";
    limited.retryAfterMs = 5_000;
    expect(sanitizeV2ProviderFailure(limited)).toMatchObject({
      errorCode: "rate_limited",
      retryable: true,
      retryAfterMs: 5_000,
    });
  });
});

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const SITE_ID = "66666666-6666-4666-8666-666666666666";
const PROFILE_ID = "77777777-7777-4777-8777-777777777777";
const REQUIREMENT_ID = "88888888-8888-4888-8888-888888888888";
const SNAPSHOT_ID = "99999999-9999-4999-8999-999999999999";
const INPUT_SHA256 = "a".repeat(64);

const DISPATCH_JOB = {
  id: "44444444-4444-4444-8444-444444444444",
  name: "calculation.execute.v2",
  data: {
    schemaVersion: "project-calculation-dispatch.v2",
    workspaceId: WORKSPACE_ID,
    jobId: JOB_ID,
  },
};

const SERIES = {
  pvKwh: new Array<number>(35_040).fill(1),
  loadKwh: new Array<number>(35_040).fill(0.5),
  providerEstimate: false,
  // Slice A: Neuanlagen-Setup ohne Bestands-Reihe (Schluessel fehlt).
};

const REQUEST = {
  contractVersion: CALCULATION_V2_CONTRACT_VERSION,
  canonicalizationVersion: "planning-jcs.v1",
  branch: "new_installation",
  asOfDate: "2026-08-29",
  bindings: {
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
  },
  site: { countryCode: "DE", latitude: 52.52, longitude: 13.41 },
  axis: { slots: 35_040, resolution: "quarter_hour" },
  storage: {
    capacityKwh: 10, socMinKwh: 1, socMaxKwh: 9, chargeKw: 5,
    dischargeKw: 5, etaCharge: 0.95, etaDischarge: 0.95,
  },
} as unknown as PlanningCalculationRequestV2;

const RESULT = {
  contractVersion: CALCULATION_V2_RESULT_CONTRACT_VERSION,
  inputSha256: INPUT_SHA256,
} as unknown as PlanningCalculationResultV2;

const STORED_INPUT = {
  inputSha256: INPUT_SHA256,
  inputSnapshot: REQUEST,
  providerSnapshot: { schemaVersion: "calculation-input-series.v2", ...SERIES },
};

function v2Claim(
  overrides: Partial<ProjectCalculationClaim> = {},
): ProjectCalculationClaim {
  return {
    workspaceId: WORKSPACE_ID,
    jobId: JOB_ID,
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
    contractVersion: CALCULATION_V2_CONTRACT_VERSION,
    providerRecipeVersion: CALCULATION_V2_PROVIDER_RECIPE_VERSION,
    modelId: CALCULATION_V2_MODEL_ID,
    modelVersion: CALCULATION_V2_MODEL_VERSION,
    sourceRevision: CALCULATION_V2_SOURCE_REVISION,
    defaultsVersion: CALCULATION_V2_DEFAULTS_VERSION,
    leaseToken: LEASE_TOKEN,
    leaseExpiresAt: new Date("2026-08-29T13:00:00.000Z"),
    startedAt: new Date("2026-08-29T12:00:00.000Z"),
    attemptCount: 1,
    providerRequest: null,
    input: null,
    preparation: null,
    // Inhaltlich prueft der Handler nur null/nicht-null; die echte
    // Provenienzform pinnt der Composer-Test (f401-prepare-v2).
    preparationV2: { latitude: 52.52, longitude: 13.41 } as unknown as
      ProjectCalculationPreparationV2,
    providerRequestV2: {
      latitude: 52.52,
      longitude: 13.41,
      roofs: [{ roofId: "dach-sued", tiltDeg: 30, azimuthDeg: 0, areaM2: 52 }],
      consumption: {
        householdKwhPerYear: { status: "known", value: 4200, source: "customer_metered" },
      },
      branch: "new_installation",
      asOfDate: "2026-08-29",
      existingPv: { status: "known_absent" },
    },
    ...overrides,
  };
}

function codedError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(code), { code }, extra);
}

type HandlerSetup = {
  claim?: ProjectCalculationClaim | null;
  fetchError?: unknown;
  buildError?: unknown;
  persistError?: unknown;
  engineError?: unknown;
  successError?: unknown;
  failureError?: unknown;
};

function setup(options: HandlerSetup = {}): {
  handler: (jobs: unknown[]) => Promise<void>;
  dependencies: CalculationV2ExecuteDependencies;
} {
  const claimResult = options.claim === undefined ? v2Claim() : options.claim;
  type Database = CalculationV2ExecuteDependencies["database"];
  const database: Database = {
    claim: vi.fn(async (
      input: Parameters<Database["claim"]>[0],
    ) => {
      expect(input).toEqual({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        leaseToken: LEASE_TOKEN,
      });
      return claimResult;
    }),
    persistInput: vi.fn(async (
      input: Parameters<Database["persistInput"]>[0],
    ) => {
      expect(input).toMatchObject({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        leaseToken: LEASE_TOKEN,
        attemptCount: 1,
        inputSnapshot: REQUEST,
        providerEstimate: false,
      });
      if (options.persistError !== undefined) throw options.persistError;
      return {
        inputSha256: INPUT_SHA256,
        inputSnapshot: REQUEST,
        providerSeries: {
          schemaVersion: "calculation-input-series.v2" as const,
          ...SERIES,
        },
        replayed: false,
      };
    }),
    finalizeSuccess: vi.fn(async (
      input: Parameters<Database["finalizeSuccess"]>[0],
    ) => {
      expect(input).toMatchObject({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        leaseToken: LEASE_TOKEN,
        attemptCount: 1,
        result: RESULT,
      });
      if (options.successError !== undefined) throw options.successError;
      return { revisionId: SNAPSHOT_ID, revision: 1, replayed: false };
    }),
    finalizeFailure: vi.fn(async (
      input: Parameters<Database["finalizeFailure"]>[0],
    ) => {
      expect(input).toMatchObject({
        workspaceId: WORKSPACE_ID,
        jobId: JOB_ID,
        leaseToken: LEASE_TOKEN,
        attemptCount: 1,
      });
      if (options.failureError !== undefined) throw options.failureError;
      return { state: "retry_wait", attemptCount: 1, nextAttemptAt: new Date() };
    }),
  };
  const dependencies: CalculationV2ExecuteDependencies = {
    database,
    provider: {
      fetch: vi.fn(async (
        request: Parameters<
          CalculationV2ExecuteDependencies["provider"]["fetch"]
        >[0],
      ) => {
        expect(request).toMatchObject({
          latitude: 52.52,
          longitude: 13.41,
          roofs: [{ roofId: "dach-sued", tiltDeg: 30, azimuthDeg: 0, areaM2: 52 }],
        });
        if (options.fetchError !== undefined) throw options.fetchError;
        // Slice A: Neuanlagen-Setup, keine Bestands-Reihe.
        return { ...SERIES, existingPvKwh: null };
      }),
    },
    buildInput: vi.fn(async () => {
      if (options.buildError !== undefined) throw options.buildError;
      return {
        inputSha256: INPUT_SHA256,
        inputSnapshot: REQUEST,
        ...SERIES,
        existingPvKwh: null,
      };
    }),
    engine: {
      calculate: vi.fn(async () => {
        if (options.engineError !== undefined) throw options.engineError;
        return RESULT;
      }),
    },
    createLeaseToken: () => LEASE_TOKEN,
  };
  return { handler: createCalculationExecuteV2Handler(dependencies), dependencies };
}

describe("F4.1 v2 execute handler", () => {
  it("ignoriert fehlenden Claim und fremde Payloads fail-closed", async () => {
    const { handler, dependencies } = setup({ claim: null });
    await handler([DISPATCH_JOB]);
    expect(dependencies.database.persistInput).not.toHaveBeenCalled();
    expect(dependencies.database.finalizeFailure).not.toHaveBeenCalled();
    expect(dependencies.database.finalizeSuccess).not.toHaveBeenCalled();
    await expect(handler([{ data: {
      schemaVersion: "project-calculation-dispatch.v1",
      workspaceId: WORKSPACE_ID,
      jobId: JOB_ID,
    } }])).rejects.toThrow(CalculationDispatchV2Error);
  });

  it("finalisiert Pin-Verletzung und v1-Input als engine_invalid", async () => {
    for (const claim of [
      v2Claim({ contractVersion: "planning-calculation.v1" }),
      v2Claim({
        input: { inputSnapshot: { contractVersion: "planning-calculation.v1" } } as never,
      }),
    ]) {
      const { handler, dependencies } = setup({ claim });
      await handler([DISPATCH_JOB]);
      expect(dependencies.provider.fetch).not.toHaveBeenCalled();
      expect(dependencies.database.finalizeFailure).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: "engine_invalid", retryable: false }),
      );
    }
  });

  it("verweigert fehlende Provenienz ohne Fetch", async () => {
    const { handler, dependencies } = setup({
      claim: v2Claim({ preparationV2: null, providerRequestV2: null }),
    });
    await handler([DISPATCH_JOB]);
    expect(dependencies.provider.fetch).not.toHaveBeenCalled();
    expect(dependencies.database.finalizeFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "engine_invalid", retryable: false }),
    );
  });

  it("mappt Provider-Rate-Limit auf retryable rate_limited", async () => {
    const { handler, dependencies } = setup({
      fetchError: codedError("provider_rate_limited", { retryAfterMs: 5_000 }),
    });
    await handler([DISPATCH_JOB]);
    expect(dependencies.database.finalizeFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "rate_limited",
        retryable: true,
        retryAfterMs: 5_000,
      }),
    );
    expect(dependencies.database.finalizeSuccess).not.toHaveBeenCalled();
  });

  it("faehrt den Frischpfad bis zum Success-Finalize", async () => {
    const { handler, dependencies } = setup();
    await handler([DISPATCH_JOB]);
    expect(dependencies.provider.fetch).toHaveBeenCalledTimes(1);
    expect(dependencies.buildInput).toHaveBeenCalledWith({
      claim: expect.objectContaining({ jobId: JOB_ID }),
      // Slice A: Fetch liefert die Bestands-Reihe (hier null) mit.
      providerSeries: { ...SERIES, existingPvKwh: null },
    });
    expect(dependencies.database.persistInput).toHaveBeenCalledTimes(1);
    expect(dependencies.engine.calculate).toHaveBeenCalledWith({
      request: REQUEST,
      pvKwh: SERIES.pvKwh,
      loadKwh: SERIES.loadKwh,
      providerEstimate: false,
    });
    expect(dependencies.database.finalizeSuccess).toHaveBeenCalledTimes(1);
    expect(dependencies.database.finalizeFailure).not.toHaveBeenCalled();
  });

  it("nutzt gespeicherten Input ohne Fetch und Persist", async () => {
    const { handler, dependencies } = setup({ claim: v2Claim({ input: STORED_INPUT as never }) });
    await handler([DISPATCH_JOB]);
    expect(dependencies.provider.fetch).not.toHaveBeenCalled();
    expect(dependencies.database.persistInput).not.toHaveBeenCalled();
    expect(dependencies.engine.calculate).toHaveBeenCalledWith({
      request: REQUEST,
      pvKwh: SERIES.pvKwh,
      loadKwh: SERIES.loadKwh,
      providerEstimate: false,
    });
    expect(dependencies.database.finalizeSuccess).toHaveBeenCalledTimes(1);
  });

  it("mappt deterministische Engine-Fehler und Unbekanntes korrekt", async () => {
    const invalid = setup({
      claim: v2Claim({ input: STORED_INPUT as never }),
      engineError: codedError("f401_engine_invalid_input"),
    });
    await invalid.handler([DISPATCH_JOB]);
    expect(invalid.dependencies.database.finalizeFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "engine_invalid", retryable: false }),
    );
    const unavailable = setup({
      claim: v2Claim({ input: STORED_INPUT as never }),
      engineError: new Error("boom"),
    });
    await unavailable.handler([DISPATCH_JOB]);
    expect(unavailable.dependencies.database.finalizeFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "engine_unavailable", retryable: true }),
    );
  });

  it("schluckt stale-Lease beim Success- und Failure-Finalize", async () => {
    const staleSuccess = setup({ successError: codedError("stale") });
    await staleSuccess.handler([DISPATCH_JOB]);
    expect(staleSuccess.dependencies.database.finalizeFailure).not.toHaveBeenCalled();
    const staleFailure = setup({
      fetchError: new Error("boom"),
      failureError: codedError("retry_conflict"),
    });
    await staleFailure.handler([DISPATCH_JOB]);
    expect(staleFailure.dependencies.database.finalizeFailure).toHaveBeenCalledTimes(1);
  });
});
