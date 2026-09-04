import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { withTenantOn } from "@/lib/db/tenant";
import { calculatePlanningEstimate } from "@/lib/integrations/calculation/engine";
import {
  CALCULATION_CANONICALIZATION_VERSION,
  canonicalizeCalculationJson,
  PLANNING_CALCULATION_CONTRACT_VERSION,
  PLANNING_CALCULATION_SCHEMA_SHA256,
  type PlanningCalculationRequestV1,
} from "@/lib/integrations/calculation/contract";
import {
  PLANNING_DEFAULTS_VERSION,
  PLANNING_MODEL_SOURCE_REVISION,
  PLANNING_PROVIDER_RECIPE_VERSION,
  PLANNING_RESERVATION_VERSION,
} from "@/lib/integrations/calculation/versions";
import {
  CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
  RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
  type CatalogComponentCreateCommandV1,
  type CatalogComponentType,
} from "@/lib/integrations/catalog/contract";
import {
  OFFER_CREATE_COMMAND_VERSION,
  OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
  OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
  OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
  OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
  type CreateOfferCommandV1,
} from "@/lib/integrations/offers/contract";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  activateCatalogComponent,
  createCatalogComponent,
  resolveProjectCatalog,
} from "@/modules/catalog";
import {
  createOfferFromRequest,
  duplicateOfferVariant,
  getOfferDetail,
  OfferNotFoundError,
  OfferValidationError,
  setOptionalBundles,
  setPrimaryVariant,
  setTotalPriceOverride,
} from "@/modules/offers";
import { testPool } from "../setup/test-db";

const GOLDEN_REQUEST = JSON.parse(readFileSync(
  resolve(
    import.meta.dirname,
    "../../contracts/examples/planning-calculation.v1.new.request.json",
  ),
  "utf8",
)) as PlanningCalculationRequestV1;

type ProductType = "module" | "inverter" | "battery" | "wallbox";
type ProductSet = Record<ProductType, string>;

type OfferMembers = {
  workspaceId: string;
  operatorId: string;
  plainEditorId: string;
  adminId: string;
  viewerId: string;
  externalId: string;
};

type PlanningProject = {
  projectId: string;
  siteId: string;
  requirementId: string;
  calculationRevisionId: string;
};

const PRODUCT_PRICES: Record<
  ProductType,
  { purchasePriceNetCents: number; salesPriceNetCents: number }
> = {
  module: { purchasePriceNetCents: 15_000, salesPriceNetCents: 25_000 },
  inverter: { purchasePriceNetCents: 100_000, salesPriceNetCents: 150_000 },
  battery: { purchasePriceNetCents: 250_000, salesPriceNetCents: 400_000 },
  wallbox: { purchasePriceNetCents: 60_000, salesPriceNetCents: 100_000 },
};

async function createOfferMembers(): Promise<OfferMembers> {
  const members = {
    workspaceId: randomUUID(),
    operatorId: randomUUID(),
    plainEditorId: randomUUID(),
    adminId: randomUUID(),
    viewerId: randomUUID(),
    externalId: randomUUID(),
  };
  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, 'F2-02 Variantenvertiefung')
    `);
    for (const userId of [
      members.operatorId,
      members.plainEditorId,
      members.adminId,
      members.viewerId,
      members.externalId,
    ]) {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${userId}::uuid, ${`${userId}@f202-variant.test`})
      `);
    }
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values
        (${members.workspaceId}::uuid, ${members.operatorId}::uuid, 'editor',
          '{"manage_catalog":true,"edit_prices":true,"convert_phase":true,
             "discounts":true,"see_purchase_prices":true}'::jsonb),
        (${members.workspaceId}::uuid, ${members.plainEditorId}::uuid, 'editor', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.adminId}::uuid, 'admin', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return members;
}

function offerCtx(
  members: OfferMembers,
  actor: "operator" | "plainEditor" | "viewer",
): ServiceCtx {
  if (actor === "viewer") {
    return {
      workspaceId: members.workspaceId,
      actor: members.viewerId,
      role: "viewer",
      capabilities: {},
      featureFlags: {},
    };
  }
  if (actor === "plainEditor") {
    return {
      workspaceId: members.workspaceId,
      actor: members.plainEditorId,
      role: "editor",
      capabilities: {},
      featureFlags: {},
    };
  }
  return {
    workspaceId: members.workspaceId,
    actor: members.operatorId,
    role: "editor",
    capabilities: {
      manage_catalog: true,
      edit_prices: true,
      convert_phase: true,
      discounts: true,
      see_purchase_prices: true,
    },
    featureFlags: {},
  };
}

async function createPlanningProject(members: OfferMembers): Promise<PlanningProject> {
  const ids = {
    contactId: randomUUID(),
    siteId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    snapshotId: randomUUID(),
    requirementId: randomUUID(),
    profileId: randomUUID(),
    jobId: randomUUID(),
    calculationRevisionId: randomUUID(),
  };
  const request = structuredClone(GOLDEN_REQUEST);
  request.bindings = {
    ...request.bindings,
    workspaceId: members.workspaceId,
    projectId: ids.projectId,
    siteId: ids.siteId,
    addressRevision: 1,
    pinConfirmedAddressRevision: 1,
    energyProfileId: ids.profileId,
    energyProfileRevision: 1,
    confirmedEnergyProfileRevision: 1,
    confirmedEnergyProfileAddressRevision: 1,
    projectRequirementId: ids.requirementId,
    projectRequirementRevision: 1,
    sourceCalculatorSnapshotId: ids.snapshotId,
  };
  const result = calculatePlanningEstimate(request);
  const profileSha256 = createHash("sha256")
    .update(canonicalizeCalculationJson(request.energyProfile), "utf8")
    .digest("hex");
  const reservationSha256 = createHash("sha256")
    .update(canonicalizeCalculationJson({
      reservationVersion: PLANNING_RESERVATION_VERSION,
      canonicalizationVersion: CALCULATION_CANONICALIZATION_VERSION,
      schemaSha256: PLANNING_CALCULATION_SCHEMA_SHA256,
      bindings: {
        workspaceId: members.workspaceId,
        projectId: ids.projectId,
        siteId: ids.siteId,
        addressRevision: 1,
        pinConfirmedAddressRevision: 1,
        profileId: ids.profileId,
        profileRevision: 1,
        confirmedProfileRevision: 1,
        confirmedAddressRevision: 1,
        requirementId: ids.requirementId,
        requirementRevision: 1,
        sourceSnapshotId: ids.snapshotId,
      },
      providerRecipeVersion: PLANNING_PROVIDER_RECIPE_VERSION,
      contractVersion: PLANNING_CALCULATION_CONTRACT_VERSION,
      modelId: result.model.id,
      modelVersion: result.model.version,
      sourceRevision: PLANNING_MODEL_SOURCE_REVISION,
      defaultsVersion: PLANNING_DEFAULTS_VERSION,
    }), "utf8")
    .digest("hex");
  const calculatorSnapshot = {
    schemaVersion: "wmee-solar-snapshot.v1",
    calculatedAt: "2026-08-30T08:00:00.000Z",
    branch: "new_installation",
    questionnaireVariant: "short",
    resultIntegrity: "client_reported_unverified",
    inputs: {},
    provenance: { investment: "market_estimate" },
    result: { mode: "new_installation" },
  };

  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, first_name, last_name, email_primary, email_normalized
      ) values (
        ${ids.contactId}::uuid, ${members.workspaceId}::uuid,
        'Synthetischer F2-02-Kontakt', 'Fixture', 'Contact', 'f202.fixture@example.test',
        'f202.fixture@example.test'
      )
    `);
    await tx.execute(sql`
      insert into site (
        id, workspace_id, contact_id, label, formatted_address,
        address_fingerprint, address_fingerprint_version, address_mode,
        street, house_number, postal_code, city, country, lat, lng,
        geocode_source, geocode_precision, address_follow_up_required,
        address_revision, pin_confirmed, pin_confirmed_address_revision
      ) values (
        ${ids.siteId}::uuid, ${members.workspaceId}::uuid,
        ${ids.contactId}::uuid, 'Synthetischer F2-02-Standort',
        'Testweg 7, 69168 Dielheim', decode(repeat('ca', 32), 'hex'), 1,
        'selected', 'Testweg', '7', '69168', 'Dielheim', 'DE',
        ${request.site.latitude}, ${request.site.longitude}, 'photon', 'house',
        false, 1, true, 1
      )
    `);
    await tx.execute(sql`
      insert into project (
        id, workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      )
      select ${ids.projectId}::uuid, ${members.workspaceId}::uuid,
             ${ids.contactId}::uuid, ${ids.siteId}::uuid,
             board.id, intake.id, 'Synthetisches F2-02-Projekt', 'wmee-rechner-v3'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id
         and intake.board_id = board.id
         and intake.is_intake = true
       where board.workspace_id = ${members.workspaceId}::uuid
         and board.scope = 'residential'
         and board.is_default = true
         and board.archived_at is null
         and intake.archived_at is null
    `);
    await tx.execute(sql`
      insert into inbound_receipt (
        id, workspace_id, source_key, submission_id, contract_version,
        body_sha256, auth_key_id, signed_at, submitted_at, received_at,
        producer_application, producer_git_revision, producer_environment,
        calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
        privacy_notice_version, privacy_notice_url, contact_resolution,
        contact_id, site_id, project_id
      ) values (
        ${ids.receiptId}::uuid, ${members.workspaceId}::uuid, 'wmee-rechner-v3',
        ${randomUUID()}::uuid, 'rechner-intake.v1', decode(repeat('20', 32), 'hex'),
        'f202-fixture', now(), now(), now(), 'wmee-rechner-v3',
        ${"2".repeat(40)}, 'development', 'wmee-solar.v1', '{}'::jsonb,
        'offer_request', 'art_6_1_b_precontractual', 'fixture-v1',
        'https://example.test/privacy', 'created', ${ids.contactId}::uuid,
        ${ids.siteId}::uuid, ${ids.projectId}::uuid
      )
    `);
    await tx.execute(sql`
      insert into calculator_snapshot (
        id, workspace_id, receipt_id, project_id, schema_version,
        calculator_engine, result_integrity, investment_source, calculated_at,
        snapshot
      ) values (
        ${ids.snapshotId}::uuid, ${members.workspaceId}::uuid,
        ${ids.receiptId}::uuid, ${ids.projectId}::uuid,
        'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate', now(),
        ${JSON.stringify(calculatorSnapshot)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into project_requirement (
        id, workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${ids.requirementId}::uuid, ${members.workspaceId}::uuid,
        ${ids.projectId}::uuid, 1, 'project-requirements.rechner.v1',
        ${ids.snapshotId}::uuid, ${JSON.stringify(request.projectRequirements)}::jsonb
      )
    `);
    await tx.execute(sql`
      insert into site_energy_profile (
        id, workspace_id, site_id, revision, schema_version, input_mode,
        source_kind, source_snapshot_id, source_project_id, address_revision,
        profile, profile_sha256, confirmed_profile_revision,
        confirmed_address_revision, confirmed_by, confirmed_at
      ) values (
        ${ids.profileId}::uuid, ${members.workspaceId}::uuid, ${ids.siteId}::uuid,
        1, 'site-energy-profile.v1', 'consumption', 'rechner_snapshot',
        ${ids.snapshotId}::uuid, ${ids.projectId}::uuid, 1,
        ${JSON.stringify(request.energyProfile)}::jsonb,
        decode(${profileSha256}, 'hex'), 1, 1, ${members.operatorId}::uuid, now()
      )
    `);
    await tx.execute(sql`
      insert into project_calculation_job (
        id, workspace_id, project_id, site_id, address_revision,
        pin_confirmed_address_revision, profile_id, profile_revision,
        confirmed_profile_revision, confirmed_address_revision,
        requirement_id, requirement_revision, source_snapshot_id,
        reservation_key, provider_recipe_version, contract_version,
        model_id, model_version, source_revision, defaults_version,
        state, attempt_count, next_attempt_at, lease_token, lease_expires_at,
        input_sha256, input_snapshot, provider_snapshot, created_by, started_at
      ) values (
        ${ids.jobId}::uuid, ${members.workspaceId}::uuid, ${ids.projectId}::uuid,
        ${ids.siteId}::uuid, 1, 1, ${ids.profileId}::uuid, 1, 1, 1,
        ${ids.requirementId}::uuid, 1, ${ids.snapshotId}::uuid,
        decode(${reservationSha256}, 'hex'), ${PLANNING_PROVIDER_RECIPE_VERSION},
        ${PLANNING_CALCULATION_CONTRACT_VERSION}, ${result.model.id},
        ${result.model.version}, ${result.model.sourceRevision},
        ${PLANNING_DEFAULTS_VERSION},
        'running', 1, now(), ${randomUUID()}::uuid, now() + interval '15 minutes',
        decode(${result.inputSha256}, 'hex'), ${JSON.stringify(request)}::jsonb,
        ${JSON.stringify(request.yieldSnapshots)}::jsonb,
        ${members.operatorId}::uuid, now()
      )
    `);
    await tx.execute(sql`
      insert into project_calculation_revision (
        id, workspace_id, project_id, site_id, revision, job_id,
        address_revision, pin_confirmed_address_revision, profile_id,
        profile_revision, confirmed_profile_revision, confirmed_address_revision,
        requirement_id, requirement_revision, source_snapshot_id,
        contract_version, model_id, model_version, source_revision,
        defaults_version, quality, validation_status, input_sha256,
        result_sha256, input_snapshot, provider_snapshot, result, created_by
      ) values (
        ${ids.calculationRevisionId}::uuid, ${members.workspaceId}::uuid,
        ${ids.projectId}::uuid, ${ids.siteId}::uuid, 1, ${ids.jobId}::uuid,
        1, 1, ${ids.profileId}::uuid, 1, 1, 1, ${ids.requirementId}::uuid, 1,
        ${ids.snapshotId}::uuid, ${PLANNING_CALCULATION_CONTRACT_VERSION},
        ${result.model.id}, ${result.model.version}, ${result.model.sourceRevision},
        ${PLANNING_DEFAULTS_VERSION}, ${result.quality}, ${result.validationStatus},
        decode(${result.inputSha256}, 'hex'), decode(${result.resultSha256}, 'hex'),
        ${JSON.stringify(request)}::jsonb, ${JSON.stringify(request.yieldSnapshots)}::jsonb,
        ${JSON.stringify(result)}::jsonb, ${members.operatorId}::uuid
      )
    `);
    await tx.execute(sql`
      update project_calculation_job
         set state = 'succeeded', lease_token = null, lease_expires_at = null,
             finished_at = now(), result_revision_id = ${ids.calculationRevisionId}::uuid
       where workspace_id = ${members.workspaceId}::uuid
         and id = ${ids.jobId}::uuid
    `);
  });
  return {
    projectId: ids.projectId,
    siteId: ids.siteId,
    requirementId: ids.requirementId,
    calculationRevisionId: ids.calculationRevisionId,
  };
}

function productCommand(
  type: ProductType,
  index: number,
): CatalogComponentCreateCommandV1 {
  const technicalData = type === "module"
    ? { schemaVersion: "module.v1" as const, nominalPowerWatts: 400 }
    : type === "inverter"
      ? {
          schemaVersion: "inverter.v1" as const,
          nominalAcPowerWatts: 10_000,
          phaseCount: 3 as const,
          mpptTrackerCount: 3,
        }
      : type === "battery"
        ? {
            schemaVersion: "battery.v1" as const,
            nominalCapacityWh: 8_500,
            usableCapacityWh: 8_000,
            maxContinuousPowerWatts: 4_000,
            roundTripEfficiencyBasisPoints: 9_400,
            backupCapability: "known_supported" as const,
          }
        : {
            schemaVersion: "wallbox.v1" as const,
            maxChargingPowerWatts: 11_000,
            phaseCount: 3 as const,
            connector: "type2_cable" as const,
            bidirectionalCapability: "known_supported" as const,
          };
  const basePrices = PRODUCT_PRICES[type];
  return {
    schemaVersion: CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
    internalSku: `F202-${type.toUpperCase()}-${index}`,
    componentType: type as CatalogComponentType,
    presentation: {
      displayName: `Synthetische ${type}-Komponente`,
      manufacturer: "WMEE Testwerk",
      model: `Fixture ${index}`,
      unit: "piece",
      keyPoints: ["Keine realen Produktdaten"],
      image: null,
      datasheet: null,
    },
    technicalData,
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: basePrices.purchasePriceNetCents,
      salesPriceNetCents: basePrices.salesPriceNetCents,
      purchaseProvenance: {
        sourceKind: "supplier_price_list",
        reference: `PRIVATE-F202-PURCHASE-${type}-${index}`,
        observedOn: "2026-08-30",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: `SYNTHETIC-F202-SALES-${type}-${index}`,
        observedOn: "2026-08-30",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "workspace_manual",
      reference: `SYNTHETIC-F202-TECH-${type}-${index}`,
      observedOn: "2026-08-30",
      rightsBasis: "workspace_owned",
      sourceDocumentSha256: null,
    },
  };
}

async function createActiveProducts(members: OfferMembers): Promise<ProductSet> {
  const operator = offerCtx(members, "operator");
  const result = {} as ProductSet;
  for (const [index, type] of ([
    "module",
    "inverter",
    "battery",
    "wallbox",
  ] as const).entries()) {
    const created = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createCatalogComponent(tx, operator, productCommand(type, index + 1)));
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      activateCatalogComponent(tx, operator, {
        componentId: created.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      }));
    result[type] = created.componentId;
  }
  return result;
}

async function resolveCatalog(
  members: OfferMembers,
  project: PlanningProject,
  products: ProductSet,
): Promise<void> {
  const operator = offerCtx(members, "operator");
  await withTenantOn(testPool, members.workspaceId, (tx) =>
    resolveProjectCatalog(tx, operator, {
      schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
      projectId: project.projectId,
      expectedResolutionRevision: 0,
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      selections: [
        { componentId: products.module, expectedComponentRevision: 1, quantity: 26 },
        { componentId: products.inverter, expectedComponentRevision: 1, quantity: 1 },
        { componentId: products.battery, expectedComponentRevision: 1, quantity: 1 },
        { componentId: products.wallbox, expectedComponentRevision: 1, quantity: 1 },
      ],
      acknowledgements: ["cross_component_compatibility_unverified"],
    }));
}

function offerCreateCommand(project: PlanningProject): CreateOfferCommandV1 {
  return {
    schemaVersion: OFFER_CREATE_COMMAND_VERSION,
    projectId: project.projectId,
    expectedRequirementRevision: 1,
    expectedCalculationRevision: 1,
    expectedResolutionRevision: 1,
    forecastValueNetCents: 1_250_000,
    priceAudience: "b2c",
    priceAudienceConfirmation: {
      code: "b2c_operator_confirmed",
      confirmed: true,
    },
    taxTreatment: "standard_19",
  };
}

type TwoVariantOffer = {
  members: OfferMembers;
  offerId: string;
  basisVariantId: string;
  secondVariantId: string;
};

async function createTwoVariantOffer(): Promise<TwoVariantOffer> {
  const members = await createOfferMembers();
  const project = await createPlanningProject(members);
  const products = await createActiveProducts(members);
  await resolveCatalog(members, project, products);
  const operator = offerCtx(members, "operator");
  const created = await withTenantOn(testPool, members.workspaceId, (tx) =>
    createOfferFromRequest(tx, operator, offerCreateCommand(project)));
  const second = await withTenantOn(testPool, members.workspaceId, (tx) =>
    duplicateOfferVariant(tx, operator, {
      schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
      offerId: created.offerId,
      sourceVariantId: created.variantId,
      expectedSourceRevision: 1,
      name: "Zweite Variante",
    }));
  return {
    members,
    offerId: created.offerId,
    basisVariantId: created.variantId,
    secondVariantId: second.variantId,
  };
}

async function readPrimaryFlags(
  workspaceId: string,
  offerId: string,
): Promise<Array<{ id: string; is_primary: boolean }>> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{ id: string; is_primary: boolean }>(sql`
      select id, is_primary from offer_variant
      where workspace_id = ${workspaceId}::uuid and offer_id = ${offerId}::uuid
      order by ordinal, id
    `);
    return result.rows;
  });
}

async function countEvents(
  workspaceId: string,
  offerId: string,
  eventType: string,
): Promise<number> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from domain_events
      where workspace_id = ${workspaceId}::uuid
        and aggregate_id = ${offerId}::uuid
        and event_type = ${eventType}
    `);
    return result.rows[0]?.n ?? 0;
  });
}

describe("F2.2 Varianten-Vertiefung", () => {
  it("markiert die Erstvariante automatisch als primaer", async () => {
    const { members, offerId, basisVariantId } = await createTwoVariantOffer();
    const flags = await readPrimaryFlags(members.workspaceId, offerId);
    expect(flags.find((row) => row.id === basisVariantId)?.is_primary).toBe(true);
  });

  it("legt Duplikate nie als primaer an", async () => {
    const { members, offerId, secondVariantId } = await createTwoVariantOffer();
    const flags = await readPrimaryFlags(members.workspaceId, offerId);
    expect(flags).toHaveLength(2);
    expect(flags.find((row) => row.id === secondVariantId)?.is_primary).toBe(false);
  });

  it("switcht die Primaermarkierung atomar (genau eine Primary)", async () => {
    const { members, offerId, basisVariantId, secondVariantId } = await createTwoVariantOffer();
    const operator = offerCtx(members, "operator");
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      setPrimaryVariant(tx, operator, {
        schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
        offerId,
        variantId: secondVariantId,
      }));
    const flags = await readPrimaryFlags(members.workspaceId, offerId);
    expect(flags.filter((row) => row.is_primary).map((row) => row.id)).toEqual([
      secondVariantId,
    ]);
    expect(flags.find((row) => row.id === basisVariantId)?.is_primary).toBe(false);
  });

  it("lehnt unbekannte und fremde Varianten mit NotFound ab", async () => {
    const first = await createTwoVariantOffer();
    const second = await createTwoVariantOffer();
    const operator = offerCtx(first.members, "operator");
    await expect(
      withTenantOn(testPool, first.members.workspaceId, (tx) =>
        setPrimaryVariant(tx, operator, {
          schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
          offerId: first.offerId,
          variantId: randomUUID(),
        })),
    ).rejects.toBeInstanceOf(OfferNotFoundError);
    await expect(
      withTenantOn(testPool, first.members.workspaceId, (tx) =>
        setPrimaryVariant(tx, operator, {
          schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
          offerId: first.offerId,
          variantId: second.secondVariantId,
        })),
    ).rejects.toBeInstanceOf(OfferNotFoundError);
  });

  it("ist idempotent ohne Audit-Rauschen auf bereits primaerer Variante", async () => {
    const { members, offerId, basisVariantId } = await createTwoVariantOffer();
    const operator = offerCtx(members, "operator");
    const before = await countEvents(members.workspaceId, offerId, "offer.primary_switched");
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      setPrimaryVariant(tx, operator, {
        schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
        offerId,
        variantId: basisVariantId,
      }));
    expect(await countEvents(members.workspaceId, offerId, "offer.primary_switched")).toBe(
      before,
    );
  });

  it("schreibt Switch mit Audit-Event und schreibt die Anzeige auf die neue Primary um", async () => {
    const { members, offerId, secondVariantId } = await createTwoVariantOffer();
    const operator = offerCtx(members, "operator");
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      setPrimaryVariant(tx, operator, {
        schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
        offerId,
        variantId: secondVariantId,
      }));
    expect(await countEvents(members.workspaceId, offerId, "offer.primary_switched")).toBe(1);
    const detail = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getOfferDetail(tx, operator, { offerId, variantId: null }));
    expect(detail?.primaryVariantId).toBe(secondVariantId);
  });

  it("setzt und loescht den Deal-Override mit Audit, ohne neue Revision", async () => {
    const { members, offerId } = await createTwoVariantOffer();
    const operator = offerCtx(members, "operator");
    const revisions = await withTenantOn(testPool, members.workspaceId, async (tx) => {
      const result = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from offer_variant_revision
        where workspace_id = ${members.workspaceId}::uuid and offer_id = ${offerId}::uuid
      `);
      return result.rows[0]?.n ?? 0;
    });
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      setTotalPriceOverride(tx, operator, {
        schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
        offerId,
        totalPriceOverrideNetCents: 999_000,
      }));
    const detail = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getOfferDetail(tx, operator, { offerId, variantId: null }));
    expect(detail?.overrideActive).toBe(true);
    expect(detail?.displayTotalNetCents).toBe(999_000);
    expect(detail?.displayTotalGrossCents).toBeNull();
    expect(await countEvents(members.workspaceId, offerId, "offer.total_override_set")).toBe(1);
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      setTotalPriceOverride(tx, operator, {
        schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
        offerId,
        totalPriceOverrideNetCents: null,
      }));
    const cleared = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getOfferDetail(tx, operator, { offerId, variantId: null }));
    expect(cleared?.overrideActive).toBe(false);
    expect(cleared?.displayTotalGrossCents).not.toBeNull();
    const after = await withTenantOn(testPool, members.workspaceId, async (tx) => {
      const result = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from offer_variant_revision
        where workspace_id = ${members.workspaceId}::uuid and offer_id = ${offerId}::uuid
      `);
      return result.rows[0]?.n ?? 0;
    });
    expect(after).toBe(revisions);
  });

  it("validiert den Override-Bereich strikt", async () => {
    const { members, offerId } = await createTwoVariantOffer();
    const operator = offerCtx(members, "operator");
    await expect(
      withTenantOn(testPool, members.workspaceId, (tx) =>
        setTotalPriceOverride(tx, operator, {
          schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
          offerId,
          totalPriceOverrideNetCents: -1,
        })),
    ).rejects.toBeInstanceOf(OfferValidationError);
  });

  it("pflegt optionale Bundles mit Form- und Eindeutigkeitsregeln", async () => {
    const { members, offerId, basisVariantId } = await createTwoVariantOffer();
    const operator = offerCtx(members, "operator");
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      setOptionalBundles(tx, operator, {
        schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
        offerId,
        variantId: basisVariantId,
        bundles: [
          { name: "Wallbox-Paket", position: 0 },
          { name: "Notstrom-Paket", position: 1 },
        ],
      }));
    await expect(
      withTenantOn(testPool, members.workspaceId, (tx) =>
        setOptionalBundles(tx, operator, {
          schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
          offerId,
          variantId: basisVariantId,
          bundles: [
            { name: "A", position: 0 },
            { name: "B", position: 0 },
          ],
        })),
    ).rejects.toBeInstanceOf(OfferValidationError);
    await expect(
      withTenantOn(testPool, members.workspaceId, (tx) =>
        setOptionalBundles(tx, operator, {
          schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
          offerId,
          variantId: basisVariantId,
          bundles: [{ name: "  ", position: 2 }],
        })),
    ).rejects.toBeInstanceOf(OfferValidationError);
    const before = await countEvents(members.workspaceId, offerId, "offer.variant_bundles_set");
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      setOptionalBundles(tx, operator, {
        schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
        offerId,
        variantId: basisVariantId,
        bundles: [
          { name: "Wallbox-Paket", position: 0 },
          { name: "Notstrom-Paket", position: 1 },
        ],
      }));
    expect(await countEvents(members.workspaceId, offerId, "offer.variant_bundles_set")).toBe(
      before,
    );
  });

  it("blockiert Viewer bei allen drei Mutationen", async () => {
    const { members, offerId, basisVariantId, secondVariantId } = await createTwoVariantOffer();
    const viewer = offerCtx(members, "viewer");
    await expect(
      withTenantOn(testPool, members.workspaceId, (tx) =>
        setPrimaryVariant(tx, viewer, {
          schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
          offerId,
          variantId: secondVariantId,
        })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      withTenantOn(testPool, members.workspaceId, (tx) =>
        setTotalPriceOverride(tx, viewer, {
          schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
          offerId,
          totalPriceOverrideNetCents: 100,
        })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      withTenantOn(testPool, members.workspaceId, (tx) =>
        setOptionalBundles(tx, viewer, {
          schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
          offerId,
          variantId: basisVariantId,
          bundles: [],
        })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("zeigt ohne Primary keine Totals, aber einen wirksamen Netto-Override", async () => {
    const { members, offerId } = await createTwoVariantOffer();
    const operator = offerCtx(members, "operator");
    await withTenantOn(testPool, members.workspaceId, async (tx) => {
      await tx.execute(sql`
        update offer_variant set is_primary = false
        where workspace_id = ${members.workspaceId}::uuid and offer_id = ${offerId}::uuid
      `);
    });
    const bare = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getOfferDetail(tx, operator, { offerId, variantId: null }));
    expect(bare?.primaryVariantId).toBeNull();
    expect(bare?.displayTotalNetCents).toBeNull();
    expect(bare?.displayTotalGrossCents).toBeNull();
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      setTotalPriceOverride(tx, operator, {
        schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
        offerId,
        totalPriceOverrideNetCents: 123_450,
      }));
    const overridden = await withTenantOn(testPool, members.workspaceId, (tx) =>
      getOfferDetail(tx, operator, { offerId, variantId: null }));
    expect(overridden?.displayTotalNetCents).toBe(123_450);
    expect(overridden?.displayTotalGrossCents).toBeNull();
  });

  it("haelt Exactly-One auch bei direkter Zweit-Primary auf DB-Ebene", async () => {
    const { members, offerId, secondVariantId } = await createTwoVariantOffer();
    await expect(
      withTenantOn(testPool, members.workspaceId, async (tx) => {
        await tx.execute(sql`
          update offer_variant set is_primary = true
          where workspace_id = ${members.workspaceId}::uuid
            and offer_id = ${offerId}::uuid
            and id = ${secondVariantId}::uuid
        `);
      }),
    ).rejects.toThrow(/duplicate|unique|PRIMARY/i);
  });

  it("unterdrueckt wertgleiche Override-Writes ohne Event", async () => {
    const { members, offerId } = await createTwoVariantOffer();
    const operator = offerCtx(members, "operator");
    const setCommand = {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId,
      totalPriceOverrideNetCents: 777_000,
    } as const;
    const first = await withTenantOn(testPool, members.workspaceId, (tx) =>
      setTotalPriceOverride(tx, operator, setCommand));
    expect(first.changed).toBe(true);
    const again = await withTenantOn(testPool, members.workspaceId, (tx) =>
      setTotalPriceOverride(tx, operator, setCommand));
    expect(again.changed).toBe(false);
    expect(await countEvents(members.workspaceId, offerId, "offer.total_override_set")).toBe(1);
    const clearCommand = {
      schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
      offerId,
      totalPriceOverrideNetCents: null,
    } as const;
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      setTotalPriceOverride(tx, operator, clearCommand));
    const clearedAgain = await withTenantOn(testPool, members.workspaceId, (tx) =>
      setTotalPriceOverride(tx, operator, clearCommand));
    expect(clearedAgain.changed).toBe(false);
    expect(await countEvents(members.workspaceId, offerId, "offer.total_override_cleared")).toBe(1);
  });

  it("laesst plainEditor Primary/Bundles zu, aber keinen Override", async () => {
    const { members, offerId, basisVariantId, secondVariantId } = await createTwoVariantOffer();
    const plainEditor = offerCtx(members, "plainEditor");
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      setPrimaryVariant(tx, plainEditor, {
        schemaVersion: OFFER_VARIANT_SET_PRIMARY_COMMAND_VERSION,
        offerId,
        variantId: secondVariantId,
      }));
    await withTenantOn(testPool, members.workspaceId, (tx) =>
      setOptionalBundles(tx, plainEditor, {
        schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
        offerId,
        variantId: basisVariantId,
        bundles: [{ name: "Editor-Paket", position: 0 }],
      }));
    await expect(
      withTenantOn(testPool, members.workspaceId, (tx) =>
        setTotalPriceOverride(tx, plainEditor, {
          schemaVersion: OFFER_TOTAL_OVERRIDE_COMMAND_VERSION,
          offerId,
          totalPriceOverrideNetCents: 100,
        })),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("validiert Bundle-Commands auf Vertrags-Ebene", async () => {
    const { members, offerId, basisVariantId } = await createTwoVariantOffer();
    const operator = offerCtx(members, "operator");
    await expect(
      withTenantOn(testPool, members.workspaceId, (tx) =>
        setOptionalBundles(tx, operator, {
          schemaVersion: OFFER_VARIANT_BUNDLES_COMMAND_VERSION,
          offerId,
          variantId: basisVariantId,
          bundles: Array.from({ length: 51 }, (_v, index) => ({
            name: `Paket ${index}`,
            position: index,
          })),
        })),
    ).rejects.toBeInstanceOf(OfferValidationError);
  });
});
