// F16.3 Snapshot-Ketten (DB-frei): strikte v1/v2-Gestalt wird upgegradet,
// Misch-Gestalten (falsches Literal + artfremde Keys) werden abgewiesen.
// Schützt den Verlaufskontrakt gegen stille Shape-Drift (Slice D/E).
import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  canonicalizeOfferJson,
  validateOfferVariantSnapshot,
} from "@/lib/integrations/offers/contract";
import {
  OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
  offerPdfDraftInputV1Schema,
} from "@/lib/integrations/offers/pdf-contract";

const hex64 = (seed: string): string =>
  createHash("sha256").update(seed, "utf8").digest("hex");

function v1Body(): Record<string, unknown> {
  const actor = randomUUID();
  const createdAt = "2026-08-29T12:00:00.000Z";
  return {
    schemaVersion: "offer-variant-snapshot.v1",
    canonicalizationVersion: "offer-jcs.v1",
    workspaceId: randomUUID(),
    offerId: randomUUID(),
    variantId: randomUUID(),
    revision: 1,
    sourceBindings: {
      projectId: randomUUID(),
      contactId: randomUUID(),
      siteId: randomUUID(),
      inboundReceiptId: randomUUID(),
      inboundPayloadSha256: hex64("inbound"),
      requirementId: randomUUID(),
      requirementRevision: 1,
      calculationRevisionId: randomUUID(),
      calculationRevision: 1,
      calculationInputSha256: hex64("calc-in"),
      calculationResultSha256: hex64("calc-out"),
      resolutionId: randomUUID(),
      resolutionRevision: 1,
      resolutionSha256: hex64("resolution"),
    },
    priceAudienceDecision: {
      audience: "b2c",
      confirmationCode: "b2c_operator_confirmed",
      confirmedBy: actor,
      confirmedAt: createdAt,
    },
    taxDecision: { treatment: "standard_19", rateBps: 1_900, selectedBy: actor, selectedAt: createdAt },
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    customDealNetCents: null,
    contactContext: { displayName: "Ketten-Fixture", emailPrimary: null, phoneE164: null },
    installationSiteContext: {
      addressRevision: 1,
      formattedAddress: "Testweg 1, 10115 Berlin",
      street: "Testweg",
      houseNumber: "1",
      postalCode: "10115",
      city: "Berlin",
      country: "DE",
    },
    variantName: "Basis",
    description: "Ketten-Fixture",
    createdBy: actor,
    createdAt,
    totals: {
      basisNetCents: 100, basisTaxCents: 19, basisGrossCents: 119,
      optionalNetCents: 0, optionalTaxCents: 0, optionalGrossCents: 0,
    },
    sections: [{
      sectionDomainId: randomUUID(),
      position: 1,
      category: "other",
      title: "Kette",
      discountBps: 0,
      lines: [{
        lineDomainId: randomUUID(),
        position: 1,
        componentCategory: "other",
        positionType: "required",
        isHidden: false,
        quantityMilli: 1_000,
        product: { kind: "custom", displayName: "Position", description: null, unit: "piece" },
        source: { kind: "custom", enteredBy: actor, enteredAt: createdAt },
        salesPricing: {
          originalUnitNetCents: 100, effectiveUnitNetCents: 100,
          provenance: { kind: "custom", enteredBy: actor, enteredAt: createdAt },
        },
        purchasePricing: {
          originalUnitNetCents: 50, effectiveUnitNetCents: 50,
          provenance: { kind: "custom", enteredBy: actor, enteredAt: createdAt },
        },
        lineDiscountBps: 0,
        taxTreatment: "standard_19",
        taxRateBps: 1_900,
        taxDecision: { treatment: "standard_19", rateBps: 1_900, selectedBy: actor, selectedAt: createdAt },
        computed: {
          lineBaseNetCents: 100, lineDiscountedNetCents: 100,
          sectionDiscountedNetCents: 100, finalSalesNetCents: 100,
          salesTaxCents: 19, salesGrossCents: 119, purchaseNetCents: 50,
        },
      }],
    }],
  };
}

function sealLikeFixture(body: Record<string, unknown>): Record<string, unknown> {
  const sha = createHash("sha256").update(canonicalizeOfferJson(body), "utf8").digest("hex");
  return { ...body, snapshotSha256: sha };
}

describe("F16.3 Snapshot-Ketten", () => {
  it("reine v1-Gestalt: ok, sha läuft durch, v3-Normalform mit null-Carry", () => {
    const sealed = sealLikeFixture(v1Body());
    const result = validateOfferVariantSnapshot(sealed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.snapshotSha256).toBe(sealed.snapshotSha256);
    expect(result.value.schemaVersion).toBe("offer-variant-snapshot.v3");
    expect(result.value.globalFixDiscountCents).toBeNull();
    expect(result.value.globalDiscountCapCents).toBeNull();
  });

  it("v1-Literal + Cap-Key: abgewiesen (keine Kette zuständig)", () => {
    const sealed = sealLikeFixture({ ...v1Body(), globalDiscountCapCents: null });
    expect(validateOfferVariantSnapshot(sealed).ok).toBe(false);
  });

  it("v1-Literal + Fix-Key: abgewiesen (keine Kette zuständig)", () => {
    const sealed = sealLikeFixture({ ...v1Body(), globalFixDiscountCents: null });
    expect(validateOfferVariantSnapshot(sealed).ok).toBe(false);
  });

  it("echte v2-Gestalt: ok per v2-Kette", () => {
    const sealed = sealLikeFixture({
      ...v1Body(),
      schemaVersion: "offer-variant-snapshot.v2",
      globalFixDiscountCents: 0,
    });
    expect(validateOfferVariantSnapshot(sealed).ok).toBe(true);
  });

  it("PDF-Input: mit Fix-Key ok, ohne Fix-Key abgewiesen", () => {
    const commercialTerms = {
      globalDiscountBps: 0,
      globalDiscountCapCents: null,
      globalFixDiscountCents: null,
      customDealNetCents: null,
    };
    const input = {
      schemaVersion: "offer-pdf-draft-input.v1",
      canonicalizationVersion: "offer-jcs.v1",
      templateVersion: "offer-pdf-draft-template.v1",
      rendererRecipeVersion: OFFER_PDF_DRAFT_RENDERER_RECIPE_VERSION,
      offerNumber: "ANG-2026-000042",
      preparedAt: "2026-08-29T12:00:00.000Z",
      recipient: { displayName: "Mia Muster" },
      installationSite: { formattedAddress: "Solstraße 8, 10115 Berlin" },
      variant: { name: "Komfort", revision: 7 },
      commercialTerms,
      sections: [{
        position: 1, title: "Leistungsumfang", discountBps: 0,
        lines: [{
          position: 1, title: "PV-Anlage", description: null,
          quantityMilli: 1_000, unit: "set", positionType: "required",
          isHidden: false, salesUnitNetCents: 100_000, lineDiscountBps: 0,
          taxRateBps: 1_900, finalNetCents: 100_000, taxCents: 19_000,
          grossCents: 119_000,
        }],
      }],
      totals: {
        basisNetCents: 100_000, basisTaxCents: 19_000, basisGrossCents: 119_000,
        optionalNetCents: 0, optionalTaxCents: 0, optionalGrossCents: 0,
      },
    };
    expect(offerPdfDraftInputV1Schema.safeParse(input).success).toBe(true);
    const { globalFixDiscountCents: _dropped, ...withoutFix } = commercialTerms;
    void _dropped;
    expect(
      offerPdfDraftInputV1Schema.safeParse({ ...input, commercialTerms: withoutFix }).success,
    ).toBe(false);
  });
});
