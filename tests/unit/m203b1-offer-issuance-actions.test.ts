import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {
    constructor() { super("private authentication sentinel"); }
  }
  class PermissionDeniedError extends Error {
    constructor() { super("private permission sentinel"); }
  }
  class OfferIssuanceValidationError extends Error {
    constructor(public readonly paths: string[] = []) { super("private validation sentinel"); }
  }
  class OfferIssuanceNotFoundError extends Error {
    constructor() { super("private not-found sentinel"); }
  }
  class OfferIssuanceConflictError extends Error {
    constructor(public readonly code?: string) { super("private conflict sentinel"); }
  }
  class OfferIssuanceIntegrityError extends Error {
    constructor() { super("private integrity sentinel"); }
  }
  class OfferIssuancePersistenceError extends Error {
    constructor() { super("private persistence sentinel"); }
  }
  class OfferIssuanceDispatchError extends Error {
    constructor() { super("private dispatch sentinel"); }
  }
  class OfferRateLimitError extends Error {
    constructor(public readonly retryAfter: string) { super("private rate limit sentinel"); }
  }
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    OfferIssuanceValidationError,
    OfferIssuanceNotFoundError,
    OfferIssuanceConflictError,
    OfferIssuanceIntegrityError,
    OfferIssuancePersistenceError,
    OfferIssuanceDispatchError,
    OfferRateLimitError,
    authorizedOfferMutationAction: vi.fn(),
    requestOfferIssuance: vi.fn(),
    approveOfferIssuance: vi.fn(),
    withdrawOfferIssuance: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: deps.revalidatePath }));
vi.mock("@/lib/action", () => ({
  authorizedOfferMutationAction: deps.authorizedOfferMutationAction,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({ PermissionDeniedError: deps.PermissionDeniedError }));
vi.mock("@/lib/integrations/offers/admission", () => ({
  OfferRateLimitError: deps.OfferRateLimitError,
}));
vi.mock("@/modules/offers", () => ({
  requestOfferIssuance: deps.requestOfferIssuance,
  approveOfferIssuance: deps.approveOfferIssuance,
  withdrawOfferIssuance: deps.withdrawOfferIssuance,
  OfferIssuanceValidationError: deps.OfferIssuanceValidationError,
  OfferIssuanceNotFoundError: deps.OfferIssuanceNotFoundError,
  OfferIssuanceConflictError: deps.OfferIssuanceConflictError,
  OfferIssuanceIntegrityError: deps.OfferIssuanceIntegrityError,
  OfferIssuancePersistenceError: deps.OfferIssuancePersistenceError,
  OfferIssuanceDispatchError: deps.OfferIssuanceDispatchError,
}));

import {
  approveOfferIssuanceAction,
  requestOfferIssuanceAction,
  withdrawOfferIssuanceAction,
} from "@/app/w/[workspaceId]/angebote/issuance-actions";
import { OFFER_ISSUANCE_ACTION_INITIAL_STATE } from "@/app/w/[workspaceId]/angebote/issuance-action-state";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const OFFER_ID = "20000000-0000-4000-8000-000000000002";
const CANDIDATE_ID = "30000000-0000-4000-8000-000000000003";
const ISSUANCE_ID = "40000000-0000-4000-8000-000000000004";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "50000000-0000-4000-8000-000000000005" };

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

function requestForm(): FormData {
  return form({
    schemaVersion: "offer-issuance-request.v1",
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    candidateId: CANDIDATE_ID,
  });
}

function approvalForm(): FormData {
  return form({
    schemaVersion: "offer-issuance-approval-command.v1",
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    issuanceId: ISSUANCE_ID,
    recipientAndScopeReviewed: "true",
    commercialTotalsReviewed: "true",
    legalProfileReviewed: "true",
    finalPdfForArchiveUnderstood: "true",
    zeroTaxTreatmentReviewed: "true",
  });
}

function withdrawalForm(): FormData {
  return form({
    schemaVersion: "offer-issuance-withdrawal-command.v1",
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    issuanceId: ISSUANCE_ID,
    withdrawalReasonCode: "content_error",
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedOfferMutationAction.mockImplementation(async (
    _workspaceId: string,
    _actions: readonly string[],
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.requestOfferIssuance.mockResolvedValue({
    issuanceId: ISSUANCE_ID,
    offerId: OFFER_ID,
    state: "queued",
    approvalCount: 0,
    replayed: false,
  });
  deps.approveOfferIssuance.mockResolvedValue({
    issuanceId: ISSUANCE_ID,
    offerId: OFFER_ID,
    approvalCount: 1,
    state: "approval_pending",
    replayed: false,
  });
  deps.withdrawOfferIssuance.mockResolvedValue({
    issuanceId: ISSUANCE_ID,
    offerId: OFFER_ID,
    withdrawnAt: "2026-08-30T12:00:00.000Z",
    state: "withdrawn_before_archive",
    approvalCount: 1,
    replayed: false,
  });
});

describe("M2-03b1 Ausstellungsfassungs-Actions", () => {
  it("fordert nur per IDs und Prepare-Recht eine neue finale Fassung an", async () => {
    await expect(requestOfferIssuanceAction(
      OFFER_ISSUANCE_ACTION_INITIAL_STATE,
      requestForm(),
    )).resolves.toEqual({
      status: "issuance_requested",
      issuanceId: ISSUANCE_ID,
      state: "queued",
      approvalCount: 0,
      replayed: false,
    });
    expect(deps.authorizedOfferMutationAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      ["offer.issue.prepare"],
      "offer_issuance",
      expect.any(Function),
    );
    expect(deps.requestOfferIssuance).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "offer-issuance-request.v1",
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      candidateId: CANDIDATE_ID,
    });
  });

  it("bindet die vier festen Bytefreigaben und die bedingte Steuerpruefung", async () => {
    await expect(approveOfferIssuanceAction(
      OFFER_ISSUANCE_ACTION_INITIAL_STATE,
      approvalForm(),
    )).resolves.toEqual({
      status: "issuance_approved",
      issuanceId: ISSUANCE_ID,
      approvalCount: 1,
      derivedState: "approval_pending",
      replayed: false,
    });
    expect(deps.authorizedOfferMutationAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      ["offer.issue.approve"],
      "offer_issuance_approval",
      expect.any(Function),
    );
    expect(deps.approveOfferIssuance).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "offer-issuance-approval-command.v1",
      issuanceId: ISSUANCE_ID,
      recipientAndScopeReviewed: true,
      commercialTotalsReviewed: true,
      legalProfileReviewed: true,
      finalPdfForArchiveUnderstood: true,
      zeroTaxTreatmentReviewed: true,
    });
  });

  it("zieht nur mit strukturiertem Grund und eigenem Recht zurueck", async () => {
    await expect(withdrawOfferIssuanceAction(
      OFFER_ISSUANCE_ACTION_INITIAL_STATE,
      withdrawalForm(),
    )).resolves.toMatchObject({
      status: "issuance_withdrawn",
      issuanceId: ISSUANCE_ID,
      state: "withdrawn_before_archive",
      approvalCount: 1,
    });
    expect(deps.authorizedOfferMutationAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      ["offer.issue.withdraw"],
      "offer_issuance_withdrawal",
      expect.any(Function),
    );
    expect(deps.withdrawOfferIssuance).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "offer-issuance-withdrawal-command.v1",
      issuanceId: ISSUANCE_ID,
      reasonCode: "content_error",
    });
  });

  it("weist Unknowns, Duplikate und falsche Checkboxwerte vor dem Service ab", async () => {
    const unknown = requestForm();
    unknown.set("candidateArtifactSha256", "attacker-choice");
    const duplicate = approvalForm();
    duplicate.append("issuanceId", ISSUANCE_ID);
    const unchecked = approvalForm();
    unchecked.set("commercialTotalsReviewed", "false");

    await expect(requestOfferIssuanceAction(
      OFFER_ISSUANCE_ACTION_INITIAL_STATE,
      unknown,
    )).resolves.toEqual({ status: "invalid" });
    await expect(approveOfferIssuanceAction(
      OFFER_ISSUANCE_ACTION_INITIAL_STATE,
      duplicate,
    )).resolves.toEqual({ status: "invalid" });
    await expect(approveOfferIssuanceAction(
      OFFER_ISSUANCE_ACTION_INITIAL_STATE,
      unchecked,
    )).resolves.toEqual({
      status: "invalid",
      paths: ["/commercialTotalsReviewed"],
    });
    expect(deps.requestOfferIssuance).not.toHaveBeenCalled();
    expect(deps.approveOfferIssuance).not.toHaveBeenCalled();
  });

  it.each([
    [new deps.NotAuthenticatedError(), { status: "unauthenticated" }],
    [new deps.PermissionDeniedError(), { status: "denied" }],
    [new deps.OfferIssuanceValidationError(["/commercialTotalsReviewed"]), {
      status: "invalid", paths: ["/commercialTotalsReviewed"],
    }],
    [new deps.OfferIssuanceNotFoundError(), { status: "not_found" }],
    [new deps.OfferIssuanceConflictError("artifact_integrity_changed"), {
      status: "conflict", code: "artifact_integrity_changed",
    }],
    [new deps.OfferIssuanceIntegrityError(), { status: "unavailable" }],
    [new deps.OfferIssuancePersistenceError(), { status: "unavailable" }],
    [new deps.OfferIssuanceDispatchError(), { status: "unavailable" }],
    [new deps.OfferRateLimitError("2026-08-30T12:15:00.000Z"), {
      status: "unavailable", retryAfter: "2026-08-30T12:15:00.000Z",
    }],
  ] as const)("redigiert %s an der Action-Grenze", async (error, expected) => {
    deps.approveOfferIssuance.mockRejectedValueOnce(error);
    const result = await approveOfferIssuanceAction(
      OFFER_ISSUANCE_ACTION_INITIAL_STATE,
      approvalForm(),
    );
    expect(result).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(error.message);
  });
});
