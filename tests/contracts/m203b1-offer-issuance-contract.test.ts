import { describe, expect, it } from "vitest";

import type { OfferReleaseCandidateInputV1 } from "@/lib/integrations/offers/release-contract";
import {
  OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION,
  OFFER_ISSUANCE_ARTIFACT_INTENT,
  OFFER_ISSUANCE_DISPATCH_VERSION,
  OFFER_ISSUANCE_INPUT_VERSION,
  OFFER_ISSUANCE_RENDERER_RECIPE_VERSION,
  OFFER_ISSUANCE_REQUEST_VERSION,
  OFFER_ISSUANCE_TEMPLATE_VERSION,
  OFFER_ISSUANCE_WITHDRAWAL_COMMAND_VERSION,
  buildOfferIssuanceInput,
  hashOfferIssuanceInput,
  offerIssuanceApprovalCommandV1Schema,
  offerIssuanceDispatchV1Schema,
  offerIssuanceInputV1Schema,
  offerIssuanceRequestV1Schema,
  offerIssuanceWithdrawalCommandV1Schema,
  validateOfferIssuanceInput,
} from "@/lib/integrations/offers/issuance-contract";

const ids = {
  workspace: "11111111-1111-4111-8111-111111111111",
  project: "22222222-2222-4222-8222-222222222222",
  offer: "33333333-3333-4333-8333-333333333333",
  candidate: "44444444-4444-4444-8444-444444444444",
  candidateApproval: "55555555-5555-4555-8555-555555555555",
  candidateArtifactVersion: "66666666-6666-4666-8666-666666666666",
  issuance: "77777777-7777-4777-8777-777777777777",
  variant: "88888888-8888-4888-8888-888888888888",
  variantRevision: "99999999-9999-4999-8999-999999999999",
  profileActivation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  profile: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  profileRevision: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  recipient: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  recipientRevision: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
} as const;

const sha = (digit: string) => digit.repeat(64);

function candidateInputFixture(lineCount = 2): OfferReleaseCandidateInputV1 {
  const lines = Array.from({ length: lineCount }, (_, index) => ({
    position: index + 1,
    title: index === 0 ? "PV-Anlage <Premium>" : `Option ${index + 1}`,
    description: index === 0 ? "Montage & Inbetriebnahme" : null,
    quantityMilli: 1_000,
    unit: "piece" as const,
    positionType: index === lineCount - 1 && lineCount > 1
      ? "optional" as const
      : "required" as const,
    salesUnitNetCents: 10_000,
    lineDiscountBps: 0,
    taxRateBps: 1_900 as const,
    finalNetCents: 10_000,
    taxCents: 1_900,
    grossCents: 11_900,
  }));
  const basisCount = lines.filter((line) => line.positionType !== "optional").length;
  const optionalCount = lines.length - basisCount;
  return {
    schemaVersion: "offer-release-candidate-input.v1",
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: "offer-release-candidate-template.v1",
    rendererRecipeVersion: "offer-release-candidate-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    documentStatus: "not_issued",
    preparedAt: "2026-08-30T10:22:33.000Z",
    documentDate: "2026-08-30",
    validThrough: "2026-09-29",
    offerNumber: "ANG-2026-000042",
    profile: { name: "WMEE Profil", revision: 4 },
    sender: {
      legalName: "Beispiel Energie GmbH",
      tradingName: null,
      representedBy: "Erika Beispiel",
      address: {
        street: "Sonnenstraße",
        houseNumber: "12",
        postalCode: "10115",
        city: "Berlin",
        country: "DE",
      },
      contactEmail: "angebot@example.invalid",
      contactPhone: "+49301234567",
      website: "https://example.invalid",
      registerCourt: "Amtsgericht Berlin",
      registerNumber: "HRB 12345",
      vatId: "DE000000000",
    },
    recipient: {
      displayName: "Mia Muster",
      company: null,
      billingAddress: {
        street: "Rechnungsweg",
        houseNumber: "17 b",
        postalCode: "10117",
        city: "Berlin",
        country: "DE",
        formattedAddress: "Rechnungsweg 17 b, 10117 Berlin",
      },
    },
    installationSite: { formattedAddress: "Solarweg 8, 10115 Berlin" },
    variant: { name: "Komfort", revision: 7 },
    commercialTerms: { globalDiscountBps: 0, customDealNetCents: null },
    sections: [{ position: 1, title: "PV-Anlage", discountBps: 0, lines }],
    totals: {
      basisNetCents: basisCount * 10_000,
      basisTaxCents: basisCount * 1_900,
      basisGrossCents: basisCount * 11_900,
      optionalNetCents: optionalCount * 10_000,
      optionalTaxCents: optionalCount * 1_900,
      optionalGrossCents: optionalCount * 11_900,
    },
    legalDocuments: {
      terms: { title: "Angebotsbedingungen", plainText: "Synthetischer Testtext." },
      withdrawalInformation: {
        title: "Widerrufsinformation",
        plainText: "Synthetischer Widerrufstext.",
      },
      privacyNotice: {
        title: "Datenschutzhinweis",
        plainText: "Synthetischer Datenschutzhinweis.",
      },
    },
  };
}

function sourceBindingFixture() {
  return {
    workspaceId: ids.workspace,
    projectId: ids.project,
    offerId: ids.offer,
    candidateId: ids.candidate,
    candidateApprovalId: ids.candidateApproval,
    candidateApprovedAt: "2026-08-30T10:30:00.000Z",
    candidateArtifactVersion: ids.candidateArtifactVersion,
    candidateArtifactSha256: sha("1"),
    candidateArtifactSizeBytes: 12_345,
    variantId: ids.variant,
    variantRevisionId: ids.variantRevision,
    variantRevision: 7,
    variantSnapshotSha256: sha("2"),
    profileActivationId: ids.profileActivation,
    profileId: ids.profile,
    profileRevisionId: ids.profileRevision,
    profileRevision: 4,
    profileSnapshotSha256: sha("3"),
    recipientId: ids.recipient,
    recipientRevisionId: ids.recipientRevision,
    recipientRevision: 3,
    recipientSnapshotSha256: sha("4"),
  };
}

function issuanceInputFixture() {
  return buildOfferIssuanceInput({
    issuanceId: ids.issuance,
    preparedAt: "2026-08-30T10:31:00.000Z",
    sourceBinding: sourceBindingFixture(),
    candidateInput: candidateInputFixture(),
  });
}

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
  if (value === null || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, keys);
    return keys;
  }
  for (const [key, entry] of Object.entries(value)) {
    keys.add(key);
    collectKeys(entry, keys);
  }
  return keys;
}

describe("M2-03b1 offer issuance contracts", () => {
  it("pinnt einen eigenen finalen, aber noch nicht ausgestellten Artefaktvertrag", () => {
    expect(OFFER_ISSUANCE_REQUEST_VERSION).toBe("offer-issuance-request.v1");
    expect(OFFER_ISSUANCE_DISPATCH_VERSION).toBe("offer-issuance-dispatch.v1");
    expect(OFFER_ISSUANCE_INPUT_VERSION).toBe("offer-issuance-input.v1");
    expect(OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION)
      .toBe("offer-issuance-approval-command.v1");
    expect(OFFER_ISSUANCE_WITHDRAWAL_COMMAND_VERSION)
      .toBe("offer-issuance-withdrawal-command.v1");
    expect(OFFER_ISSUANCE_TEMPLATE_VERSION).toBe("offer-issuance-template.v1");
    expect(OFFER_ISSUANCE_RENDERER_RECIPE_VERSION).toMatch(
      /^offer-issuance-renderer-recipe\.v1-linux-amd64-pw1\.62\.1-[0-9a-f]{64}$/u,
    );
    expect(OFFER_ISSUANCE_ARTIFACT_INTENT).toBe("offer_issuance_final");
  });

  it("nimmt fuer Request und Worker-Dispatch ausschliesslich IDs an", () => {
    const request = {
      schemaVersion: OFFER_ISSUANCE_REQUEST_VERSION,
      workspaceId: ids.workspace,
      offerId: ids.offer,
      candidateId: ids.candidate,
    };
    const dispatch = {
      schemaVersion: OFFER_ISSUANCE_DISPATCH_VERSION,
      workspaceId: ids.workspace,
      issuanceId: ids.issuance,
    };
    expect(offerIssuanceRequestV1Schema.safeParse(request).success).toBe(true);
    expect(offerIssuanceRequestV1Schema.safeParse({
      ...request,
      candidateInput: candidateInputFixture(),
    }).success).toBe(false);
    expect(offerIssuanceDispatchV1Schema.safeParse(dispatch).success).toBe(true);
    for (const forbidden of [
      { inputSnapshot: issuanceInputFixture() },
      { recipientName: "Mia Muster" },
      { artifactSha256: sha("9") },
      { artifactBytes: "base64" },
    ]) {
      expect(offerIssuanceDispatchV1Schema.safeParse({ ...dispatch, ...forbidden }).success)
        .toBe(false);
    }
  });

  it("begrenzt Approval und Withdrawal auf Issuance-ID und feste sichere Codes", () => {
    const approval = {
      schemaVersion: OFFER_ISSUANCE_APPROVAL_COMMAND_VERSION,
      issuanceId: ids.issuance,
      recipientAndScopeReviewed: true,
      commercialTotalsReviewed: true,
      legalProfileReviewed: true,
      finalPdfForArchiveUnderstood: true,
      zeroTaxTreatmentReviewed: true,
    };
    expect(offerIssuanceApprovalCommandV1Schema.safeParse(approval).success).toBe(true);
    expect(offerIssuanceApprovalCommandV1Schema.safeParse({
      ...approval,
      commercialTotalsReviewed: false,
    }).success).toBe(false);
    for (const forbidden of ["workspaceId", "offerId", "actorId", "artifactSha256", "note"]) {
      expect(offerIssuanceApprovalCommandV1Schema.safeParse({
        ...approval,
        [forbidden]: forbidden === "artifactSha256" ? sha("8") : "private",
      }).success, forbidden).toBe(false);
    }

    const withdrawal = {
      schemaVersion: OFFER_ISSUANCE_WITHDRAWAL_COMMAND_VERSION,
      issuanceId: ids.issuance,
      reasonCode: "legal_text_error" as const,
    };
    expect(offerIssuanceWithdrawalCommandV1Schema.safeParse(withdrawal).success).toBe(true);
    for (const reasonCode of [
      "content_error",
      "recipient_error",
      "legal_text_error",
      "commercial_error",
      "other",
    ]) {
      expect(offerIssuanceWithdrawalCommandV1Schema.safeParse({
        ...withdrawal,
        reasonCode,
      }).success, reasonCode).toBe(true);
    }
    expect(offerIssuanceWithdrawalCommandV1Schema.safeParse({
      ...withdrawal,
      reasonCode: "free_text",
    }).success).toBe(false);
    expect(offerIssuanceWithdrawalCommandV1Schema.safeParse({
      ...withdrawal,
      note: "PII oder Vertragsinhalt",
    }).success).toBe(false);
  });

  it("transformiert nur einen validierten Candidate in einen neuen versiegelbaren Input", () => {
    const candidate = candidateInputFixture();
    const issuance = issuanceInputFixture();

    expect(issuance).toMatchObject({
      schemaVersion: "offer-issuance-input.v1",
      canonicalizationVersion: "offer-jcs.v1",
      templateVersion: "offer-issuance-template.v1",
      artifactIntent: "offer_issuance_final",
      issuanceId: ids.issuance,
      preparedAt: "2026-08-30T10:31:00.000Z",
      source: {
        workspaceId: ids.workspace,
        projectId: ids.project,
        offerId: ids.offer,
        candidateId: ids.candidate,
        candidateApprovalId: ids.candidateApproval,
        candidateArtifactSha256: sha("1"),
        candidateInputVersion: candidate.schemaVersion,
        candidateTemplateVersion: candidate.templateVersion,
        candidateRendererRecipeVersion: candidate.rendererRecipeVersion,
        variant: { id: ids.variant, revisionId: ids.variantRevision, revision: 7 },
        profile: { id: ids.profile, revisionId: ids.profileRevision, revision: 4 },
        recipient: { id: ids.recipient, revisionId: ids.recipientRevision, revision: 3 },
      },
      document: {
        offerNumber: candidate.offerNumber,
        sender: candidate.sender,
        recipient: candidate.recipient,
        sections: candidate.sections,
        totals: candidate.totals,
      },
    });
    expect(issuance.source.candidateInputSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashOfferIssuanceInput(issuance)).toMatch(/^[0-9a-f]{64}$/u);

    const documentKeys = collectKeys(issuance.document);
    for (const forbidden of [
      "schemaVersion",
      "canonicalizationVersion",
      "templateVersion",
      "rendererRecipeVersion",
      "documentStatus",
      "artifactBytes",
      "candidateBytes",
      "source",
      "purchasePricing",
      "createdBy",
      "approvedBy",
    ]) expect(documentKeys.has(forbidden), forbidden).toBe(false);
  });

  it("verweigert Candidate-Drift, unbekannte Felder und Quellenbindungsdrift", () => {
    const candidate = candidateInputFixture();
    const badCandidate = {
      ...candidate,
      totals: { ...candidate.totals, basisGrossCents: candidate.totals.basisGrossCents + 1 },
    };
    expect(() => buildOfferIssuanceInput({
      issuanceId: ids.issuance,
      preparedAt: "2026-08-30T10:31:00.000Z",
      sourceBinding: sourceBindingFixture(),
      candidateInput: badCandidate,
    })).toThrow(/Candidate/iu);
    expect(() => buildOfferIssuanceInput({
      issuanceId: ids.issuance,
      preparedAt: "2026-08-30T10:31:00.000Z",
      sourceBinding: {
        ...sourceBindingFixture(),
        unknown: "private",
      } as ReturnType<typeof sourceBindingFixture>,
      candidateInput: candidate,
    })).toThrow(/Quellenbindung/iu);
    expect(() => buildOfferIssuanceInput({
      issuanceId: ids.issuance,
      preparedAt: "2026-08-30T10:31:00.000Z",
      sourceBinding: { ...sourceBindingFixture(), variantRevision: 8 },
      candidateInput: candidate,
    })).toThrow(/Quellenbindung/iu);

    const issuance = issuanceInputFixture();
    const result = validateOfferIssuanceInput({
      ...issuance,
      document: {
        ...issuance.document,
        profile: { ...issuance.document.profile, revision: 5 },
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.paths).toContain("/document/profile/revision");
    expect(offerIssuanceInputV1Schema.safeParse({ ...issuance, issued: true }).success)
      .toBe(false);
  });

  it("pinnt den kanonischen Golden Hash der Ausstellungsfassung", () => {
    expect(hashOfferIssuanceInput(issuanceInputFixture()))
      .toBe("16c9e9270db2ef250f99c27b4caecb3e8a2b9d42366f48345d2c79e4ddcdc6e2");
  });
});
