import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { TenantTx } from "@/lib/db/types";
import {
  OFFER_ISSUANCE_INPUT_VERSION,
  OFFER_ISSUANCE_RENDERER_RECIPE_VERSION,
  OFFER_ISSUANCE_TEMPLATE_VERSION,
  hashOfferIssuanceInput,
} from "@/lib/integrations/offers/issuance-contract";
import {
  M203B1_IDS,
  m203b1Artifact,
  m203b1IssuanceInput,
} from "@/tests/helpers/m203b1-offer-issuance-fixture";
import {
  OFFER_ISSUANCE_LEASE_SECONDS,
  OFFER_ISSUANCE_MAX_ATTEMPTS,
  OfferIssuanceWorkerError,
  claimOfferIssuance,
  finalizeOfferIssuanceFailure,
  finalizeOfferIssuanceSuccess,
  recoverDueOfferIssuances,
} from "@/worker/offer-issuance-database";

type ExecuteResponse = { rows: unknown[] } | Error;

function transaction(responses: ExecuteResponse[]) {
  let index = 0;
  const execute = vi.fn(async () => {
    const response = responses[index++] ?? { rows: [] };
    if (response instanceof Error) throw response;
    return response;
  });
  return { tx: { execute } as unknown as TenantTx, execute };
}

function claimEnvelope(attemptCount = 1) {
  const input = m203b1IssuanceInput();
  return {
    result: {
      status: "claimed",
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      leaseToken: M203B1_IDS.lease,
      attemptCount,
      inputVersion: OFFER_ISSUANCE_INPUT_VERSION,
      canonicalizationVersion: "offer-jcs.v1",
      templateVersion: OFFER_ISSUANCE_TEMPLATE_VERSION,
      rendererRecipeVersion: OFFER_ISSUANCE_RENDERER_RECIPE_VERSION,
      inputSha256: hashOfferIssuanceInput(input),
      input,
    },
  };
}

function dispatchGate(
  dispatchSignature: "pgboss.enqueue_offer_issuance(uuid,uuid)" | null =
    "pgboss.enqueue_offer_issuance(uuid,uuid)",
  overrides: Partial<{
    current_role: string;
    session_role: string;
    database_name: string;
  }> = {},
) {
  return { rows: [{
    dispatch_signature: dispatchSignature,
    current_role: "app_worker",
    session_role: "app_worker",
    database_name: "energie_saas",
    ...overrides,
  }] };
}

describe("M2-03b1 offer issuance worker database", () => {
  it("pins the three-attempt and two-minute lease contract", () => {
    expect(OFFER_ISSUANCE_MAX_ATTEMPTS).toBe(3);
    expect(OFFER_ISSUANCE_LEASE_SECONDS).toBe(120);
  });

  it("claims through one narrow function and repairs only an ID-only dispatch", async () => {
    const harness = transaction([
      { rows: [claimEnvelope()] },
      dispatchGate(),
      { rows: [{}] },
    ]);
    const result = await claimOfferIssuance(harness.tx, {
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      leaseToken: M203B1_IDS.lease,
    });
    expect(result).toMatchObject({
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      attemptCount: 1,
    });
    expect(result?.input).not.toBe(claimEnvelope().result.input);
    const sqlCalls = JSON.stringify(harness.execute.mock.calls);
    expect(sqlCalls).toContain("claim_offer_issuance_render");
    expect(sqlCalls).toContain("to_regprocedure");
    expect(sqlCalls).toContain("enqueue_offer_issuance");
    expect(sqlCalls).toContain(String(OFFER_ISSUANCE_LEASE_SECONDS));
    expect(sqlCalls).not.toContain("PRIVATE_RECIPIENT_SENTINEL");
  });

  it("dispatches the crash-recovery sentinel immediately after claim three", async () => {
    const harness = transaction([
      { rows: [claimEnvelope(3)] },
      dispatchGate(),
      { rows: [{}] },
    ]);
    await expect(claimOfferIssuance(harness.tx, {
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      leaseToken: M203B1_IDS.lease,
    })).resolves.toMatchObject({ attemptCount: 3 });
    expect(harness.execute).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(harness.execute.mock.calls))
      .toContain("enqueue_offer_issuance");
  });

  it("skips only an absent dispatch in the explicit single-role test database", async () => {
    const explicitTest = transaction([
      { rows: [claimEnvelope()] },
      dispatchGate(null, {
        current_role: "app_test",
        session_role: "app_test",
        database_name: "energie_saas_test",
      }),
    ]);
    await expect(claimOfferIssuance(explicitTest.tx, {
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      leaseToken: M203B1_IDS.lease,
    })).resolves.toMatchObject({ attemptCount: 1 });
    expect(explicitTest.execute).toHaveBeenCalledTimes(2);

    for (const unsafeGate of [
      dispatchGate(null),
      dispatchGate(null, {
        current_role: "app_test",
        session_role: "app_test",
        database_name: "energie_saas",
      }),
      dispatchGate(null, {
        current_role: "app_worker",
        session_role: "app_migrator",
        database_name: "energie_saas_test",
      }),
    ]) {
      const failClosed = transaction([{ rows: [claimEnvelope()] }, unsafeGate]);
      await expect(claimOfferIssuance(failClosed.tx, {
        workspaceId: M203B1_IDS.workspace,
        issuanceId: M203B1_IDS.issuance,
        leaseToken: M203B1_IDS.lease,
      })).rejects.toMatchObject({ code: "persistence_unavailable" });
      expect(failClosed.execute).toHaveBeenCalledTimes(2);
    }
  });

  it("marks a contract-invalid claimed input terminal before returning it", async () => {
    const invalid = claimEnvelope();
    invalid.result.inputSha256 = "0".repeat(64);
    const harness = transaction([
      { rows: [invalid] },
      { rows: [{ result: {
        status: "failed_final",
        attemptCount: 1,
        nextAttemptAt: "2026-08-30T10:32:00.000Z",
        errorCode: "invalid_input",
      } }] },
    ]);
    await expect(claimOfferIssuance(harness.tx, {
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      leaseToken: M203B1_IDS.lease,
    })).resolves.toBeNull();
    expect(JSON.stringify(harness.execute.mock.calls))
      .toContain("finalize_offer_issuance_render_failure");
  });

  it("commits SQL-terminalized claim outcomes without throwing or dispatching", async () => {
    for (const errorCode of ["invalid_input", "lease_expired"] as const) {
      const harness = transaction([{ rows: [{ result: {
        status: "failed_final",
        attemptCount: errorCode === "lease_expired" ? 3 : 2,
        nextAttemptAt: "2026-08-30T10:32:00.000Z",
        errorCode,
      } }] }]);
      await expect(claimOfferIssuance(harness.tx, {
        workspaceId: M203B1_IDS.workspace,
        issuanceId: M203B1_IDS.issuance,
        leaseToken: M203B1_IDS.lease,
      })).resolves.toBeNull();
      expect(harness.execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(harness.execute.mock.calls))
        .not.toMatch(/enqueue_offer_issuance|finalize_offer_issuance_render_failure/u);
    }
  });

  it("passes exact verified PDF bytes to atomic success and rejects forged envelopes", async () => {
    const artifact = m203b1Artifact();
    const success = transaction([{ rows: [{ result: {
      status: "ready_for_approval",
      attemptCount: 1,
      replayed: false,
      artifactVersion: M203B1_IDS.artifactVersion,
    } }] }]);
    await expect(finalizeOfferIssuanceSuccess(success.tx, {
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      leaseToken: M203B1_IDS.lease,
      attemptCount: 1,
      artifact,
    })).resolves.toEqual({
      state: "ready_for_approval",
      attemptCount: 1,
      replayed: false,
      artifactVersion: M203B1_IDS.artifactVersion,
    });
    const sqlCalls = JSON.stringify(success.execute.mock.calls);
    expect(sqlCalls).toContain("finalize_offer_issuance_render_success");
    expect(sqlCalls).not.toContain(artifact.sha256);
    const source = readFileSync(resolve(
      import.meta.dirname,
      "../../worker/offer-issuance-database.ts",
    ), "utf8");
    expect(source).toContain("${artifact.bytes}::bytea");

    for (const invalidArtifact of [
      { ...artifact, sha256: "0".repeat(64) },
      { ...artifact, mimeType: "text/html" },
      { ...artifact, privateField: "PRIVATE" },
    ]) {
      const invalid = transaction([]);
      await expect(finalizeOfferIssuanceSuccess(invalid.tx, {
        workspaceId: M203B1_IDS.workspace,
        issuanceId: M203B1_IDS.issuance,
        leaseToken: M203B1_IDS.lease,
        attemptCount: 1,
        artifact: invalidArtifact,
      })).rejects.toMatchObject({ code: "invalid_pdf" });
      expect(invalid.execute).not.toHaveBeenCalled();
    }
  });

  it("uses DB-owned retry state, dispatches retry_wait and accepts final exhaustion", async () => {
    const retry = transaction([
      { rows: [{ result: {
        status: "retry_wait",
        attemptCount: 1,
        nextAttemptAt: "2026-08-30T10:32:00.000Z",
        errorCode: "browser_unavailable",
      } }] },
      dispatchGate(),
      { rows: [{}] },
    ]);
    await expect(finalizeOfferIssuanceFailure(retry.tx, {
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      leaseToken: M203B1_IDS.lease,
      attemptCount: 1,
      errorCode: "browser_unavailable",
      retryable: true,
    })).resolves.toMatchObject({ state: "retry_wait", attemptCount: 1 });
    expect(JSON.stringify(retry.execute.mock.calls)).toContain("enqueue_offer_issuance");

    const exhausted = transaction([{ rows: [{ result: {
      status: "failed_final",
      attemptCount: 3,
      nextAttemptAt: "2026-08-30T10:32:00.000Z",
      errorCode: "browser_unavailable",
    } }] }]);
    await expect(finalizeOfferIssuanceFailure(exhausted.tx, {
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      leaseToken: M203B1_IDS.lease,
      attemptCount: 3,
      errorCode: "browser_unavailable",
      retryable: true,
    })).resolves.toMatchObject({ state: "failed_final", attemptCount: 3 });
  });

  it("maps renderer nondeterminism only to a terminal failure", async () => {
    const terminal = transaction([{ rows: [{ result: {
      status: "failed_final",
      attemptCount: 1,
      nextAttemptAt: "2026-08-30T10:32:00.000Z",
      errorCode: "renderer_nondeterministic",
    } }] }]);
    await expect(finalizeOfferIssuanceFailure(terminal.tx, {
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      leaseToken: M203B1_IDS.lease,
      attemptCount: 1,
      errorCode: "renderer_nondeterministic",
      retryable: false,
    })).resolves.toMatchObject({ state: "failed_final", attemptCount: 1 });
    expect(JSON.stringify(terminal.execute.mock.calls))
      .toContain("finalize_offer_issuance_render_failure");

    const retryable = transaction([]);
    await expect(finalizeOfferIssuanceFailure(retryable.tx, {
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      leaseToken: M203B1_IDS.lease,
      attemptCount: 1,
      errorCode: "renderer_nondeterministic",
      retryable: true,
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(retryable.execute).not.toHaveBeenCalled();
  });

  it("recovers only returned issuance IDs and never queries the tenant table directly", async () => {
    const second = "f7777777-7777-4777-8777-777777777777";
    const harness = transaction([
      { rows: [{ issuance_id: M203B1_IDS.issuance }, { issuance_id: second }] },
      dispatchGate(),
      { rows: [{}] },
      dispatchGate(),
      { rows: [{}] },
    ]);
    await expect(recoverDueOfferIssuances(harness.tx, {
      workspaceId: M203B1_IDS.workspace,
      limit: 2,
    })).resolves.toEqual([M203B1_IDS.issuance, second]);
    const sqlCalls = JSON.stringify(harness.execute.mock.calls);
    expect(sqlCalls).toContain("recover_offer_issuance_renders");
    expect(sqlCalls.match(/enqueue_offer_issuance/gu)).toHaveLength(4);

    const source = readFileSync(resolve(
      import.meta.dirname,
      "../../worker/offer-issuance-database.ts",
    ), "utf8");
    expect(source).toContain('servicePoolConfig(connectionString, "app_worker", max)');
    expect(source).toContain("claim_offer_issuance_render");
    expect(source).toContain("finalize_offer_issuance_render_success");
    expect(source).toContain("finalize_offer_issuance_render_failure");
    expect(source).toContain("recover_offer_issuance_renders");
    expect(source).toContain("list_offer_issuance_recovery_workspaces");
    expect(source).not.toMatch(/\bfrom\s+offer_issuance\b/iu);
    expect(source).not.toMatch(/\bupdate\s+offer_issuance\b/iu);
    expect(source).not.toContain("row_security = off");
    expect(source).not.toContain("bypassrls");
    expect(source).not.toContain("modules/offers/issuance-service");
  });

  it("exposes only closed worker errors", () => {
    expect(new OfferIssuanceWorkerError("stale")).toMatchObject({
      name: "OfferIssuanceWorkerError",
      code: "stale",
      message: "offer issuance worker database operation failed",
    });
  });
});
