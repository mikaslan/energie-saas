import { createHash } from "node:crypto";

import type { OfferReleaseCandidateInputV1 } from "@/lib/integrations/offers/release-contract";
import {
  buildOfferIssuanceInput,
  type OfferIssuanceInputV1,
} from "@/lib/integrations/offers/issuance-contract";

export const M203B1_IDS = {
  workspace: "11111111-1111-4111-8111-111111111111",
  otherWorkspace: "12111111-1111-4111-8111-111111111111",
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
  actor: "f1111111-1111-4111-8111-111111111111",
  secondActor: "f2222222-2222-4222-8222-222222222222",
  approval: "f3333333-3333-4333-8333-333333333333",
  withdrawal: "f4444444-4444-4444-8444-444444444444",
  lease: "f5555555-5555-4555-8555-555555555555",
  artifactVersion: "f6666666-6666-4666-8666-666666666666",
} as const;

export const m203b1Sha = (digit: string): string => digit.repeat(64);

export function m203b1CandidateInput(
  taxRateBps: 0 | 1900 = 1900,
): OfferReleaseCandidateInputV1 {
  const taxCents = taxRateBps === 0 ? 0 : 1_900;
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
    profile: { name: "Synthetisches Angebotsprofil", revision: 4 },
    sender: {
      legalName: "Beispiel Energie GmbH",
      tradingName: null,
      representedBy: "Erika Beispiel",
      address: {
        street: "Sonnenstrasse",
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
      displayName: "PRIVATE_RECIPIENT_SENTINEL",
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
        unit: "piece",
        positionType: "required",
        salesUnitNetCents: 10_000,
        lineDiscountBps: 0,
        taxRateBps,
        finalNetCents: 10_000,
        taxCents,
        grossCents: 10_000 + taxCents,
      }],
    }],
    totals: {
      basisNetCents: 10_000,
      basisTaxCents: taxCents,
      basisGrossCents: 10_000 + taxCents,
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

export function m203b1IssuanceInput(
  taxRateBps: 0 | 1900 = 1900,
): OfferIssuanceInputV1 {
  return buildOfferIssuanceInput({
    issuanceId: M203B1_IDS.issuance,
    preparedAt: "2026-08-30T10:31:00.000Z",
    sourceBinding: {
      workspaceId: M203B1_IDS.workspace,
      projectId: M203B1_IDS.project,
      offerId: M203B1_IDS.offer,
      candidateId: M203B1_IDS.candidate,
      candidateApprovalId: M203B1_IDS.candidateApproval,
      candidateApprovedAt: "2026-08-30T10:30:00.000Z",
      candidateArtifactVersion: M203B1_IDS.candidateArtifactVersion,
      candidateArtifactSha256: m203b1Sha("1"),
      candidateArtifactSizeBytes: 12_345,
      variantId: M203B1_IDS.variant,
      variantRevisionId: M203B1_IDS.variantRevision,
      variantRevision: 7,
      variantSnapshotSha256: m203b1Sha("2"),
      profileActivationId: M203B1_IDS.profileActivation,
      profileId: M203B1_IDS.profile,
      profileRevisionId: M203B1_IDS.profileRevision,
      profileRevision: 4,
      profileSnapshotSha256: m203b1Sha("3"),
      recipientId: M203B1_IDS.recipient,
      recipientRevisionId: M203B1_IDS.recipientRevision,
      recipientRevision: 3,
      recipientSnapshotSha256: m203b1Sha("4"),
    },
    candidateInput: m203b1CandidateInput(taxRateBps),
  });
}

export function m203b1Artifact(fill = 0x61) {
  const bytes = Buffer.concat([
    Buffer.from("%PDF-1.7\n", "latin1"),
    Buffer.alloc(128, fill),
    Buffer.from("\n%%EOF", "latin1"),
  ]);
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sizeBytes: bytes.length,
    mimeType: "application/pdf" as const,
  };
}
