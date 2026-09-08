import { describe, expect, it } from "vitest";

import {
  CALCULATION_V2_CONTRACT_VERSION,
  CALCULATION_V2_DEFAULTS_VERSION,
  CALCULATION_V2_MODEL_ID,
  CALCULATION_V2_MODEL_VERSION,
  CALCULATION_V2_PROVIDER_RECIPE_VERSION,
  CALCULATION_V2_SOURCE_REVISION,
} from "@/lib/integrations/calculation/versions-v2";
import {
  CalculationDispatchV2Error,
  parseCalculationDispatchV2Payload,
  sanitizeV2EngineFailure,
  sanitizeV2ProviderFailure,
  supportsV2ClaimPins,
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
