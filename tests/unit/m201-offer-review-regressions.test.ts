import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const routeMocks = vi.hoisted(() => ({
  notFound: vi.fn<() => never>(),
  authorizedQuery: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  notFound: routeMocks.notFound,
}));

vi.mock("@/lib/action", () => ({
  NotAuthenticatedError: class NotAuthenticatedError extends Error {},
  authorizedQuery: routeMocks.authorizedQuery,
}));

import type { TenantTx } from "@/lib/db/types";
import {
  OFFER_CANONICALIZATION_VERSION,
  OFFER_VARIANT_SNAPSHOT_VERSION,
  sealOfferVariantSnapshot,
  type OfferVariantSnapshotV1,
} from "@/lib/integrations/offers/contract";
import type { ServiceCtx } from "@/lib/permissions";
import { getOfferDetail } from "@/modules/offers";

const IDS = {
  workspace: "10000000-0000-4000-8000-000000000001",
  project: "20000000-0000-4000-8000-000000000002",
  offer: "30000000-0000-4000-8000-000000000003",
  firstVariant: "40000000-0000-4000-8000-000000000004",
  secondVariant: "40000000-0000-4000-8000-000000000005",
  foreignVariant: "40000000-0000-4000-8000-000000000006",
  section: "50000000-0000-4000-8000-000000000005",
  line: "60000000-0000-4000-8000-000000000006",
  contact: "70000000-0000-4000-8000-000000000007",
  site: "80000000-0000-4000-8000-000000000008",
  firstOperator: "90000000-0000-4000-8000-000000000009",
  secondOperator: "a0000000-0000-4000-8000-00000000000a",
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

const SERVICE_PATH = "modules/offers/service.ts";
const CATALOG_OFFER_COPY_PATH = "modules/catalog/offer-copy.ts";

function sourceSlice(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, `Startmarker fehlt: ${start}`).toBeGreaterThanOrEqual(0);
  expect(to, `Endmarker fehlt: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

function offerSnapshot(): OfferVariantSnapshotV1 {
  const at = "2026-08-30T10:00:00.000Z";
  return sealOfferVariantSnapshot({
    schemaVersion: OFFER_VARIANT_SNAPSHOT_VERSION,
    canonicalizationVersion: OFFER_CANONICALIZATION_VERSION,
    workspaceId: IDS.workspace,
    offerId: IDS.offer,
    variantId: IDS.firstVariant,
    revision: 1,
    variantName: "Basis",
    description: null,
    contactContext: {
      displayName: "Synthetischer Reviewkontakt",
      emailPrimary: "review@example.test",
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
      confirmedBy: IDS.firstOperator,
      confirmedAt: at,
    },
    taxDecision: {
      treatment: "standard_19",
      rateBps: 1_900,
      selectedBy: IDS.firstOperator,
      selectedAt: at,
    },
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    // F16.3 Slice D: v2-Pflichtfeld.
    globalFixDiscountCents: null,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: IDS.section,
      position: 1,
      category: "other",
      title: "Weitere Komponenten",
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
          displayName: "Synthetische Reviewposition",
          description: null,
          unit: "piece",
        },
        source: {
          kind: "custom",
          enteredBy: IDS.firstOperator,
          enteredAt: at,
        },
        salesPricing: {
          originalUnitNetCents: 10_000,
          effectiveUnitNetCents: 10_000,
          provenance: {
            kind: "custom",
            enteredBy: IDS.firstOperator,
            enteredAt: at,
          },
        },
        purchasePricing: {
          originalUnitNetCents: 5_000,
          effectiveUnitNetCents: 5_000,
          provenance: {
            kind: "custom",
            enteredBy: IDS.firstOperator,
            enteredAt: at,
          },
        },
        lineDiscountBps: 0,
        taxTreatment: "standard_19",
        taxRateBps: 1_900,
        taxDecision: {
          treatment: "standard_19",
          rateBps: 1_900,
          selectedBy: IDS.firstOperator,
          selectedAt: at,
        },
        computed: {
          lineBaseNetCents: 10_000,
          lineDiscountedNetCents: 10_000,
          sectionDiscountedNetCents: 10_000,
          finalSalesNetCents: 10_000,
          salesTaxCents: 1_900,
          salesGrossCents: 11_900,
          purchaseNetCents: 5_000,
        },
      }],
    }],
    totals: {
      basisNetCents: 10_000,
      basisTaxCents: 1_900,
      basisGrossCents: 11_900,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
    createdBy: IDS.firstOperator,
    createdAt: at,
  });
}

function adminContext(): ServiceCtx {
  return {
    workspaceId: IDS.workspace,
    actor: IDS.secondOperator,
    role: "admin",
    capabilities: {},
    featureFlags: {},
  };
}

describe("M2-01 Review-Regressionen", () => {
  it("uebernimmt bei neuer Basis durch einen zweiten Operator die urspruengliche Preiszielgruppen-Entscheidung unveraendert", async () => {
    const initial = offerSnapshot();
    const resealedBySecondOperator = sealOfferVariantSnapshot({
      ...structuredClone(initial),
      variantId: IDS.secondVariant,
      variantName: "Neue aktuelle Basis",
      createdBy: IDS.secondOperator,
      createdAt: "2026-08-30T11:00:00.000Z",
    });
    expect(resealedBySecondOperator.createdBy).toBe(IDS.secondOperator);
    expect(resealedBySecondOperator.priceAudienceDecision)
      .toEqual(initial.priceAudienceDecision);
    expect(resealedBySecondOperator.priceAudienceDecision.confirmedBy)
      .toBe(IDS.firstOperator);

    const source = await readFile(SERVICE_PATH, "utf8");
    const readStored = sourceSlice(
      source,
      "function readStoredPriceAudienceDecision(",
      "async function nextVariantOrdinal(",
    );
    const createBasis = sourceSlice(
      source,
      "export async function createVariantFromCurrentResolution(",
      "function findLine(",
    );
    expect(readStored).toContain("offerRecord.price_audience_decision");
    expect(readStored).toContain("offerPriceAudienceDecisionV1Schema.safeParse");
    expect(readStored).toContain("structuredClone(parsed.data)");
    expect(createBasis).toMatch(
      /const priceAudienceDecision = readStoredPriceAudienceDecision\(offerRecord\)/u,
    );
    expect(createBasis).toMatch(/buildResolutionSnapshot\([\s\S]*?priceAudienceDecision,/u);
  });

  it("blockiert eine neue Basis, wenn sich die Installationsadresse seit dem Angebot geaendert hat", async () => {
    const source = await readFile(SERVICE_PATH, "utf8");
    const createBasis = sourceSlice(
      source,
      "export async function createVariantFromCurrentResolution(",
      "function findLine(",
    );
    expect(createBasis).toMatch(
      /canonicalizeOfferJson\(offerRecord\.installation_site_context\)\s*!==\s*canonicalizeOfferJson\(basis\.installationSiteContext\)/u,
    );
    expect(createBasis).toContain('throw new OfferBlockedError("installation_site_changed")');
  });

  it("faellt bei einer syntaktisch gueltigen fremden Varianten-ID auf die erste Variante zurueck", async () => {
    const snapshot = offerSnapshot();
    const responses = [
      { rows: [{
        id: IDS.offer,
        project_id: IDS.project,
        offer_number: "ANG-2026-000001",
        status: "draft",
        forecast_value_net_cents: null,
      }] },
      { rows: [
        {
          id: IDS.firstVariant,
          offer_id: IDS.offer,
          ordinal: 1,
          current_revision: 1,
          name: "Basis",
          description: null,
        },
        {
          id: IDS.secondVariant,
          offer_id: IDS.offer,
          ordinal: 2,
          current_revision: 1,
          name: "Alternative",
          description: null,
        },
      ] },
      { rows: [{
        id: "f0000000-0000-4000-8000-00000000000f",
        revision_snapshot: snapshot,
        snapshot_sha256_hex: snapshot.snapshotSha256,
        resolution_id: IDS.resolution,
        resolution_revision: 1,
        resolution_sha256_hex: SHA.resolution,
      }] },
      { rows: [{ request_key: IDS.offer, outdated: false }] },
      { rows: [{
        catalog_resolution_status: "resolved",
        expected_requirement_revision: 1,
        expected_calculation_revision: 1,
        expected_resolution_revision: 1,
      }] },
    ];
    const execute = vi.fn(async () => responses.shift() ?? { rows: [] });
    const tx = { execute } as unknown as TenantTx;

    const detail = await getOfferDetail(tx, adminContext(), {
      offerId: IDS.offer,
      variantId: IDS.foreignVariant,
    });

    expect(execute).toHaveBeenCalledTimes(5);
    expect(detail?.variants.map(({ id, active }) => ({ id, active }))).toEqual([
      { id: IDS.firstVariant, active: true },
      { id: IDS.secondVariant, active: false },
    ]);
    expect(detail?.offer.outdated).toBe(false);
    expect(detail?.newBasisInput).toEqual({
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      expectedResolutionRevision: 1,
    });
    expect(detail?.activeVariant.snapshot.variantId).toBe(IDS.firstVariant);
  });

  it("behandelt eine ungueltige Varianten-Query wie keine Auswahl und laedt dadurch die erste Variante", async () => {
    routeMocks.notFound.mockReset();
    routeMocks.authorizedQuery.mockReset();
    routeMocks.notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    let sqlCalls = 0;
    routeMocks.authorizedQuery.mockImplementation(
      async (
        _workspaceId: string,
        _action: string,
        _resource: string,
        operation: (tx: TenantTx, ctx: ServiceCtx) => Promise<unknown>,
      ) => operation({
        execute: async () => {
          sqlCalls += 1;
          return { rows: [] };
        },
      } as unknown as TenantTx, adminContext()),
    );
    const { default: OfferDetailPage } = await import(
      "@/app/w/[workspaceId]/angebote/[offerId]/page"
    );

    await expect(OfferDetailPage({
      params: Promise.resolve({
        workspaceId: IDS.workspace,
        offerId: IDS.offer,
      }),
      searchParams: Promise.resolve({ variante: "keine-gueltige-uuid" }),
    } as never)).rejects.toThrow("NEXT_NOT_FOUND");

    // Der Query-Wert wird zu null normalisiert. Der eine SQL-Aufruf stammt
    // deshalb aus dem regulären Offer-Lookup; erst dessen leeres Ergebnis
    // fuehrt hier im Test zum absichtlich gemockten notFound().
    expect(sqlCalls).toBe(1);
    expect(routeMocks.authorizedQuery).toHaveBeenCalledTimes(1);
  });

  it("wertet die Liste bei Project-/Component-Stale als outdated und bei irgendeiner aktuellen neuen Basis wieder als fresh", async () => {
    const [source, catalogBoundary] = await Promise.all([
      readFile(SERVICE_PATH, "utf8"),
      readFile(CATALOG_OFFER_COPY_PATH, "utf8"),
    ]);
    const listOffers = sourceSlice(
      source,
      "export async function listOffers(",
      "export async function getOfferDetail(",
    );
    const readFreshness = catalogBoundary.slice(catalogBoundary.indexOf(
      "export async function readOfferCatalogFreshness(",
    ));

    // Offer liefert dem engen Katalogexport nur die Bindungen aller aktuellen
    // Varianten. Dadurch kann eine neue aktuelle Basis das Angebot wieder auf
    // fresh setzen, ohne dass Offer fremde Katalogtabellen direkt ausliest.
    expect(listOffers).toContain("current_revision.revision = variant.current_revision");
    expect(listOffers).toContain("jsonb_agg(jsonb_build_object(");
    expect(listOffers).toContain("bindings: row.catalog_bindings");
    expect(listOffers).toContain("readOfferCatalogFreshness(");
    expect(listOffers).not.toContain("project_catalog_resolution");
    expect(listOffers).not.toContain("catalog_component");

    expect(readFreshness).toContain("project_record.catalog_resolution_status <> 'resolved'");
    expect(readFreshness).toContain("bool_or(");
    expect(readFreshness).toContain("latest.id = binding.resolution_id");
    expect(readFreshness).toContain("latest.revision = binding.resolution_revision");
    expect(readFreshness).toContain("latest.resolution_sha256_hex = binding.resolution_sha256");
    expect(readFreshness).toContain("component.status <> 'active'");
    expect(readFreshness).toMatch(
      /component\.current_revision\s*<> source_line\.catalog_component_revision/u,
    );
    expect(readFreshness).toContain("coalesce(binding_state.any_current, false) is not true");
  });

  it("erzeugt Sektionen in fester Fachreihenfolge statt in Resolution-Reihenfolge", async () => {
    const source = await readFile(SERVICE_PATH, "utf8");
    const buildSnapshot = sourceSlice(
      source,
      "function buildResolutionSnapshot(input:",
      "async function persistRevision(",
    );
    const categoryOrderSource = buildSnapshot.match(
      /const categoryOrder:[^=]+?=\s*\[([\s\S]*?)\];/u,
    )?.[1];
    expect(categoryOrderSource).toBeDefined();
    const categoryOrder = [...(categoryOrderSource ?? "").matchAll(/"([a-z_]+)"/gu)]
      .map((match) => match[1]);
    expect(categoryOrder).toEqual([
      "module",
      "inverter",
      "battery",
      "wallbox",
      "heat_pump",
      "mounting",
      "other",
    ]);
    expect(buildSnapshot).toMatch(
      /const sections:[\s\S]*?categoryOrder\s*\.filter\([\s\S]*?\.map\(/u,
    );
  });
});
