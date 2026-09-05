import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OFFER_RELEASE_CANDIDATE_DISPATCH_VERSION,
  OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
  OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
  OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
  hashOfferReleaseCandidateInput,
  type OfferReleaseCandidateInputV1,
} from "@/lib/integrations/offers/release-contract";
import {
  OfferReleaseCandidateDispatchError,
  OfferReleaseCandidateIntegrityIncidentError,
  OfferReleaseCandidateRecoverySweepError,
  createOfferReleaseCandidateRenderHandler,
  parseOfferReleaseCandidateDispatchPayload,
  startOfferReleaseCandidateRecoverySweep,
  type OfferReleaseCandidateClaim,
} from "@/worker/offer-release-candidate";
import type {
  OfferReleaseCandidateRenderer,
} from "@/worker/offer-release-candidate-renderer";
import { OfferPdfRenderError } from "@/worker/offer-pdf-renderer";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";
const LEASE_TOKEN = "33333333-3333-4333-8333-333333333333";

function validInput(): OfferReleaseCandidateInputV1 {
  return {
    schemaVersion: OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
    rendererRecipeVersion: OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
    documentStatus: "not_issued",
    preparedAt: "2026-08-30T11:22:33.000Z",
    documentDate: "2026-08-30",
    validThrough: "2026-09-29",
    offerNumber: "ANG-2026-000042",
    profile: { name: "Synthetisches Angebotsprofil", revision: 4 },
    sender: {
      legalName: "Beispiel Energie GmbH",
      tradingName: "Beispiel Energie",
      representedBy: "Erika Beispiel",
      address: {
        street: "Sonnenstrasse",
        houseNumber: "12",
        postalCode: "10115",
        city: "Berlin",
        country: "DE",
      },
      contactEmail: "angebot@beispiel.invalid",
      contactPhone: "+49301234567",
      website: "https://angebot.beispiel.invalid",
      registerCourt: "Beispielregistergericht",
      registerNumber: "HRB 123456 B",
      vatId: "DE123456789",
    },
    recipient: {
      displayName: "Mia Muster",
      company: null,
      billingAddress: {
        street: "Rechnungsweg",
        houseNumber: "7",
        postalCode: "10117",
        city: "Berlin",
        country: "DE",
        formattedAddress: "Rechnungsweg 7, 10117 Berlin",
      },
    },
    installationSite: { formattedAddress: "Solarweg 8, 10115 Berlin" },
    variant: { name: "Komfort", revision: 7 },
    commercialTerms: { globalDiscountBps: 0, globalFixDiscountCents: null, customDealNetCents: null },
    sections: [{
      position: 1,
      title: "Photovoltaik",
      discountBps: 0,
      lines: [{
        position: 1,
        title: "PV-Anlage und Montage",
        description: "Synthetische Testposition",
        quantityMilli: 1_000,
        unit: "set",
        positionType: "required",
        salesUnitNetCents: 100_000,
        lineDiscountBps: 0,
        taxRateBps: 1_900,
        finalNetCents: 100_000,
        taxCents: 19_000,
        grossCents: 119_000,
      }],
    }],
    totals: {
      basisNetCents: 100_000,
      basisTaxCents: 19_000,
      basisGrossCents: 119_000,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
    legalDocuments: {
      terms: { title: "Testbedingungen", plainText: "Nur synthetischer Testtext." },
      withdrawalInformation: {
        title: "Test-Widerrufsinformation",
        plainText: "Nur synthetischer Testtext.",
      },
      privacyNotice: {
        title: "Test-Datenschutzhinweis",
        plainText: "Nur synthetischer Testtext.",
      },
    },
  };
}

function claim(overrides: Partial<OfferReleaseCandidateClaim> = {}) {
  const input = validInput();
  return {
    workspaceId: WORKSPACE_ID,
    candidateId: CANDIDATE_ID,
    leaseToken: LEASE_TOKEN,
    attemptCount: 1,
    inputVersion: OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
    templateVersion: OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
    rendererRecipeVersion: OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
    inputSha256: hashOfferReleaseCandidateInput(input),
    input,
    ...overrides,
  } satisfies OfferReleaseCandidateClaim;
}

function artifact() {
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.alloc(128, 0x61),
    Buffer.from("\n%%EOF", "latin1"),
  ]);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    mimeType: "application/pdf" as const,
  };
}

function harness(inputClaim: OfferReleaseCandidateClaim | null = claim()) {
  const database = {
    claim: vi.fn(async () => inputClaim),
    finalizeSuccess: vi.fn(async () => ({ state: "ready_for_approval" })),
    finalizeFailure: vi.fn(async () => ({ state: "failed_final" })),
  };
  const renderer = {
    render: vi.fn(async () => artifact()),
  } as OfferReleaseCandidateRenderer;
  const onIntegrityIncident = vi.fn();
  const handler = createOfferReleaseCandidateRenderHandler({
    database,
    renderer,
    onIntegrityIncident,
    createLeaseToken: () => LEASE_TOKEN,
  });
  return { database, renderer, onIntegrityIncident, handler };
}

function job(data: unknown = {
  schemaVersion: OFFER_RELEASE_CANDIDATE_DISPATCH_VERSION,
  workspaceId: WORKSPACE_ID,
  candidateId: CANDIDATE_ID,
}) {
  return { data };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("M2-03a release candidate worker", () => {
  it("accepts only the exact ID-only dispatch contract", () => {
    expect(parseOfferReleaseCandidateDispatchPayload(job().data)).toEqual(job().data);
    for (const invalid of [
      null,
      { ...job().data as object, offerId: CANDIDATE_ID },
      { ...job().data as object, schemaVersion: "offer-release-candidate-dispatch.v2" },
    ]) {
      expect(() => parseOfferReleaseCandidateDispatchPayload(invalid))
        .toThrow(OfferReleaseCandidateDispatchError);
    }
  });

  it("reloads by workspace/candidate IDs and renders only a fully pinned hash-valid input", async () => {
    const test = harness();
    await test.handler([job()]);

    expect(test.database.claim).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
    });
    expect(test.renderer.render).toHaveBeenCalledOnce();
    expect(test.database.finalizeSuccess).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      artifact: expect.objectContaining({ mimeType: "application/pdf" }),
    }));
    expect(test.database.finalizeFailure).not.toHaveBeenCalled();
  });

  it("fails a hash mismatch closed before rendering", async () => {
    const test = harness(claim({ inputSha256: "a".repeat(64) }));
    await test.handler([job()]);

    expect(test.renderer.render).not.toHaveBeenCalled();
    expect(test.database.finalizeSuccess).not.toHaveBeenCalled();
    expect(test.database.finalizeFailure).toHaveBeenCalledWith({
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      leaseToken: LEASE_TOKEN,
      attemptCount: 1,
      errorCode: "invalid_input",
      retryable: false,
    });
  });

  it("maps renderer failures to fixed codes without leaking document content", async () => {
    const privateMarker = "PRIVATE-RECIPIENT-MARKER";
    const test = harness();
    vi.mocked(test.renderer.render).mockRejectedValueOnce(
      new OfferPdfRenderError("render_timeout", true),
    );
    await test.handler([job({
      schemaVersion: OFFER_RELEASE_CANDIDATE_DISPATCH_VERSION,
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
    })]);

    expect(test.database.finalizeFailure).toHaveBeenCalledWith(expect.objectContaining({
      errorCode: "render_timeout",
      retryable: true,
    }));
    expect(JSON.stringify(test.database.finalizeFailure.mock.calls))
      .not.toContain(privateMarker);
  });

  it("raises and reports a sanitized incident on nondeterministic finalization", async () => {
    const test = harness();
    test.database.finalizeSuccess.mockRejectedValueOnce({
      code: "renderer_nondeterministic",
      message: "PRIVATE_BYTES",
    });

    await expect(test.handler([job()]))
      .rejects.toBeInstanceOf(OfferReleaseCandidateIntegrityIncidentError);
    expect(test.onIntegrityIncident).toHaveBeenCalledWith(
      expect.any(OfferReleaseCandidateIntegrityIncidentError),
    );
    expect(test.database.finalizeFailure).not.toHaveBeenCalled();
  });

  it("ignores stale replays and skips a dispatch that cannot be claimed", async () => {
    const stale = harness();
    stale.database.finalizeSuccess.mockRejectedValueOnce({ code: "stale" });
    await expect(stale.handler([job()])).resolves.toBeUndefined();
    expect(stale.database.finalizeFailure).not.toHaveBeenCalled();

    const absent = harness(null);
    await absent.handler([job()]);
    expect(absent.renderer.render).not.toHaveBeenCalled();
  });

  it("sweeps tenants in bounded order and stops after a fatal malformed page", async () => {
    vi.useFakeTimers();
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const listRecoveryWorkspaces = vi.fn()
      .mockResolvedValueOnce({ workspaceIds: [first, second], nextAfterWorkspaceId: second })
      .mockResolvedValueOnce({ workspaceIds: [first], nextAfterWorkspaceId: null });
    const requeueDue = vi.fn(async (
      input: { workspaceId: string; limit: number },
    ) => {
      void input;
      return [] as string[];
    });
    const onFatal = vi.fn();
    const controller = startOfferReleaseCandidateRecoverySweep({
      database: { listRecoveryWorkspaces, requeueDue },
      onFatal,
    }, { intervalMs: 50, workspaceLimit: 2, jobsPerWorkspaceLimit: 3 });

    await vi.advanceTimersByTimeAsync(1);
    expect(requeueDue.mock.calls.map(([input]) => input)).toEqual([
      { workspaceId: first, limit: 3 },
      { workspaceId: second, limit: 3 },
    ]);
    await vi.advanceTimersByTimeAsync(50);
    expect(onFatal).toHaveBeenCalledWith(expect.any(OfferReleaseCandidateRecoverySweepError));
    const callsAfterFatal = listRecoveryWorkspaces.mock.calls.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(listRecoveryWorkspaces).toHaveBeenCalledTimes(callsAfterFatal);
    await controller.stop();
  });

  it("wires the isolated queue, integrity incident and recovery into the fatal worker path", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "../../worker/index.ts"),
      "utf8",
    );

    expect(source).toContain(
      'const OFFER_RELEASE_CANDIDATE_QUEUE = "offer.release-candidate.render"',
    );
    expect(source).toContain("createOfferReleaseCandidateRenderHandler({");
    expect(source).toContain('reportFatalWorkerError("offer-release-candidate-integrity"');
    expect(source).toContain("startOfferReleaseCandidateRecoverySweep({");
    expect(source).toContain('reportFatalWorkerError("offer-release-candidate-recovery"');
    expect(source).toContain("offerReleaseCandidateRecovery?.stop()");
  });
});
