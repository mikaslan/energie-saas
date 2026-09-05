import { describe, expect, it } from "vitest";
import {
  OFFER_CANONICALIZATION_VERSION,
  OFFER_VARIANT_SNAPSHOT_VERSION,
  sealOfferVariantSnapshot,
} from "@/lib/integrations/offers/contract";
import { calculateOfferPricing } from "@/lib/integrations/offers/money";
import {
  OFFER_PDF_DRAFT_INPUT_VERSION,
  OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
  OFFER_PDF_DRAFT_TEMPLATE_VERSION,
  buildOfferPdfDraftInput,
  hashOfferPdfDraftInput,
  offerPdfDraftInputV1Schema,
  validateOfferPdfDraftInput,
} from "@/lib/integrations/offers/pdf-contract";

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
} as const;

const sha = (digit: string) => digit.repeat(64);
const lineId = (index: number) =>
  `dddddddd-dddd-4ddd-8ddd-${index.toString(16).padStart(12, "0")}`;

function snapshotFixture(lineCount = 4) {
  const lineInputs = Array.from({ length: lineCount }, (_, index) => ({
    lineDomainId: lineId(index + 1),
    position: index + 1,
    unit: index === 1 ? "meter" as const : "piece" as const,
    positionType: index === 2 ? "optional" as const
      : index === 1 ? "additional" as const : "required" as const,
    isHidden: index === 3,
    quantityMilli: index === 1 ? 2_500 : 1_000,
    salesUnitNetCents: index === 2 ? 20_000 : 10_000,
    purchaseUnitNetCents: 7_777,
    lineDiscountBps: index === 0 ? 500 : 0,
    taxRateBps: index === 1 ? 0 as const : 1_900 as const,
  }));
  const pricing = calculateOfferPricing({
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 250,
    globalFixDiscountCents: null,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: ids.section,
      position: 1,
      discountBps: 100,
      lines: lineInputs,
    }],
  });
  const calculatedById = new Map(pricing.lines.map((line) => [line.lineDomainId, line]));
  const createdAt = "2026-08-30T10:00:00.000Z";

  return sealOfferVariantSnapshot({
    schemaVersion: OFFER_VARIANT_SNAPSHOT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    workspaceId: ids.workspace,
    offerId: ids.offer,
    variantId: ids.variant,
    revision: 7,
    variantName: "  Komfort A\u0308  ",
    description: "  Geprüfter Leistungsumfang  ",
    contactContext: {
      displayName: "  Mia <Muster>  ",
      emailPrimary: "pdf-private-sentinel@example.test",
      phoneE164: "+491701234567",
    },
    installationSiteContext: {
      addressRevision: 4,
      formattedAddress: "  Solstraße 8, 10115 Berlin  ",
      street: "Solstraße",
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
    globalDiscountBps: 250,
    globalFixDiscountCents: null,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: ids.section,
      position: 1,
      category: "other",
      title: "  Montage & Zubehör  ",
      discountBps: 100,
      lines: lineInputs.map((line, index) => {
        const calculated = calculatedById.get(line.lineDomainId)!;
        return {
          lineDomainId: line.lineDomainId,
          position: line.position,
          componentCategory: "other" as const,
          positionType: line.positionType,
          isHidden: line.isHidden,
          quantityMilli: line.quantityMilli,
          product: {
            kind: "custom" as const,
            displayName: index === 3 ? "VERSTECKTE POSITION" : ` Position ${index + 1} `,
            description: index === 0 ? " <script>privat()</script> & sicher " : null,
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
          taxTreatment: line.taxRateBps === 0
            ? "zero_operator_confirmed" as const
            : "standard_19" as const,
          taxRateBps: line.taxRateBps,
          taxDecision: line.taxRateBps === 0 ? {
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

function directInput(lineCount = 1) {
  return {
    schemaVersion: "offer-pdf-draft-input.v1",
    canonicalizationVersion: "offer-jcs.v1",
    templateVersion: "offer-pdf-draft-template.v1",
    rendererRecipeVersion: "offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac",
    offerNumber: "ANG-2026-000042",
    preparedAt: "2026-08-30T11:22:33.000Z",
    recipient: { displayName: "Mia Muster" },
    installationSite: { formattedAddress: "Solstraße 8, 10115 Berlin" },
    variant: { name: "Basis", revision: 7 },
    commercialTerms: { globalDiscountBps: 0, globalFixDiscountCents: null, customDealNetCents: null },
    sections: [{
      position: 1,
      title: "Leistungsumfang",
      discountBps: 0,
      lines: Array.from({ length: lineCount }, (_, index) => ({
        position: index + 1,
        title: `Position ${index + 1}`,
        description: null,
        quantityMilli: 1_000,
        unit: "piece" as const,
        positionType: "required" as const,
        isHidden: false,
        salesUnitNetCents: 100,
        lineDiscountBps: 0,
        taxRateBps: 1_900 as const,
        finalNetCents: 100,
        taxCents: 19,
        grossCents: 119,
      })),
    }],
    totals: {
      basisNetCents: lineCount * 100,
      basisTaxCents: lineCount * 19,
      basisGrossCents: lineCount * 119,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
  };
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

describe("offer-pdf-draft-input.v1 contract", () => {
  it("pinnt alle fachlichen Versionen und akzeptiert nur UTC-Zeitpunkte", () => {
    expect(OFFER_PDF_DRAFT_INPUT_VERSION).toBe("offer-pdf-draft-input.v1");
    expect(OFFER_PDF_DRAFT_TEMPLATE_VERSION).toBe("offer-pdf-draft-template.v1");
    expect(OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION)
      .toBe("offer-pdf-draft-renderer-recipe.v1-linux-amd64-pw1.62.1-c091b21d9fae78c76e85cd4356431e9b018402f172a214fc7d7a5e9a7e29d8ac");
    expect(offerPdfDraftInputV1Schema.safeParse(directInput()).success).toBe(true);
    expect(offerPdfDraftInputV1Schema.safeParse({
      ...directInput(),
      offerNumber: "ANG-2026-0042",
    }).success).toBe(false);

    for (const preparedAt of [
      "2026-08-30T13:22:33.000+02:00",
      "2026-08-30T11:22:33",
      "kein-zeitpunkt",
    ]) {
      expect(offerPdfDraftInputV1Schema.safeParse({
        ...directInput(),
        preparedAt,
      }).success, preparedAt).toBe(false);
    }
  });

  it("ist auf jeder Ebene strikt und begrenzt den Dokumentstand auf 500 Zeilen", () => {
    expect(offerPdfDraftInputV1Schema.safeParse({
      ...directInput(),
      workspaceId: ids.workspace,
    }).success).toBe(false);
    expect(offerPdfDraftInputV1Schema.safeParse({
      ...directInput(),
      recipient: { displayName: "Mia", email: "private@example.test" },
    }).success).toBe(false);
    expect(offerPdfDraftInputV1Schema.safeParse({
      ...directInput(),
      variant: { ...directInput().variant, description: "Interne Notiz" },
    }).success).toBe(false);
    expect(offerPdfDraftInputV1Schema.safeParse({
      ...directInput(),
      sections: [{
        ...directInput().sections[0],
        lines: [{ ...directInput().sections[0]!.lines[0], purchaseUnitNetCents: 1 }],
      }],
    }).success).toBe(false);

    expect(offerPdfDraftInputV1Schema.safeParse(directInput(500)).success).toBe(true);
    const tooMany = directInput(500);
    tooMany.sections.push({
      ...directInput().sections[0]!,
      position: 2,
      title: "Eine Zeile zu viel",
      lines: directInput().sections[0]!.lines,
    });
    tooMany.totals.basisNetCents += 100;
    tooMany.totals.basisTaxCents += 19;
    tooMany.totals.basisGrossCents += 119;
    expect(validateOfferPdfDraftInput(tooMany)).toEqual({
      ok: false,
      paths: ["/sections"],
    });
  });

  it("minimiert einen hashvaliden Snapshot ohne IDs, Hashes, Kontaktkanäle oder EK", () => {
    const built = buildOfferPdfDraftInput({
      offerNumber: "  ANG-2026-000042  ",
      preparedAt: "2026-08-30T11:22:33.000Z",
      variantSnapshot: snapshotFixture(),
    });

    expect(built).toMatchObject({
      offerNumber: "ANG-2026-000042",
      preparedAt: "2026-08-30T11:22:33.000Z",
      recipient: { displayName: "Mia <Muster>" },
      installationSite: { formattedAddress: "Solstraße 8, 10115 Berlin" },
      variant: { name: "Komfort Ä", revision: 7 },
      commercialTerms: { globalDiscountBps: 250, globalFixDiscountCents: null, customDealNetCents: null },
    });
    expect(built.variant).toEqual({ name: "Komfort Ä", revision: 7 });
    expect(built.sections).toHaveLength(1);
    expect(built.sections[0]!.lines.map((line) => line.title))
      .toEqual(["Position 1", "Position 2", "Position 3", "VERSTECKTE POSITION"]);
    expect(built.sections[0]!.lines[0]).toMatchObject({
      description: "<script>privat()</script> & sicher",
      salesUnitNetCents: 10_000,
      lineDiscountBps: 500,
      taxRateBps: 1_900,
    });

    const keys = collectKeys(built);
    for (const forbidden of [
      "workspaceId", "offerId", "variantId", "lineDomainId", "sectionDomainId",
      "snapshotSha256", "emailPrimary", "phoneE164", "sourceBindings", "source",
      "purchasePricing", "purchaseUnitNetCents", "purchaseNetCents", "marginNetCents",
      "provenance", "createdBy", "createdAt",
    ]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(JSON.stringify(built)).not.toContain("pdf-private-sentinel");
    expect(JSON.stringify(built)).not.toContain("7777");
    expect(built.sections[0]!.lines[3]).toMatchObject({
      title: "VERSTECKTE POSITION",
      isHidden: true,
    });
  });

  it("verwirft Snapshot-Drift und liefert bei Inputfehlern stabile JSON-Pfade", () => {
    const snapshot = snapshotFixture();
    const tampered = structuredClone(snapshot);
    tampered.contactContext.displayName = "Nach dem Seal geändert";
    expect(() => buildOfferPdfDraftInput({
      offerNumber: "ANG-2026-000042",
      preparedAt: "2026-08-30T11:22:33.000Z",
      variantSnapshot: tampered,
    })).toThrow(/Snapshot/u);

    const result = validateOfferPdfDraftInput({
      ...directInput(),
      recipient: { displayName: "" },
    });
    expect(result).toEqual({ ok: false, paths: ["/recipient/displayName"] });
  });

  it("verweigert arithmetisch entkoppelte Dokument- und Zeilensummen", () => {
    const input = directInput();
    expect(validateOfferPdfDraftInput({
      ...input,
      totals: {
        basisNetCents: 0,
        basisTaxCents: 0,
        basisGrossCents: 0,
        optionalNetCents: 0,
        optionalTaxCents: 0,
        optionalGrossCents: 0,
      },
    })).toEqual({ ok: false, paths: ["/totals"] });

    const wrongTax = directInput();
    wrongTax.sections[0]!.lines[0]!.taxCents = 20;
    wrongTax.sections[0]!.lines[0]!.grossCents = 120;
    wrongTax.totals.basisTaxCents = 20;
    wrongTax.totals.basisGrossCents = 120;
    expect(validateOfferPdfDraftInput(wrongTax)).toEqual({
      ok: false,
      paths: ["/sections/0/lines/0/taxCents"],
    });
  });

  it("kanonisiert Unicode und Objektreihenfolge zu einem gepinnten SHA-256", () => {
    const parsed = offerPdfDraftInputV1Schema.parse({
      ...directInput(),
      variant: { name: "A\u0308nderung", revision: 7 },
    });
    const reordered = {
      totals: parsed.totals,
      sections: parsed.sections,
      commercialTerms: parsed.commercialTerms,
      variant: { revision: 7, name: "Änderung" },
      installationSite: parsed.installationSite,
      recipient: parsed.recipient,
      preparedAt: parsed.preparedAt,
      offerNumber: parsed.offerNumber,
      rendererRecipeVersion: parsed.rendererRecipeVersion,
      templateVersion: parsed.templateVersion,
      canonicalizationVersion: parsed.canonicalizationVersion,
      schemaVersion: parsed.schemaVersion,
    };

    expect(hashOfferPdfDraftInput(parsed)).toBe(hashOfferPdfDraftInput(reordered));
    expect(hashOfferPdfDraftInput(parsed))
      .toBe("cfa07bcbccffe7c01ee42f6528c9e60483db54a311f17bd792b9caae677868e4");
  });
});
