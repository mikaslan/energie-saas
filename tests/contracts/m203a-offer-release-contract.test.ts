import { describe, expect, it } from "vitest";

import {
  OFFER_CANONICALIZATION_VERSION,
  OFFER_VARIANT_SNAPSHOT_VERSION,
  sealOfferVariantSnapshot,
} from "@/lib/integrations/offers/contract";
import { calculateOfferPricing } from "@/lib/integrations/offers/money";
import {
  OFFER_RECIPIENT_SNAPSHOT_VERSION,
  OFFER_RECIPIENT_REVISE_COMMAND_VERSION,
  OFFER_RELEASE_APPROVAL_COMMAND_VERSION,
  OFFER_RELEASE_CANDIDATE_APPROVAL_VERSION,
  OFFER_RELEASE_CANDIDATE_DISPATCH_VERSION,
  OFFER_RELEASE_CANDIDATE_INPUT_VERSION,
  OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION,
  OFFER_RELEASE_CANDIDATE_REQUEST_VERSION,
  OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION,
  OFFER_RELEASE_PROFILE_SNAPSHOT_VERSION,
  OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION,
  OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION,
  OfferReleaseHiddenLineError,
  OfferReleaseSourceBindingError,
  buildOfferRecipientSnapshot,
  buildOfferReleaseCandidateInput,
  buildOfferReleaseProfileSnapshot,
  hashOfferRecipientSnapshot,
  hashOfferReleaseCandidateInput,
  hashOfferReleaseProfileSnapshot,
  offerReleaseApprovalCommandV1Schema,
  offerRecipientReviseCommandV1Schema,
  offerReleaseCandidateInputV1Schema,
  offerReleaseCandidateDispatchV1Schema,
  offerReleaseCandidateRequestV1Schema,
  offerReleaseProfileActivateCommandV1Schema,
  offerReleaseProfileReviseCommandV1Schema,
  validateOfferReleaseCandidateInput,
} from "@/lib/integrations/offers/release-contract";

const ids = {
  actor: "11111111-1111-4111-8111-111111111111",
  workspace: "22222222-2222-4222-8222-222222222222",
  offer: "33333333-3333-4333-8333-333333333333",
  variant: "44444444-4444-4444-8444-444444444444",
  project: "55555555-5555-4555-8555-555555555555",
  contact: "66666666-6666-4666-8666-666666666666",
  site: "77777777-7777-4777-8777-777777777777",
  receipt: "88888888-8888-4888-8888-888888888888",
  requirement: "99999999-9999-4999-8999-999999999999",
  calculation: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  resolution: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  section: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  profile: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  profileRevision: "d1d1d1d1-d1d1-41d1-81d1-d1d1d1d1d1d1",
  recipient: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  draft: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  candidate: "12121212-1212-4212-8212-121212121212",
  otherWorkspace: "15151515-1515-4515-8515-151515151515",
  otherOffer: "16161616-1616-4616-8616-161616161616",
  otherProfile: "17171717-1717-4717-8717-171717171717",
  otherProfileRevision: "18181818-1818-4818-8818-181818181818",
} as const;

const sha = (digit: string) => digit.repeat(64);

function variantSnapshotFixture({ hidden = false }: { hidden?: boolean } = {}) {
  const lineInputs = [
    {
      lineDomainId: "13131313-1313-4313-8313-131313131313",
      position: 1,
      unit: "piece" as const,
      positionType: "required" as const,
      isHidden: hidden,
      quantityMilli: 1_000,
      salesUnitNetCents: 100_000,
      purchaseUnitNetCents: 70_000,
      lineDiscountBps: 0,
      taxRateBps: 1_900 as const,
    },
    {
      lineDomainId: "14141414-1414-4414-8414-141414141414",
      position: 2,
      unit: "meter" as const,
      positionType: "optional" as const,
      isHidden: false,
      quantityMilli: 2_500,
      salesUnitNetCents: 1_000,
      purchaseUnitNetCents: 600,
      lineDiscountBps: 0,
      taxRateBps: 0 as const,
    },
  ];
  const pricing = calculateOfferPricing({
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    // F16.3 Slice E: Cap (null = ungedeckelt).
    globalDiscountCapCents: null,
    globalFixDiscountCents: null,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: ids.section,
      position: 1,
      discountBps: 0,
      lines: lineInputs,
    }],
  });
  const values = new Map(pricing.lines.map((line) => [line.lineDomainId, line]));
  const createdAt = "2026-08-30T10:00:00.000Z";

  return sealOfferVariantSnapshot({
    schemaVersion: OFFER_VARIANT_SNAPSHOT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    workspaceId: ids.workspace,
    offerId: ids.offer,
    variantId: ids.variant,
    revision: 7,
    variantName: "  Komfort A\u0308  ",
    description: "  Kundensichtbarer Umfang  ",
    contactContext: {
      displayName: "Quellkontakt darf nicht still gewinnen",
      emailPrimary: "source-private@example.invalid",
      phoneE164: "+491701234567",
    },
    installationSiteContext: {
      addressRevision: 4,
      formattedAddress: "  Solarweg 8, 10115 Berlin  ",
      street: "Solarweg",
      houseNumber: "8",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    },
    sourceBindings: {
      projectId: ids.project,
      contactId: ids.contact,
      siteId: ids.site,
      inboundReceiptId: ids.receipt,
      inboundPayloadSha256: sha("1"),
      requirementId: ids.requirement,
      requirementRevision: 2,
      calculationRevisionId: ids.calculation,
      calculationRevision: 3,
      calculationInputSha256: sha("2"),
      calculationResultSha256: sha("3"),
      resolutionId: ids.resolution,
      resolutionRevision: 4,
      resolutionSha256: sha("4"),
    },
    priceAudienceDecision: {
      audience: "b2c",
      confirmationCode: "b2c_operator_confirmed",
      confirmedBy: ids.actor,
      confirmedAt: createdAt,
    },
    taxDecision: {
      treatment: "standard_19",
      rateBps: 1_900,
      selectedBy: ids.actor,
      selectedAt: createdAt,
    },
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    // F16.3 Slice E: Cap (null = ungedeckelt).
    globalDiscountCapCents: null,
    globalFixDiscountCents: null,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: ids.section,
      position: 1,
      category: "other",
      title: "  Anlage & Montage  ",
      discountBps: 0,
      lines: lineInputs.map((line, index) => {
        const calculated = values.get(line.lineDomainId)!;
        const zero = line.taxRateBps === 0;
        return {
          lineDomainId: line.lineDomainId,
          position: line.position,
          componentCategory: "other" as const,
          positionType: line.positionType,
          isHidden: line.isHidden,
          quantityMilli: line.quantityMilli,
          product: {
            kind: "custom" as const,
            displayName: index === 0 ? "PV-Anlage <Premium>" : "Optionales Kabel",
            description: index === 0 ? "Montage & Inbetriebnahme" : null,
            unit: line.unit,
          },
          source: { kind: "custom" as const, enteredBy: ids.actor, enteredAt: createdAt },
          salesPricing: {
            originalUnitNetCents: line.salesUnitNetCents,
            effectiveUnitNetCents: line.salesUnitNetCents,
            provenance: { kind: "custom" as const, enteredBy: ids.actor, enteredAt: createdAt },
          },
          purchasePricing: {
            originalUnitNetCents: line.purchaseUnitNetCents,
            effectiveUnitNetCents: line.purchaseUnitNetCents,
            provenance: { kind: "custom" as const, enteredBy: ids.actor, enteredAt: createdAt },
          },
          lineDiscountBps: line.lineDiscountBps,
          taxTreatment: zero ? "zero_operator_confirmed" as const : "standard_19" as const,
          taxRateBps: line.taxRateBps,
          taxDecision: zero ? {
            treatment: "zero_operator_confirmed" as const,
            rateBps: 0 as const,
            selectedBy: ids.actor,
            selectedAt: createdAt,
            confirmationCode: "zero_tax_draft_operator_confirmed" as const,
            confirmedBy: ids.actor,
            confirmedAt: createdAt,
          } : {
            treatment: "standard_19" as const,
            rateBps: 1_900 as const,
            selectedBy: ids.actor,
            selectedAt: createdAt,
          },
          computed: {
            lineBaseNetCents: calculated.lineBaseNetCents,
            lineDiscountedNetCents: calculated.lineDiscountedNetCents,
            sectionDiscountedNetCents: calculated.sectionDiscountedNetCents,
            finalSalesNetCents: calculated.finalSalesNetCents,
            salesTaxCents: calculated.salesTaxCents,
            salesGrossCents: calculated.salesGrossCents,
            purchaseNetCents: calculated.purchaseNetCents,
          },
        };
      }),
    }],
    totals: pricing.totals,
    createdBy: ids.actor,
    createdAt,
  });
}

function profileFixture({
  workspaceId = ids.workspace,
  profileId = ids.profile,
  profileRevisionId = ids.profileRevision,
}: {
  workspaceId?: string;
  profileId?: string;
  profileRevisionId?: string;
} = {}) {
  return buildOfferReleaseProfileSnapshot({
    profileId,
    profileRevisionId,
    workspaceId,
    revision: 3,
    profileName: "  WMEE Testprofil A\u0308  ",
    sender: {
      legalName: "  Beispiel Energie GmbH  ",
      tradingName: "  Beispiel Solar  ",
      representedBy: "  Erika Beispiel  ",
      address: {
        street: "  Musterstraße  ",
        houseNumber: "  9a  ",
        postalCode: "  10115  ",
        city: "  Berlin  ",
        country: "DE",
      },
      email: "  ANGEBOT@EXAMPLE.INVALID  ",
      phoneE164: "+49301234567",
      websiteHttpsUrl: "https://example.invalid",
      registerCourt: "Amtsgericht Beispiel",
      registerNumber: "HRB 12345",
      vatId: "DE000000000",
    },
    legalDocuments: {
      terms: {
        title: "  Angebotsbedingungen  ",
        plainText: "  Zeile eins\nZeile zwei <kein HTML>  ",
      },
      withdrawalInformation: {
        title: "  Widerrufsinformation  ",
        plainText: "  Synthetischer Testtext, keine Rechtsberatung.  ",
      },
      privacyNotice: {
        title: "  Datenschutzhinweis  ",
        plainText: "  Synthetischer Datenschutzhinweis.  ",
      },
    },
    createdBy: ids.actor,
    createdAt: "2026-08-30T10:05:00.000Z",
  });
}

function recipientFixture({
  workspaceId = ids.workspace,
  offerId = ids.offer,
}: {
  workspaceId?: string;
  offerId?: string;
} = {}) {
  return buildOfferRecipientSnapshot({
    recipientRevisionId: ids.recipient,
    workspaceId,
    offerId,
    revision: 2,
    displayName: "  Mia A\u0308. Muster  ",
    company: null,
    email: "  MIA@EXAMPLE.INVALID  ",
    billingAddress: {
      street: "  Rechnungsweg  ",
      houseNumber: "  17 b  ",
      postalCode: "  10117  ",
      city: "  Berlin  ",
      country: "DE",
    },
    confirmationCode: "recipient_billing_operator_confirmed",
    confirmedBy: ids.actor,
    confirmedAt: "2026-08-30T10:10:00.000Z",
    createdBy: ids.actor,
    createdAt: "2026-08-30T10:10:00.000Z",
  });
}

function candidateInputFixture() {
  return buildOfferReleaseCandidateInput({
    offerNumber: "ANG-2026-000042",
    preparedAt: "2026-08-30T11:22:33.000Z",
    documentDate: "2026-08-30",
    validThrough: "2026-09-12",
    profileSnapshot: profileFixture(),
    recipientSnapshot: recipientFixture(),
    variantSnapshot: variantSnapshotFixture(),
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

describe("M2-03a offer release contracts", () => {
  it("pinnt alle Versionen und kennt ausschliesslich not_issued", () => {
    expect(OFFER_RELEASE_PROFILE_SNAPSHOT_VERSION).toBe("offer-release-profile-snapshot.v1");
    expect(OFFER_RECIPIENT_SNAPSHOT_VERSION).toBe("offer-recipient-snapshot.v1");
    expect(OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION)
      .toBe("offer-release-profile-revise-command.v1");
    expect(OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION)
      .toBe("offer-release-profile-activate-command.v1");
    expect(OFFER_RECIPIENT_REVISE_COMMAND_VERSION)
      .toBe("offer-recipient-revise-command.v1");
    expect(OFFER_RELEASE_CANDIDATE_REQUEST_VERSION).toBe("offer-release-candidate-request.v1");
    expect(OFFER_RELEASE_CANDIDATE_DISPATCH_VERSION)
      .toBe("offer-release-candidate-dispatch.v1");
    expect(OFFER_RELEASE_CANDIDATE_INPUT_VERSION).toBe("offer-release-candidate-input.v1");
    expect(OFFER_RELEASE_APPROVAL_COMMAND_VERSION).toBe("offer-release-approval-command.v1");
    expect(OFFER_RELEASE_CANDIDATE_APPROVAL_VERSION)
      .toBe("offer-release-candidate-approval.v1");
    expect(OFFER_RELEASE_CANDIDATE_TEMPLATE_VERSION).toBe("offer-release-candidate-template.v1");
    expect(OFFER_RELEASE_CANDIDATE_RENDERER_RECIPE_VERSION).toMatch(
      /^offer-release-candidate-renderer-recipe\.v1-linux-amd64-pw1\.62\.1-[0-9a-f]{64}$/u,
    );
    expect(candidateInputFixture().documentStatus).toBe("not_issued");
  });

  it("normalisiert und versiegelt ein reines Plain-Text-Profil ohne Default", () => {
    const profile = profileFixture();

    expect(profile).toMatchObject({
      schemaVersion: "offer-release-profile-snapshot.v1",
      canonicalizationVersion: "offer-jcs.v1",
      profileId: ids.profile,
      profileRevisionId: ids.profileRevision,
      workspaceId: ids.workspace,
      revision: 3,
      profileName: "WMEE Testprofil Ä",
      locale: "de-DE",
      currency: "EUR",
      sender: {
        legalName: "Beispiel Energie GmbH",
        email: "angebot@example.invalid",
      },
    });
    expect(profile.legalDocuments.terms.plainText).toBe("Zeile eins\nZeile zwei <kein HTML>");
    expect(profile.snapshotSha256).toBe(hashOfferReleaseProfileSnapshot(profile));
    expect(profile.snapshotSha256).toMatch(/^[0-9a-f]{64}$/u);

    expect(() => buildOfferReleaseProfileSnapshot({
      ...profile,
      snapshotSha256: undefined,
      legalDocuments: {
        ...profile.legalDocuments,
        terms: { ...profile.legalDocuments.terms, plainText: "\u0000" },
      },
    })).toThrow(/profil/iu);
  });

  it("versiegelt Rechnungsdaten getrennt vom Anlagenstandort", () => {
    const recipient = recipientFixture();

    expect(recipient).toMatchObject({
      displayName: "Mia Ä. Muster",
      email: "mia@example.invalid",
      billingAddress: {
        street: "Rechnungsweg",
        houseNumber: "17 b",
        postalCode: "10117",
        city: "Berlin",
        country: "DE",
      },
      confirmation: {
        code: "recipient_billing_operator_confirmed",
        confirmed: true,
      },
    });
    expect(recipient.snapshotSha256).toBe(hashOfferRecipientSnapshot(recipient));
    expect(JSON.stringify(recipient)).not.toContain("Solarweg");
  });

  it("nimmt fuer Candidate-Requests nur IDs, erwartete Revisionen und Gueltigkeit an", () => {
    const request = {
      schemaVersion: OFFER_RELEASE_CANDIDATE_REQUEST_VERSION,
      workspaceId: ids.workspace,
      offerId: ids.offer,
      variantId: ids.variant,
      expectedVariantRevision: 7,
      sourcePdfDraftId: ids.draft,
      documentProfileId: ids.profile,
      documentProfileRevisionId: ids.profileRevision,
      expectedDocumentProfileRevision: 3,
      recipientRevisionId: ids.recipient,
      expectedRecipientRevision: 2,
      validThrough: "2026-09-12",
    };
    expect(offerReleaseCandidateRequestV1Schema.safeParse(request).success).toBe(true);
    expect(offerReleaseCandidateRequestV1Schema.safeParse({
      ...request,
      recipientDisplayName: "Client-controlled",
    }).success).toBe(false);
    expect(offerReleaseCandidateRequestV1Schema.safeParse({
      ...request,
      basisGrossCents: 1,
    }).success).toBe(false);
  });

  it("nimmt fuer Profil, Aktivierung und Empfaenger nur fachliche Commands an", () => {
    const profile = profileFixture();
    const recipient = recipientFixture();
    const reviseProfile = {
      schemaVersion: OFFER_RELEASE_PROFILE_REVISE_COMMAND_VERSION,
      workspaceId: ids.workspace,
      expectedCurrentRevision: 2,
      profileName: profile.profileName,
      sender: profile.sender,
      legalDocuments: profile.legalDocuments,
    };
    expect(offerReleaseProfileReviseCommandV1Schema.safeParse(reviseProfile).success).toBe(true);
    expect(offerReleaseProfileReviseCommandV1Schema.safeParse({
      ...reviseProfile,
      createdBy: ids.actor,
    }).success).toBe(false);

    const activateProfile = {
      schemaVersion: OFFER_RELEASE_PROFILE_ACTIVATE_COMMAND_VERSION,
      workspaceId: ids.workspace,
      profileId: ids.profile,
      profileRevisionId: ids.profileRevision,
      expectedProfileRevision: 3,
    };
    expect(offerReleaseProfileActivateCommandV1Schema.safeParse(activateProfile).success)
      .toBe(true);
    expect(offerReleaseProfileActivateCommandV1Schema.safeParse({
      ...activateProfile,
      snapshotSha256: profile.snapshotSha256,
    }).success).toBe(false);

    const reviseRecipient = {
      schemaVersion: OFFER_RECIPIENT_REVISE_COMMAND_VERSION,
      workspaceId: ids.workspace,
      offerId: ids.offer,
      expectedCurrentRevision: 1,
      displayName: recipient.displayName,
      company: recipient.company,
      email: recipient.email,
      billingAddress: recipient.billingAddress,
      billingDetailsConfirmed: true,
    };
    expect(offerRecipientReviseCommandV1Schema.safeParse(reviseRecipient).success).toBe(true);
    expect(offerRecipientReviseCommandV1Schema.safeParse({
      ...reviseRecipient,
      confirmedAt: recipient.confirmation.confirmedAt,
    }).success).toBe(false);
  });

  it("begrenzt den Worker-Dispatch strikt auf Workspace- und Candidate-ID", () => {
    const dispatch = {
      schemaVersion: OFFER_RELEASE_CANDIDATE_DISPATCH_VERSION,
      workspaceId: ids.workspace,
      candidateId: ids.candidate,
    };
    expect(offerReleaseCandidateDispatchV1Schema.safeParse(dispatch).success).toBe(true);
    expect(offerReleaseCandidateDispatchV1Schema.safeParse({
      ...dispatch,
      inputSnapshot: candidateInputFixture(),
    }).success).toBe(false);
  });

  it("baut einen minimierten, arithmetisch geschlossenen Kundenrenderstand", () => {
    const candidate = candidateInputFixture();

    expect(candidate).toMatchObject({
      documentStatus: "not_issued",
      documentDate: "2026-08-30",
      validThrough: "2026-09-12",
      recipient: {
        displayName: "Mia Ä. Muster",
        billingAddress: { formattedAddress: "Rechnungsweg 17 b, 10117 Berlin" },
      },
      installationSite: { formattedAddress: "Solarweg 8, 10115 Berlin" },
      profile: { revision: 3, name: "WMEE Testprofil Ä" },
      variant: { name: "Komfort Ä", revision: 7 },
    });
    expect(candidate.sections[0]!.lines).toHaveLength(2);
    expect(candidate.sections[0]!.lines[0]).toMatchObject({
      title: "PV-Anlage <Premium>",
      salesUnitNetCents: 100_000,
      taxRateBps: 1_900,
    });
    expect(hashOfferReleaseCandidateInput(candidate)).toMatch(/^[0-9a-f]{64}$/u);

    const keys = collectKeys(candidate);
    for (const forbidden of [
      "workspaceId", "offerId", "variantId", "recipientRevisionId", "profileId",
      "profileRevisionId",
      "snapshotSha256", "email", "phoneE164", "websiteHttpsUrl", "sourceBindings",
      "source", "purchasePricing", "purchaseUnitNetCents", "purchaseNetCents",
      "marginNetCents", "provenance", "createdBy", "createdAt", "isHidden",
    ]) expect(keys.has(forbidden), forbidden).toBe(false);
    expect(JSON.stringify(candidate)).not.toContain("source-private");
    expect(JSON.stringify(candidate)).not.toContain("70000");
  });

  it("blockiert jede Hidden-Zeile statt Inhalt oder Summen still umzudeuten", () => {
    expect(() => buildOfferReleaseCandidateInput({
      offerNumber: "ANG-2026-000042",
      preparedAt: "2026-08-30T11:22:33.000Z",
      documentDate: "2026-08-30",
      validThrough: "2026-09-12",
      profileSnapshot: profileFixture(),
      recipientSnapshot: recipientFixture(),
      variantSnapshot: variantSnapshotFixture({ hidden: true }),
    })).toThrow(OfferReleaseHiddenLineError);
  });

  it("blockiert gueltig versiegelte Profil- und Empfaengerstaende aus einem anderen Graphen", () => {
    expect(() => buildOfferReleaseCandidateInput({
      offerNumber: "ANG-2026-000042",
      preparedAt: "2026-08-30T11:22:33.000Z",
      documentDate: "2026-08-30",
      validThrough: "2026-09-12",
      profileSnapshot: profileFixture({
        workspaceId: ids.otherWorkspace,
        profileId: ids.otherProfile,
        profileRevisionId: ids.otherProfileRevision,
      }),
      recipientSnapshot: recipientFixture(),
      variantSnapshot: variantSnapshotFixture(),
    })).toThrow(OfferReleaseSourceBindingError);

    expect(() => buildOfferReleaseCandidateInput({
      offerNumber: "ANG-2026-000042",
      preparedAt: "2026-08-30T11:22:33.000Z",
      documentDate: "2026-08-30",
      validThrough: "2026-09-12",
      profileSnapshot: profileFixture(),
      recipientSnapshot: recipientFixture({ offerId: ids.otherOffer }),
      variantSnapshot: variantSnapshotFixture(),
    })).toThrow(OfferReleaseSourceBindingError);
  });

  it("verweigert ungueltige Gueltigkeit, unbekannte Felder und Summendrift", () => {
    const input = candidateInputFixture();
    for (const validThrough of ["2026-08-30", "2026-10-30", "kein-datum"]) {
      expect(offerReleaseCandidateInputV1Schema.safeParse({
        ...input,
        validThrough,
      }).success, validThrough).toBe(false);
    }
    expect(offerReleaseCandidateInputV1Schema.safeParse({
      ...input,
      issued: true,
    }).success).toBe(false);

    const result = validateOfferReleaseCandidateInput({
      ...input,
      totals: { ...input.totals, basisGrossCents: input.totals.basisGrossCents + 1 },
    });
    expect(result).toEqual({ ok: false, paths: ["/totals/basisGrossCents", "/totals"] });
  });

  it("leitet das Dokumentdatum auch an UTC-Tagesgrenzen aus Europe/Berlin ab", () => {
    const input = candidateInputFixture();

    expect(offerReleaseCandidateInputV1Schema.safeParse({
      ...input,
      preparedAt: "2026-08-30T22:30:00.000Z",
      documentDate: "2026-08-31",
      validThrough: "2026-09-01",
    }).success).toBe(true);
    expect(offerReleaseCandidateInputV1Schema.safeParse({
      ...input,
      preparedAt: "2026-08-30T22:30:00.000Z",
      documentDate: "2026-08-30",
      validThrough: "2026-08-31",
    }).success).toBe(false);
  });

  it("laesst Approval nur als feste Checkliste ohne clientseitige Hashes zu", () => {
    const approval = {
      schemaVersion: OFFER_RELEASE_APPROVAL_COMMAND_VERSION,
      workspaceId: ids.workspace,
      offerId: ids.offer,
      candidateId: ids.candidate,
      expectedArtifactVersion: "abababab-abab-4bab-8bab-abababababab",
      recipientBillingReviewed: true,
      commercialContentReviewed: true,
      activeProfileReviewed: true,
      notIssuedStatusUnderstood: true,
      zeroTaxTreatmentReviewed: true,
    };
    expect(offerReleaseApprovalCommandV1Schema.safeParse(approval).success).toBe(true);
    expect(offerReleaseApprovalCommandV1Schema.safeParse({
      ...approval,
      artifactSha256: sha("9"),
    }).success).toBe(false);
    expect(offerReleaseApprovalCommandV1Schema.safeParse({
      ...approval,
      commercialContentReviewed: false,
    }).success).toBe(false);
    const { expectedArtifactVersion: ignoredVersion, ...withoutVersion } = approval;
    void ignoredVersion;
    expect(offerReleaseApprovalCommandV1Schema.safeParse(withoutVersion).success).toBe(false);
    expect(offerReleaseApprovalCommandV1Schema.safeParse({
      ...approval,
      expectedArtifactVersion: "not-a-uuid",
    }).success).toBe(false);
  });

  it("pinnt kanonische Golden Hashes fuer Profil, Empfaenger und Candidate", () => {
    expect(hashOfferReleaseProfileSnapshot(profileFixture()))
      .toBe("de7db1eab333f801642c867cfd9e7b643f8e96fd7daf8dce7733806e87f4afa3");
    expect(hashOfferRecipientSnapshot(recipientFixture()))
      .toBe("23349d6b19073f6cf8d696983f225533d5f6d18a31349beee7ccacbae6c5c01f");
    expect(hashOfferReleaseCandidateInput(candidateInputFixture()))
      .toBe("23efebd94974794822386836ecdb31a5e47350543bc16a304359785f55c4d717");
  });
});
