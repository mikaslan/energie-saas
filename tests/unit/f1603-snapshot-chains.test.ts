// F16.3/F3.1 Snapshot-Ketten (DB-frei): strikte v1/v2/v3-Gestalten werden
// nur als Laufzeitwert auf v4 gehoben. Eingabeobjekt, historische Bytes und
// historischer SHA bleiben unverändert.
import { createHash } from "node:crypto";
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
  let idSequence = 1;
  const nextUuid = (): string =>
    `00000000-0000-4000-8000-${String(idSequence++).padStart(12, "0")}`;
  const actor = nextUuid();
  const createdAt = "2026-08-29T12:00:00.000Z";
  return {
    schemaVersion: "offer-variant-snapshot.v1",
    canonicalizationVersion: "offer-jcs.v1",
    workspaceId: nextUuid(),
    offerId: nextUuid(),
    variantId: nextUuid(),
    revision: 1,
    sourceBindings: {
      projectId: nextUuid(),
      contactId: nextUuid(),
      siteId: nextUuid(),
      inboundReceiptId: nextUuid(),
      inboundPayloadSha256: hex64("inbound"),
      requirementId: nextUuid(),
      requirementRevision: 1,
      calculationRevisionId: nextUuid(),
      calculationRevision: 1,
      calculationInputSha256: hex64("calc-in"),
      calculationResultSha256: hex64("calc-out"),
      resolutionId: nextUuid(),
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
      sectionDomainId: nextUuid(),
      position: 1,
      category: "other",
      title: "Kette",
      discountBps: 0,
      lines: [{
        lineDomainId: nextUuid(),
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

type LegacySnapshotVersion = "offer-variant-snapshot.v1"
  | "offer-variant-snapshot.v2"
  | "offer-variant-snapshot.v3";

const expectedLegacySha256: Record<LegacySnapshotVersion, string> = {
  "offer-variant-snapshot.v1": "f520d80326bfc42084c4ef43be41b33d42fe6f83ac5b68dde963a9556e47cc0f",
  "offer-variant-snapshot.v2": "c9eda48a1beef21aa8d2f529afb81ae4478f07a9589469848bf4fb65dd1acad1",
  "offer-variant-snapshot.v3": "aebd8c3f6de3ecaff1ebc25c0667bb9827c0785c9b33fe68e874968625dcfd50",
};

function legacyBody(version: LegacySnapshotVersion): Record<string, unknown> {
  const body: Record<string, unknown> = { ...v1Body(), schemaVersion: version };
  if (version !== "offer-variant-snapshot.v1") {
    body.globalFixDiscountCents = 0;
  }
  if (version === "offer-variant-snapshot.v3") {
    body.globalDiscountCapCents = null;
  }
  return body;
}

describe("F16.3 Snapshot-Ketten", () => {
  it.each([
    "offer-variant-snapshot.v1",
    "offer-variant-snapshot.v2",
    "offer-variant-snapshot.v3",
  ] as const)("%s liest als Quick-v4, ohne historische Bytes oder SHA zu verändern", (version) => {
    const sealed = sealLikeFixture(legacyBody(version));
    const storedBytes = JSON.stringify(sealed);
    const storedSha256 = sealed.snapshotSha256;
    expect(storedSha256).toBe(expectedLegacySha256[version]);

    const result = validateOfferVariantSnapshot(sealed);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(sealed)).toBe(storedBytes);
    expect(sealed.snapshotSha256).toBe(storedSha256);
    expect(result.value.snapshotSha256).toBe(storedSha256);
    expect(result.value.schemaVersion).toBe("offer-variant-snapshot.v4");
    expect(result.value.planningMode).toBe("quick");
    expect(result.value.globalFixDiscountCents).toBe(
      version === "offer-variant-snapshot.v1" ? null : 0,
    );
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
    const sealed = sealLikeFixture(legacyBody("offer-variant-snapshot.v2"));
    expect(validateOfferVariantSnapshot(sealed).ok).toBe(true);
  });

  it("v2-Literal + Cap-Key und v3-Literal + Mode-Key bleiben geschlossene Misch-Gestalten", () => {
    expect(validateOfferVariantSnapshot(sealLikeFixture({
      ...legacyBody("offer-variant-snapshot.v2"),
      globalDiscountCapCents: null,
    })).ok).toBe(false);
    expect(validateOfferVariantSnapshot(sealLikeFixture({
      ...legacyBody("offer-variant-snapshot.v3"),
      planningMode: "quick",
    })).ok).toBe(false);
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
