import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import { OFFER_CANONICALIZATION_VERSION } from "@/lib/integrations/offers/contract";
import {
  OFFER_RELEASE_APPROVAL_COMMAND_VERSION,
  OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
  OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
  OFFER_RELEASE_CANDIDATE_REQUEST_VERSION,
  OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
  hashOfferReleaseCandidateInput,
  type OfferReleaseCandidateInputV1,
} from "@/lib/integrations/offers/release-contract";
import type { ServiceCtx } from "@/lib/permissions";
import {
  OfferReleaseDispatchError,
  OfferReleaseIntegrityError,
  OfferReleaseNotFoundError,
  OfferReleasePersistenceError,
  OfferReleaseValidationError,
  approveOfferReleaseCandidate,
  getOfferReleaseCandidateStatus,
  listOfferReleaseCandidates,
  readOfferReleaseCandidateArtifact,
  requestOfferReleaseCandidate,
} from "@/modules/offers/release-service";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_WORKSPACE_ID = "12111111-1111-4111-8111-111111111111";
const ACTOR_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "33333333-3333-4333-8333-333333333333";
const OFFER_ID = "44444444-4444-4444-8444-444444444444";
const VARIANT_ID = "55555555-5555-4555-8555-555555555555";
const VARIANT_REVISION_ID = "56555555-5555-4555-8555-555555555555";
const SOURCE_DRAFT_ID = "66666666-6666-4666-8666-666666666666";
const PROFILE_ID = "77777777-7777-4777-8777-777777777777";
const PROFILE_REVISION_ID = "78777777-7777-4777-8777-777777777777";
const PROFILE_ACTIVATION_ID = "79777777-7777-4777-8777-777777777777";
const RECIPIENT_ID = "88888888-8888-4888-8888-888888888888";
const RECIPIENT_REVISION_ID = "89888888-8888-4888-8888-888888888888";
const CANDIDATE_ID = "99999999-9999-4999-8999-999999999999";
const APPROVAL_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ARTIFACT_VERSION = "abababab-abab-4bab-8bab-abababababab";
const OFFER_NUMBER = "ANG-2026-000042";
const PREPARED_AT = "2026-08-30T11:22:33.000Z";
const FINISHED_AT = "2026-08-30T11:23:33.000Z";
const APPROVED_AT = "2026-08-30T11:24:33.000Z";
const SHA = (digit: string) => digit.repeat(64);

type InsertValue = Record<string, unknown>;
type ExecuteResponse = { rows: unknown[] } | Error;

function context(
  role: ServiceCtx["role"] = "editor",
  capabilities: ServiceCtx["capabilities"] = {
    prepare_offer_documents: true,
    approve_offer_documents: true,
  },
): ServiceCtx {
  return {
    workspaceId: WORKSPACE_ID,
    actor: ACTOR_ID,
    role,
    capabilities,
    featureFlags: {},
  };
}

function transaction(responses: ExecuteResponse[]) {
  let index = 0;
  const inserts: InsertValue[] = [];
  const execute = vi.fn(async () => {
    const response = responses[index++] ?? { rows: [] };
    if (response instanceof Error) throw response;
    return response;
  });
  const tx = {
    execute,
    insert: vi.fn(() => ({
      values: async (entry: InsertValue) => {
        inserts.push(entry);
      },
    })),
  } as unknown as TenantTx;
  return { tx, execute, inserts };
}

function requestCommand(workspaceId = WORKSPACE_ID) {
  return {
    schemaVersion: OFFER_RELEASE_CANDIDATE_REQUEST_VERSION,
    workspaceId,
    offerId: OFFER_ID,
    variantId: VARIANT_ID,
    expectedVariantRevision: 7,
    sourcePdfDraftId: SOURCE_DRAFT_ID,
    documentProfileId: PROFILE_ID,
    documentProfileRevisionId: PROFILE_REVISION_ID,
    expectedDocumentProfileRevision: 3,
    recipientRevisionId: RECIPIENT_REVISION_ID,
    expectedRecipientRevision: 2,
    validThrough: "2026-09-29",
  };
}

function approvalCommand(workspaceId = WORKSPACE_ID) {
  return {
    schemaVersion: OFFER_RELEASE_APPROVAL_COMMAND_VERSION,
    workspaceId,
    offerId: OFFER_ID,
    candidateId: CANDIDATE_ID,
    expectedArtifactVersion: ARTIFACT_VERSION,
    recipientBillingReviewed: true as const,
    commercialContentReviewed: true as const,
    activeProfileReviewed: true as const,
    notIssuedStatusUnderstood: true as const,
  };
}

function candidateInput(
  taxRateBps: 0 | 1900 = 1900,
): OfferReleaseCandidateInputV1 {
  const net = 12_345;
  const tax = taxRateBps === 0 ? 0 : 2_346;
  return {
    schemaVersion: OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    templateVersion: OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
    rendererRecipeVersion: OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
    documentStatus: "not_issued",
    preparedAt: PREPARED_AT,
    documentDate: "2026-08-30",
    validThrough: "2026-09-29",
    offerNumber: OFFER_NUMBER,
    profile: { name: "Synthetisches Angebotsprofil", revision: 3 },
    sender: {
      legalName: "Beispiel Energie GmbH",
      tradingName: "Beispiel Energie",
      representedBy: "Mara Muster",
      address: {
        street: "Sonnenallee",
        houseNumber: "17",
        postalCode: "10115",
        city: "Berlin",
        country: "DE",
      },
      contactEmail: "office@release.invalid",
      contactPhone: "+49301234567",
      website: "https://release.invalid",
      registerCourt: "Amtsgericht Berlin",
      registerNumber: "HRB 12345",
      vatId: "DE123456789",
    },
    recipient: {
      displayName: "PRIVATE_RECIPIENT_SENTINEL",
      company: "PRIVATE_COMPANY_SENTINEL",
      billingAddress: {
        street: "Rechnungsweg",
        houseNumber: "8a",
        postalCode: "10999",
        city: "Berlin",
        country: "DE",
        formattedAddress: "Rechnungsweg 8a, 10999 Berlin",
      },
    },
    installationSite: { formattedAddress: "Solstrasse 8, 10115 Berlin" },
    variant: { name: "Komfort", revision: 7 },
    commercialTerms: { globalDiscountBps: 0, globalFixDiscountCents: null, customDealNetCents: null },
    sections: [{
      position: 1,
      title: "Leistungsumfang",
      discountBps: 0,
      lines: [{
        position: 1,
        title: "Montage",
        description: "Sichere Beschreibung",
        quantityMilli: 1_000,
        unit: "piece",
        positionType: "required",
        salesUnitNetCents: net,
        lineDiscountBps: 0,
        taxRateBps,
        finalNetCents: net,
        taxCents: tax,
        grossCents: net + tax,
      }],
    }],
    totals: {
      basisNetCents: net,
      basisTaxCents: tax,
      basisGrossCents: net + tax,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
    legalDocuments: {
      terms: { title: "Bedingungen", plainText: "PRIVATE_TERMS_SENTINEL" },
      withdrawalInformation: {
        title: "Widerruf",
        plainText: "PRIVATE_WITHDRAWAL_SENTINEL",
      },
      privacyNotice: {
        title: "Datenschutz",
        plainText: "PRIVATE_PRIVACY_SENTINEL",
      },
    },
  };
}

function preparedEnvelope(options: {
  state?: "queued" | "running" | "retry_wait" | "ready_for_approval" | "failed_final";
  replayed?: boolean;
  input?: OfferReleaseCandidateInputV1;
} = {}) {
  const input = options.input ?? candidateInput();
  const state = options.state ?? "queued";
  const started = state === "queued" ? null : PREPARED_AT;
  const terminal = state === "ready_for_approval" || state === "failed_final";
  return {
    result: {
      status: "prepared",
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      projectId: PROJECT_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      variantRevisionId: VARIANT_REVISION_ID,
      variantRevision: 7,
      variantSnapshotSha256: SHA("1"),
      sourcePdfDraftId: SOURCE_DRAFT_ID,
      sourcePdfDraftInputSha256: SHA("2"),
      sourcePdfDraftArtifactSha256: SHA("3"),
      profileActivationId: PROFILE_ACTIVATION_ID,
      profileId: PROFILE_ID,
      profileRevisionId: PROFILE_REVISION_ID,
      profileRevision: 3,
      profileSnapshotSha256: SHA("4"),
      recipientId: RECIPIENT_ID,
      recipientRevisionId: RECIPIENT_REVISION_ID,
      recipientRevision: 2,
      recipientSnapshotSha256: SHA("5"),
      inputVersion: OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
      canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
      templateVersion: OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
      rendererRecipeVersion: OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
      reservationKeySha256: SHA("6"),
      inputSnapshot: input,
      inputSha256: hashOfferReleaseCandidateInput(input),
      publicationStatus: "not_issued",
      hasZeroTaxTreatment: input.sections.some((section) => (
        section.lines.some((line) => line.taxRateBps === 0)
      )),
      state,
      attemptCount: state === "queued" ? 0 : 1,
      nextAttemptAt: PREPARED_AT,
      createdBy: ACTOR_ID,
      createdAt: PREPARED_AT,
      startedAt: started,
      finishedAt: terminal ? FINISHED_AT : null,
      errorCode: state === "retry_wait" || state === "failed_final"
        ? "browser_unavailable"
        : null,
      replayed: options.replayed ?? false,
    },
  };
}

function approvalEnvelope(input = candidateInput(), replayed = false) {
  return {
    result: {
      status: "approved",
      workspaceId: WORKSPACE_ID,
      candidateId: CANDIDATE_ID,
      approvalId: APPROVAL_ID,
      projectId: PROJECT_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      variantRevisionId: VARIANT_REVISION_ID,
      variantRevision: 7,
      variantSnapshotSha256: SHA("1"),
      sourcePdfDraftId: SOURCE_DRAFT_ID,
      sourcePdfDraftInputSha256: SHA("2"),
      sourcePdfDraftArtifactSha256: SHA("3"),
      profileActivationId: PROFILE_ACTIVATION_ID,
      profileId: PROFILE_ID,
      profileRevisionId: PROFILE_REVISION_ID,
      profileRevision: 3,
      profileSnapshotSha256: SHA("4"),
      recipientId: RECIPIENT_ID,
      recipientRevisionId: RECIPIENT_REVISION_ID,
      recipientRevision: 2,
      recipientSnapshotSha256: SHA("5"),
      inputVersion: OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
      canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
      templateVersion: OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
      rendererRecipeVersion: OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
      inputSnapshot: input,
      inputSha256: hashOfferReleaseCandidateInput(input),
      publicationStatus: "not_issued",
      hasZeroTaxTreatment: false,
      candidateState: "ready_for_approval",
      candidateCreatedAt: PREPARED_AT,
      candidateFinishedAt: FINISHED_AT,
      artifactMimeType: "application/pdf",
      artifactSha256: SHA("7"),
      artifactSizeBytes: 512,
      artifactVersion: ARTIFACT_VERSION,
      approvalVersion: "offer-release-candidate-approval.v1",
      approvalCommandVersion: OFFER_RELEASE_APPROVAL_COMMAND_VERSION,
      approvalCommand: approvalCommand(),
      approvedBy: ACTOR_ID,
      approvedAt: APPROVED_AT,
      derivedState: "approved_not_issued",
      replayed,
    },
  };
}

function statusRow(options: {
  state?: "queued" | "running" | "retry_wait" | "ready_for_approval" | "failed_final";
  approved?: boolean;
  attemptCount?: number;
  approvalArtifactVersion?: string | null;
  nextAttemptAt?: string;
} = {}) {
  const state = options.state ?? "ready_for_approval";
  const approved = options.approved ?? false;
  const attemptCount = options.attemptCount ?? (state === "queued" ? 0 : 1);
  return {
    workspace_id: WORKSPACE_ID,
    id: CANDIDATE_ID,
    offer_id: OFFER_ID,
    variant_id: VARIANT_ID,
    variant_revision: 7,
    profile_revision: 3,
    recipient_revision: 2,
    publication_status: "not_issued",
    has_zero_tax_treatment: false,
    state,
    attempt_count: attemptCount,
    next_attempt_at: options.nextAttemptAt ?? PREPARED_AT,
    created_at: PREPARED_AT,
    started_at: state === "queued" && attemptCount === 0 ? null : PREPARED_AT,
    finished_at: state === "ready_for_approval" || state === "failed_final"
      ? FINISHED_AT
      : null,
    error_code: state === "retry_wait" || state === "failed_final"
      ? "browser_unavailable"
      : null,
    approval_id: approved ? APPROVAL_ID : null,
    approval_version: approved ? "offer-release-candidate-approval.v1" : null,
    approval_command_version: approved ? OFFER_RELEASE_APPROVAL_COMMAND_VERSION : null,
    approved_at: approved ? APPROVED_AT : null,
    approval_artifact_version: options.approvalArtifactVersion ?? null,
  };
}

describe("M2-03a offer release candidate app service", () => {
  it("authorizes every boundary before parsing or SQL and blocks external-only actors", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const tx = { execute } as unknown as TenantTx;

    await expect(requestOfferReleaseCandidate(tx, context("viewer"), {}))
      .rejects.toMatchObject({ name: "PermissionDeniedError", action: "offer.release.prepare" });
    await expect(approveOfferReleaseCandidate(
      tx,
      context("editor", { prepare_offer_documents: true }),
      {},
    )).rejects.toMatchObject({ name: "PermissionDeniedError", action: "offer.release.approve" });
    await expect(listOfferReleaseCandidates(
      tx,
      context("viewer", { external_only: true }),
      {},
    )).rejects.toMatchObject({ name: "PermissionDeniedError", action: "project.read" });
    await expect(getOfferReleaseCandidateStatus(
      tx,
      context("viewer", { external_only: true }),
      {},
    )).rejects.toMatchObject({ name: "PermissionDeniedError" });
    await expect(readOfferReleaseCandidateArtifact(
      tx,
      context("viewer", { external_only: true }),
      {},
    )).rejects.toMatchObject({ name: "PermissionDeniedError" });

    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unknown browser fields, false acknowledgements and cross-workspace keys", async () => {
    const execute = vi.fn(async () => ({ rows: [] }));
    const tx = { execute } as unknown as TenantTx;

    await expect(requestOfferReleaseCandidate(tx, context(), {
      ...requestCommand(),
      inputSnapshot: candidateInput(),
    })).rejects.toBeInstanceOf(OfferReleaseValidationError);
    await expect(approveOfferReleaseCandidate(tx, context(), {
      ...approvalCommand(),
      commercialContentReviewed: false,
    })).rejects.toBeInstanceOf(OfferReleaseValidationError);
    await expect(requestOfferReleaseCandidate(
      tx,
      context(),
      requestCommand(OTHER_WORKSPACE_ID),
    )).rejects.toBeInstanceOf(OfferReleaseNotFoundError);
    await expect(getOfferReleaseCandidateStatus(tx, context("viewer"), {
      workspaceId: OTHER_WORKSPACE_ID,
      offerId: OFFER_ID,
      candidateId: CANDIDATE_ID,
    })).rejects.toBeInstanceOf(OfferReleaseNotFoundError);

    expect(execute).not.toHaveBeenCalled();
  });

  it("validates the DB-sealed input, dispatches ID-only and emits redacted success metadata", async () => {
    const harness = transaction([
      { rows: [preparedEnvelope()] },
      { rows: [{
        dispatch_signature: "pgboss.enqueue_offer_release_candidate(uuid,uuid)",
        current_role: "app_runtime",
        session_role: "app_runtime",
        database_name: "energie_saas",
      }] },
      { rows: [{ enqueue_offer_release_candidate: "boss-id" }] },
    ]);

    const result = await requestOfferReleaseCandidate(
      harness.tx,
      context(),
      requestCommand(),
    );

    expect(result).toEqual({
      candidateId: CANDIDATE_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      variantRevision: 7,
      profileRevision: 3,
      recipientRevision: 2,
      state: "queued",
      publicationStatus: "not_issued",
      replayed: false,
    });
    expect(harness.execute).toHaveBeenCalledTimes(3);
    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("prepare_offer_release_candidate");
    expect(sqlArguments).toContain("pgboss.enqueue_offer_release_candidate");
    expect(sqlArguments).not.toContain("PRIVATE_");
    expect(sqlArguments).not.toContain("inputSnapshot");
    expect(sqlArguments).not.toContain("artifactSha256");

    expect(harness.inserts).toHaveLength(2);
    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).toContain(CANDIDATE_ID);
    expect(metadata).toContain("queued");
    expect(metadata).not.toContain("PRIVATE_");
    expect(metadata).not.toContain(SHA("1"));
    expect(metadata).not.toContain("12345");
  });

  it("repairs dispatch for nonterminal replays and leaves terminal replays undispatched", async () => {
    for (const state of ["queued", "running", "retry_wait"] as const) {
      const harness = transaction([
        { rows: [preparedEnvelope({ state, replayed: true })] },
        { rows: [{
          dispatch_signature: "pgboss.enqueue_offer_release_candidate(uuid,uuid)",
          current_role: "app_runtime",
          session_role: "app_runtime",
          database_name: "energie_saas",
        }] },
        { rows: [{}] },
      ]);
      await expect(requestOfferReleaseCandidate(
        harness.tx,
        context(),
        requestCommand(),
      )).resolves.toMatchObject({ candidateId: CANDIDATE_ID, state, replayed: true });
      expect(JSON.stringify(harness.execute.mock.calls)).toContain(
        "pgboss.enqueue_offer_release_candidate",
      );
    }

    for (const state of ["ready_for_approval", "failed_final"] as const) {
      const harness = transaction([{
        rows: [preparedEnvelope({ state, replayed: true })],
      }]);
      await expect(requestOfferReleaseCandidate(
        harness.tx,
        context(),
        requestCommand(),
      )).resolves.toMatchObject({ state, replayed: true });
      expect(JSON.stringify(harness.execute.mock.calls)).not.toContain(
        "pgboss.enqueue_offer_release_candidate",
      );
    }
  });

  it("fails closed for conflicts, malformed envelopes, persistence and unavailable dispatch", async () => {
    const conflict = transaction([{ rows: [{ result: {
      status: "conflict",
      code: "variant_revision_changed",
      currentRevision: 8,
    } }] }]);
    await expect(requestOfferReleaseCandidate(
      conflict.tx,
      context(),
      requestCommand(),
    )).rejects.toMatchObject({
      name: "OfferReleaseConflictError",
      code: "variant_revision_changed",
      currentRevision: 8,
    });

    const missing = transaction([{ rows: [{ result: { status: "not_found" } }] }]);
    await expect(requestOfferReleaseCandidate(
      missing.tx,
      context(),
      requestCommand(),
    )).rejects.toBeInstanceOf(OfferReleaseNotFoundError);

    const malformed = transaction([{ rows: [{ result: {
      ...preparedEnvelope().result,
      inputSha256: SHA("0"),
    } }] }]);
    await expect(requestOfferReleaseCandidate(
      malformed.tx,
      context(),
      requestCommand(),
    )).rejects.toBeInstanceOf(OfferReleaseIntegrityError);

    const persistence = transaction([new Error("PRIVATE_DATABASE_SENTINEL")]);
    await expect(requestOfferReleaseCandidate(
      persistence.tx,
      context(),
      requestCommand(),
    )).rejects.toBeInstanceOf(OfferReleasePersistenceError);

    const dispatch = transaction([
      { rows: [preparedEnvelope()] },
      { rows: [{
        dispatch_signature: null,
        current_role: "app_runtime",
        session_role: "app_runtime",
        database_name: "energie_saas",
      }] },
    ]);
    await expect(requestOfferReleaseCandidate(
      dispatch.tx,
      context(),
      requestCommand(),
    )).rejects.toBeInstanceOf(OfferReleaseDispatchError);
    expect(dispatch.inserts).toEqual([]);
  });

  it("approves only a strict byte-bound envelope and returns approved_not_issued", async () => {
    const harness = transaction([{ rows: [approvalEnvelope()] }]);

    const result = await approveOfferReleaseCandidate(
      harness.tx,
      context(),
      approvalCommand(),
    );

    expect(result).toEqual({
      approvalId: APPROVAL_ID,
      candidateId: CANDIDATE_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      variantRevision: 7,
      profileRevision: 3,
      recipientRevision: 2,
      state: "approved_not_issued",
      publicationStatus: "not_issued",
      approvedAt: APPROVED_AT,
      replayed: false,
    });
    const sqlArguments = JSON.stringify(harness.execute.mock.calls);
    expect(sqlArguments).toContain("approve_offer_release_candidate");
    expect(sqlArguments).toContain(ARTIFACT_VERSION);
    expect(sqlArguments).not.toContain("PRIVATE_");
    expect(sqlArguments).not.toContain(SHA("7"));
    expect(harness.inserts).toHaveLength(2);
    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).toContain("approved_not_issued");
    expect(metadata).not.toContain("PRIVATE_");
    expect(metadata).not.toContain(SHA("7"));
  });

  it("records approval replay as replay without presenting the replay actor as a new approver", async () => {
    const harness = transaction([{
      rows: [approvalEnvelope(candidateInput(), true)],
    }]);

    await expect(approveOfferReleaseCandidate(
      harness.tx,
      context(),
      approvalCommand(),
    )).resolves.toMatchObject({
      approvalId: APPROVAL_ID,
      replayed: true,
    });

    const metadata = JSON.stringify(harness.inserts);
    expect(metadata).toContain("offer.release_candidate_approval_replayed");
    expect(metadata).toContain('"replayed":true');
    expect(metadata).not.toContain("offer.release_candidate_approved_not_issued");
  });

  it("enforces conditional zero-tax review and rejects stale or drifted approval envelopes", async () => {
    const zeroTaxInput = candidateInput(0);
    const missingAck = transaction([{ rows: [approvalEnvelope(zeroTaxInput)] }]);
    await expect(approveOfferReleaseCandidate(
      missingAck.tx,
      context(),
      approvalCommand(),
    )).rejects.toBeInstanceOf(OfferReleaseIntegrityError);

    const command = { ...approvalCommand(), zeroTaxTreatmentReviewed: true as const };
    const valid = approvalEnvelope(zeroTaxInput);
    valid.result.hasZeroTaxTreatment = true;
    valid.result.approvalCommand = command;
    const approved = transaction([{ rows: [valid] }]);
    await expect(approveOfferReleaseCandidate(approved.tx, context(), command))
      .resolves.toMatchObject({ state: "approved_not_issued" });

    for (const result of [
      { ...approvalEnvelope().result, artifactSha256: "not-a-hash" },
      { ...approvalEnvelope().result, candidateState: "running" },
      { ...approvalEnvelope().result, derivedState: "issued" },
      { ...approvalEnvelope().result, approvedAt: "not-a-date" },
      { ...approvalEnvelope().result, offerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
      {
        ...approvalEnvelope().result,
        inputSnapshot: { ...candidateInput(), validThrough: "2026-09-28" },
      },
    ]) {
      const harness = transaction([{ rows: [{ result }] }]);
      await expect(approveOfferReleaseCandidate(
        harness.tx,
        context(),
        approvalCommand(),
      )).rejects.toBeInstanceOf(OfferReleaseIntegrityError);
      expect(harness.inserts).toEqual([]);
    }
  });

  it("derives list and detail status from an all-or-none approval join without leaking internals", async () => {
    const approvedRow = statusRow({ approved: true });
    const listHarness = transaction([
      { rows: [{ id: OFFER_ID }] },
      { rows: [approvedRow] },
    ]);
    const listed = await listOfferReleaseCandidates(
      listHarness.tx,
      context("viewer", {}),
      { workspaceId: WORKSPACE_ID, offerId: OFFER_ID },
    );
    const detailHarness = transaction([{ rows: [approvedRow] }]);
    const detail = await getOfferReleaseCandidateStatus(
      detailHarness.tx,
      context("viewer", {}),
      { workspaceId: WORKSPACE_ID, offerId: OFFER_ID, candidateId: CANDIDATE_ID },
    );

    expect(listed).toEqual([detail]);
    expect(detail).toEqual({
      candidateId: CANDIDATE_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      variantRevision: 7,
      profileRevision: 3,
      recipientRevision: 2,
      state: "approved_not_issued",
      renderState: "ready_for_approval",
      publicationStatus: "not_issued",
      requiresZeroTaxReview: false,
      attemptCount: 1,
      nextAttemptAt: PREPARED_AT,
      createdAt: PREPARED_AT,
      startedAt: PREPARED_AT,
      finishedAt: FINISHED_AT,
      errorCode: null,
      approval: { approvalId: APPROVAL_ID, approvedAt: APPROVED_AT },
      canDownload: true,
    });
    expect(JSON.stringify(detail)).not.toContain("PRIVATE_");
    expect(JSON.stringify(detail)).not.toContain(SHA("7"));
    expect(JSON.stringify(detail)).not.toContain(ACTOR_ID);
    expect(detail).not.toHaveProperty("approvalArtifactVersion");

    const approverReadyHarness = transaction([{ rows: [statusRow({
      approvalArtifactVersion: ARTIFACT_VERSION,
    })] }]);
    await expect(getOfferReleaseCandidateStatus(
      approverReadyHarness.tx,
      context(),
      { workspaceId: WORKSPACE_ID, offerId: OFFER_ID, candidateId: CANDIDATE_ID },
    )).resolves.toMatchObject({ approvalArtifactVersion: ARTIFACT_VERSION });

    const pgTimestampHarness = transaction([{ rows: [statusRow({
      approvalArtifactVersion: ARTIFACT_VERSION,
      nextAttemptAt: "2026-08-30 13:22:33+02",
    })] }]);
    await expect(getOfferReleaseCandidateStatus(
      pgTimestampHarness.tx,
      context(),
      { workspaceId: WORKSPACE_ID, offerId: OFFER_ID, candidateId: CANDIDATE_ID },
    )).resolves.toMatchObject({ nextAttemptAt: PREPARED_AT });

    const queuedHarness = transaction([{ rows: [statusRow({
      state: "queued",
      attemptCount: 2,
    })] }]);
    await expect(getOfferReleaseCandidateStatus(
      queuedHarness.tx,
      context(),
      { workspaceId: WORKSPACE_ID, offerId: OFFER_ID, candidateId: CANDIDATE_ID },
    )).resolves.toMatchObject({
      state: "queued",
      attemptCount: 2,
      startedAt: PREPARED_AT,
      canDownload: false,
    });

    const exhaustedQueued = transaction([{ rows: [statusRow({
      state: "queued",
      attemptCount: 3,
    })] }]);
    await expect(getOfferReleaseCandidateStatus(
      exhaustedQueued.tx,
      context(),
      { workspaceId: WORKSPACE_ID, offerId: OFFER_ID, candidateId: CANDIDATE_ID },
    )).rejects.toBeInstanceOf(OfferReleaseIntegrityError);

    const partialJoin = transaction([{ rows: [{
      ...statusRow(),
      approval_id: APPROVAL_ID,
    }] }]);
    await expect(getOfferReleaseCandidateStatus(
      partialJoin.tx,
      context("viewer", {}),
      { workspaceId: WORKSPACE_ID, offerId: OFFER_ID, candidateId: CANDIDATE_ID },
    )).rejects.toBeInstanceOf(OfferReleaseIntegrityError);
  });

  it("keeps an existing offer with no candidates distinct from a hidden offer", async () => {
    const existing = transaction([
      { rows: [{ id: OFFER_ID }] },
      { rows: [] },
    ]);
    await expect(listOfferReleaseCandidates(
      existing.tx,
      context("viewer", {}),
      { workspaceId: WORKSPACE_ID, offerId: OFFER_ID },
    )).resolves.toEqual([]);

    const hidden = transaction([{ rows: [] }]);
    await expect(listOfferReleaseCandidates(
      hidden.tx,
      context("viewer", {}),
      { workspaceId: WORKSPACE_ID, offerId: OFFER_ID },
    )).rejects.toBeInstanceOf(OfferReleaseNotFoundError);
  });

  it("allows unapproved bytes only to approvers and approved bytes to internal readers", async () => {
    const bytes = Buffer.alloc(512, 0x61);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifact = {
      ...statusRow(),
      offer_number: OFFER_NUMBER,
      artifact_mime_type: "application/pdf",
      artifact_sha256_hex: sha256,
      artifact_size_bytes: bytes.length,
      artifact_bytes: bytes,
    };

    const viewer = transaction([{ rows: [statusRow()] }]);
    await expect(readOfferReleaseCandidateArtifact(
      viewer.tx,
      context("viewer", {}),
      { workspaceId: WORKSPACE_ID, offerId: OFFER_ID, candidateId: CANDIDATE_ID },
    )).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "offer.release.approve",
    });

    const approver = transaction([
      { rows: [statusRow({ approvalArtifactVersion: ARTIFACT_VERSION })] },
      { rows: [artifact] },
    ]);
    const unapproved = await readOfferReleaseCandidateArtifact(
      approver.tx,
      context(),
      { workspaceId: WORKSPACE_ID, offerId: OFFER_ID, candidateId: CANDIDATE_ID },
    );
    expect(unapproved).toMatchObject({
      candidateId: CANDIDATE_ID,
      filename: "ANG-2026-000042-Freigabekandidat-R7.pdf",
      mimeType: "application/pdf",
      sha256,
      sizeBytes: 512,
      state: "ready_for_approval",
      publicationStatus: "not_issued",
    });
    expect(unapproved.bytes).not.toBe(bytes);
    expect(unapproved.bytes.equals(bytes)).toBe(true);

    const approvedArtifact = { ...artifact, ...statusRow({ approved: true }) };
    const internalViewer = transaction([
      { rows: [statusRow({ approved: true })] },
      { rows: [approvedArtifact] },
    ]);
    await expect(readOfferReleaseCandidateArtifact(
      internalViewer.tx,
      context("viewer", {}),
      { workspaceId: WORKSPACE_ID, offerId: OFFER_ID, candidateId: CANDIDATE_ID },
    )).resolves.toMatchObject({ state: "approved_not_issued" });
  });

  it("rehashes every artifact read and rejects MIME, size, byte and approval-state drift", async () => {
    const bytes = Buffer.alloc(512, 0x61);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const baseline = {
      ...statusRow(),
      offer_number: OFFER_NUMBER,
      artifact_mime_type: "application/pdf",
      artifact_sha256_hex: sha256,
      artifact_size_bytes: bytes.length,
      artifact_bytes: bytes,
    };

    for (const row of [
      { ...baseline, artifact_mime_type: "text/html" },
      { ...baseline, artifact_size_bytes: 99 },
      { ...baseline, artifact_size_bytes: 513 },
      { ...baseline, artifact_bytes: new Uint8Array(bytes) },
      { ...baseline, artifact_sha256_hex: SHA("0") },
      { ...baseline, state: "running", finished_at: null },
      { ...baseline, approval_id: APPROVAL_ID },
    ]) {
      const harness = transaction([
        { rows: [statusRow({ approvalArtifactVersion: ARTIFACT_VERSION })] },
        { rows: [row] },
      ]);
      await expect(readOfferReleaseCandidateArtifact(
        harness.tx,
        context(),
        { workspaceId: WORKSPACE_ID, offerId: OFFER_ID, candidateId: CANDIDATE_ID },
      )).rejects.toBeInstanceOf(OfferReleaseIntegrityError);
    }
  });
});
