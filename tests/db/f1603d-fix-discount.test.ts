import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { withAuthorizedTenantOn, withTenantOn } from "@/lib/db/tenant";
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
  type CreateOfferCommandV1,
} from "@/lib/integrations/offers/contract";
import { DISCOUNT_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/discounts/contract";
import { type ServiceCtx } from "@/lib/permissions";
import {
  activateCatalogComponent,
  createCatalogComponent,
  resolveProjectCatalog,
} from "@/modules/catalog";
import {
  applyDiscountTemplateToOfferGlobal,
  createDiscountTemplate,
} from "@/modules/discounts";
import {
  applySubsidyTemplateToOfferGlobal,
  createSubsidyTemplate,
} from "@/modules/subsidies";
import {
  canonicalizeOfferJson,
  OFFER_VARIANT_REVISE_COMMAND_VERSION,
  validateOfferVariantSnapshot,
} from "@/lib/integrations/offers/contract";
import { SUBSIDY_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/subsidies/contract";
import { createOfferFromRequest, reviseOfferVariant } from "@/modules/offers";
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
      values (${members.workspaceId}::uuid, 'F16.3C Template-Apply')
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
        values (${userId}::uuid, ${`${userId}@f1603d.test`})
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
    internalSku: `F1603D-${type.toUpperCase()}-${index}`,
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
        reference: `PRIVATE-F1603D-PURCHASE-${type}-${index}`,
        observedOn: "2026-08-30",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: `SYNTHETIC-F1603D-SALES-${type}-${index}`,
        observedOn: "2026-08-30",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "workspace_manual",
      reference: `SYNTHETIC-F1603D-TECH-${type}-${index}`,
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



type TemplateOffer = {
  members: OfferMembers;
  offerId: string;
  variantId: string;
};

async function createBasisOffer(): Promise<TemplateOffer> {
  const members = await createOfferMembers();
  const project = await createPlanningProject(members);
  const products = await createActiveProducts(members);
  await resolveCatalog(members, project, products);
  const operator = offerCtx(members, "operator");
  const created = await withTenantOn(testPool, members.workspaceId, (tx) =>
    createOfferFromRequest(tx, operator, offerCreateCommand(project)));
  return { members, offerId: created.offerId, variantId: created.variantId };
}

async function readRevisionSnapshot(
  workspaceId: string,
  variantId: string,
  revision: number,
): Promise<{ snapshot: Record<string, unknown>; totalsBasisNet: number; fix: unknown }> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{ snapshot: Record<string, unknown>; basis: number; fix: unknown }>(sql`
      select revision_snapshot as snapshot,
             (revision_snapshot -> 'totals' ->> 'basisNetCents')::integer as basis,
             (revision_snapshot -> 'globalFixDiscountCents') as fix
        from offer_variant_revision
       where workspace_id = ${workspaceId}::uuid
         and variant_id = ${variantId}::uuid
         and revision = ${revision}
    `);
    const row = result.rows[0];
    if (!row) throw new Error("F1603D: Revision fehlt.");
    return { snapshot: row.snapshot, totalsBasisNet: row.basis, fix: row.fix };
  });
}

describe("F16.3 Slice D Fix-Modell global (PostgreSQL)", () => {
  it("F1603D-DB-01: Fix-Vorlage zieht Betrag vom Total ab (exakt, siegelgebunden)", async () => {
    const { members, offerId, variantId } = await createBasisOffer();
    const before = await readRevisionSnapshot(members.workspaceId, variantId, 1);
    expect(before.fix).toBeNull();
    const created = await withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => createDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
        name: "Fix-500",
        kind: "fix_cents",
        amountCents: 500,
        percentBps: null,
        capCents: null,
      }),
    );
    const result = await withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => applyDiscountTemplateToOfferGlobal(tx, ctx, {
        templateId: created.id, offerId, variantId, expectedRevision: 1,
      }),
    );
    expect(result.revision).toBe(2);
    const after = await readRevisionSnapshot(members.workspaceId, variantId, 2);
    expect(after.fix).toBe(500);
    expect(after.totalsBasisNet).toBe(before.totalsBasisNet - 500);
    // Siegel über Fix-Key: Parser akzeptiert, Wert erhalten.
    const validated = validateOfferVariantSnapshot(after.snapshot);
    expect(validated.ok).toBe(true);
    if (validated.ok) expect(validated.value.globalFixDiscountCents).toBe(500);
  });

  it("F1603D-DB-02: Fix über Total floort bei 0, Aufheben stellt Total wieder her", async () => {
    const { members, offerId, variantId } = await createBasisOffer();
    const before = await readRevisionSnapshot(members.workspaceId, variantId, 1);
    const created = await withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => createDiscountTemplate(tx, ctx, {
        schemaVersion: DISCOUNT_TEMPLATE_SCHEMA_VERSION,
        name: "Fix-Riese",
        kind: "fix_cents",
        amountCents: before.totalsBasisNet + 100_000,
        percentBps: null,
        capCents: null,
      }),
    );
    const apply = (templateId: string, expectedRevision: number) => withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => applyDiscountTemplateToOfferGlobal(tx, ctx, {
        templateId, offerId, variantId, expectedRevision,
      }),
    );
    await apply(created.id, 1);
    const floored = await readRevisionSnapshot(members.workspaceId, variantId, 2);
    expect(floored.totalsBasisNet).toBe(0);
    // Aufheben per direkter Operation (null = kein Fix).
    await withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => reviseOfferVariant(tx, ctx, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId,
        variantId,
        expectedRevision: 2,
        operations: [{ operation: "set_global_fix_discount", fixDiscountCents: null }],
      }),
    );
    const restored = await readRevisionSnapshot(members.workspaceId, variantId, 3);
    expect(restored.fix).toBeNull();
    expect(restored.totalsBasisNet).toBe(before.totalsBasisNet);
  });

  it("F1603D-DB-03: Förder-Fix symmetrisch + v1-Historie bleibt lesbar", async () => {
    const { members, offerId, variantId } = await createBasisOffer();
    const created = await withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => createSubsidyTemplate(tx, ctx, {
        schemaVersion: SUBSIDY_TEMPLATE_SCHEMA_VERSION,
        name: "Foerder-Fix",
        kind: "fix_cents",
        amountCents: 750,
        percentBps: null,
        capCents: null,
      }),
    );
    await withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => applySubsidyTemplateToOfferGlobal(tx, ctx, {
        templateId: created.id, offerId, variantId, expectedRevision: 1,
      }),
    );
    const after = await readRevisionSnapshot(members.workspaceId, variantId, 2);
    expect(after.fix).toBe(750);

    // v1-Historie: Rev-1-Snapshot (fix null) als v1-Body mit v1-Literal
    // und v1-kanonischem Hash versiegeln — echte v1-Gestalt:
    const rev1 = await readRevisionSnapshot(members.workspaceId, variantId, 1);
    const rev1body: Record<string, unknown> = { ...(rev1.snapshot as Record<string, unknown>) };
    delete rev1body.globalFixDiscountCents;
    delete rev1body.snapshotSha256;
    rev1body.schemaVersion = "offer-variant-snapshot.v1";
    const v1sealed = {
      ...rev1body,
      snapshotSha256: createHash("sha256").update(canonicalizeOfferJson(rev1body), "utf8").digest("hex"),
    };
    const validated = validateOfferVariantSnapshot(v1sealed);
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(validated.value.globalFixDiscountCents).toBeNull();
      expect(validated.value.schemaVersion).toBe("offer-variant-snapshot.v2");
    }
  });
});
