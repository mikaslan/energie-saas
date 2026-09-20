// F2-01b Forecast-Pin (F201B-4..7): PIN-Tests auf VERIFIED-Bestandssemantik.
// Erwartung: GRUEN. Faellt ein Pin rot, ist das ein Befund (Verhaltensdrift),
// kein RED im TDD-Sinn — die Implementierung bleibt unangetastet.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { euroForecastToCents } from "@/app/w/[workspaceId]/anfragen/[projectId]/offer-create-view";
import type { TenantTx } from "@/lib/db/types";
import {
  OFFER_CANONICALIZATION_VERSION,
  OFFER_VARIANT_SNAPSHOT_VERSION,
  sealOfferVariantSnapshot,
  type OfferVariantSnapshotV1,
} from "@/lib/integrations/offers/contract";
import type { ServiceCtx } from "@/lib/permissions";
import { getOfferDetail, OfferIntegrityError } from "@/modules/offers";

const IDS = {
  workspace: "10000000-0000-4000-8000-000000000001",
  project: "20000000-0000-4000-8000-000000000002",
  offer: "30000000-0000-4000-8000-000000000003",
  variant: "40000000-0000-4000-8000-000000000004",
  revision: "50000000-0000-4000-8000-000000000005",
  section: "60000000-0000-4000-8000-000000000006",
  line: "70000000-0000-4000-8000-000000000007",
  contact: "80000000-0000-4000-8000-000000000008",
  site: "90000000-0000-4000-8000-000000000009",
  operator: "a0000000-0000-4000-8000-00000000000a",
  receipt: "b0000000-0000-4000-8000-00000000000b",
  requirement: "c0000000-0000-4000-8000-00000000000c",
  calculation: "d0000000-0000-4000-8000-00000000000d",
  resolution: "e0000000-0000-4000-8000-00000000000e",
} as const;

const SHA = {
  inbound: "1".repeat(64),
  calculationInput: "2".repeat(64),
  calculationResult: "3".repeat(64),
  resolution: "4".repeat(64),
} as const;

const NOW = "2026-08-30T10:00:00.000Z";

// Primaerbasis bewusst klein (100/119), damit jede Vermischung mit dem
// Forecast (2_500_000) in displayTotal sofort sichtbar wuerde.
function pinSnapshot(): OfferVariantSnapshotV1 {
  return sealOfferVariantSnapshot({
    schemaVersion: OFFER_VARIANT_SNAPSHOT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    workspaceId: IDS.workspace,
    offerId: IDS.offer,
    variantId: IDS.variant,
    revision: 1,
    variantName: "Basis",
    description: null,
    planningMode: "quick",
    contactContext: {
      displayName: "Synthetischer Pinkontakt",
      emailPrimary: "forecast-pin@example.test",
      phoneE164: null,
    },
    installationSiteContext: {
      addressRevision: 1,
      formattedAddress: "Testweg 7, 69168 Dielheim",
      street: "Testweg",
      houseNumber: "7",
      postalCode: "69168",
      city: "Dielheim",
      country: "DE",
    },
    sourceBindings: {
      projectId: IDS.project,
      contactId: IDS.contact,
      siteId: IDS.site,
      inboundReceiptId: IDS.receipt,
      inboundPayloadSha256: SHA.inbound,
      requirementId: IDS.requirement,
      requirementRevision: 1,
      calculationRevisionId: IDS.calculation,
      calculationRevision: 1,
      calculationInputSha256: SHA.calculationInput,
      calculationResultSha256: SHA.calculationResult,
      resolutionId: IDS.resolution,
      resolutionRevision: 1,
      resolutionSha256: SHA.resolution,
    },
    priceAudienceDecision: {
      audience: "b2c",
      confirmationCode: "b2c_operator_confirmed",
      confirmedBy: IDS.operator,
      confirmedAt: NOW,
    },
    taxDecision: {
      treatment: "standard_19",
      rateBps: 1_900,
      selectedBy: IDS.operator,
      selectedAt: NOW,
    },
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    globalDiscountCapCents: null,
    globalFixDiscountCents: null,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: IDS.section,
      position: 1,
      category: "other",
      title: "Leistungen",
      discountBps: 0,
      lines: [{
        lineDomainId: IDS.line,
        position: 1,
        componentCategory: "other",
        positionType: "required",
        isHidden: false,
        quantityMilli: 1_000,
        product: {
          kind: "custom",
          displayName: "Synthetische Pinleistung",
          description: null,
          unit: "piece",
        },
        source: { kind: "custom", enteredBy: IDS.operator, enteredAt: NOW },
        salesPricing: {
          originalUnitNetCents: 100,
          effectiveUnitNetCents: 100,
          provenance: { kind: "custom", enteredBy: IDS.operator, enteredAt: NOW },
        },
        purchasePricing: {
          originalUnitNetCents: 50,
          effectiveUnitNetCents: 50,
          provenance: { kind: "custom", enteredBy: IDS.operator, enteredAt: NOW },
        },
        lineDiscountBps: 0,
        taxTreatment: "standard_19",
        taxRateBps: 1_900,
        taxDecision: {
          treatment: "standard_19",
          rateBps: 1_900,
          selectedBy: IDS.operator,
          selectedAt: NOW,
        },
        computed: {
          lineBaseNetCents: 100,
          lineDiscountedNetCents: 100,
          sectionDiscountedNetCents: 100,
          finalSalesNetCents: 100,
          salesTaxCents: 19,
          salesGrossCents: 119,
          purchaseNetCents: 50,
        },
      }],
    }],
    totals: {
      basisNetCents: 100,
      basisTaxCents: 19,
      basisGrossCents: 119,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
    createdBy: IDS.operator,
    createdAt: NOW,
  });
}

function adminContext(): ServiceCtx {
  return {
    workspaceId: IDS.workspace,
    actor: IDS.operator,
    role: "admin",
    capabilities: {},
    featureFlags: {},
  };
}

// Antwortfolge von getOfferDetail: Offer, Varianten, aktive Revision,
// Katalog-Frische, Basisreferenz, Content-Lock, Primaer-Revision.
// override === undefined simuliert die Alt-Zeile ohne Override-Spalte.
function detailTx(
  current: OfferVariantSnapshotV1,
  offer: { forecast: string | null; override?: string | null },
) {
  const offerRow: Record<string, unknown> = {
    id: IDS.offer,
    project_id: IDS.project,
    project_outcome: "open",
    offer_number: "ANG-2026-000001",
    status: "draft",
    forecast_value_net_cents: offer.forecast,
  };
  if (offer.override !== undefined) {
    offerRow.total_price_override_net_cents = offer.override;
  }
  const revisionRow = {
    id: IDS.revision,
    revision_snapshot: current,
    snapshot_sha256_hex: current.snapshotSha256,
    resolution_id: IDS.resolution,
    resolution_revision: 1,
    resolution_sha256_hex: SHA.resolution,
  };
  const responses = [
    { rows: [offerRow] },
    { rows: [{
      id: IDS.variant,
      offer_id: IDS.offer,
      ordinal: 1,
      current_revision: 1,
      name: "Basis",
      description: null,
      is_primary: true,
    }] },
    { rows: [revisionRow] },
    { rows: [{ request_key: IDS.offer, outdated: false }] },
    { rows: [{
      catalog_resolution_status: "resolved",
      expected_requirement_revision: 1,
      expected_calculation_revision: 1,
      expected_resolution_revision: 1,
    }] },
    { rows: [] },
    { rows: [revisionRow] },
  ];
  const execute = vi.fn(async () => responses.shift() ?? { rows: [] });
  return { tx: { execute } as unknown as TenantTx, execute };
}

function readDetail(tx: TenantTx) {
  return getOfferDetail(tx, adminContext(), {
    offerId: IDS.offer,
    variantId: null,
  });
}

describe("F2-01b Forecast-Pin (VERIFIED, erwartet GRUEN)", () => {
  it("F201B-4 Parser-Pin: pinnt euroForecastToCents auf Bestandssemantik", () => {
    expect(euroForecastToCents("25.000,00")).toBe("2500000");
    expect(euroForecastToCents("")).toBe("");
    expect(euroForecastToCents("-1")).toBeNull();
    expect(euroForecastToCents("1,234")).toBeNull();
    expect(euroForecastToCents("abc")).toBeNull();
  });

  it("F201B-5 Roundtrip-Pin: Parse→Read ist cent-identisch, NULL bleibt NULL", async () => {
    const parsed = euroForecastToCents("25.000,00");
    expect(parsed).toBe("2500000");
    const { tx } = detailTx(pinSnapshot(), { forecast: parsed, override: null });
    const detail = await readDetail(tx);
    expect(detail?.offer.forecastValueNetCents).toBe(2_500_000);

    const nullCase = detailTx(pinSnapshot(), { forecast: null, override: null });
    const nullDetail = await readDetail(nullCase.tx);
    expect(nullDetail?.offer.forecastValueNetCents).toBeNull();
  });

  it("F201B-6 Trennungs-Pin: Forecast fliesst nie in displayTotalNetCents ein", async () => {
    const active = detailTx(pinSnapshot(), { forecast: "2500000", override: "5000" });
    const activeDetail = await readDetail(active.tx);
    expect(activeDetail?.offer.forecastValueNetCents).toBe(2_500_000);
    expect(activeDetail?.overrideActive).toBe(true);
    expect(activeDetail?.displayTotalNetCents).toBe(5_000);
    expect(activeDetail?.displayTotalGrossCents).toBeNull();

    const inactive = detailTx(pinSnapshot(), { forecast: "2500000", override: null });
    const inactiveDetail = await readDetail(inactive.tx);
    expect(inactiveDetail?.offer.forecastValueNetCents).toBe(2_500_000);
    expect(inactiveDetail?.overrideActive).toBe(false);
    expect(inactiveDetail?.displayTotalNetCents).toBe(100);
    expect(inactiveDetail?.displayTotalGrossCents).toBe(119);

    const missing = detailTx(pinSnapshot(), { forecast: "2500000" });
    const missingDetail = await readDetail(missing.tx);
    expect(missingDetail?.offer.forecastValueNetCents).toBe(2_500_000);
    expect(missingDetail?.overrideActive).toBe(false);
    expect(missingDetail?.displayTotalNetCents).toBe(100);
    expect(missingDetail?.displayTotalGrossCents).toBe(119);
  });

  it("F201B-7 Grenz-Pin: 0 und 9e15 passieren, 9e15+1 und negativ blockieren", async () => {
    expect(euroForecastToCents("0")).toBe("0");
    expect(euroForecastToCents("90000000000000")).toBe("9000000000000000");
    expect(euroForecastToCents("90000000000000,01")).toBeNull();
    expect(euroForecastToCents("-0,01")).toBeNull();

    const max = detailTx(pinSnapshot(), {
      forecast: "9000000000000000",
      override: null,
    });
    const maxDetail = await readDetail(max.tx);
    expect(maxDetail?.offer.forecastValueNetCents).toBe(9_000_000_000_000_000);

    const negative = detailTx(pinSnapshot(), { forecast: "-1", override: null });
    await expect(readDetail(negative.tx)).rejects.toThrow(OfferIntegrityError);
  });
});
