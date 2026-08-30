import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => {
  class NotAuthenticatedError extends Error {
    constructor() { super("private authentication sentinel"); }
  }
  class PermissionDeniedError extends Error {
    constructor() { super("private permission sentinel"); }
  }
  class OfferReleaseValidationError extends Error {
    constructor(public readonly paths: string[] = []) { super("private validation sentinel"); }
  }
  class OfferReleaseConflictError extends Error {
    constructor(public readonly code: string, public readonly currentRevision?: number) {
      super("private conflict sentinel");
    }
  }
  class OfferReleaseNotFoundError extends Error {
    constructor() { super("private not-found sentinel"); }
  }
  class OfferReleaseIntegrityError extends Error {
    constructor() { super("private integrity sentinel"); }
  }
  class OfferReleasePersistenceError extends Error {
    constructor() { super("private persistence sentinel"); }
  }
  class OfferReleaseDispatchError extends Error {
    constructor() { super("private dispatch sentinel"); }
  }
  class OfferReleaseProfileValidationError extends Error {
    constructor(public readonly paths: string[] = []) { super("private profile validation sentinel"); }
  }
  class OfferReleaseProfileConflictError extends Error {
    constructor(public readonly currentRevision?: number) { super("private profile conflict sentinel"); }
  }
  class OfferReleaseProfileNotFoundError extends Error {
    constructor() { super("private profile not-found sentinel"); }
  }
  class OfferReleaseProfileIntegrityError extends Error {
    constructor() { super("private profile integrity sentinel"); }
  }
  class OfferReleaseProfilePersistenceError extends Error {
    constructor() { super("private profile persistence sentinel"); }
  }
  class OfferRateLimitError extends Error {
    constructor(public readonly retryAfter: string) { super("private admission sentinel"); }
  }
  return {
    NotAuthenticatedError,
    PermissionDeniedError,
    OfferReleaseValidationError,
    OfferReleaseConflictError,
    OfferReleaseNotFoundError,
    OfferReleaseIntegrityError,
    OfferReleasePersistenceError,
    OfferReleaseDispatchError,
    OfferReleaseProfileValidationError,
    OfferReleaseProfileConflictError,
    OfferReleaseProfileNotFoundError,
    OfferReleaseProfileIntegrityError,
    OfferReleaseProfilePersistenceError,
    OfferRateLimitError,
    authorizedOfferMutationAction: vi.fn(),
    reviseOfferRecipient: vi.fn(),
    requestOfferReleaseCandidate: vi.fn(),
    approveOfferReleaseCandidate: vi.fn(),
    revalidatePath: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath: deps.revalidatePath }));
vi.mock("@/lib/action", () => ({
  authorizedOfferMutationAction: deps.authorizedOfferMutationAction,
  NotAuthenticatedError: deps.NotAuthenticatedError,
}));
vi.mock("@/lib/permissions", () => ({
  PermissionDeniedError: deps.PermissionDeniedError,
}));
vi.mock("@/lib/integrations/offers/admission", () => ({
  OfferRateLimitError: deps.OfferRateLimitError,
}));
vi.mock("@/modules/offers", () => ({
  requestOfferReleaseCandidate: deps.requestOfferReleaseCandidate,
  approveOfferReleaseCandidate: deps.approveOfferReleaseCandidate,
  OfferReleaseValidationError: deps.OfferReleaseValidationError,
  OfferReleaseConflictError: deps.OfferReleaseConflictError,
  OfferReleaseNotFoundError: deps.OfferReleaseNotFoundError,
  OfferReleaseIntegrityError: deps.OfferReleaseIntegrityError,
  OfferReleasePersistenceError: deps.OfferReleasePersistenceError,
  OfferReleaseDispatchError: deps.OfferReleaseDispatchError,
  reviseOfferRecipient: deps.reviseOfferRecipient,
  OfferReleaseProfileValidationError: deps.OfferReleaseProfileValidationError,
  OfferReleaseProfileConflictError: deps.OfferReleaseProfileConflictError,
  OfferReleaseProfileNotFoundError: deps.OfferReleaseProfileNotFoundError,
  OfferReleaseProfileIntegrityError: deps.OfferReleaseProfileIntegrityError,
  OfferReleaseProfilePersistenceError: deps.OfferReleaseProfilePersistenceError,
}));

import {
  approveOfferReleaseCandidateAction,
  requestOfferReleaseCandidateAction,
  reviseOfferRecipientAction,
} from "@/app/w/[workspaceId]/angebote/release-actions";
import { OFFER_RELEASE_ACTION_INITIAL_STATE } from "@/app/w/[workspaceId]/angebote/release-action-state";
import { OfferReleaseCandidatePanel } from "@/app/w/[workspaceId]/angebote/[offerId]/offer-release-candidate-panel";

const WORKSPACE_ID = "10000000-0000-4000-8000-000000000001";
const OFFER_ID = "20000000-0000-4000-8000-000000000002";
const VARIANT_ID = "30000000-0000-4000-8000-000000000003";
const PDF_DRAFT_ID = "40000000-0000-4000-8000-000000000004";
const PROFILE_ID = "50000000-0000-4000-8000-000000000005";
const PROFILE_REVISION_ID = "60000000-0000-4000-8000-000000000006";
const RECIPIENT_REVISION_ID = "70000000-0000-4000-8000-000000000007";
const CANDIDATE_ID = "80000000-0000-4000-8000-000000000008";
const ARTIFACT_VERSION = "81000000-0000-4000-8000-000000000009";
const TX = { kind: "tenant-transaction" };
const CTX = { workspaceId: WORKSPACE_ID, actor: "90000000-0000-4000-8000-000000000009" };

function recipientForm(): FormData {
  const form = new FormData();
  const values: Record<string, string> = {
    schemaVersion: "offer-recipient-revise-command.v1",
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    expectedCurrentRevision: "0",
    displayName: "Synthetische Kundin",
    company: "",
    email: "kunde@example.test",
    street: "Testweg",
    houseNumber: "7",
    postalCode: "69168",
    city: "Dielheim",
    country: "DE",
    billingDetailsConfirmed: "true",
  };
  for (const [name, value] of Object.entries(values)) form.set(name, value);
  return form;
}

function candidateForm(): FormData {
  const form = new FormData();
  const values: Record<string, string> = {
    schemaVersion: "offer-release-candidate-request.v1",
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    variantId: VARIANT_ID,
    expectedVariantRevision: "7",
    sourcePdfDraftId: PDF_DRAFT_ID,
    documentProfileId: PROFILE_ID,
    documentProfileRevisionId: PROFILE_REVISION_ID,
    expectedDocumentProfileRevision: "3",
    recipientRevisionId: RECIPIENT_REVISION_ID,
    expectedRecipientRevision: "1",
    validThrough: "2026-09-14",
  };
  for (const [name, value] of Object.entries(values)) form.set(name, value);
  return form;
}

function approvalForm(withZeroTax = true): FormData {
  const form = new FormData();
  const values: Record<string, string> = {
    schemaVersion: "offer-release-approval-command.v1",
    workspaceId: WORKSPACE_ID,
    offerId: OFFER_ID,
    candidateId: CANDIDATE_ID,
    expectedArtifactVersion: ARTIFACT_VERSION,
    recipientBillingReviewed: "true",
    commercialContentReviewed: "true",
    activeProfileReviewed: "true",
    notIssuedStatusUnderstood: "true",
  };
  if (withZeroTax) values.zeroTaxTreatmentReviewed = "true";
  for (const [name, value] of Object.entries(values)) form.set(name, value);
  return form;
}

beforeEach(() => {
  vi.resetAllMocks();
  deps.authorizedOfferMutationAction.mockImplementation(async (
    _workspaceId: string,
    _actions: readonly string[],
    _resource: string,
    operation: (tx: unknown, ctx: typeof CTX) => Promise<unknown>,
  ) => operation(TX, CTX));
  deps.reviseOfferRecipient.mockResolvedValue({
    recipientRevisionId: RECIPIENT_REVISION_ID,
    revision: 1,
    snapshot: { offerId: OFFER_ID },
  });
  deps.requestOfferReleaseCandidate.mockResolvedValue({
    candidateId: CANDIDATE_ID,
    offerId: OFFER_ID,
    variantRevision: 7,
    state: "queued",
    replayed: false,
  });
  deps.approveOfferReleaseCandidate.mockResolvedValue({
    candidateId: CANDIDATE_ID,
    offerId: OFFER_ID,
    approvedAt: "2026-08-30T12:00:00.000Z",
    replayed: false,
  });
});

describe("M2-03a Offer-Release-Actions", () => {
  it("speichert einen expliziten Empfängerstand hinter offer.release.prepare", async () => {
    const result = await reviseOfferRecipientAction(
      OFFER_RELEASE_ACTION_INITIAL_STATE,
      recipientForm(),
    );
    expect(deps.authorizedOfferMutationAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      ["offer.release.prepare"],
      "offer_recipient",
      expect.any(Function),
    );
    expect(deps.reviseOfferRecipient).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "offer-recipient-revise-command.v1",
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      expectedCurrentRevision: 0,
      displayName: "Synthetische Kundin",
      company: null,
      email: "kunde@example.test",
      billingAddress: {
        street: "Testweg",
        houseNumber: "7",
        postalCode: "69168",
        city: "Dielheim",
        country: "DE",
      },
      billingDetailsConfirmed: true,
    });
    expect(result).toEqual({
      status: "recipient_saved",
      recipientRevisionId: RECIPIENT_REVISION_ID,
      recipientRevision: 1,
      submittedRecipientRevision: 0,
    });
  });

  it("bindet beim Renderauftrag ausschließlich IDs, erwartete Revisionen und das Datum", async () => {
    const result = await requestOfferReleaseCandidateAction(
      OFFER_RELEASE_ACTION_INITIAL_STATE,
      candidateForm(),
    );
    expect(deps.requestOfferReleaseCandidate).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "offer-release-candidate-request.v1",
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      expectedVariantRevision: 7,
      sourcePdfDraftId: PDF_DRAFT_ID,
      documentProfileId: PROFILE_ID,
      documentProfileRevisionId: PROFILE_REVISION_ID,
      expectedDocumentProfileRevision: 3,
      recipientRevisionId: RECIPIENT_REVISION_ID,
      expectedRecipientRevision: 1,
      validThrough: "2026-09-14",
    });
    expect(result).toMatchObject({
      status: "candidate_requested",
      candidateId: CANDIDATE_ID,
      variantRevision: 7,
    });
  });

  it("bindet alle vier festen Bestätigungen und die bedingte Nullsteuerprüfung", async () => {
    await expect(approveOfferReleaseCandidateAction(
      OFFER_RELEASE_ACTION_INITIAL_STATE,
      approvalForm(true),
    )).resolves.toMatchObject({ status: "candidate_approved", candidateId: CANDIDATE_ID });
    expect(deps.authorizedOfferMutationAction).toHaveBeenCalledWith(
      WORKSPACE_ID,
      ["offer.release.approve"],
      "offer_release_candidate_approval",
      expect.any(Function),
    );
    expect(deps.approveOfferReleaseCandidate).toHaveBeenCalledWith(TX, CTX, {
      schemaVersion: "offer-release-approval-command.v1",
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      candidateId: CANDIDATE_ID,
      expectedArtifactVersion: ARTIFACT_VERSION,
      recipientBillingReviewed: true,
      commercialContentReviewed: true,
      activeProfileReviewed: true,
      notIssuedStatusUnderstood: true,
      zeroTaxTreatmentReviewed: true,
    });
  });

  it("weist Unknowns, Duplikate und fehlende feste Bestätigungen fail-closed ab", async () => {
    const unknown = candidateForm();
    unknown.set("artifactSha256", "attacker-choice");
    await expect(requestOfferReleaseCandidateAction(
      OFFER_RELEASE_ACTION_INITIAL_STATE,
      unknown,
    )).resolves.toEqual({ status: "invalid" });

    const duplicate = candidateForm();
    duplicate.append("variantId", VARIANT_ID);
    await expect(requestOfferReleaseCandidateAction(
      OFFER_RELEASE_ACTION_INITIAL_STATE,
      duplicate,
    )).resolves.toEqual({ status: "invalid" });

    const missing = approvalForm(false);
    missing.delete("commercialContentReviewed");
    await expect(approveOfferReleaseCandidateAction(
      OFFER_RELEASE_ACTION_INITIAL_STATE,
      missing,
    )).resolves.toEqual({ status: "invalid" });
    expect(deps.requestOfferReleaseCandidate).not.toHaveBeenCalled();
    expect(deps.approveOfferReleaseCandidate).not.toHaveBeenCalled();
  });

  it("übersetzt sichere Konfliktcodes ohne private Fehlermeldung", async () => {
    const error = new deps.OfferReleaseConflictError("candidate_source_changed", 9);
    deps.requestOfferReleaseCandidate.mockRejectedValueOnce(error);
    const result = await requestOfferReleaseCandidateAction(
      OFFER_RELEASE_ACTION_INITIAL_STATE,
      candidateForm(),
    );
    expect(result).toEqual({
      status: "conflict",
      code: "candidate_source_changed",
      currentRevision: 9,
    });
    expect(JSON.stringify(result)).not.toContain(error.message);
  });
});

describe("M2-03a Offer-Release-Panel", () => {
  const profile = {
    profileId: PROFILE_ID,
    profileRevisionId: PROFILE_REVISION_ID,
    revision: 3,
    profileName: "Synthetisches Angebotsprofil",
  };
  const recipient = {
    recipientRevisionId: RECIPIENT_REVISION_ID,
    revision: 1,
    displayName: "Synthetische Kundin",
    company: null,
    email: "kunde@example.test",
    billingAddress: {
      street: "Testweg",
      houseNumber: "7",
      postalCode: "69168",
      city: "Dielheim",
      country: "DE" as const,
    },
  };
  const candidates = [{
    candidateId: CANDIDATE_ID,
    variantId: VARIANT_ID,
    variantRevision: 7,
    state: "ready_for_approval" as const,
    publicationStatus: "not_issued" as const,
    requiresZeroTaxReview: true,
    attemptCount: 1,
    nextAttemptAt: "2026-08-30T11:00:00.000Z",
    createdAt: "2026-08-30T10:00:00.000Z",
    finishedAt: "2026-08-30T10:01:00.000Z",
    errorCode: null,
    approvedAt: null,
    canDownload: true,
    approvalArtifactVersion: ARTIFACT_VERSION,
  }];

  function renderPanel(
    input: { canPrepare: boolean; canApprove: boolean },
    renderedCandidates = candidates,
  ): string {
    return renderToStaticMarkup(createElement(OfferReleaseCandidatePanel, {
      workspaceId: WORKSPACE_ID,
      offerId: OFFER_ID,
      variantId: VARIANT_ID,
      variantRevision: 7,
      contactDisplayName: input.canPrepare ? "Synthetische Kundin" : null,
      profile,
      recipient: input.canPrepare ? recipient : null,
      recipientPresence: { revision: recipient.revision },
      sourcePdfDraftId: PDF_DRAFT_ID,
      validityWindow: {
        min: "2026-08-31",
        suggested: "2026-09-14",
        max: "2026-10-29",
      },
      canPrepare: input.canPrepare,
      canApprove: input.canApprove,
      candidates: renderedCandidates,
    }));
  }

  it("zeigt die drei getrennten Stufen mit neutralem Dokumentstatus und bytebezogener Prüfung", () => {
    const html = renderPanel({ canPrepare: true, canApprove: true });
    expect(html).toContain("Schritt 1 von 3");
    expect(html).toContain("Schritt 2 von 3");
    expect(html).toContain("Schritt 3 von 3");
    expect(html).toContain("Freigabekandidat · nicht ausgestellt · nicht versendet");
    expect(html).toContain("Finale Prüfung der erzeugten PDF-Bytes");
    expect(html).toContain('name="zeroTaxTreatmentReviewed"');
    expect(html).toContain('name="notIssuedStatusUnderstood"');
    expect(html).toContain(`name="expectedArtifactVersion" value="${ARTIFACT_VERSION}"`);
    expect(html).toContain('min="2026-08-31"');
    expect(html).toContain('max="2026-10-29"');
    expect(html).toContain("1 bis 60 Kalendertage nach dem serverseitigen Dokumentdatum");
    expect(html).toContain(`/freigabekandidaten/${CANDIDATE_ID}/pdf`);
    expect(html).toContain("<fieldset");
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("sticky");
    expect(html).not.toContain("Angebot versenden");
  });

  it("entfernt für reine Leser alle drei Mutationsformulare, nicht aber berechtigte Downloads", () => {
    const html = renderPanel({ canPrepare: false, canApprove: false });
    expect(html).toContain("Nur berechtigte interne Bearbeiter");
    expect(html).toContain("Gespeicherter und geprüfter Empfängerstand ist vorhanden: Revision 1");
    expect(html).not.toContain("<form");
    expect(html).toContain("Freigabekandidat-PDF laden");
    expect(html).not.toContain("Abschlussfreigabe speichern");
    expect(html).not.toContain("expectedArtifactVersion");
    expect(html).not.toContain("kunde@example.test");
    expect(html).not.toContain("Testweg");
  });

  it("bindet Freigabeformular und Live-Rückmeldung eindeutig an jeden Kandidaten", () => {
    const secondCandidateId = "81000000-0000-4000-8000-000000000008";
    const html = renderPanel(
      { canPrepare: true, canApprove: true },
      [candidates[0], { ...candidates[0], candidateId: secondCandidateId }],
    );
    expect(html).toContain(`aria-describedby="approval-action-feedback-${CANDIDATE_ID}"`);
    expect(html).toContain(`aria-describedby="approval-action-feedback-${secondCandidateId}"`);
    expect(html).toContain(`id="approval-action-feedback-${CANDIDATE_ID}"`);
    expect(html).toContain(`id="approval-action-feedback-${secondCandidateId}"`);
    expect(html).not.toContain('id="approval-action-feedback"');
  });
});
