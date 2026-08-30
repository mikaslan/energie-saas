import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OFFER_ISSUANCE_DISPATCH_VERSION,
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
  OfferIssuanceDispatchError,
  OfferIssuanceIntegrityIncidentError,
  OfferIssuanceRecoverySweepError,
  createOfferIssuanceRenderHandler,
  parseOfferIssuanceDispatchPayload,
  startOfferIssuanceRecoverySweep,
  type OfferIssuanceClaim,
} from "@/worker/offer-issuance";
import { OfferIssuanceWorkerError } from "@/worker/offer-issuance-database";
import type { OfferIssuanceRenderer } from "@/worker/offer-issuance-renderer";
import { OfferPdfRenderError } from "@/worker/offer-pdf-renderer";

function claim(overrides: Partial<OfferIssuanceClaim> = {}): OfferIssuanceClaim {
  const input = m203b1IssuanceInput();
  return {
    workspaceId: M203B1_IDS.workspace,
    issuanceId: M203B1_IDS.issuance,
    leaseToken: M203B1_IDS.lease,
    attemptCount: 1,
    inputVersion: OFFER_ISSUANCE_INPUT_VERSION,
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: OFFER_ISSUANCE_TEMPLATE_VERSION,
    rendererRecipeVersion: OFFER_ISSUANCE_RENDERER_RECIPE_VERSION,
    inputSha256: hashOfferIssuanceInput(input),
    input,
    ...overrides,
  };
}

function job(data: unknown = {
  schemaVersion: OFFER_ISSUANCE_DISPATCH_VERSION,
  workspaceId: M203B1_IDS.workspace,
  issuanceId: M203B1_IDS.issuance,
}) {
  return { data };
}

function harness(inputClaim: OfferIssuanceClaim | null = claim()) {
  const database = {
    claim: vi.fn(async () => inputClaim),
    finalizeSuccess: vi.fn(async () => ({ state: "ready_for_approval" })),
    finalizeFailure: vi.fn(async () => ({ state: "failed_final" })),
  };
  const renderer = {
    render: vi.fn(async () => m203b1Artifact()),
  } as OfferIssuanceRenderer;
  const onIntegrityIncident = vi.fn();
  return {
    database,
    renderer,
    onIntegrityIncident,
    handler: createOfferIssuanceRenderHandler({
      database,
      renderer,
      onIntegrityIncident,
      createLeaseToken: () => M203B1_IDS.lease,
    }),
  };
}

afterEach(() => vi.useRealTimers());

describe("M2-03b1 offer issuance render worker", () => {
  it("accepts only the exact ID-only dispatch and reloads a pinned input", async () => {
    expect(parseOfferIssuanceDispatchPayload(job().data)).toEqual(job().data);
    for (const invalid of [
      null,
      { ...job().data as object, offerId: M203B1_IDS.offer },
      { ...job().data as object, artifactSha256: "a".repeat(64) },
    ]) expect(() => parseOfferIssuanceDispatchPayload(invalid))
      .toThrow(OfferIssuanceDispatchError);

    const test = harness();
    await test.handler([job()]);
    expect(test.database.claim).toHaveBeenCalledWith({
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      leaseToken: M203B1_IDS.lease,
    });
    expect(test.renderer.render).toHaveBeenCalledOnce();
    expect(test.database.finalizeSuccess).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      attemptCount: 1,
      artifact: expect.objectContaining({ mimeType: "application/pdf" }),
    }));
  });

  it("fails hash/version drift closed before rendering", async () => {
    for (const drifted of [
      claim({ inputSha256: "0".repeat(64) }),
      claim({ templateVersion: "offer-issuance-template.v2" }),
      claim({ canonicalizationVersion: "other-jcs.v1" }),
      claim({ workspaceId: M203B1_IDS.otherWorkspace }),
    ]) {
      const test = harness(drifted);
      await test.handler([job()]);
      expect(test.renderer.render).not.toHaveBeenCalled();
      expect(test.database.finalizeFailure).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: "invalid_input",
        retryable: false,
      }));
    }
  });

  it("maps renderer and persistence failures to fixed codes without input leakage", async () => {
    const rendering = harness();
    vi.mocked(rendering.renderer.render).mockRejectedValueOnce(
      new OfferPdfRenderError("render_timeout", true),
    );
    await rendering.handler([job()]);
    expect(rendering.database.finalizeFailure).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "render_timeout", retryable: true }),
    );

    const persistence = harness();
    persistence.database.finalizeSuccess.mockRejectedValueOnce(
      new Error("PRIVATE_RECIPIENT_SENTINEL"),
    );
    await persistence.handler([job()]);
    const calls = JSON.stringify(persistence.database.finalizeFailure.mock.calls);
    expect(calls).toContain("persistence_unavailable");
    expect(calls).not.toContain("PRIVATE_RECIPIENT_SENTINEL");
  });

  it("records nondeterminism terminally before raising a sanitized incident", async () => {
    const test = harness();
    test.database.finalizeSuccess.mockRejectedValueOnce({
      ...new OfferIssuanceWorkerError("renderer_nondeterministic"),
      code: "renderer_nondeterministic" as const,
      detail: "PRIVATE_BYTES",
    });
    await expect(test.handler([job()]))
      .rejects.toBeInstanceOf(OfferIssuanceIntegrityIncidentError);
    expect(test.onIntegrityIncident).toHaveBeenCalledWith(
      expect.any(OfferIssuanceIntegrityIncidentError),
    );
    expect(test.database.finalizeFailure).toHaveBeenCalledOnce();
    expect(test.database.finalizeFailure).toHaveBeenCalledWith({
      workspaceId: M203B1_IDS.workspace,
      issuanceId: M203B1_IDS.issuance,
      leaseToken: M203B1_IDS.lease,
      attemptCount: 1,
      errorCode: "renderer_nondeterministic",
      retryable: false,
    });
  });

  it("keeps the incident authoritative when terminalization is stale or unavailable", async () => {
    for (const finalizationError of [
      new OfferIssuanceWorkerError("retry_conflict"),
      new OfferIssuanceWorkerError("persistence_unavailable"),
    ]) {
      const test = harness();
      test.database.finalizeSuccess.mockRejectedValueOnce(
        new OfferIssuanceWorkerError("renderer_nondeterministic"),
      );
      test.database.finalizeFailure.mockRejectedValueOnce(finalizationError);

      await expect(test.handler([job()]))
        .rejects.toBeInstanceOf(OfferIssuanceIntegrityIncidentError);
      expect(test.database.finalizeFailure).toHaveBeenCalledOnce();
      expect(test.onIntegrityIncident).toHaveBeenCalledOnce();
    }
  });

  it("sweeps tenant IDs in bounded monotonic pages and stops on malformed data", async () => {
    vi.useFakeTimers();
    const listRecoveryWorkspaces = vi.fn()
      .mockResolvedValueOnce({
        workspaceIds: [M203B1_IDS.workspace, M203B1_IDS.otherWorkspace],
        nextAfterWorkspaceId: M203B1_IDS.otherWorkspace,
      })
      .mockResolvedValueOnce({
        workspaceIds: [M203B1_IDS.workspace],
        nextAfterWorkspaceId: null,
      });
    const requeueDue = vi.fn(async () => [] as string[]);
    const onFatal = vi.fn();
    const controller = startOfferIssuanceRecoverySweep({
      database: { listRecoveryWorkspaces, requeueDue },
      onFatal,
    }, { intervalMs: 50, workspaceLimit: 2, jobsPerWorkspaceLimit: 3 });

    await vi.advanceTimersByTimeAsync(1);
    expect(requeueDue).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(50);
    expect(onFatal).toHaveBeenCalledWith(expect.any(OfferIssuanceRecoverySweepError));
    const calls = listRecoveryWorkspaces.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(listRecoveryWorkspaces).toHaveBeenCalledTimes(calls);
    await controller.stop();
  });
});
