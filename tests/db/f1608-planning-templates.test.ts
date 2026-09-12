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
import { PLANNING_TEMPLATE_SCHEMA_VERSION } from "@/lib/integrations/planning/template-contract";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  activateCatalogComponent,
  createCatalogComponent,
  resolveProjectCatalog,
} from "@/modules/catalog";
import { applyPlanningTemplate } from "@/modules/offers";
import { createOfferFromRequest, OfferConflictError } from "@/modules/offers";
import {
  archivePlanningTemplate,
  createPlanningTemplate,
  listPlanningTemplates,
  PlanningTemplateConflictError,
  PlanningTemplateNotFoundError,
  PlanningTemplateValidationError,
  restorePlanningTemplate,
  updatePlanningTemplate,
} from "@/modules/planning";
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
  adminId: string;
  viewerId: string;
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
    adminId: randomUUID(),
    viewerId: randomUUID(),
  };
  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into workspace (id, name)
      values (${members.workspaceId}::uuid, 'F16-08 Planungs-Vorlagen')
    `);
    for (const userId of [members.operatorId, members.adminId, members.viewerId]) {
      await tx.execute(sql`
        insert into user_identity (id, email)
        values (${userId}::uuid, ${`${userId}@f1608.test`})
      `);
    }
    await tx.execute(sql`
      insert into membership (workspace_id, user_id, role, capabilities)
      values
        (${members.workspaceId}::uuid, ${members.operatorId}::uuid, 'editor',
          '{"manage_catalog":true,"edit_prices":true,"convert_phase":true}'::jsonb),
        (${members.workspaceId}::uuid, ${members.adminId}::uuid, 'admin', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.viewerId}::uuid, 'viewer', '{}'::jsonb)
    `);
  });
  return members;
}

function offerCtx(members: OfferMembers, actor: "operator" | "viewer"): ServiceCtx {
  if (actor === "viewer") {
    return {
      workspaceId: members.workspaceId,
      actor: members.viewerId,
      role: "viewer",
      capabilities: {},
      featureFlags: {},
    };
  }
  return {
    workspaceId: members.workspaceId,
    actor: members.operatorId,
    role: "editor",
    capabilities: { manage_catalog: true, edit_prices: true, convert_phase: true },
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
        'Synthetischer F16-08-Kontakt', 'Fixture', 'Contact', 'f1608.fixture@example.test',
        'f1608.fixture@example.test'
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
        ${ids.contactId}::uuid, 'Synthetischer F16-08-Standort',
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
             board.id, intake.id, 'Synthetisches F16-08-Projekt', 'wmee-rechner-v3'
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
    internalSku: `F1608-${type.toUpperCase()}-${index}`,
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
        reference: `PRIVATE-F1608-PURCHASE-${type}-${index}`,
        observedOn: "2026-08-30",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: `SYNTHETIC-F1608-SALES-${type}-${index}`,
        observedOn: "2026-08-30",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "workspace_manual",
      reference: `SYNTHETIC-F1608-TECH-${type}-${index}`,
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

async function createPlanningPreset(
  members: OfferMembers,
  input: { name: string; mode: "quick" | "2d" | "3d" },
): Promise<string> {
  const created = await withAuthorizedTenantOn(
    testPool, members.adminId, members.workspaceId,
    (tx, ctx) => createPlanningTemplate(tx, ctx, {
      schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
      name: input.name,
      mode: input.mode,
    }),
  );
  return created.id;
}

async function readVariantMode(
  workspaceId: string,
  offerId: string,
  variantId: string,
  revision: number,
): Promise<string | null> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<{ mode: string | null }>(sql`
      select revision_snapshot ->> 'planningMode' as mode
        from offer_variant_revision
       where workspace_id = ${workspaceId}::uuid
         and offer_id = ${offerId}::uuid
         and variant_id = ${variantId}::uuid
         and revision = ${revision}
    `);
    const row = result.rows[0];
    if (!row) throw new Error(`revision ${revision} not found`);
    return row.mode;
  });
}

describe("F16-08 Planungs-Vorlagen (PostgreSQL)", () => {
  it("F1608-DB-01: Anlage → Liste (canWrite je Rolle) → Anwenden setzt Planungsmodus", async () => {
    const { members, offerId, variantId } = await createBasisOffer();
    const templateId = await createPlanningPreset(members, { name: "Standard 2D", mode: "2d" });

    const created = await withAuthorizedTenantOn(
      testPool, members.adminId, members.workspaceId,
      (tx, ctx) => listPlanningTemplates(tx, ctx).then((rows) => rows.find((row) => row.id === templateId)!),
    );
    expect(created.name).toBe("Standard 2D");
    expect(created.mode).toBe("2d");
    expect(created.active).toBe(true);
    expect(created.permissions.canWrite).toBe(true);

    const viewerList = await withAuthorizedTenantOn(
      testPool, members.viewerId, members.workspaceId,
      (tx, ctx) => listPlanningTemplates(tx, ctx),
    );
    expect(viewerList).toHaveLength(1);
    expect(viewerList[0]!.permissions.canWrite).toBe(false);

    const applied = await withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => applyPlanningTemplate(tx, ctx, {
        schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
        templateId,
        offerId,
        variantId,
        expectedRevision: 1,
      }),
    );
    expect(applied.templateId).toBe(templateId);
    expect(applied.mode).toBe("2d");
    expect(applied.revision).toBe(2);
    expect(await readVariantMode(members.workspaceId, offerId, variantId, 2)).toBe("2d");

    // Veraltete Revision → Konflikt, keine dritte Revision.
    await expect(withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => applyPlanningTemplate(tx, ctx, {
        schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
        templateId,
        offerId,
        variantId,
        expectedRevision: 1,
      }),
    )).rejects.toBeInstanceOf(OfferConflictError);
  });

  it("F1608-DB-02: Duplikat → Konflikt; Archiv fail-closed; Viewer-denied", async () => {
    const { members, offerId, variantId } = await createBasisOffer();
    const templateId = await createPlanningPreset(members, { name: "Doppelt", mode: "2d" });
    await expect(createPlanningPreset(members, { name: "  DOPPELT ", mode: "quick" }))
      .rejects.toBeInstanceOf(PlanningTemplateConflictError);

    // Ungültiger Modus.
    await expect(withAuthorizedTenantOn(
      testPool, members.adminId, members.workspaceId,
      (tx, ctx) => createPlanningTemplate(tx, ctx, {
        schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
        name: "Kaputt",
        mode: "4d" as "quick",
      }),
    )).rejects.toBeInstanceOf(PlanningTemplateValidationError);

    // Viewer darf keine Vorlage anlegen (settings.manage = admin).
    await expect(withAuthorizedTenantOn(
      testPool, members.viewerId, members.workspaceId,
      (tx, ctx) => createPlanningTemplate(tx, ctx, {
        schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
        name: "Viewer",
        mode: "quick",
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    // Archivierte Vorlage ist nicht anwendbar.
    await withAuthorizedTenantOn(
      testPool, members.adminId, members.workspaceId,
      (tx, ctx) => archivePlanningTemplate(tx, ctx, {
        schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
        id: templateId,
        active: false,
      }),
    );
    await expect(withAuthorizedTenantOn(
      testPool, members.operatorId, members.workspaceId,
      (tx, ctx) => applyPlanningTemplate(tx, ctx, {
        schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
        templateId,
        offerId,
        variantId,
        expectedRevision: 1,
      }),
    )).rejects.toBeInstanceOf(PlanningTemplateNotFoundError);

    // Reaktivieren → wieder anwendbar.
    const restored = await withAuthorizedTenantOn(
      testPool, members.adminId, members.workspaceId,
      (tx, ctx) => restorePlanningTemplate(tx, ctx, {
        schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
        id: templateId,
        active: true,
      }),
    );
    expect(restored.active).toBe(true);

    // Viewer-Anwenden scheitert am Angebots-Schreibschutz.
    await expect(withAuthorizedTenantOn(
      testPool, members.viewerId, members.workspaceId,
      (tx, ctx) => applyPlanningTemplate(tx, ctx, {
        schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
        templateId,
        offerId,
        variantId,
        expectedRevision: 1,
      }),
    )).rejects.toBeInstanceOf(PermissionDeniedError);

    // Update + fremder Mandant fail-closed.
    const updated = await withAuthorizedTenantOn(
      testPool, members.adminId, members.workspaceId,
      (tx, ctx) => updatePlanningTemplate(tx, ctx, {
        schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
        id: templateId,
        name: "Doppelt Umbenannt",
        mode: "quick",
        position: 3,
      }),
    );
    expect(updated.name).toBe("Doppelt Umbenannt");
    expect(updated.mode).toBe("quick");
    const other = await createOfferMembers();
    await expect(withAuthorizedTenantOn(
      testPool, other.adminId, other.workspaceId,
      (tx, ctx) => updatePlanningTemplate(tx, ctx, {
        schemaVersion: PLANNING_TEMPLATE_SCHEMA_VERSION,
        id: templateId,
        name: "Fremd",
        mode: "quick",
        position: 0,
      }),
    )).rejects.toBeInstanceOf(PlanningTemplateNotFoundError);
  });
});
