import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
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
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
  CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
  RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
  sealCatalogComponentRevision,
  type CatalogComponentCreateCommandV1,
  type CatalogComponentType,
} from "@/lib/integrations/catalog/contract";
import {
  OFFER_CREATE_COMMAND_VERSION,
  OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
  OFFER_VARIANT_FROM_RESOLUTION_COMMAND_VERSION,
  OFFER_VARIANT_REVISE_COMMAND_VERSION,
  validateOfferVariantSnapshot,
  type CreateOfferCommandV1,
  type OfferVariantSnapshotV1,
} from "@/lib/integrations/offers/contract";
import { calculateOfferPricing } from "@/lib/integrations/offers/money";
import { PermissionDeniedError, type ServiceCtx } from "@/lib/permissions";
import {
  activateCatalogComponent,
  createCatalogComponent,
  resolveProjectCatalog,
  reviseCatalogComponentPricing,
} from "@/modules/catalog";
import {
  createOfferFromRequest,
  createVariantFromCurrentResolution,
  duplicateOfferVariant,
  getOfferDetail,
  listOffers,
  OfferConflictError,
  OfferNotFoundError,
  OfferValidationError,
  reviseOfferVariant,
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
type ProductRevisions = Record<ProductType, number>;

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

type OfferFixture = {
  members: OfferMembers;
  project: PlanningProject;
  products: ProductSet;
  createCommand: CreateOfferCommandV1;
};

type RevisionRow = {
  revision: number;
  revision_snapshot: OfferVariantSnapshotV1;
  snapshot_text: string;
  snapshot_sha256_hex: string;
  [key: string]: unknown;
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
      values (${members.workspaceId}::uuid, 'M2-01 Angebotsservice')
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
        values (${userId}::uuid, ${`${userId}@m201-offer.test`})
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
        (${members.workspaceId}::uuid, ${members.viewerId}::uuid, 'viewer', '{}'::jsonb),
        (${members.workspaceId}::uuid, ${members.externalId}::uuid, 'editor',
          '{"manage_catalog":true,"edit_prices":true,"convert_phase":true,
             "discounts":true,"see_purchase_prices":true,"external_only":true}'::jsonb)
    `);
  });
  return members;
}

function offerCtx(
  members: OfferMembers,
  actor: "operator" | "plainEditor" | "admin" | "viewer" | "external",
): ServiceCtx {
  if (actor === "admin") {
    return {
      workspaceId: members.workspaceId,
      actor: members.adminId,
      role: "admin",
      capabilities: {},
      featureFlags: {},
    };
  }
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
  const external = actor === "external";
  return {
    workspaceId: members.workspaceId,
    actor: external ? members.externalId : members.operatorId,
    role: "editor",
    capabilities: {
      manage_catalog: true,
      edit_prices: true,
      convert_phase: true,
      discounts: true,
      see_purchase_prices: true,
      ...(external ? { external_only: true } : {}),
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
        'Synthetischer Angebotskontakt', 'Fixture', 'Contact', 'offer.fixture@example.test',
        'offer.fixture@example.test'
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
        ${ids.contactId}::uuid, 'Synthetischer Angebotsstandort',
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
             board.id, intake.id, 'Synthetisches Angebotsprojekt', 'wmee-rechner-v3'
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
        'm201-fixture', now(), now(), now(), 'wmee-rechner-v3',
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
  priceOffsetCents = 0,
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
    internalSku: `M201-${type.toUpperCase()}-${index}`,
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
      purchasePriceNetCents: basePrices.purchasePriceNetCents
        + Math.trunc(priceOffsetCents / 2),
      salesPriceNetCents: basePrices.salesPriceNetCents + priceOffsetCents,
      purchaseProvenance: {
        sourceKind: "supplier_price_list",
        reference: `PRIVATE-M201-PURCHASE-${type}-${index}`,
        observedOn: "2026-08-30",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: `SYNTHETIC-M201-SALES-${type}-${index}`,
        observedOn: "2026-08-30",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "workspace_manual",
      reference: `SYNTHETIC-M201-TECH-${type}-${index}`,
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

/**
 * Large Offer-boundary fixtures are inserted in bulk so the test spends its
 * time in the real resolution and Offer services, not in hundreds of
 * unrelated catalog create/activate round trips. Every copied component is
 * nevertheless sealed by the production catalog contract and accepted by the
 * catalog revision triggers before it can become active.
 */
async function createBulkActiveOtherProducts(
  members: OfferMembers,
  count: number,
): Promise<string[]> {
  const rows = Array.from({ length: count }, (_value, index) => {
    const ordinal = index + 1;
    const componentId = randomUUID();
    const revisionId = randomUUID();
    const internalSku = `M201-SEED-OTHER-${String(ordinal).padStart(3, "0")}`;
    const snapshot = sealCatalogComponentRevision({
      schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
      canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
      identity: {
        workspaceId: members.workspaceId,
        componentId,
        revision: 1,
        internalSku,
        componentType: "other",
      },
      presentation: {
        displayName: `Synthetische Seed-Komponente ${ordinal}`,
        manufacturer: "WMEE Testwerk",
        model: `Seedgrenze ${ordinal}`,
        unit: "piece",
        keyPoints: ["Nur fuer den vollstaendigen Seed-Grenztest"],
        image: null,
        datasheet: null,
      },
      technicalData: {
        schemaVersion: "other.v1",
        attributes: [{ name: "fixture", value: String(ordinal) }],
      },
      commercial: {
        currency: "EUR",
        basis: "net",
        purchasePriceNetCents: 100,
        salesPriceNetCents: 200,
        purchaseProvenance: {
          sourceKind: "supplier_price_list",
          reference: `PRIVATE-M201-SEED-PURCHASE-${ordinal}`,
          observedOn: "2026-08-30",
          rightsBasis: "supplier_authorized",
          sourceDocumentSha256: null,
        },
        salesProvenance: {
          sourceKind: "workspace_pricing",
          reference: `SYNTHETIC-M201-SEED-SALES-${ordinal}`,
          observedOn: "2026-08-30",
          rightsBasis: "workspace_owned",
          sourceDocumentSha256: null,
        },
      },
      technicalProvenance: {
        sourceKind: "workspace_manual",
        reference: `SYNTHETIC-M201-SEED-TECH-${ordinal}`,
        observedOn: "2026-08-30",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    });
    return {
      component_id: componentId,
      revision_id: revisionId,
      internal_sku: internalSku,
      revision_snapshot: snapshot,
      snapshot_sha256: snapshot.snapshotSha256,
    };
  });

  await withTenantOn(testPool, members.workspaceId, async (tx) => {
    await tx.execute(sql`
      insert into catalog_component (
        id, workspace_id, internal_sku, component_type, created_by
      )
      select seed.component_id::uuid, ${members.workspaceId}::uuid,
             seed.internal_sku, 'other', ${members.operatorId}::uuid
        from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as seed(
          component_id text,
          revision_id text,
          internal_sku text,
          revision_snapshot jsonb,
          snapshot_sha256 text
        )
    `);
    await tx.execute(sql`
      insert into catalog_component_revision (
        id, workspace_id, component_id, revision, component_type,
        schema_version, canonicalization_version, revision_snapshot,
        snapshot_sha256, created_by
      )
      select seed.revision_id::uuid, ${members.workspaceId}::uuid,
             seed.component_id::uuid, 1, 'other',
             ${CATALOG_COMPONENT_CONTRACT_VERSION},
             ${CATALOG_CANONICALIZATION_VERSION}, seed.revision_snapshot,
             decode(seed.snapshot_sha256, 'hex'), ${members.operatorId}::uuid
        from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as seed(
          component_id text,
          revision_id text,
          internal_sku text,
          revision_snapshot jsonb,
          snapshot_sha256 text
        )
    `);
    await tx.execute(sql`
      update catalog_component component
         set status = 'active', updated_at = now()
        from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as seed(
          component_id text
        )
       where component.workspace_id = ${members.workspaceId}::uuid
         and component.id = seed.component_id::uuid
    `);
  });
  return rows.map((row) => row.component_id);
}

function orderedSeedComponentIds(
  products: ProductSet,
  additionalProductIds: readonly string[],
): string[] {
  return [
    products.module,
    products.inverter,
    products.battery,
    products.wallbox,
    ...additionalProductIds,
  ];
}

async function resolveCatalogLineBoundary(
  members: OfferMembers,
  project: PlanningProject,
  products: ProductSet,
  additionalProductIds: readonly string[],
): Promise<string[]> {
  const componentIds = orderedSeedComponentIds(products, additionalProductIds);
  const quantities = [26, 1, 1, 1];
  await withTenantOn(testPool, members.workspaceId, (tx) =>
    resolveProjectCatalog(tx, offerCtx(members, "operator"), {
      schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
      projectId: project.projectId,
      expectedResolutionRevision: 0,
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      selections: componentIds.map((componentId, index) => ({
        componentId,
        expectedComponentRevision: 1,
        quantity: quantities[index] ?? 1,
      })),
      acknowledgements: ["cross_component_compatibility_unverified"],
    }));
  return componentIds;
}

function offerCreateCommand(
  project: PlanningProject,
  expectedResolutionRevision = 1,
): CreateOfferCommandV1 {
  return {
    schemaVersion: OFFER_CREATE_COMMAND_VERSION,
    projectId: project.projectId,
    expectedRequirementRevision: 1,
    expectedCalculationRevision: 1,
    expectedResolutionRevision,
    forecastValueNetCents: 1_250_000,
    priceAudience: "b2c",
    priceAudienceConfirmation: {
      code: "b2c_operator_confirmed",
      confirmed: true,
    },
    taxTreatment: "standard_19",
  };
}

async function resolveCatalog(
  members: OfferMembers,
  project: PlanningProject,
  products: ProductSet,
  expectedResolutionRevision: number,
  revisions: ProductRevisions,
): Promise<void> {
  const operator = offerCtx(members, "operator");
  await withTenantOn(testPool, members.workspaceId, (tx) =>
    resolveProjectCatalog(tx, operator, {
      schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
      projectId: project.projectId,
      expectedResolutionRevision,
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      selections: [
        {
          componentId: products.module,
          expectedComponentRevision: revisions.module,
          quantity: 26,
        },
        {
          componentId: products.inverter,
          expectedComponentRevision: revisions.inverter,
          quantity: 1,
        },
        {
          componentId: products.battery,
          expectedComponentRevision: revisions.battery,
          quantity: 1,
        },
        {
          componentId: products.wallbox,
          expectedComponentRevision: revisions.wallbox,
          quantity: 1,
        },
      ],
      acknowledgements: ["cross_component_compatibility_unverified"],
    }));
}

async function createFixture(): Promise<OfferFixture> {
  const members = await createOfferMembers();
  const project = await createPlanningProject(members);
  const products = await createActiveProducts(members);
  await resolveCatalog(members, project, products, 0, {
    module: 1,
    inverter: 1,
    battery: 1,
    wallbox: 1,
  });
  return {
    members,
    project,
    products,
    createCommand: offerCreateCommand(project),
  };
}

async function readRevision(
  workspaceId: string,
  variantId: string,
  revision?: number,
): Promise<RevisionRow> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<RevisionRow>(sql`
      select revision, revision_snapshot,
             revision_snapshot::text as snapshot_text,
             encode(snapshot_sha256, 'hex') as snapshot_sha256_hex
        from offer_variant_revision
       where workspace_id = ${workspaceId}::uuid
         and variant_id = ${variantId}::uuid
         ${revision === undefined ? sql`` : sql`and revision = ${revision}`}
       order by revision desc
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Erwartete Angebotsrevision fehlt in der Fixture.");
    return row;
  });
}

function pricingInputFromSnapshot(snapshot: OfferVariantSnapshotV1) {
  return {
    currency: snapshot.currency,
    priceBasis: snapshot.priceBasis,
    globalDiscountBps: snapshot.globalDiscountBps,
    globalFixDiscountCents: snapshot.globalFixDiscountCents,
    customDealNetCents: snapshot.customDealNetCents,
    sections: snapshot.sections.map((section) => ({
      sectionDomainId: section.sectionDomainId,
      position: section.position,
      discountBps: section.discountBps,
      lines: section.lines.map((line) => ({
        lineDomainId: line.lineDomainId,
        position: line.position,
        unit: line.product.unit,
        positionType: line.positionType,
        isHidden: line.isHidden,
        quantityMilli: line.quantityMilli,
        salesUnitNetCents: line.salesPricing.effectiveUnitNetCents,
        purchaseUnitNetCents: line.purchasePricing.effectiveUnitNetCents,
        lineDiscountBps: line.lineDiscountBps,
        taxRateBps: line.taxRateBps,
      })),
    })),
  };
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolvePromise!: Deferred<T>["resolve"];
  let rejectPromise!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromiseValue, rejectPromiseValue) => {
    resolvePromise = resolvePromiseValue;
    rejectPromise = rejectPromiseValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

async function waitForPostgresLockWaiters(
  applicationNames: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const result = await testPool.query<{ waiter_count: number }>(
      `select count(*)::int as waiter_count
         from pg_catalog.pg_stat_activity
        where application_name = any($1::text[])
          and wait_event_type = 'Lock'`,
      [[...applicationNames]],
    );
    if (result.rows[0]?.waiter_count === applicationNames.length) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(
    `Erwartete ${applicationNames.length} PostgreSQL-Lock-Waiter wurden nicht sichtbar.`,
  );
}

async function waitForPostgresBlockingPid(
  waiterPid: number,
  blockerPid: number,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await testPool.query<{ blocked: boolean }>(`
      select $2::integer = any(pg_catalog.pg_blocking_pids($1::integer)) as blocked
    `, [waiterPid, blockerPid]);
    if (result.rows[0]?.blocked) return;
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error(`${description}: erwartete PostgreSQL-Blockierung wurde nicht sichtbar.`);
}

async function runBehindProjectLock<T>(
  workspaceId: string,
  projectId: string,
  attempts: ReadonlyArray<(applicationName: string) => Promise<T>>,
): Promise<Array<PromiseSettledResult<T>>> {
  const blockerReady = deferred<void>();
  const releaseBlocker = deferred<void>();
  const blockerCompletion = withTenantOn(testPool, workspaceId, async (tx) => {
    await tx.execute(sql`
      select id
        from project
       where workspace_id = ${workspaceId}::uuid
         and id = ${projectId}::uuid
       for update
    `);
    blockerReady.resolve();
    await releaseBlocker.promise;
  });
  void blockerCompletion.catch(blockerReady.reject);
  await blockerReady.promise;

  const applicationNames = attempts.map(
    (_attempt, index) => `m201-offer-race-${index}-${randomUUID()}`,
  );
  const settled = Promise.allSettled(attempts.map((attempt, index) =>
    attempt(applicationNames[index]!)));
  let waiterFailure: unknown;
  try {
    await waitForPostgresLockWaiters(applicationNames);
  } catch (error) {
    waiterFailure = error;
  } finally {
    releaseBlocker.resolve();
    await blockerCompletion;
  }
  const outcomes = await settled;
  if (waiterFailure) throw waiterFailure;
  return outcomes;
}

type OfferMutationState = {
  variants: number;
  revisions: number;
  sections: number;
  lines: number;
  events: number;
  audits: number;
  [key: string]: unknown;
};

async function readOfferMutationState(
  workspaceId: string,
  offerId: string,
): Promise<OfferMutationState> {
  return withTenantOn(testPool, workspaceId, async (tx) => {
    const result = await tx.execute<OfferMutationState>(sql`
      select
        (select count(*)::int
           from offer_variant
          where workspace_id = ${workspaceId}::uuid
            and offer_id = ${offerId}::uuid) as variants,
        (select count(*)::int
           from offer_variant_revision
          where workspace_id = ${workspaceId}::uuid
            and offer_id = ${offerId}::uuid) as revisions,
        (select count(*)::int
           from offer_variant_section
          where workspace_id = ${workspaceId}::uuid
            and offer_id = ${offerId}::uuid) as sections,
        (select count(*)::int
           from offer_bom_line
          where workspace_id = ${workspaceId}::uuid
            and offer_id = ${offerId}::uuid) as lines,
        (select count(*)::int
           from domain_events
          where workspace_id = ${workspaceId}::uuid
            and aggregate_id = ${offerId}::uuid
            and event_type in (
              'offer.variant_created',
              'offer.variant_duplicated',
              'offer.variant_revised'
            )) as events,
        (select count(*)::int
           from audit_log
          where workspace_id = ${workspaceId}::uuid
            and resource = 'offer'
            and allowed = true
            and details->>'offerId' = ${offerId}) as audits
    `);
    const row = result.rows[0];
    if (!row) throw new Error("Erwarteter Angebots-Mutationsstand fehlt.");
    return row;
  });
}

function expectMutationDelta(
  before: OfferMutationState,
  after: OfferMutationState,
  delta: Pick<
    OfferMutationState,
    "variants" | "revisions" | "sections" | "lines" | "events" | "audits"
  >,
): void {
  for (const key of ["variants", "revisions", "sections", "lines", "events", "audits"] as const) {
    expect(after[key] - before[key], key).toBe(delta[key]);
  }
}

describe("M2-01 Angebots-Service", () => {
  it("kanonisiert Contact und Anlagenstandort genau einmal vor Digest und Persistenz", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");
    await withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
      await tx.execute(sql`
        update contact
           set display_name = ${"  Ju\u0308rgen Angebot  "},
               email_primary = '  CANON@example.test  ',
               email_normalized = 'canon@example.test'
         where workspace_id = ${fixture.members.workspaceId}::uuid
           and id = (
             select contact_id from project
              where workspace_id = ${fixture.members.workspaceId}::uuid
                and id = ${fixture.project.projectId}::uuid
           )
      `);
      await tx.execute(sql`
        update site
           set formatted_address = ${"Gru\u0308ner Weg 7, 69168 Du\u0308sseldorf"},
               street = ${"Gru\u0308ner Weg"},
               house_number = '7', postal_code = '69168',
               city = ${"Du\u0308sseldorf"}
         where workspace_id = ${fixture.members.workspaceId}::uuid
           and id = ${fixture.project.siteId}::uuid
      `);
    });

    const created = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand));
    const contexts = await withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
      const offer = await tx.execute<{
        contact_context: unknown;
        installation_site_context: unknown;
        [key: string]: unknown;
      }>(sql`
        select contact_context, installation_site_context
          from offer
         where workspace_id = ${fixture.members.workspaceId}::uuid
           and id = ${created.offerId}::uuid
      `);
      return offer.rows[0];
    });
    const revision = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      1,
    );
    expect(contexts).toEqual({
      contact_context: {
        displayName: "Jürgen Angebot",
        emailPrimary: "CANON@example.test",
        phoneE164: null,
      },
      installation_site_context: {
        addressRevision: 1,
        formattedAddress: "Grüner Weg 7, 69168 Düsseldorf",
        street: "Grüner Weg",
        houseNumber: "7",
        postalCode: "69168",
        city: "Düsseldorf",
        country: "DE",
      },
    });
    expect(revision.revision_snapshot.contactContext).toEqual(contexts?.contact_context);
    expect(revision.revision_snapshot.installationSiteContext)
      .toEqual(contexts?.installation_site_context);
  });

  it("konvertiert einen echten Rechner-v3-Request atomar in Angebot, Basis-Snapshot und vollständige Mirrors", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");

    const created = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand));

    expect(created).toMatchObject({ revision: 1 });
    expect(created.offerId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(created.variantId).toMatch(/^[0-9a-f-]{36}$/u);

    const persisted = await withTenantOn(
      testPool,
      fixture.members.workspaceId,
      async (tx) => {
        const project = await tx.execute<{
          phase: string;
          column_type: string;
          source_key: string;
          [key: string]: unknown;
        }>(sql`
          select project.phase, project.source_key, column_state.column_type
            from project
            join kanban_column column_state
              on column_state.workspace_id = project.workspace_id
             and column_state.id = project.kanban_column_id
           where project.workspace_id = ${fixture.members.workspaceId}::uuid
             and project.id = ${fixture.project.projectId}::uuid
        `);
        const offer = await tx.execute<{
          offer_number: string;
          number_sequence: number;
          forecast_value_net_cents: string;
          variant_count: number;
          revision_count: number;
          section_count: number;
          line_count: number;
          [key: string]: unknown;
        }>(sql`
          select offer.offer_number, offer.number_sequence,
                 offer.forecast_value_net_cents,
                 count(distinct variant.id)::int as variant_count,
                 count(distinct revision.id)::int as revision_count,
                 count(distinct section.id)::int as section_count,
                 count(distinct line.id)::int as line_count
            from offer
            join offer_variant variant
              on variant.workspace_id = offer.workspace_id
             and variant.offer_id = offer.id
            join offer_variant_revision revision
              on revision.workspace_id = variant.workspace_id
             and revision.variant_id = variant.id
            join offer_variant_section section
              on section.workspace_id = revision.workspace_id
             and section.revision_id = revision.id
            join offer_bom_line line
              on line.workspace_id = section.workspace_id
             and line.revision_id = revision.id
             and line.section_domain_id = section.section_domain_id
           where offer.workspace_id = ${fixture.members.workspaceId}::uuid
             and offer.id = ${created.offerId}::uuid
           group by offer.offer_number, offer.number_sequence,
                    offer.forecast_value_net_cents
        `);
        const sectionMirrors = await tx.execute<{
          section_snapshot: OfferVariantSnapshotV1["sections"][number];
          [key: string]: unknown;
        }>(sql`
          select section_snapshot
            from offer_variant_section
           where workspace_id = ${fixture.members.workspaceId}::uuid
             and variant_id = ${created.variantId}::uuid
             and revision = 1
           order by position
        `);
        const lineMirrors = await tx.execute<{
          line_snapshot: OfferVariantSnapshotV1["sections"][number]["lines"][number];
          [key: string]: unknown;
        }>(sql`
          select line.line_snapshot
            from offer_bom_line line
            join offer_variant_section section
              on section.workspace_id = line.workspace_id
             and section.revision_id = line.revision_id
             and section.id = line.section_id
           where line.workspace_id = ${fixture.members.workspaceId}::uuid
             and line.variant_id = ${created.variantId}::uuid
             and line.revision = 1
           order by section.position, line.position
        `);
        const events = await tx.execute<{
          event_type: string;
          payload: Record<string, unknown>;
          [key: string]: unknown;
        }>(sql`
          select event_type, payload from domain_events
           where workspace_id = ${fixture.members.workspaceId}::uuid
             and aggregate_id in (${fixture.project.projectId}::uuid, ${created.offerId}::uuid)
             and event_type in ('project.phase_changed', 'offer.created', 'offer.variant_created')
           order by event_type
        `);
        return {
          project: project.rows[0],
          offer: offer.rows[0],
          sectionMirrors: sectionMirrors.rows,
          lineMirrors: lineMirrors.rows,
          events: events.rows.map((row) => row.event_type),
          eventPayloads: events.rows,
        };
      },
    );
    const revision = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      1,
    );
    const validated = validateOfferVariantSnapshot(revision.revision_snapshot);

    expect(persisted.project).toEqual({
      phase: "offer",
      source_key: "wmee-rechner-v3",
      column_type: "offer",
    });
    expect(persisted.offer).toMatchObject({
      offer_number: expect.stringMatching(/^ANG-[0-9]{4}-000001$/u),
      number_sequence: 1,
      forecast_value_net_cents: "1250000",
      variant_count: 1,
      revision_count: 1,
      section_count: 4,
      line_count: 4,
    });
    expect(validated.ok).toBe(true);
    expect(revision.revision_snapshot).toMatchObject({
      workspaceId: fixture.members.workspaceId,
      offerId: created.offerId,
      variantId: created.variantId,
      revision: 1,
      variantName: "Basis",
      contactContext: {
        displayName: "Synthetischer Angebotskontakt",
        emailPrimary: "offer.fixture@example.test",
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
        projectId: fixture.project.projectId,
        requirementRevision: 1,
        calculationRevision: 1,
        resolutionRevision: 1,
      },
      priceAudienceDecision: {
        audience: "b2c",
        confirmationCode: "b2c_operator_confirmed",
        confirmedBy: fixture.members.operatorId,
      },
      taxDecision: {
        treatment: "standard_19",
        rateBps: 1_900,
        selectedBy: fixture.members.operatorId,
      },
      totals: {
        basisNetCents: 1_300_000,
        basisTaxCents: 247_000,
        basisGrossCents: 1_547_000,
        optionalNetCents: 0,
        optionalTaxCents: 0,
        optionalGrossCents: 0,
      },
    });
    const lines = revision.revision_snapshot.sections.flatMap((section) => section.lines);
    expect(lines.map((line) => ({
      sku: line.product.kind === "catalog" ? line.product.internalSku : "custom",
      quantityMilli: line.quantityMilli,
      sales: line.salesPricing.effectiveUnitNetCents,
      purchase: line.purchasePricing.effectiveUnitNetCents,
      sourceRevision: line.source.kind === "catalog"
        ? line.source.catalogComponentRevision
        : null,
    }))).toEqual([
      { sku: "M201-MODULE-1", quantityMilli: 26_000, sales: 25_000, purchase: 15_000, sourceRevision: 1 },
      { sku: "M201-INVERTER-2", quantityMilli: 1_000, sales: 150_000, purchase: 100_000, sourceRevision: 1 },
      { sku: "M201-BATTERY-3", quantityMilli: 1_000, sales: 400_000, purchase: 250_000, sourceRevision: 1 },
      { sku: "M201-WALLBOX-4", quantityMilli: 1_000, sales: 100_000, purchase: 60_000, sourceRevision: 1 },
    ]);
    expect(persisted.sectionMirrors.map((row) => row.section_snapshot))
      .toEqual(revision.revision_snapshot.sections);
    expect(persisted.lineMirrors.map((row) => row.line_snapshot))
      .toEqual(lines);
    expect(persisted.events).toEqual([
      "offer.created",
      "offer.variant_created",
      "project.phase_changed",
    ]);
    expect(persisted.eventPayloads.slice(0, 2)).toEqual([
      {
        event_type: "offer.created",
        payload: {
          offerId: created.offerId,
          variantId: created.variantId,
          previousRevision: null,
          newRevision: 1,
          changeClasses: ["offer_created"],
          previousState: "request",
          newState: "draft",
        },
      },
      {
        event_type: "offer.variant_created",
        payload: {
          offerId: created.offerId,
          variantId: created.variantId,
          previousRevision: null,
          newRevision: 1,
          changeClasses: ["resolution_seed"],
          previousState: "absent",
          newState: "draft",
        },
      },
    ]);
  });

  it("seedet 250 und 251 Resolution-Zeilen im echten Servicepfad vollstaendig ohne Kuerzung", async () => {
    const members = await createOfferMembers();
    const project250 = await createPlanningProject(members);
    const project251 = await createPlanningProject(members);
    const products = await createActiveProducts(members);
    const additionalProducts = await createBulkActiveOtherProducts(members, 247);
    const expected250 = await resolveCatalogLineBoundary(
      members,
      project250,
      products,
      additionalProducts.slice(0, 246),
    );
    const expected251 = await resolveCatalogLineBoundary(
      members,
      project251,
      products,
      additionalProducts,
    );
    const operator = offerCtx(members, "operator");
    const created250 = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, offerCreateCommand(project250)));
    const created251 = await withTenantOn(testPool, members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, offerCreateCommand(project251)));

    for (const boundary of [
      { expected: expected250, created: created250 },
      { expected: expected251, created: created251 },
    ]) {
      const revision = await readRevision(
        members.workspaceId,
        boundary.created.variantId,
        1,
      );
      const lines = revision.revision_snapshot.sections
        .flatMap((section) => section.lines);
      const catalogComponentIds = lines.map((line) => {
        if (line.source.kind !== "catalog") {
          throw new Error("Seed-Grenztest erwartet ausschliesslich Katalogzeilen.");
        }
        return line.source.catalogComponentId;
      });
      const mirrorCounts = await withTenantOn(
        testPool,
        members.workspaceId,
        async (tx) => {
          const result = await tx.execute<{
            source_lines: number;
            snapshot_lines: number;
            mirror_lines: number;
            [key: string]: unknown;
          }>(sql`
            select
              (select count(*)::int
                 from project_catalog_resolution_line
                where workspace_id = ${members.workspaceId}::uuid
                  and resolution_id = ${revision.revision_snapshot.sourceBindings.resolutionId}::uuid
              ) as source_lines,
              jsonb_array_length(
                (select jsonb_path_query_array(revision_snapshot, '$.sections[*].lines[*]')
                   from offer_variant_revision
                  where workspace_id = ${members.workspaceId}::uuid
                    and variant_id = ${boundary.created.variantId}::uuid
                    and revision = 1)
              ) as snapshot_lines,
              (select count(*)::int
                 from offer_bom_line
                where workspace_id = ${members.workspaceId}::uuid
                  and variant_id = ${boundary.created.variantId}::uuid
                  and revision = 1
              ) as mirror_lines
          `);
          return result.rows[0];
        },
      );

      expect(validateOfferVariantSnapshot(revision.revision_snapshot).ok).toBe(true);
      expect(lines).toHaveLength(boundary.expected.length);
      expect(catalogComponentIds).toEqual(boundary.expected);
      expect(new Set(catalogComponentIds).size).toBe(boundary.expected.length);
      expect(lines.every((line) => (
        line.positionType === "required"
        && line.isHidden === false
        && line.lineDiscountBps === 0
      ))).toBe(true);
      expect(mirrorCounts).toEqual({
        source_lines: boundary.expected.length,
        snapshot_lines: boundary.expected.length,
        mirror_lines: boundary.expected.length,
      });
    }
  }, 240_000);

  it("linearisiert einen echten Create-Doppelklick auf genau ein Offer und eine Angebotsnummer", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");

    const outcomes = await runBehindProjectLock(
      fixture.members.workspaceId,
      fixture.project.projectId,
      ["A", "B"].map(() => (applicationName: string) =>
        withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
          await tx.execute(sql`
            select set_config('application_name', ${applicationName}, true)
          `);
          return createOfferFromRequest(
            tx,
            operator,
            structuredClone(fixture.createCommand),
          );
        })),
    );

    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    const results = outcomes.map((outcome) => {
      if (outcome.status !== "fulfilled") throw outcome.reason;
      return outcome.value;
    });
    expect(results[1]).toEqual(results[0]);
    const created = results[0];
    if (!created) throw new Error("Erwartetes Create-Ergebnis fehlt.");

    const persisted = await withTenantOn(
      testPool,
      fixture.members.workspaceId,
      async (tx) => {
        const result = await tx.execute<{
          offers: number;
          variants: number;
          revisions: number;
          sections: number;
          lines: number;
          series_rows: number;
          last_sequence: number;
          offer_events: number;
          project_events: number;
          audits: number;
          phase: string;
          column_type: string;
          [key: string]: unknown;
        }>(sql`
          select
            (select count(*)::int from offer
              where workspace_id = ${fixture.members.workspaceId}::uuid) as offers,
            (select count(*)::int from offer_variant
              where workspace_id = ${fixture.members.workspaceId}::uuid) as variants,
            (select count(*)::int from offer_variant_revision
              where workspace_id = ${fixture.members.workspaceId}::uuid) as revisions,
            (select count(*)::int from offer_variant_section
              where workspace_id = ${fixture.members.workspaceId}::uuid) as sections,
            (select count(*)::int from offer_bom_line
              where workspace_id = ${fixture.members.workspaceId}::uuid) as lines,
            (select count(*)::int from offer_number_series
              where workspace_id = ${fixture.members.workspaceId}::uuid) as series_rows,
            (select last_sequence from offer_number_series
              where workspace_id = ${fixture.members.workspaceId}::uuid) as last_sequence,
            (select count(*)::int from domain_events
              where workspace_id = ${fixture.members.workspaceId}::uuid
                and aggregate_id = ${created.offerId}::uuid
                and event_type in ('offer.created', 'offer.variant_created')) as offer_events,
            (select count(*)::int from domain_events
              where workspace_id = ${fixture.members.workspaceId}::uuid
                and aggregate_id = ${fixture.project.projectId}::uuid
                and event_type = 'project.phase_changed') as project_events,
            (select count(*)::int from audit_log
              where workspace_id = ${fixture.members.workspaceId}::uuid
                and resource = 'offer'
                and allowed = true
                and details->>'offerId' = ${created.offerId}) as audits,
            project.phase,
            column_state.column_type
          from project
          join kanban_column column_state
            on column_state.workspace_id = project.workspace_id
           and column_state.id = project.kanban_column_id
          where project.workspace_id = ${fixture.members.workspaceId}::uuid
            and project.id = ${fixture.project.projectId}::uuid
        `);
        return result.rows[0];
      },
    );
    expect(persisted).toEqual({
      offers: 1,
      variants: 1,
      revisions: 1,
      sections: 4,
      lines: 4,
      series_rows: 1,
      last_sequence: 1,
      offer_events: 2,
      project_events: 1,
      audits: 1,
      phase: "offer",
      column_type: "offer",
    });
  });

  it("rollt bei mehrdeutiger Offer-Spalte die gesamte Konvertierung einschließlich Nummer zurück", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");
    await withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
      const initial = await tx.execute<{ count: number; [key: string]: unknown }>(sql`
        select count(*)::int as count
          from kanban_column column_state
          join kanban_board board
            on board.workspace_id = column_state.workspace_id
           and board.id = column_state.board_id
         where board.workspace_id = ${fixture.members.workspaceId}::uuid
           and board.scope = 'residential'
           and board.is_default = true
           and board.archived_at is null
           and column_state.archived_at is null
           and column_state.column_type = 'offer'
      `);
      expect(initial.rows[0]?.count).toBe(1);
      await tx.execute(sql`
        insert into kanban_column (
          workspace_id, board_id, name, column_type, position, color, is_intake
        )
        select board.workspace_id, board.id, 'Zweite Angebotsspalte', 'offer',
               coalesce(max(existing.position), 0) + 1, 'amber', false
          from kanban_board board
          left join kanban_column existing
            on existing.workspace_id = board.workspace_id
           and existing.board_id = board.id
           and existing.archived_at is null
         where board.workspace_id = ${fixture.members.workspaceId}::uuid
           and board.scope = 'residential'
           and board.is_default = true
           and board.archived_at is null
         group by board.workspace_id, board.id
      `);
    });

    await expect(withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand)))
      .rejects.toBeInstanceOf(OfferValidationError);

    const state = await withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
      const project = await tx.execute<{
        phase: string;
        column_type: string;
        [key: string]: unknown;
      }>(sql`
        select project.phase, column_state.column_type
          from project
          join kanban_column column_state
            on column_state.workspace_id = project.workspace_id
           and column_state.id = project.kanban_column_id
         where project.workspace_id = ${fixture.members.workspaceId}::uuid
           and project.id = ${fixture.project.projectId}::uuid
      `);
      const counts = await tx.execute<{
        offers: number;
        variants: number;
        revisions: number;
        series: number;
        events: number;
        [key: string]: unknown;
      }>(sql`
        select
          (select count(*)::int from offer
            where workspace_id = ${fixture.members.workspaceId}::uuid) as offers,
          (select count(*)::int from offer_variant
            where workspace_id = ${fixture.members.workspaceId}::uuid) as variants,
          (select count(*)::int from offer_variant_revision
            where workspace_id = ${fixture.members.workspaceId}::uuid) as revisions,
          (select count(*)::int from offer_number_series
            where workspace_id = ${fixture.members.workspaceId}::uuid) as series,
          (select count(*)::int from domain_events
            where workspace_id = ${fixture.members.workspaceId}::uuid
              and event_type like 'offer.%') as events
      `);
      return { project: project.rows[0], counts: counts.rows[0] };
    });
    expect(state.project).toEqual({ phase: "request", column_type: "lead" });
    expect(state.counts).toEqual({
      offers: 0,
      variants: 0,
      revisions: 0,
      series: 0,
      events: 0,
    });
  });

  it("behandelt nur denselben Create-Digest als Replay, schützt External und redigiert Viewer-Reads strukturell", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");
    const viewer = offerCtx(fixture.members, "viewer");
    const plainEditor = offerCtx(fixture.members, "plainEditor");
    const admin = offerCtx(fixture.members, "admin");
    const external = offerCtx(fixture.members, "external");
    const created = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand));

    const replay = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, structuredClone(fixture.createCommand)));
    expect(replay).toEqual(created);
    await expect(withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, {
        ...fixture.createCommand,
        forecastValueNetCents: 1_250_001,
      }))).rejects.toBeInstanceOf(OfferConflictError);

    await expect(withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, viewer, fixture.createCommand)))
      .rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      listOffers(tx, external))).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      getOfferDetail(tx, external, { offerId: created.offerId, variantId: null })))
      .rejects.toBeInstanceOf(PermissionDeniedError);

    const list = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      listOffers(tx, viewer));
    const editorList = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      listOffers(tx, plainEditor));
    const viewerDetail = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      getOfferDetail(tx, viewer, { offerId: created.offerId, variantId: created.variantId }));
    const adminDetail = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      getOfferDetail(tx, admin, { offerId: created.offerId, variantId: created.variantId }));
    const viewerJson = JSON.stringify({ list, detail: viewerDetail });
    const adminJson = JSON.stringify(adminDetail);

    expect(list).toMatchObject({
      state: "read_only",
      workspaceId: fixture.members.workspaceId,
      permissions: { canCreate: false },
    });
    expect(editorList).toMatchObject({
      state: "loaded",
      workspaceId: fixture.members.workspaceId,
      permissions: { canCreate: false },
    });
    expect(viewerDetail).toMatchObject({
      state: "read_only",
      workspaceId: fixture.members.workspaceId,
      offer: {
        id: created.offerId,
        outdated: false,
        forecastValueNetCents: 1_250_000,
      },
      newBasisInput: null,
      permissions: {
        canEdit: false,
        canDuplicate: false,
        canCreateBasis: false,
        canReadPurchasePrice: false,
      },
    });
    expect(viewerJson).not.toContain("purchasePricing");
    expect(viewerJson).not.toContain("purchaseNetCents");
    expect(viewerJson).not.toContain("marginNetCents");
    expect(viewerJson).not.toContain("PRIVATE-M201-PURCHASE");
    expect(viewerJson).not.toMatch(/(?:Sha256|sha256|objectKey)/u);
    expect(viewerJson).toContain("salesPricing");
    expect(adminDetail).toMatchObject({
      newBasisInput: {
        expectedRequirementRevision: 1,
        expectedCalculationRevision: 1,
        expectedResolutionRevision: 1,
      },
      permissions: { canReadPurchasePrice: true },
    });
    expect(adminJson).toContain("purchasePricing");
    expect(adminJson).toContain("purchaseNetCents");
    expect(adminJson).toContain("marginNetCents");

    const counts = await withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
      const result = await tx.execute<{
        offers: number;
        variants: number;
        revisions: number;
        [key: string]: unknown;
      }>(sql`
        select
          (select count(*)::int from offer
            where workspace_id = ${fixture.members.workspaceId}::uuid) as offers,
          (select count(*)::int from offer_variant
            where workspace_id = ${fixture.members.workspaceId}::uuid) as variants,
          (select count(*)::int from offer_variant_revision
            where workspace_id = ${fixture.members.workspaceId}::uuid) as revisions
      `);
      return result.rows[0];
    });
    expect(counts).toEqual({ offers: 1, variants: 1, revisions: 1 });
  });

  it("legt list/detail/mutations ueber die echte Servicegrenze strikt auf den Mandanten fest", async () => {
    const ownerFixture = await createFixture();
    const owner = offerCtx(ownerFixture.members, "operator");
    const created = await withTenantOn(
      testPool,
      ownerFixture.members.workspaceId,
      (tx) => createOfferFromRequest(tx, owner, ownerFixture.createCommand),
    );
    const foreignMembers = await createOfferMembers();
    const foreignActor = offerCtx(foreignMembers, "operator");
    const unknownOfferId = randomUUID();
    const unknownVariantId = randomUUID();
    const ownerBefore = await readOfferMutationState(
      ownerFixture.members.workspaceId,
      created.offerId,
    );
    const foreignBefore = await readOfferMutationState(
      foreignMembers.workspaceId,
      created.offerId,
    );

    const foreignList = await withTenantOn(
      testPool,
      foreignMembers.workspaceId,
      (tx) => listOffers(tx, foreignActor),
    );
    const foreignDetail = await withTenantOn(
      testPool,
      foreignMembers.workspaceId,
      (tx) => getOfferDetail(tx, foreignActor, {
        offerId: created.offerId,
        variantId: created.variantId,
      }),
    );
    const unknownDetail = await withTenantOn(
      testPool,
      foreignMembers.workspaceId,
      (tx) => getOfferDetail(tx, foreignActor, {
        offerId: unknownOfferId,
        variantId: unknownVariantId,
      }),
    );

    expect(foreignList).toMatchObject({
      state: "empty",
      workspaceId: foreignMembers.workspaceId,
      columns: [],
    });
    expect(JSON.stringify(foreignList)).not.toMatch(new RegExp(
      [created.offerId, created.variantId, "Synthetischer Angebotskontakt", "Testweg"]
        .join("|"),
      "u",
    ));
    expect(foreignDetail).toBeNull();
    expect(unknownDetail).toBeNull();

    const mutationAttempts = [
      () => withTenantOn(testPool, foreignMembers.workspaceId, (tx) =>
        duplicateOfferVariant(tx, foreignActor, {
          schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
          offerId: created.offerId,
          sourceVariantId: created.variantId,
          expectedSourceRevision: 1,
          name: "Unzulaessige Fremdkopie",
        })),
      () => withTenantOn(testPool, foreignMembers.workspaceId, (tx) =>
        createVariantFromCurrentResolution(tx, foreignActor, {
          schemaVersion: OFFER_VARIANT_FROM_RESOLUTION_COMMAND_VERSION,
          offerId: created.offerId,
          expectedRequirementRevision: 1,
          expectedCalculationRevision: 1,
          expectedResolutionRevision: 1,
          name: "Unzulaessige Fremdbasis",
          taxTreatment: "standard_19",
        })),
      () => withTenantOn(testPool, foreignMembers.workspaceId, (tx) =>
        reviseOfferVariant(tx, foreignActor, {
          schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
          offerId: created.offerId,
          variantId: created.variantId,
          expectedRevision: 1,
          operations: [{
            operation: "set_variant_name",
            name: "Unzulaessige Fremdaenderung",
          }],
        })),
    ];
    for (const attempt of mutationAttempts) {
      await expect(attempt()).rejects.toBeInstanceOf(OfferNotFoundError);
    }

    const ownerAfter = await readOfferMutationState(
      ownerFixture.members.workspaceId,
      created.offerId,
    );
    const foreignAfter = await readOfferMutationState(
      foreignMembers.workspaceId,
      created.offerId,
    );
    expect(ownerAfter).toEqual(ownerBefore);
    expect(foreignAfter).toEqual(foreignBefore);
    expect(foreignAfter).toEqual({
      variants: 0,
      revisions: 0,
      sections: 0,
      lines: 0,
      events: 0,
      audits: 0,
    });
  });

  it("dupliziert Varianten unabhängig und revidiert nur per expectedRevision mit serverseitiger Preis- und Steuerneuberechnung", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");
    const plainEditor = offerCtx(fixture.members, "plainEditor");
    const created = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand));
    const basisBefore = await readRevision(fixture.members.workspaceId, created.variantId, 1);

    const duplicate = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      duplicateOfferVariant(tx, plainEditor, {
        schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
        offerId: created.offerId,
        sourceVariantId: created.variantId,
        expectedSourceRevision: 1,
        name: "Unabhängige Kopie",
      }));
    const duplicateBefore = await readRevision(
      fixture.members.workspaceId,
      duplicate.variantId,
      1,
    );
    expect(duplicate).toMatchObject({ offerId: created.offerId, revision: 1 });
    expect(duplicate.variantId).not.toBe(created.variantId);
    expect(duplicateBefore.revision_snapshot.sections)
      .toEqual(basisBefore.revision_snapshot.sections);
    expect(duplicateBefore.revision_snapshot.totals)
      .toEqual(basisBefore.revision_snapshot.totals);
    expect(duplicateBefore.revision_snapshot.sourceBindings)
      .toEqual(basisBefore.revision_snapshot.sourceBindings);

    const firstSection = basisBefore.revision_snapshot.sections[0]!;
    const firstLine = firstSection.lines[0]!;
    const customSectionDomainId = randomUUID();
    const customLineDomainId = randomUUID();
    const nextSectionPosition = Math.max(
      ...basisBefore.revision_snapshot.sections.map((section) => section.position),
    ) + 1;
    const revised = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      reviseOfferVariant(tx, operator, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: created.offerId,
        variantId: created.variantId,
        expectedRevision: 1,
        operations: [
          { operation: "set_global_discount", discountBps: 500 },
          {
            operation: "set_line_discount",
            lineDomainId: firstLine.lineDomainId,
            discountBps: 1_000,
          },
          {
            operation: "set_line_tax",
            lineDomainId: firstLine.lineDomainId,
            taxTreatment: "zero_operator_confirmed",
            zeroConfirmation: {
              code: "zero_tax_draft_operator_confirmed",
              confirmed: true,
            },
          },
          {
            operation: "add_custom_section",
            sectionDomainId: customSectionDomainId,
            position: nextSectionPosition,
            title: "Synthetische Zusatzleistung",
            category: "other",
          },
          {
            operation: "add_custom_line",
            lineDomainId: customLineDomainId,
            sectionDomainId: customSectionDomainId,
            position: 1,
            displayName: "Synthetische Montagepauschale",
            description: "Nur für den Servicetest",
            unit: "piece",
            quantityMilli: 2_000,
            salesUnitNetCents: 100_000,
            purchaseUnitNetCents: 40_000,
            positionType: "required",
            isHidden: false,
            taxTreatment: "standard_19",
          },
        ],
      }));
    expect(revised).toMatchObject({
      offerId: created.offerId,
      variantId: created.variantId,
      revision: 2,
    });
    const revisionTwo = await readRevision(fixture.members.workspaceId, created.variantId, 2);
    const parsed = validateOfferVariantSnapshot(revisionTwo.revision_snapshot);
    const recalculated = calculateOfferPricing(
      pricingInputFromSnapshot(revisionTwo.revision_snapshot),
    );
    const revisedFirstLine = revisionTwo.revision_snapshot.sections
      .flatMap((section) => section.lines)
      .find((line) => line.lineDomainId === firstLine.lineDomainId);
    const customLine = revisionTwo.revision_snapshot.sections
      .flatMap((section) => section.lines)
      .find((line) => line.lineDomainId === customLineDomainId);

    expect(parsed.ok).toBe(true);
    expect(revisionTwo.revision_snapshot.globalDiscountBps).toBe(500);
    expect(revisionTwo.revision_snapshot.totals).toEqual(recalculated.totals);
    expect(revisedFirstLine).toMatchObject({
      lineDiscountBps: 1_000,
      taxTreatment: "zero_operator_confirmed",
      taxRateBps: 0,
      taxDecision: {
        treatment: "zero_operator_confirmed",
        rateBps: 0,
        selectedBy: fixture.members.operatorId,
        confirmationCode: "zero_tax_draft_operator_confirmed",
        confirmedBy: fixture.members.operatorId,
      },
    });
    expect(customLine).toMatchObject({
      componentCategory: "other",
      quantityMilli: 2_000,
      product: {
        kind: "custom",
        displayName: "Synthetische Montagepauschale",
        unit: "piece",
      },
      source: { kind: "custom", enteredBy: fixture.members.operatorId },
      salesPricing: {
        originalUnitNetCents: 100_000,
        effectiveUnitNetCents: 100_000,
        provenance: { kind: "custom", enteredBy: fixture.members.operatorId },
      },
      purchasePricing: {
        originalUnitNetCents: 40_000,
        effectiveUnitNetCents: 40_000,
        provenance: { kind: "custom", enteredBy: fixture.members.operatorId },
      },
    });

    await expect(withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      reviseOfferVariant(tx, operator, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: created.offerId,
        variantId: created.variantId,
        expectedRevision: 1,
        operations: [{ operation: "set_variant_name", name: "Veralteter Save" }],
      }))).rejects.toBeInstanceOf(OfferConflictError);

    const duplicateAfter = await readRevision(
      fixture.members.workspaceId,
      duplicate.variantId,
      1,
    );
    expect(duplicateAfter.snapshot_text).toBe(duplicateBefore.snapshot_text);
    expect(duplicateAfter.snapshot_sha256_hex).toBe(duplicateBefore.snapshot_sha256_hex);
    expect(duplicateAfter.revision_snapshot.sections)
      .toEqual(basisBefore.revision_snapshot.sections);
    const mutationEvents = await withTenantOn(
      testPool,
      fixture.members.workspaceId,
      (tx) => tx.execute<{ event_type: string; payload: Record<string, unknown> }>(sql`
        select event_type, payload
          from domain_events
         where workspace_id = ${fixture.members.workspaceId}::uuid
           and aggregate_id = ${created.offerId}::uuid
           and event_type in ('offer.variant_duplicated', 'offer.variant_revised')
         order by event_type
      `),
    );
    expect(mutationEvents.rows).toEqual([
      {
        event_type: "offer.variant_duplicated",
        payload: {
          offerId: created.offerId,
          variantId: duplicate.variantId,
          sourceVariantId: created.variantId,
          previousRevision: 1,
          newRevision: 1,
          changeClasses: ["variant_duplicate"],
          previousState: "absent",
          newState: "draft",
        },
      },
      {
        event_type: "offer.variant_revised",
        payload: {
          offerId: created.offerId,
          variantId: created.variantId,
          previousRevision: 1,
          newRevision: 2,
          changeClasses: [
            "add_custom_line",
            "add_custom_section",
            "set_global_discount",
            "set_line_discount",
            "set_line_tax",
          ],
          previousState: "draft",
          newState: "draft",
        },
      },
    ]);
  });

  it("verwendet nach Lock-Akquise eine frische DB-Zeit statt eines alten Transaktionsstarts", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");
    const created = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand));

    let releaseOlder!: () => void;
    let markOlderStarted!: () => void;
    const olderMayContinue = new Promise<void>((resolve) => {
      releaseOlder = resolve;
    });
    const olderStarted = new Promise<void>((resolve) => {
      markOlderStarted = resolve;
    });
    const olderTransaction = withTenantOn(
      testPool,
      fixture.members.workspaceId,
      async (tx) => {
        await tx.execute(sql`select transaction_timestamp()`);
        markOlderStarted();
        await olderMayContinue;
        return duplicateOfferVariant(tx, operator, {
          schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
          offerId: created.offerId,
          sourceVariantId: created.variantId,
          expectedSourceRevision: 1,
          name: "Aeltere Transaktion, spaeterer Lock",
        });
      },
    );

    await olderStarted;
    let newer;
    try {
      newer = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
        duplicateOfferVariant(tx, operator, {
          schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
          offerId: created.offerId,
          sourceVariantId: created.variantId,
          expectedSourceRevision: 1,
          name: "Juengere Transaktion, frueherer Lock",
        }));
    } finally {
      releaseOlder();
    }
    const older = await olderTransaction;
    expect(newer).toMatchObject({ offerId: created.offerId, revision: 1 });
    expect(older).toMatchObject({ offerId: created.offerId, revision: 1 });
    expect(older.variantId).not.toBe(newer.variantId);
  });

  it("vergibt die gemeinsame Nummernserie auch dann monoton, wenn ein aelterer Create erst nach einem juengeren zum Series-Lock gelangt", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");
    await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand));

    const olderProject = await createPlanningProject(fixture.members);
    const youngerProject = await createPlanningProject(fixture.members);
    for (const project of [olderProject, youngerProject]) {
      await resolveCatalog(fixture.members, project, fixture.products, 0, {
        module: 1,
        inverter: 1,
        battery: 1,
        wallbox: 1,
      });
    }

    const blocker = await testPool.connect();
    const pauseKey = "m201-offer-series-inverse-lock";
    let blockerOpen = false;
    let triggerInstalled = false;
    try {
      await testPool.query(`
        create or replace function test_m201_pause_offer_series_insert()
        returns trigger
        language plpgsql
        as $function$
        begin
          if current_setting('app.m201_pause_offer_series', true) = 'on' then
            perform pg_catalog.pg_advisory_xact_lock(
              pg_catalog.hashtextextended('m201-offer-series-inverse-lock', 0)
            );
          end if;
          return new;
        end
        $function$;
        drop trigger if exists test_m201_pause_offer_series_insert
          on offer_number_series;
        create trigger test_m201_pause_offer_series_insert
          before insert on offer_number_series
          for each row execute function test_m201_pause_offer_series_insert()
      `);
      triggerInstalled = true;
      await blocker.query("begin");
      blockerOpen = true;
      const blockerPidResult = await blocker.query<{ blocker_pid: number }>(
        "select pg_catalog.pg_backend_pid() as blocker_pid",
      );
      const blockerPid = blockerPidResult.rows[0]?.blocker_pid;
      if (!blockerPid) throw new Error("Series-Test konnte die Blocker-PID nicht lesen.");
      await blocker.query(
        "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
        [pauseKey],
      );

      const olderCreate = withTenantOn(
        testPool,
        fixture.members.workspaceId,
        async (tx) => {
          await tx.execute(sql`
            select set_config('app.m201_pause_offer_series', 'on', true)
          `);
          return createOfferFromRequest(
            tx,
            operator,
            offerCreateCommand(olderProject),
          );
        },
      );

      const waitDeadline = Date.now() + 5_000;
      let waiterObserved = false;
      while (Date.now() < waitDeadline) {
        const waiting = await testPool.query<{ waiting: boolean }>(`
          select exists (
            select 1
              from pg_catalog.pg_stat_activity activity
             where $1::integer = any(pg_catalog.pg_blocking_pids(activity.pid))
               and activity.wait_event_type = 'Lock'
          ) as waiting
        `, [blockerPid]);
        if (waiting.rows[0]?.waiting) {
          waiterObserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiterObserved).toBe(true);

      const younger = await withTenantOn(
        testPool,
        fixture.members.workspaceId,
        (tx) => createOfferFromRequest(
          tx,
          operator,
          offerCreateCommand(youngerProject),
        ),
      );
      await blocker.query("commit");
      blockerOpen = false;
      const older = await olderCreate;

      const numbers = await withTenantOn(
        testPool,
        fixture.members.workspaceId,
        (tx) => tx.execute<{ project_id: string; number_sequence: number; [key: string]: unknown }>(sql`
          select project_id, number_sequence
            from offer
           where workspace_id = ${fixture.members.workspaceId}::uuid
             and project_id in (${olderProject.projectId}::uuid, ${youngerProject.projectId}::uuid)
           order by number_sequence
        `),
      );
      expect(older.offerId).not.toBe(younger.offerId);
      expect(numbers.rows.map((row) => row.number_sequence)).toHaveLength(2);
      expect(new Set(numbers.rows.map((row) => row.number_sequence)).size).toBe(2);
    } finally {
      if (blockerOpen) await blocker.query("rollback");
      blocker.release();
      if (triggerInstalled) {
        await testPool.query(`
          drop trigger if exists test_m201_pause_offer_series_insert
            on offer_number_series;
          drop function if exists test_m201_pause_offer_series_insert()
        `);
      }
    }
  });

  it("verweigert kataloggebundene EK-Overrides trotz voller Rechte und erlaubt sie nur für freie Zeilen", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");
    const created = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand));
    const immutableBasis = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      1,
    );
    const targetSection = immutableBasis.revision_snapshot.sections[0]!;
    const catalogLine = targetSection.lines.find((line) => line.source.kind === "catalog");
    if (!catalogLine) throw new Error("Kataloggebundene Angebotszeile fehlt in der Fixture.");
    const beforeRejectedOverride = await readOfferMutationState(
      fixture.members.workspaceId,
      created.offerId,
    );

    await expect(withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      reviseOfferVariant(tx, operator, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: created.offerId,
        variantId: created.variantId,
        expectedRevision: 1,
        operations: [{
          operation: "set_line_purchase_price",
          lineDomainId: catalogLine.lineDomainId,
          purchaseUnitNetCents:
            catalogLine.purchasePricing.effectiveUnitNetCents + 1_000,
          reasonCode: "correction",
        }],
      }))).rejects.toMatchObject({
      name: "OfferValidationError",
      paths: ["/operations/lineDomainId"],
    });
    await expect(withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      reviseOfferVariant(tx, operator, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: created.offerId,
        variantId: created.variantId,
        expectedRevision: 1,
        operations: [{
          operation: "set_custom_line_details",
          lineDomainId: catalogLine.lineDomainId,
          displayName: "Verbotene Katalogumbenennung",
          description: null,
          unit: "set",
        }],
      }))).rejects.toMatchObject({
      name: "OfferValidationError",
      paths: ["/operations/lineDomainId"],
    });

    const afterRejectedOverride = await readOfferMutationState(
      fixture.members.workspaceId,
      created.offerId,
    );
    const basisAfterRejectedOverride = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      1,
    );
    expect(afterRejectedOverride).toEqual(beforeRejectedOverride);
    expect(basisAfterRejectedOverride.snapshot_text).toBe(immutableBasis.snapshot_text);
    expect(basisAfterRejectedOverride.snapshot_sha256_hex)
      .toBe(immutableBasis.snapshot_sha256_hex);

    const customLineDomainId = randomUUID();
    const customLinePurchaseNetCents = 40_000;
    const addedCustomLine = await withTenantOn(
      testPool,
      fixture.members.workspaceId,
      (tx) => reviseOfferVariant(tx, operator, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: created.offerId,
        variantId: created.variantId,
        expectedRevision: 1,
        operations: [{
          operation: "add_custom_line",
          lineDomainId: customLineDomainId,
          sectionDomainId: targetSection.sectionDomainId,
          position: targetSection.lines.length + 1,
          displayName: "Freie EK-korrigierbare Montageleistung",
          description: "Synthetische Regressionstest-Zeile",
          unit: "piece",
          quantityMilli: 1_000,
          salesUnitNetCents: 100_000,
          purchaseUnitNetCents: customLinePurchaseNetCents,
          positionType: "required",
          isHidden: false,
          taxTreatment: "standard_19",
        }],
      }),
    );
    expect(addedCustomLine).toMatchObject({ revision: 2 });
    const revisionTwo = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      2,
    );
    const customBeforeOverride = revisionTwo.revision_snapshot.sections
      .flatMap((section) => section.lines)
      .find((line) => line.lineDomainId === customLineDomainId);
    if (!customBeforeOverride) throw new Error("Freie Angebotszeile wurde nicht persistiert.");

    const overriddenPurchaseNetCents = 35_000;
    const overridden = await withTenantOn(
      testPool,
      fixture.members.workspaceId,
      (tx) => reviseOfferVariant(tx, operator, {
        schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
        offerId: created.offerId,
        variantId: created.variantId,
        expectedRevision: 2,
        operations: [
          {
            operation: "set_custom_line_details",
            lineDomainId: customLineDomainId,
            displayName: "Umbenannte freie Montageleistung",
            description: "Metadaten nach Reload geändert",
            unit: "set",
          },
          {
            operation: "set_line_purchase_price",
            lineDomainId: customLineDomainId,
            purchaseUnitNetCents: overriddenPurchaseNetCents,
            reasonCode: "correction",
          },
        ],
      }),
    );
    expect(overridden).toMatchObject({ revision: 3 });

    const revisionThree = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      3,
    );
    const catalogAfterAllowedOverride = revisionThree.revision_snapshot.sections
      .flatMap((section) => section.lines)
      .find((line) => line.lineDomainId === catalogLine.lineDomainId);
    const customAfterOverride = revisionThree.revision_snapshot.sections
      .flatMap((section) => section.lines)
      .find((line) => line.lineDomainId === customLineDomainId);
    expect(validateOfferVariantSnapshot(revisionThree.revision_snapshot).ok).toBe(true);
    expect(catalogAfterAllowedOverride?.purchasePricing)
      .toEqual(catalogLine.purchasePricing);
    expect(customAfterOverride).toMatchObject({
      product: {
        kind: "custom",
        displayName: "Umbenannte freie Montageleistung",
        description: "Metadaten nach Reload geändert",
        unit: "set",
      },
      source: {
        kind: "custom",
        enteredBy: fixture.members.operatorId,
      },
      purchasePricing: {
        originalUnitNetCents: customLinePurchaseNetCents,
        effectiveUnitNetCents: overriddenPurchaseNetCents,
        provenance: {
          kind: "manual_override",
          reasonCode: "correction",
          overriddenBy: fixture.members.operatorId,
          overriddenAt: expect.any(String),
          originalProvenance: customBeforeOverride.purchasePricing.provenance,
        },
      },
      computed: { purchaseNetCents: overriddenPurchaseNetCents },
    });

    const afterAllowedOverride = await readOfferMutationState(
      fixture.members.workspaceId,
      created.offerId,
    );
    expectMutationDelta(afterRejectedOverride, afterAllowedOverride, {
      variants: 0,
      revisions: 2,
      sections: 8,
      lines: 10,
      events: 2,
      audits: 2,
    });
  });

  it("hält alte Katalog-Snapshots bytegleich, markiert Outdated und seedet nur explizit eine neue aktuelle Basis", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");
    const created = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand));
    const oldBasis = await readRevision(fixture.members.workspaceId, created.variantId, 1);

    await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      reviseCatalogComponentPricing(tx, operator, {
        schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
        componentId: fixture.products.battery,
        expectedRevision: 1,
        commercial: productCommand("battery", 3, 10_000).commercial,
      }));

    const outdated = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      getOfferDetail(tx, operator, {
        offerId: created.offerId,
        variantId: created.variantId,
      }));
    expect(outdated).toMatchObject({
      state: "outdated",
      offer: { id: created.offerId, outdated: true },
    });
    const afterCatalogChange = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      1,
    );
    expect(afterCatalogChange.snapshot_text).toBe(oldBasis.snapshot_text);
    expect(afterCatalogChange.snapshot_sha256_hex).toBe(oldBasis.snapshot_sha256_hex);

    await expect(withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createVariantFromCurrentResolution(tx, operator, {
        schemaVersion: OFFER_VARIANT_FROM_RESOLUTION_COMMAND_VERSION,
        offerId: created.offerId,
        expectedRequirementRevision: 1,
        expectedCalculationRevision: 1,
        expectedResolutionRevision: 1,
        name: "Unzulässige Basis aus veralteter Produktauswahl",
        taxTreatment: "standard_19",
      }))).rejects.toMatchObject({
      name: "OfferBlockedError",
      code: "resolution_not_current",
    });

    await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      activateCatalogComponent(tx, operator, {
        componentId: fixture.products.battery,
        expectedRevision: 2,
        expectedStatus: "draft",
      }));
    await resolveCatalog(fixture.members, fixture.project, fixture.products, 1, {
      module: 1,
      inverter: 1,
      battery: 2,
      wallbox: 1,
    });
    const newBasis = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createVariantFromCurrentResolution(tx, operator, {
        schemaVersion: OFFER_VARIANT_FROM_RESOLUTION_COMMAND_VERSION,
        offerId: created.offerId,
        expectedRequirementRevision: 1,
        expectedCalculationRevision: 1,
        expectedResolutionRevision: 2,
        name: "Basis aus Katalogrevision 2",
        taxTreatment: "standard_19",
      }));
    const currentBasis = await readRevision(
      fixture.members.workspaceId,
      newBasis.variantId,
      1,
    );
    const newBattery = currentBasis.revision_snapshot.sections
      .flatMap((section) => section.lines)
      .find((line) => line.source.kind === "catalog"
        && line.source.catalogComponentId === fixture.products.battery);

    expect(newBasis).toMatchObject({ offerId: created.offerId, revision: 1 });
    expect(newBasis.variantId).not.toBe(created.variantId);
    expect(currentBasis.revision_snapshot).toMatchObject({
      variantName: "Basis aus Katalogrevision 2",
      sourceBindings: { resolutionRevision: 2 },
    });
    expect(newBattery).toMatchObject({
      source: {
        kind: "catalog",
        catalogComponentRevision: 2,
        catalogSalesUnitNetCents: 410_000,
        catalogPurchaseUnitNetCents: 255_000,
      },
      salesPricing: {
        originalUnitNetCents: 410_000,
        effectiveUnitNetCents: 410_000,
      },
      purchasePricing: {
        originalUnitNetCents: 255_000,
        effectiveUnitNetCents: 255_000,
      },
    });
    const oldBasisAfterNewVariant = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      1,
    );
    expect(oldBasisAfterNewVariant.snapshot_text).toBe(oldBasis.snapshot_text);
    expect(oldBasisAfterNewVariant.snapshot_sha256_hex).toBe(oldBasis.snapshot_sha256_hex);
    const createdEvent = await withTenantOn(
      testPool,
      fixture.members.workspaceId,
      (tx) => tx.execute<{ event_type: string; payload: Record<string, unknown> }>(sql`
        select event_type, payload
          from domain_events
         where workspace_id = ${fixture.members.workspaceId}::uuid
           and aggregate_id = ${created.offerId}::uuid
           and event_type = 'offer.variant_created'
           and payload->>'variantId' = ${newBasis.variantId}
      `),
    );
    expect(createdEvent.rows).toEqual([{
      event_type: "offer.variant_created",
      payload: {
        offerId: created.offerId,
        variantId: newBasis.variantId,
        previousRevision: null,
        newRevision: 1,
        changeClasses: ["resolution_seed"],
        previousState: "absent",
        newState: "draft",
      },
    }]);
  });

  it("erlaubt exakt zwölf Varianten und lehnt die dreizehnte ohne Teilzustand ab", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");
    const created = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand));

    for (let ordinal = 2; ordinal <= 12; ordinal += 1) {
      const duplicate = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
        duplicateOfferVariant(tx, operator, {
          schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
          offerId: created.offerId,
          sourceVariantId: created.variantId,
          expectedSourceRevision: 1,
          name: `Synthetische Variante ${ordinal}`,
        }));
      expect(duplicate).toMatchObject({ revision: 1 });
    }

    await expect(withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      duplicateOfferVariant(tx, operator, {
        schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
        offerId: created.offerId,
        sourceVariantId: created.variantId,
        expectedSourceRevision: 1,
        name: "Unzulässige Variante 13",
      }))).rejects.toBeInstanceOf(OfferValidationError);

    const variants = await withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
      const result = await tx.execute<{
        ordinal: number;
        current_revision: number;
        [key: string]: unknown;
      }>(sql`
        select ordinal, current_revision
          from offer_variant
         where workspace_id = ${fixture.members.workspaceId}::uuid
           and offer_id = ${created.offerId}::uuid
         order by ordinal
      `);
      return result.rows;
    });
    expect(variants).toHaveLength(12);
    expect(variants.map((variant) => variant.ordinal))
      .toEqual(Array.from({ length: 12 }, (_value, index) => index + 1));
    expect(variants.every((variant) => variant.current_revision === 1)).toBe(true);
  });

  it("serialisiert zwei echte Variant-Races bei elf Varianten auf exakt eine zwölfte ohne Verlierer-Teilzustand", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");
    const created = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand));

    for (let ordinal = 2; ordinal <= 11; ordinal += 1) {
      await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
        duplicateOfferVariant(tx, operator, {
          schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
          offerId: created.offerId,
          sourceVariantId: created.variantId,
          expectedSourceRevision: 1,
          name: `Vorbereitete Variante ${ordinal}`,
        }));
    }
    const before = await readOfferMutationState(
      fixture.members.workspaceId,
      created.offerId,
    );
    expect(before.variants).toBe(11);

    const raceNames = ["Race-Kandidat A", "Race-Kandidat B"] as const;
    const outcomes = await runBehindProjectLock(
      fixture.members.workspaceId,
      fixture.project.projectId,
      raceNames.map((name) => (applicationName: string) =>
        withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
          await tx.execute(sql`
            select set_config('application_name', ${applicationName}, true)
          `);
          return duplicateOfferVariant(tx, operator, {
            schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
            offerId: created.offerId,
            sourceVariantId: created.variantId,
            expectedSourceRevision: 1,
            name,
          });
        })),
    );

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const loser = rejected[0];
    if (!loser || loser.status !== "rejected") {
      throw new Error("Erwarteter Race-Verlierer fehlt.");
    }
    expect(loser.reason).toBeInstanceOf(OfferValidationError);
    expect((loser.reason as OfferValidationError).paths)
      .toEqual(["/blocked/variant_limit"]);

    const after = await readOfferMutationState(
      fixture.members.workspaceId,
      created.offerId,
    );
    expectMutationDelta(before, after, {
      variants: 1,
      revisions: 1,
      sections: 4,
      lines: 4,
      events: 1,
      audits: 1,
    });
    expect(after.variants).toBe(12);

    const persistedRaceVariants = await withTenantOn(
      testPool,
      fixture.members.workspaceId,
      async (tx) => {
        const result = await tx.execute<{
          id: string;
          name: string;
          ordinal: number;
          current_revision: number;
          [key: string]: unknown;
        }>(sql`
          select id, name, ordinal, current_revision
            from offer_variant
           where workspace_id = ${fixture.members.workspaceId}::uuid
             and offer_id = ${created.offerId}::uuid
             and name in (${raceNames[0]}, ${raceNames[1]})
           order by name
        `);
        return result.rows;
      },
    );
    expect(persistedRaceVariants).toHaveLength(1);
    expect(persistedRaceVariants[0]).toMatchObject({
      id: (fulfilled[0] as PromiseFulfilledResult<{ variantId: string }>).value.variantId,
      ordinal: 12,
      current_revision: 1,
    });
  });

  it("linearisiert Save gegen Duplicate ohne Deadlock oder halbe Revision/Event/Audit-Spuren", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");
    const created = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand));
    const basisBefore = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      1,
    );
    const before = await readOfferMutationState(
      fixture.members.workspaceId,
      created.offerId,
    );

    const outcomes = await runBehindProjectLock(
      fixture.members.workspaceId,
      fixture.project.projectId,
      [
        (applicationName: string) =>
          withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
            await tx.execute(sql`
              select set_config('application_name', ${applicationName}, true)
            `);
            return reviseOfferVariant(tx, operator, {
              schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
              offerId: created.offerId,
              variantId: created.variantId,
              expectedRevision: 1,
              operations: [{
                operation: "set_variant_name",
                name: "Parallel gespeicherte Basis",
              }],
            });
          }),
        (applicationName: string) =>
          withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
            await tx.execute(sql`
              select set_config('application_name', ${applicationName}, true)
            `);
            return duplicateOfferVariant(tx, operator, {
              schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
              offerId: created.offerId,
              sourceVariantId: created.variantId,
              expectedSourceRevision: 1,
              name: "Parallel duplizierte Basis",
            });
          }),
      ],
    );

    expect(outcomes[0]?.status).toBe("fulfilled");
    const duplicateOutcome = outcomes[1];
    if (!duplicateOutcome) throw new Error("Duplicate-Race-Ergebnis fehlt.");
    if (duplicateOutcome.status === "rejected") {
      expect(duplicateOutcome.reason).toBeInstanceOf(OfferConflictError);
    }

    const saved = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      2,
    );
    expect(saved.revision_snapshot.variantName).toBe("Parallel gespeicherte Basis");
    const immutableBasis = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      1,
    );
    expect(immutableBasis.snapshot_text).toBe(basisBefore.snapshot_text);
    expect(immutableBasis.snapshot_sha256_hex).toBe(basisBefore.snapshot_sha256_hex);

    const duplicateCommitted = duplicateOutcome.status === "fulfilled";
    const after = await readOfferMutationState(
      fixture.members.workspaceId,
      created.offerId,
    );
    expectMutationDelta(before, after, {
      variants: duplicateCommitted ? 1 : 0,
      revisions: duplicateCommitted ? 2 : 1,
      sections: duplicateCommitted ? 8 : 4,
      lines: duplicateCommitted ? 8 : 4,
      events: duplicateCommitted ? 2 : 1,
      audits: duplicateCommitted ? 2 : 1,
    });

    if (duplicateOutcome.status === "fulfilled") {
      const duplicate = await readRevision(
        fixture.members.workspaceId,
        duplicateOutcome.value.variantId,
        1,
      );
      expect(duplicate.revision_snapshot.variantName).toBe("Parallel duplizierte Basis");
      expect(duplicate.revision_snapshot.sections)
        .toEqual(basisBefore.revision_snapshot.sections);
    } else {
      const partialDuplicate = await withTenantOn(
        testPool,
        fixture.members.workspaceId,
        (tx) => tx.execute<{ count: number; [key: string]: unknown }>(sql`
          select count(*)::int as count
            from offer_variant
           where workspace_id = ${fixture.members.workspaceId}::uuid
             and offer_id = ${created.offerId}::uuid
             and name = 'Parallel duplizierte Basis'
        `),
      );
      expect(partialDuplicate.rows[0]?.count).toBe(0);
    }
  });

  it("serialisiert Save gegen neue Katalogbasis und committet beide Aggregateänderungen vollständig", async () => {
    const fixture = await createFixture();
    const operator = offerCtx(fixture.members, "operator");
    const created = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
      createOfferFromRequest(tx, operator, fixture.createCommand));
    const basisBefore = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      1,
    );
    const before = await readOfferMutationState(
      fixture.members.workspaceId,
      created.offerId,
    );

    const outcomes = await runBehindProjectLock(
      fixture.members.workspaceId,
      fixture.project.projectId,
      [
        (applicationName: string) =>
          withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
            await tx.execute(sql`
              select set_config('application_name', ${applicationName}, true)
            `);
            return reviseOfferVariant(tx, operator, {
              schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
              offerId: created.offerId,
              variantId: created.variantId,
              expectedRevision: 1,
              operations: [{
                operation: "set_variant_name",
                name: "Parallel aktualisierte Ausgangsbasis",
              }],
            });
          }),
        (applicationName: string) =>
          withTenantOn(testPool, fixture.members.workspaceId, async (tx) => {
            await tx.execute(sql`
              select set_config('application_name', ${applicationName}, true)
            `);
            return createVariantFromCurrentResolution(tx, operator, {
              schemaVersion: OFFER_VARIANT_FROM_RESOLUTION_COMMAND_VERSION,
              offerId: created.offerId,
              expectedRequirementRevision: 1,
              expectedCalculationRevision: 1,
              expectedResolutionRevision: 1,
              name: "Parallel erzeugte aktuelle Basis",
              taxTreatment: "standard_19",
            });
          }),
      ],
    );
    expect(outcomes.map((outcome) => outcome.status))
      .toEqual(["fulfilled", "fulfilled"]);

    const newBasisOutcome = outcomes[1];
    if (!newBasisOutcome || newBasisOutcome.status !== "fulfilled") {
      throw new Error("Erwartete neue Basis fehlt.");
    }
    const saved = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      2,
    );
    const newBasis = await readRevision(
      fixture.members.workspaceId,
      newBasisOutcome.value.variantId,
      1,
    );
    expect(saved.revision_snapshot.variantName)
      .toBe("Parallel aktualisierte Ausgangsbasis");
    expect(newBasis.revision_snapshot).toMatchObject({
      variantName: "Parallel erzeugte aktuelle Basis",
      sourceBindings: { resolutionRevision: 1 },
    });
    const immutableBasis = await readRevision(
      fixture.members.workspaceId,
      created.variantId,
      1,
    );
    expect(immutableBasis.snapshot_text).toBe(basisBefore.snapshot_text);
    expect(immutableBasis.snapshot_sha256_hex).toBe(basisBefore.snapshot_sha256_hex);

    const after = await readOfferMutationState(
      fixture.members.workspaceId,
      created.offerId,
    );
    expectMutationDelta(before, after, {
      variants: 1,
      revisions: 2,
      sections: 8,
      lines: 8,
      events: 2,
      audits: 2,
    });
  });

  it.each(["Save", "Duplicate", "neue Basis"] as const)(
    "linearisiert echte Erasure gegen %s ohne Deadlock oder Teilzustand",
    async (mutationKind) => {
      const fixture = await createFixture();
      const operator = offerCtx(fixture.members, "operator");
      const created = await withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
        createOfferFromRequest(tx, operator, fixture.createCommand));
      const contact = await withTenantOn(
        testPool,
        fixture.members.workspaceId,
        (tx) => tx.execute<{ contact_id: string; [key: string]: unknown }>(sql`
          select contact_id
            from offer
           where workspace_id = ${fixture.members.workspaceId}::uuid
             and id = ${created.offerId}::uuid
        `),
      );
      const contactId = contact.rows[0]?.contact_id;
      if (!contactId) throw new Error("Erasure-Race verlangt einen Offer-Kontakt.");
      const before = await readOfferMutationState(
        fixture.members.workspaceId,
        created.offerId,
      );

      const pauseKey = "m201-offer-erasure-mutation-pause";
      const blocker = await testPool.connect();
      let blockerOpen = false;
      let triggerInstalled = false;
      let erasureClient: PoolClient | undefined;
      let erasureOpen = false;
      let mutationCompletion:
        | Promise<{ offerId: string; variantId: string; revision: number }>
        | undefined;
      let erasureSettled:
        | Promise<{ error: unknown | undefined }>
        | undefined;
      try {
        await testPool.query(`
          create or replace function test_m201_pause_offer_touch()
          returns trigger
          language plpgsql
          as $function$
          begin
            if current_setting('app.m201_pause_offer_touch', true) = 'on' then
              perform pg_catalog.pg_advisory_xact_lock(
                pg_catalog.hashtextextended('m201-offer-erasure-mutation-pause', 0)
              );
            end if;
            return new;
          end
          $function$;
          drop trigger if exists test_m201_pause_offer_touch on offer;
          create trigger test_m201_pause_offer_touch
            before update on offer
            for each row execute function test_m201_pause_offer_touch()
        `);
        triggerInstalled = true;

        await blocker.query("begin");
        blockerOpen = true;
        const blockerPidResult = await blocker.query<{ blocker_pid: number }>(
          "select pg_catalog.pg_backend_pid() as blocker_pid",
        );
        const blockerPid = blockerPidResult.rows[0]?.blocker_pid;
        if (!blockerPid) throw new Error("Erasure-Race konnte die Blocker-PID nicht lesen.");
        await blocker.query(
          "select pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))",
          [pauseKey],
        );

        const mutationPidReady = deferred<number>();
        mutationCompletion = withTenantOn(
          testPool,
          fixture.members.workspaceId,
          async (tx) => {
            const pidResult = await tx.execute<{ pid: number; [key: string]: unknown }>(sql`
              select set_config('app.m201_pause_offer_touch', 'on', true),
                     pg_backend_pid() as pid
            `);
            const pid = pidResult.rows[0]?.pid;
            if (!pid) throw new Error("Erasure-Race konnte die Mutations-PID nicht lesen.");
            mutationPidReady.resolve(pid);

            if (mutationKind === "Save") {
              return reviseOfferVariant(tx, operator, {
                schemaVersion: OFFER_VARIANT_REVISE_COMMAND_VERSION,
                offerId: created.offerId,
                variantId: created.variantId,
                expectedRevision: 1,
                operations: [{
                  operation: "set_variant_name",
                  name: "Erasure-sicher gespeicherte Basis",
                }],
              });
            }
            if (mutationKind === "Duplicate") {
              return duplicateOfferVariant(tx, operator, {
                schemaVersion: OFFER_VARIANT_DUPLICATE_COMMAND_VERSION,
                offerId: created.offerId,
                sourceVariantId: created.variantId,
                expectedSourceRevision: 1,
                name: "Erasure-sicher duplizierte Basis",
              });
            }
            return createVariantFromCurrentResolution(tx, operator, {
              schemaVersion: OFFER_VARIANT_FROM_RESOLUTION_COMMAND_VERSION,
              offerId: created.offerId,
              expectedRequirementRevision: 1,
              expectedCalculationRevision: 1,
              expectedResolutionRevision: 1,
              name: "Erasure-sichere aktuelle Basis",
              taxTreatment: "standard_19",
            });
          },
        );
        void mutationCompletion.catch(mutationPidReady.reject);
        const mutationPid = await mutationPidReady.promise;
        await waitForPostgresBlockingPid(
          mutationPid,
          blockerPid,
          `${mutationKind} am Offer-Touch`,
        );

        erasureClient = await testPool.connect();
        await erasureClient.query("begin");
        erasureOpen = true;
        await erasureClient.query("set local lock_timeout = '5s'");
        const erasurePidResult = await erasureClient.query<{ erasure_pid: number }>(
          "select pg_catalog.pg_backend_pid() as erasure_pid",
        );
        const erasurePid = erasurePidResult.rows[0]?.erasure_pid;
        if (!erasurePid) throw new Error("Erasure-Race konnte die Erasure-PID nicht lesen.");
        erasureSettled = erasureClient.query(
          "select public.erase_inactive_lead($1::uuid, $2::uuid, $3::uuid)",
          [fixture.members.workspaceId, contactId, randomUUID()],
        ).then(
          () => ({ error: undefined }),
          (error: unknown) => ({ error }),
        );
        await waitForPostgresBlockingPid(
          erasurePid,
          mutationPid,
          `Erasure hinter ${mutationKind}`,
        );

        await blocker.query("commit");
        blockerOpen = false;
        const mutation = await mutationCompletion;
        const erasure = await erasureSettled;
        expect(erasure.error).toMatchObject({ code: "P0001" });
        expect(String((erasure.error as Error | undefined)?.message))
          .toMatch(/erasure_not_eligible/);
        await erasureClient.query("rollback");
        erasureOpen = false;
        erasureClient.release();
        erasureClient = undefined;

        expect(mutation).toMatchObject({
          offerId: created.offerId,
          revision: mutationKind === "Save" ? 2 : 1,
        });
        const after = await readOfferMutationState(
          fixture.members.workspaceId,
          created.offerId,
        );
        expectMutationDelta(before, after, {
          variants: mutationKind === "Save" ? 0 : 1,
          revisions: 1,
          sections: 4,
          lines: 4,
          events: 1,
          audits: 1,
        });
        const tombstone = await withTenantOn(
          testPool,
          fixture.members.workspaceId,
          (tx) => tx.execute<{ count: number; [key: string]: unknown }>(sql`
            select count(*)::int as count
              from erasure_tombstone
             where workspace_id = ${fixture.members.workspaceId}::uuid
               and contact_id = ${contactId}::uuid
          `),
        );
        expect(tombstone.rows[0]?.count).toBe(0);
        await expect(withTenantOn(testPool, fixture.members.workspaceId, (tx) =>
          getOfferDetail(tx, operator, {
            offerId: created.offerId,
            variantId: mutation.variantId,
          }))).resolves.not.toBeNull();
      } finally {
        if (blockerOpen) await blocker.query("rollback").catch(() => undefined);
        blocker.release();
        if (mutationCompletion) await mutationCompletion.catch(() => undefined);
        if (erasureClient) {
          if (erasureOpen) await erasureClient.query("rollback").catch(() => undefined);
          erasureClient.release();
        }
        if (erasureSettled) await erasureSettled.catch(() => undefined);
        if (triggerInstalled) {
          await testPool.query(`
            drop trigger if exists test_m201_pause_offer_touch on offer;
            drop function if exists test_m201_pause_offer_touch()
          `);
        }
      }
    },
    30_000,
  );
});
