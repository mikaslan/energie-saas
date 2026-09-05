import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TenantTx } from "@/lib/db/types";
import {
  OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
  OFFER_VARIANT_REVISE_COMMAND_VERSION,
  OFFER_VARIANT_SNAPSHOT_VERSION,
  sealOfferVariantSnapshot,
  type OfferVariantSnapshotV1,
  type ReviseOfferVariantOperationV1,
} from "@/lib/integrations/offers/contract";
import type { ServiceCtx } from "@/lib/permissions";
import {
  createOfferFromRequest,
  createVariantFromCurrentResolution,
  duplicateOfferVariant,
  getOfferDetail,
  listOffers,
  reviseOfferVariant,
} from "@/modules/offers";

const ids = {
  workspace: "10000000-0000-4000-8000-000000000001",
  actor: "10000000-0000-4000-8000-000000000002",
  project: "10000000-0000-4000-8000-000000000003",
  offer: "10000000-0000-4000-8000-000000000004",
  variant: "10000000-0000-4000-8000-000000000005",
  revision: "10000000-0000-4000-8000-000000000006",
  contact: "10000000-0000-4000-8000-000000000007",
  site: "10000000-0000-4000-8000-000000000008",
  receipt: "10000000-0000-4000-8000-000000000009",
  requirement: "10000000-0000-4000-8000-00000000000a",
  calculation: "10000000-0000-4000-8000-00000000000b",
  resolution: "10000000-0000-4000-8000-00000000000c",
  section: "10000000-0000-4000-8000-00000000000d",
  line: "10000000-0000-4000-8000-00000000000e",
} as const;

const now = "2026-08-30T10:00:00.000Z";
const sha = (digit: string) => digit.repeat(64);

function context(
  capabilities: ServiceCtx["capabilities"] = {},
  role: ServiceCtx["role"] = "editor",
): ServiceCtx {
  return {
    workspaceId: ids.workspace,
    actor: ids.actor,
    role,
    capabilities,
    featureFlags: {},
  };
}

function snapshot(): OfferVariantSnapshotV1 {
  return sealOfferVariantSnapshot({
    schemaVersion: OFFER_VARIANT_SNAPSHOT_VERSION,
    canonicalizationVersion: "offer-jcs.v1",
    workspaceId: ids.workspace,
    offerId: ids.offer,
    variantId: ids.variant,
    revision: 1,
    variantName: "Basis",
    description: null,
    contactContext: {
      displayName: "Synthetische Kundin",
      emailPrimary: "permission-matrix@example.test",
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
      projectId: ids.project,
      contactId: ids.contact,
      siteId: ids.site,
      inboundReceiptId: ids.receipt,
      inboundPayloadSha256: sha("1"),
      requirementId: ids.requirement,
      requirementRevision: 1,
      calculationRevisionId: ids.calculation,
      calculationRevision: 1,
      calculationInputSha256: sha("2"),
      calculationResultSha256: sha("3"),
      resolutionId: ids.resolution,
      resolutionRevision: 1,
      resolutionSha256: sha("4"),
    },
    priceAudienceDecision: {
      audience: "b2c",
      confirmationCode: "b2c_operator_confirmed",
      confirmedBy: ids.actor,
      confirmedAt: now,
    },
    taxDecision: {
      treatment: "standard_19",
      rateBps: 1_900,
      selectedBy: ids.actor,
      selectedAt: now,
    },
    currency: "EUR",
    priceBasis: "net",
    globalDiscountBps: 0,
    // F16.3 Slice E: Cap (null = ungedeckelt).
    globalDiscountCapCents: null,
    // F16.3 Slice D: v2-Pflichtfeld.
    globalFixDiscountCents: null,
    customDealNetCents: null,
    sections: [{
      sectionDomainId: ids.section,
      position: 1,
      category: "other",
      title: "Leistungen",
      discountBps: 0,
      lines: [{
        lineDomainId: ids.line,
        position: 1,
        componentCategory: "other",
        positionType: "required",
        isHidden: false,
        quantityMilli: 1_000,
        product: {
          kind: "custom",
          displayName: "Synthetische Leistung",
          description: null,
          unit: "piece",
        },
        source: { kind: "custom", enteredBy: ids.actor, enteredAt: now },
        salesPricing: {
          originalUnitNetCents: 100,
          effectiveUnitNetCents: 100,
          provenance: { kind: "custom", enteredBy: ids.actor, enteredAt: now },
        },
        purchasePricing: {
          originalUnitNetCents: 50,
          effectiveUnitNetCents: 50,
          provenance: { kind: "custom", enteredBy: ids.actor, enteredAt: now },
        },
        lineDiscountBps: 0,
        taxTreatment: "standard_19",
        taxRateBps: 1_900,
        taxDecision: {
          treatment: "standard_19",
          rateBps: 1_900,
          selectedBy: ids.actor,
          selectedAt: now,
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
    createdBy: ids.actor,
    createdAt: now,
  });
}

function reviseCommand(operations: readonly ReviseOfferVariantOperationV1[]) {
  return {
    schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
    offerId: ids.offer,
    variantId: ids.variant,
    expectedRevision: 1,
    operations: [...operations],
  };
}

function revisionRows(current: OfferVariantSnapshotV1) {
  return {
    projectId: { rows: [{ project_id: ids.project }] },
    project: { rows: [{ id: ids.project }] },
    offer: { rows: [{ id: ids.offer, project_id: ids.project }] },
    variant: {
      rows: [{
        id: ids.variant,
        offer_id: ids.offer,
        ordinal: 1,
        current_revision: 1,
        name: "Basis",
        description: null,
      }],
    },
    revision: {
      rows: [{
        id: ids.revision,
        revision_snapshot: current,
        snapshot_sha256_hex: current.snapshotSha256,
        resolution_id: ids.resolution,
        resolution_revision: 1,
        resolution_sha256_hex: sha("4"),
      }],
    },
    now: { rows: [{ now }] },
  };
}

type CapturedInsert = Record<string, unknown>;

function reviseTx(current: OfferVariantSnapshotV1, resultingLineCount = 1) {
  const rows = revisionRows(current);
  const responses: Array<{ rows: unknown[] }> = [
    rows.projectId,
    rows.project, // project row lock
    rows.project, // coherent project basis after the lock
    rows.offer,
    rows.variant,
    rows.revision,
    rows.now,
    { rows: [] }, // offer_variant_revision
    { rows: [] }, // offer_variant_section
    ...Array.from({ length: resultingLineCount }, () => ({ rows: [] })),
    { rows: [{ id: ids.variant }] }, // CAS pointer update
    { rows: [] }, // offer touch
    { rows: [] }, // project touch
  ];
  const inserts: CapturedInsert[] = [];
  let executeIndex = 0;
  const tx = {
    execute: vi.fn(async () => responses[executeIndex++] ?? { rows: [] }),
    insert: vi.fn(() => ({
      values: async (value: CapturedInsert) => {
        inserts.push(value);
      },
    })),
  } as unknown as TenantTx;
  return { tx, inserts, execute: tx.execute as ReturnType<typeof vi.fn> };
}

function duplicateTx(current: OfferVariantSnapshotV1) {
  const rows = revisionRows(current);
  const responses: Array<{ rows: unknown[] }> = [
    rows.projectId,
    rows.project, // project row lock
    rows.project, // coherent project basis after the lock
    rows.offer,
    rows.variant,
    rows.revision,
    { rows: [{ next_ordinal: 2 }] },
    rows.now,
    { rows: [] }, // offer_variant
    { rows: [] }, // offer_variant_revision
    { rows: [] }, // offer_variant_section
    { rows: [] }, // offer_bom_line
    { rows: [] }, // offer touch
    { rows: [] }, // project touch
  ];
  const inserts: CapturedInsert[] = [];
  let executeIndex = 0;
  const tx = {
    execute: vi.fn(async () => responses[executeIndex++] ?? { rows: [] }),
    insert: vi.fn(() => ({
      values: async (value: CapturedInsert) => {
        inserts.push(value);
      },
    })),
  } as unknown as TenantTx;
  return { tx, inserts };
}

function poisonTx() {
  const reached = new Error("permission matrix reached SQL");
  const execute = vi.fn(async () => {
    throw reached;
  });
  const tx = { execute } as unknown as TenantTx;
  return { tx, execute, reached };
}

function readTx(current: OfferVariantSnapshotV1) {
  const responses = [
    {
      rows: [{
        id: ids.offer,
        project_id: ids.project,
        offer_number: "ANG-2026-000001",
        status: "draft",
        forecast_value_net_cents: "100",
        outdated: false,
      }],
    },
    {
      rows: [{
        id: ids.variant,
        offer_id: ids.offer,
        ordinal: 1,
        current_revision: 1,
        name: "Basis",
        description: null,
      }],
    },
    {
      rows: [{
        id: ids.revision,
        revision_snapshot: current,
        snapshot_sha256_hex: current.snapshotSha256,
        resolution_id: ids.resolution,
        resolution_revision: 1,
        resolution_sha256_hex: sha("4"),
      }],
    },
    { rows: [{ outdated: false }] },
  ];
  let executeIndex = 0;
  return {
    execute: vi.fn(async () => responses[executeIndex++] ?? { rows: [] }),
  } as unknown as TenantTx;
}

describe("M201-RBAC-01 Offer-Service-Berechtigungsmatrix", () => {
  it("weist External an jeder öffentlichen Offer-Grenze vor Parsing und SQL fail-closed ab", async () => {
    const { tx, execute } = poisonTx();
    const external = context({
      external_only: true,
      edit_prices: true,
      convert_phase: true,
      discounts: true,
      see_purchase_prices: true,
    }, "admin");
    const calls = [
      () => listOffers(tx, external),
      () => getOfferDetail(tx, external, { offerId: ids.offer, variantId: null }),
      () => createOfferFromRequest(tx, external, "untrusted"),
      () => duplicateOfferVariant(tx, external, "untrusted"),
      () => reviseOfferVariant(tx, external, "untrusted"),
      () => createVariantFromCurrentResolution(tx, external, "untrusted"),
    ];

    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({
        name: "PermissionDeniedError",
        reason: "external_only_without_assignment",
      });
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("lässt Duplikat und reine Custom-/Strukturänderung mit project.write ohne Preisrecht bis zur Fach-SQL passieren", async () => {
    const plainEditor = context();
    const duplicatePoison = poisonTx();
    const structurePoison = poisonTx();
    const customDetailsPoison = poisonTx();

    await expect(duplicateOfferVariant(
      duplicatePoison.tx,
      plainEditor,
      {
        schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
        offerId: ids.offer,
        sourceVariantId: ids.variant,
        expectedSourceRevision: 1,
        name: "Kopie",
      },
    )).rejects.toBe(duplicatePoison.reached);
    await expect(reviseOfferVariant(
      structurePoison.tx,
      plainEditor,
      reviseCommand([{ operation: "set_variant_name", name: "Nur Struktur" }]),
    )).rejects.toBe(structurePoison.reached);
    await expect(reviseOfferVariant(
      customDetailsPoison.tx,
      plainEditor,
      reviseCommand([{
        operation: "set_custom_line_details",
        lineDomainId: ids.line,
        displayName: "Freie Montage",
        description: null,
        unit: "set",
      }]),
    )).rejects.toBe(customDetailsPoison.reached);

    expect(duplicatePoison.execute).toHaveBeenCalledTimes(1);
    expect(structurePoison.execute).toHaveBeenCalledTimes(1);
    expect(customDetailsPoison.execute).toHaveBeenCalledTimes(1);
  });

  it("bindet Verkaufspreise exklusiv an price.edit", async () => {
    const operation = {
      operation: "set_line_sales_price",
      lineDomainId: ids.line,
      salesUnitNetCents: 125,
      reasonCode: "correction",
    } as const;
    const denied = poisonTx();
    await expect(reviseOfferVariant(
      denied.tx,
      context(),
      reviseCommand([operation]),
    )).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "price.edit",
    });
    expect(denied.execute).not.toHaveBeenCalled();

    const allowed = poisonTx();
    await expect(reviseOfferVariant(
      allowed.tx,
      context({ edit_prices: true }),
      reviseCommand([operation]),
    )).rejects.toBe(allowed.reached);
    expect(allowed.execute).toHaveBeenCalledTimes(1);
  });

  it("bindet Rabatte an discount.apply, ohne zusätzlich price.edit zu verlangen", async () => {
    const operation = {
      operation: "set_global_discount",
      discountBps: 500,
    } as const;
    const deniedHarness = reviseTx(snapshot());
    await expect(reviseOfferVariant(
      deniedHarness.tx,
      context({ edit_prices: true }),
      reviseCommand([operation]),
    )).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "discount.apply",
    });
    expect(deniedHarness.inserts).toEqual([]);

    const allowed = poisonTx();
    await expect(reviseOfferVariant(
      allowed.tx,
      context({ discounts: true }),
      reviseCommand([operation]),
    )).rejects.toBe(allowed.reached);
    expect(allowed.execute).toHaveBeenCalledTimes(1);
  });

  it("redigiert EK beim Read und verlangt price.read_purchase für EK-Änderungen", async () => {
    const current = snapshot();
    const viewer = await getOfferDetail(
      readTx(current),
      context({}, "viewer"),
      { offerId: ids.offer, variantId: ids.variant },
    );
    const purchaseReader = await getOfferDetail(
      readTx(current),
      context({ see_purchase_prices: true }),
      { offerId: ids.offer, variantId: ids.variant },
    );
    expect(JSON.stringify(viewer)).not.toContain("purchasePricing");
    expect(JSON.stringify(viewer)).not.toContain("purchaseNetCents");
    expect(JSON.stringify(viewer)).not.toContain("marginNetCents");
    expect(JSON.stringify(purchaseReader)).toContain("purchasePricing");
    expect(JSON.stringify(purchaseReader)).toContain("purchaseNetCents");
    expect(JSON.stringify(purchaseReader)).toContain("marginNetCents");

    const purchaseOperation = {
      operation: "set_line_purchase_price",
      lineDomainId: ids.line,
      purchaseUnitNetCents: 55,
      reasonCode: "correction",
    } as const;
    const missingPurchase = reviseTx(current);
    await expect(reviseOfferVariant(
      missingPurchase.tx,
      context({ edit_prices: true }),
      reviseCommand([purchaseOperation]),
    )).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "price.read_purchase",
    });
    expect(missingPurchase.inserts).toEqual([]);
  });

  it("behandelt den EK einer neuen freien Zeile ebenfalls als price.read_purchase", async () => {
    const current = snapshot();
    const harness = reviseTx(current, 2);
    await expect(reviseOfferVariant(
      harness.tx,
      context({ edit_prices: true }),
      reviseCommand([{
        operation: "add_custom_line",
        lineDomainId: randomUUID(),
        sectionDomainId: ids.section,
        position: 2,
        displayName: "Freie Montage",
        description: null,
        unit: "piece",
        quantityMilli: 1_000,
        salesUnitNetCents: 200,
        purchaseUnitNetCents: 80,
        positionType: "required",
        isHidden: false,
        taxTreatment: "standard_19",
      }]),
    )).rejects.toMatchObject({
      name: "PermissionDeniedError",
      action: "price.read_purchase",
    });
    expect(harness.inserts).toEqual([]);
  });

  it("auditiert Duplicate mit derselben project.write-Action, die der Service geprüft hat", async () => {
    const harness = duplicateTx(snapshot());
    await expect(duplicateOfferVariant(
      harness.tx,
      context(),
      {
        schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
        offerId: ids.offer,
        sourceVariantId: ids.variant,
        expectedSourceRevision: 1,
        name: "Berechtigte Kopie",
      },
    )).resolves.toMatchObject({ offerId: ids.offer, revision: 1 });

    const audit = harness.inserts.find((entry) => entry.allowed === true);
    expect(audit).toMatchObject({
      action: "project.write",
      resource: "offer",
      allowed: true,
    });
  });
});

describe("M201-RBAC-01 Offer-Action-Routing", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("server-only", () => ({}));
  });

  it("reserviert an der Action-Boundary exakt die zum Command passende Basisberechtigung", async () => {
    const stopped = new Error("boundary inspected");
    const authorizedOfferMutationAction = vi.fn(async () => {
      throw stopped;
    });
    class NotAuthenticatedError extends Error {}
    class ActionPermissionDeniedError extends Error {}
    class OfferConflictError extends Error {}
    class OfferBlockedError extends Error {}
    class OfferValidationError extends Error {}
    class OfferRateLimitError extends Error {
      constructor(public readonly retryAfter: string) {
        super("rate limited");
      }
    }
    vi.doMock("next/cache", () => ({ revalidatePath: vi.fn() }));
    vi.doMock("next/navigation", () => ({ redirect: vi.fn() }));
    vi.doMock("@/lib/action", () => ({
      authorizedOfferMutationAction,
      NotAuthenticatedError,
    }));
    vi.doMock("@/lib/permissions", () => ({
      PermissionDeniedError: ActionPermissionDeniedError,
    }));
    vi.doMock("@/modules/offers", () => ({
      createOfferFromRequest: vi.fn(),
      createVariantFromCurrentResolution: vi.fn(),
      duplicateOfferVariant: vi.fn(),
      reviseOfferVariant: vi.fn(),
      OfferBlockedError,
      OfferConflictError,
      OfferValidationError,
      OfferRateLimitError,
    }));
    const actions = await import("@/app/w/[workspaceId]/angebote/actions");

    const form = (values: Record<string, string>) => {
      const result = new FormData();
      for (const [key, value] of Object.entries(values)) result.set(key, value);
      return result;
    };
    const cases = [
      {
        call: () => actions.createOfferFromRequestAction({ status: "idle" }, form({
          workspaceId: ids.workspace,
          projectId: ids.project,
          expectedRequirementRevision: "1",
          expectedCalculationRevision: "1",
          expectedResolutionRevision: "1",
          forecastValueNetCents: "100",
          priceAudience: "b2c",
          "priceAudienceConfirmation.code": "b2c_operator_confirmed",
          "priceAudienceConfirmation.confirmed": "true",
          taxTreatment: "standard_19",
        })),
        expected: [
          ids.workspace,
          ["project.write", "phase.convert", "price.edit"],
          "offer",
        ],
      },
      {
        call: () => actions.duplicateOfferVariantAction({ status: "idle" }, form({
          workspaceId: ids.workspace,
          offerId: ids.offer,
          sourceVariantId: ids.variant,
          expectedSourceRevision: "1",
          name: "Kopie",
        })),
        expected: [ids.workspace, ["project.write"], "offer_variant"],
      },
      {
        call: () => actions.reviseOfferVariantAction({ status: "idle" }, form({
          workspaceId: ids.workspace,
          offerId: ids.offer,
          variantId: ids.variant,
          expectedRevision: "1",
          operations: JSON.stringify([{ operation: "set_variant_name", name: "Struktur" }]),
        })),
        expected: [ids.workspace, ["project.write"], "offer_variant"],
      },
      {
        call: () => actions.createVariantFromCurrentResolutionAction(
          { status: "idle" },
          form({
            workspaceId: ids.workspace,
            offerId: ids.offer,
            expectedRequirementRevision: "1",
            expectedCalculationRevision: "1",
            expectedResolutionRevision: "1",
            name: "Neue Basis",
            taxTreatment: "standard_19",
          }),
        ),
        expected: [
          ids.workspace,
          ["project.write", "price.edit"],
          "offer_variant",
        ],
      },
    ] as const;

    for (const testCase of cases) {
      authorizedOfferMutationAction.mockClear();
      await expect(testCase.call()).rejects.toBe(stopped);
      expect(authorizedOfferMutationAction).toHaveBeenCalledWith(
        ...testCase.expected,
        expect.any(Function),
      );
    }
  });
});
