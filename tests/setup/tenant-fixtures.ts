import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  CATALOG_CANONICALIZATION_VERSION,
  CATALOG_COMPONENT_CONTRACT_VERSION,
  PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
  sealCatalogComponentRevision,
  sealProjectCatalogResolution,
} from "@/lib/integrations/catalog/contract";
import { canonicalizeOfferJson } from "@/lib/integrations/offers/contract";
import type { TenantTx } from "@/lib/db/types";

async function fixtureProjectGraph(tx: TenantTx, wsId: string): Promise<{
  contactId: string;
  siteId: string;
  projectId: string;
}> {
  const contactId = randomUUID();
  const siteId = randomUUID();
  const projectId = randomUUID();
  await tx.execute(sql`
    insert into contact (
      id, workspace_id, display_name, email_primary, email_normalized
    ) values (
      ${contactId}::uuid, ${wsId}::uuid, 'Fixture Contact',
      ${`${contactId}@test.local`}, ${`${contactId}@test.local`}
    )
  `);
  await tx.execute(sql`
    insert into site (id, workspace_id, contact_id, label)
    values (${siteId}::uuid, ${wsId}::uuid, ${contactId}::uuid, 'Fixture Site')
  `);
  await tx.execute(sql`
    insert into project (
      id, workspace_id, contact_id, site_id, kanban_board_id,
      kanban_column_id, name, source_key
    )
    select ${projectId}::uuid, ${wsId}::uuid, ${contactId}::uuid,
           ${siteId}::uuid, board.id, intake_column.id,
           'Fixture Project', 'fixture'
    from kanban_board board
    join kanban_column intake_column
      on intake_column.workspace_id = board.workspace_id
      and intake_column.board_id = board.id
      and intake_column.is_intake = true
      and intake_column.archived_at is null
    where board.workspace_id = ${wsId}::uuid
      and board.scope = 'residential'
      and board.is_default = true
      and board.archived_at is null
  `);
  return { contactId, siteId, projectId };
}

async function fixtureReceipt(tx: TenantTx, wsId: string): Promise<{
  receiptId: string;
  projectId: string;
}> {
  const { contactId, siteId, projectId } = await fixtureProjectGraph(tx, wsId);
  const receiptId = randomUUID();
  await tx.execute(sql`
    insert into inbound_receipt (
      id, workspace_id, source_key, submission_id, contract_version,
      body_sha256, auth_key_id, signed_at, submitted_at, received_at,
      producer_application, producer_git_revision, producer_environment,
      calculator_engine, acquisition, privacy_purpose, privacy_legal_basis,
      privacy_notice_version, privacy_notice_url, contact_resolution,
      contact_id, site_id, project_id
    ) values (
      ${receiptId}::uuid, ${wsId}::uuid, 'wmee-rechner-v3', ${randomUUID()}::uuid,
      'rechner-intake.v1', decode(repeat('00', 32), 'hex'), 'fixture-key',
      now(), now(), now(), 'wmee-rechner-v3', ${"0".repeat(40)}, 'development',
      'wmee-solar.v1', '{}'::jsonb, 'offer_request',
      'art_6_1_b_precontractual', 'fixture', 'https://example.test/privacy',
      'created', ${contactId}::uuid, ${siteId}::uuid, ${projectId}::uuid
    )
  `);
  return { receiptId, projectId };
}

async function fixtureSnapshot(tx: TenantTx, wsId: string): Promise<{
  snapshotId: string;
  projectId: string;
}> {
  const { receiptId, projectId } = await fixtureReceipt(tx, wsId);
  const snapshotId = randomUUID();
  const snapshot = {
    schemaVersion: "wmee-solar-snapshot.v1",
    calculatedAt: "2026-08-29T00:00:00.000Z",
    branch: "new_installation",
    questionnaireVariant: "short",
    resultIntegrity: "client_reported_unverified",
    inputs: {},
    provenance: { investment: "market_estimate" },
    result: { mode: "new_installation" },
  };
  await tx.execute(sql`
    insert into calculator_snapshot (
      id, workspace_id, receipt_id, project_id, schema_version,
      calculator_engine, result_integrity, investment_source, calculated_at,
      snapshot
    ) values (
      ${snapshotId}::uuid, ${wsId}::uuid, ${receiptId}::uuid, ${projectId}::uuid,
      'wmee-solar-snapshot.v1', 'wmee-solar.v1', 'client_reported_unverified',
      'market_estimate', now(), ${JSON.stringify(snapshot)}::jsonb
    )
  `);
  return { snapshotId, projectId };
}

const fixtureRequirements = {
  schemaVersion: "project-requirements.rechner.v1",
  source: "wmee-rechner-v3",
  branch: "new_installation",
  requestedProducts: {
    targetStorageKwh: 8,
    wallbox: false,
    bidirectionalCharging: false,
    backupPower: false,
  },
};

const fixtureEnergyProfile = {
  schemaVersion: "site-energy-profile.v1",
  inputMode: "consumption",
  building: {
    type: { status: "unknown", value: null, source: "not_collected" },
    year: { status: "unknown", value: null, source: "not_collected" },
    heatedAreaM2: { status: "unknown", value: null, source: "not_collected" },
  },
  roofs: [{
    id: "fixture-roof",
    areaM2: 42,
    azimuthDeg: 0,
    tiltDeg: 35,
    type: "pitched",
    shading: { status: "unknown", value: null, source: "not_collected" },
    source: "user_drawn",
  }],
  consumption: {
    householdKwhPerYear: { status: "known", value: 4_200, source: "customer_metered" },
    electricityPriceCentsPerKwh: { status: "known", value: 36, source: "customer_input" },
    annualPriceIncreasePercent: { status: "unknown", value: null, source: "not_collected" },
    loadProfile: { status: "unknown", value: null, source: "not_collected" },
    evKmPerYear: { status: "unknown", value: null, source: "not_collected" },
    evChargingPattern: { status: "unknown", value: null, source: "not_collected" },
    heatPumpKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
    coolingKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
    heatingAcKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
    hotWaterKwhPerYear: { status: "unknown", value: null, source: "not_collected" },
  },
  existingAssets: {
    pv: { status: "known_absent", source: "rechner_branch" },
    storage: { status: "unknown", source: "not_collected" },
    wallbox: { status: "unknown", source: "not_collected" },
    ev: { status: "unknown", source: "not_collected" },
  },
  provenance: {
    source: "rechner_snapshot",
    sourceSchemaVersion: "wmee-solar-snapshot.v1",
    sourceEngine: "wmee-solar.v1",
    roof: "user_drawn",
    consumption: "metered_kwh",
    electricityPrice: "customer",
    annualPriceIncrease: "default",
  },
};

async function fixtureEnergyGraph(tx: TenantTx, wsId: string): Promise<{
  actorId: string;
  siteId: string;
  projectId: string;
  snapshotId: string;
  requirementId: string;
  profileId: string;
}> {
  const actorId = randomUUID();
  await tx.execute(sql`
    insert into user_identity (id, email)
    values (${actorId}::uuid, ${`${actorId}@energy-fixture.test`})
  `);
  await tx.execute(sql`
    insert into membership (workspace_id, user_id, role)
    values (${wsId}::uuid, ${actorId}::uuid, 'editor')
  `);

  const { snapshotId, projectId } = await fixtureSnapshot(tx, wsId);
  const projectRow = await tx.execute<{ site_id: string; [key: string]: unknown }>(sql`
    select site_id from project
    where workspace_id = ${wsId}::uuid and id = ${projectId}::uuid
  `);
  const siteId = projectRow.rows[0].site_id;
  const requirementId = randomUUID();
  const profileId = randomUUID();

  await tx.execute(sql`
    insert into project_requirement (
      id, workspace_id, project_id, revision, schema_version,
      source_snapshot_id, requirements
    ) values (
      ${requirementId}::uuid, ${wsId}::uuid, ${projectId}::uuid, 1,
      'project-requirements.rechner.v1', ${snapshotId}::uuid,
      ${JSON.stringify(fixtureRequirements)}::jsonb
    )
  `);
  await tx.execute(sql`
    insert into site_energy_profile (
      id, workspace_id, site_id, revision, schema_version, input_mode,
      source_kind, source_snapshot_id, source_project_id, address_revision,
      profile, profile_sha256, confirmed_profile_revision,
      confirmed_address_revision, confirmed_by, confirmed_at
    ) values (
      ${profileId}::uuid, ${wsId}::uuid, ${siteId}::uuid, 1,
      'site-energy-profile.v1', 'consumption', 'rechner_snapshot',
      ${snapshotId}::uuid, ${projectId}::uuid, 1,
      ${JSON.stringify(fixtureEnergyProfile)}::jsonb,
      decode(repeat('11', 32), 'hex'), 1, 1, ${actorId}::uuid, now()
    )
  `);

  return { actorId, siteId, projectId, snapshotId, requirementId, profileId };
}

async function fixtureCalculationJob(tx: TenantTx, wsId: string): Promise<{
  actorId: string;
  siteId: string;
  projectId: string;
  snapshotId: string;
  requirementId: string;
  profileId: string;
  jobId: string;
}> {
  const graph = await fixtureEnergyGraph(tx, wsId);
  const jobId = randomUUID();
  await tx.execute(sql`
    insert into project_calculation_job (
      id, workspace_id, project_id, site_id, address_revision,
      pin_confirmed_address_revision, profile_id, profile_revision,
      confirmed_profile_revision, confirmed_address_revision,
      requirement_id, requirement_revision, source_snapshot_id,
      reservation_key, provider_recipe_version, contract_version,
      model_id, model_version, source_revision, defaults_version,
      state, attempt_count, next_attempt_at, created_by
    ) values (
      ${jobId}::uuid, ${wsId}::uuid, ${graph.projectId}::uuid,
      ${graph.siteId}::uuid, 1, 1, ${graph.profileId}::uuid, 1, 1, 1,
      ${graph.requirementId}::uuid, 1, ${graph.snapshotId}::uuid,
      decode(repeat('22', 32), 'hex'), 'pvgis-5.3-sarah3-2020.v1',
      'planning-calculation.v1', 'wmee-solar', '1.0.0', ${"a".repeat(40)},
      'wmee-planning-defaults.v1', 'queued', 0, now(), ${graph.actorId}::uuid
    )
  `);
  return { ...graph, jobId };
}

async function fixtureCatalogGraph(tx: TenantTx, wsId: string): Promise<void> {
  await tenantFixtures.project_calculation_revision(tx, wsId);
  const calculation = await tx.execute<{
    actor_id: string;
    project_id: string;
    site_id: string;
    requirement_id: string;
    requirement_revision: number;
    calculation_revision_id: string;
    calculation_revision: number;
    input_sha256: string;
    result_sha256: string;
    [key: string]: unknown;
  }>(sql`
    select revision.created_by as actor_id,
           revision.project_id,
           revision.site_id,
           revision.requirement_id,
           revision.requirement_revision,
           revision.id as calculation_revision_id,
           revision.revision as calculation_revision,
           encode(revision.input_sha256, 'hex') as input_sha256,
           encode(revision.result_sha256, 'hex') as result_sha256
      from project_calculation_revision revision
     where revision.workspace_id = ${wsId}::uuid
     order by revision.created_at desc, revision.id desc
     limit 1
  `);
  const row = calculation.rows[0];
  if (!row) throw new Error("Catalog-Fixture braucht eine Calculation-Revision.");

  const componentId = randomUUID();
  const internalSku = `FIX-${componentId.slice(0, 8).toUpperCase()}`;
  const snapshot = sealCatalogComponentRevision({
    schemaVersion: CATALOG_COMPONENT_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    identity: {
      workspaceId: wsId,
      componentId,
      revision: 1,
      internalSku,
      componentType: "battery",
    },
    presentation: {
      displayName: "Synthetischer Fixture-Speicher",
      manufacturer: "WMEE Fixture",
      model: internalSku,
      unit: "piece",
      keyPoints: ["Keine realen Produktdaten"],
      image: null,
      datasheet: null,
    },
    technicalData: {
      schemaVersion: "battery.v1",
      nominalCapacityWh: 8_500,
      usableCapacityWh: 8_000,
      maxContinuousPowerWatts: 4_000,
      roundTripEfficiencyBasisPoints: 9_400,
      backupCapability: "known_supported",
    },
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: 250_000,
      salesPriceNetCents: 390_000,
      purchaseProvenance: {
        sourceKind: "supplier_price_list",
        reference: "synthetic-purchase-fixture",
        observedOn: "2026-08-29",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: "synthetic-sales-fixture",
        observedOn: "2026-08-29",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "manufacturer_datasheet",
      reference: "synthetic-technical-fixture",
      observedOn: "2026-08-29",
      rightsBasis: "manufacturer_published",
      sourceDocumentSha256: null,
    },
  });
  await tx.execute(sql`
    insert into catalog_component (
      id, workspace_id, internal_sku, component_type, status,
      current_revision, created_by
    ) values (
      ${componentId}::uuid, ${wsId}::uuid, ${internalSku}, 'battery',
      'draft', 0, ${row.actor_id}::uuid
    )
  `);
  await tx.execute(sql`
    insert into catalog_component_revision (
      workspace_id, component_id, revision, component_type, schema_version,
      canonicalization_version, revision_snapshot, snapshot_sha256, created_by
    ) values (
      ${wsId}::uuid, ${componentId}::uuid, 1, 'battery',
      ${snapshot.schemaVersion}, ${snapshot.canonicalizationVersion},
      ${JSON.stringify(snapshot)}::jsonb, decode(${snapshot.snapshotSha256}, 'hex'),
      ${row.actor_id}::uuid
    )
  `);
  await tx.execute(sql`
    update catalog_component set status = 'active', updated_at = now()
     where workspace_id = ${wsId}::uuid and id = ${componentId}::uuid
  `);

  const lineId = randomUUID();
  const resolution = sealProjectCatalogResolution({
    schemaVersion: PROJECT_CATALOG_RESOLUTION_CONTRACT_VERSION,
    canonicalizationVersion: CATALOG_CANONICALIZATION_VERSION,
    revision: 1,
    bindings: {
      workspaceId: wsId,
      projectId: row.project_id,
      siteId: row.site_id,
      requirementId: row.requirement_id,
      requirementRevision: row.requirement_revision,
      calculationRevisionId: row.calculation_revision_id,
      calculationRevision: row.calculation_revision,
      calculationInputSha256: row.input_sha256,
      calculationResultSha256: row.result_sha256,
      calculationQuality: "server_reproduced_estimate",
      calculationValidationStatus: "not_f4_reference_validated",
    },
    lines: [{
      lineId,
      position: 1,
      quantity: 1,
      coversRequirementKeys: ["storage_capacity"],
      catalogComponentId: componentId,
      catalogComponentRevision: 1,
      componentSnapshotSha256: snapshot.snapshotSha256,
      componentSnapshot: snapshot,
    }],
    requested: {
      branch: "new_installation",
      pvPeakPowerWatts: 0,
      storageCapacityWh: 8_000,
      wallbox: false,
      backupPower: false,
      bidirectionalCharging: false,
    },
    acknowledgements: [],
    confirmedBy: row.actor_id,
    confirmedAt: "2026-08-29T18:00:00.000Z",
  });
  const resolutionId = randomUUID();
  await tx.execute(sql`
    insert into project_catalog_resolution (
      id, workspace_id, project_id, site_id, revision,
      requirement_id, requirement_revision,
      calculation_revision_id, calculation_revision,
      calculation_input_sha256, calculation_result_sha256,
      calculation_quality, calculation_validation_status,
      schema_version, canonicalization_version, resolution_snapshot,
      resolution_sha256, confirmed_by, confirmed_at
    ) values (
      ${resolutionId}::uuid, ${wsId}::uuid, ${row.project_id}::uuid,
      ${row.site_id}::uuid, 1, ${row.requirement_id}::uuid,
      ${row.requirement_revision}, ${row.calculation_revision_id}::uuid,
      ${row.calculation_revision}, decode(${row.input_sha256}, 'hex'),
      decode(${row.result_sha256}, 'hex'), 'server_reproduced_estimate',
      'not_f4_reference_validated', ${resolution.schemaVersion},
      ${resolution.canonicalizationVersion}, ${JSON.stringify(resolution)}::jsonb,
      decode(${resolution.resolutionSha256}, 'hex'), ${row.actor_id}::uuid,
      ${resolution.confirmedAt}::timestamptz
    )
  `);
  await tx.execute(sql`
    insert into project_catalog_resolution_line (
      id, workspace_id, resolution_id, project_id, position, quantity,
      catalog_component_id, catalog_component_revision,
      component_snapshot_sha256
    ) values (
      ${lineId}::uuid, ${wsId}::uuid, ${resolutionId}::uuid,
      ${row.project_id}::uuid, 1, 1, ${componentId}::uuid, 1,
      decode(${snapshot.snapshotSha256}, 'hex')
    )
  `);
}

type FixtureOfferSource = {
  workspace_id: string;
  actor_id: string;
  contact_id: string;
  site_id: string;
  project_id: string;
  inbound_receipt_id: string;
  inbound_payload_sha256: string;
  requirement_id: string;
  requirement_revision: number;
  calculation_revision_id: string;
  calculation_revision: number;
  calculation_input_sha256: string;
  calculation_result_sha256: string;
  resolution_id: string;
  resolution_revision: number;
  resolution_sha256: string;
  [key: string]: unknown;
};

/**
 * Legt genau einen vollständigen, von den deferred DB-Guards akzeptierten
 * Offer-Graphen an. Alle sieben M2-01-Tenanttabellen teilen sich diese
 * Factory: Der erste Aufruf erzeugt den Graphen, spätere Aufrufe finden ihn
 * bereits vor. So prüft die generische Tenant-Suite echte Rows statt die
 * neuen Tabellen zu exemptieren.
 */
async function fixtureOfferGraph(tx: TenantTx, wsId: string): Promise<void> {
  const existing = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id from offer where workspace_id = ${wsId}::uuid limit 1
  `);
  if (existing.rows[0]) return;

  const resolution = await tx.execute<{ id: string; [key: string]: unknown }>(sql`
    select id from project_catalog_resolution
     where workspace_id = ${wsId}::uuid
     limit 1
  `);
  if (!resolution.rows[0]) await fixtureCatalogGraph(tx, wsId);

  const sourceResult = await tx.execute<FixtureOfferSource>(sql`
    select resolution.workspace_id,
           resolution.confirmed_by as actor_id,
           project.contact_id,
           project.site_id,
           project.id as project_id,
           receipt.id as inbound_receipt_id,
           encode(receipt.body_sha256, 'hex') as inbound_payload_sha256,
           resolution.requirement_id,
           resolution.requirement_revision,
           resolution.calculation_revision_id,
           resolution.calculation_revision,
           encode(resolution.calculation_input_sha256, 'hex') as calculation_input_sha256,
           encode(resolution.calculation_result_sha256, 'hex') as calculation_result_sha256,
           resolution.id as resolution_id,
           resolution.revision as resolution_revision,
           encode(resolution.resolution_sha256, 'hex') as resolution_sha256
      from project_catalog_resolution as resolution
      join project
        on project.workspace_id = resolution.workspace_id
       and project.id = resolution.project_id
      join inbound_receipt as receipt
        on receipt.workspace_id = project.workspace_id
       and receipt.project_id = project.id
     where resolution.workspace_id = ${wsId}::uuid
     order by resolution.revision desc
     limit 1
  `);
  const source = sourceResult.rows[0];
  if (!source) throw new Error("Offer-Tenant-Fixture braucht einen Source-Graphen.");

  const offerId = randomUUID();
  const variantId = randomUUID();
  const revisionId = randomUUID();
  const sectionId = randomUUID();
  const sectionDomainId = randomUUID();
  const lineId = randomUUID();
  const lineDomainId = randomUUID();
  const createdAt = "2026-08-29T12:00:00.000Z";
  const contactContext = { displayName: "Offer Tenant Fixture" };
  const installationSiteContext = { formattedAddress: "Testweg 1, 10115 Berlin" };
  const bindings = {
    projectId: source.project_id,
    contactId: source.contact_id,
    siteId: source.site_id,
    inboundReceiptId: source.inbound_receipt_id,
    inboundPayloadSha256: source.inbound_payload_sha256,
    requirementId: source.requirement_id,
    requirementRevision: source.requirement_revision,
    calculationRevisionId: source.calculation_revision_id,
    calculationRevision: source.calculation_revision,
    calculationInputSha256: source.calculation_input_sha256,
    calculationResultSha256: source.calculation_result_sha256,
    resolutionId: source.resolution_id,
    resolutionRevision: source.resolution_revision,
    resolutionSha256: source.resolution_sha256,
  };
  const audienceDecision = {
    audience: "b2c",
    confirmationCode: "b2c_operator_confirmed",
    confirmedBy: source.actor_id,
    confirmedAt: createdAt,
  };
  const lineSnapshot = {
    lineDomainId,
    position: 1,
    componentCategory: "other",
    positionType: "required",
    isHidden: false,
    quantityMilli: 1_000,
    product: {
      kind: "custom",
      displayName: "Freie Tenant-Fixture-Position",
      description: null,
      unit: "piece",
    },
    source: { kind: "custom" },
    salesPricing: { originalUnitNetCents: 100, effectiveUnitNetCents: 100 },
    purchasePricing: { originalUnitNetCents: 50, effectiveUnitNetCents: 50 },
    lineDiscountBps: 0,
    taxTreatment: "standard_19",
    taxRateBps: 1_900,
    taxDecision: { treatment: "standard_19", taxRateBps: 1_900 },
    computed: {
      lineBaseNetCents: 100,
      lineDiscountedNetCents: 100,
      sectionDiscountedNetCents: 100,
      finalSalesNetCents: 100,
      salesTaxCents: 19,
      salesGrossCents: 119,
      purchaseNetCents: 50,
    },
  };
  const sectionSnapshot = {
    sectionDomainId,
    position: 1,
    category: "other",
    title: "Tenant Fixture",
    discountBps: 0,
    lines: [lineSnapshot],
  };
  const snapshotBody = {
    schemaVersion: "offer-variant-snapshot.v1",
    canonicalizationVersion: "offer-jcs.v1",
    workspaceId: wsId,
    offerId,
    variantId,
    revision: 1,
    sourceBindings: bindings,
    priceAudienceDecision: audienceDecision,
    contactContext,
    installationSiteContext,
    variantName: "Basis",
    description: "Vollständige Tenant-Fixture",
    createdBy: source.actor_id,
    createdAt,
    totals: {
      basisNetCents: 100,
      basisTaxCents: 19,
      basisGrossCents: 119,
      optionalNetCents: 0,
      optionalTaxCents: 0,
      optionalGrossCents: 0,
    },
    sections: [sectionSnapshot],
  };
  const snapshotSha256 = createHash("sha256")
    .update(canonicalizeOfferJson(snapshotBody), "utf8")
    .digest("hex");
  const snapshot = { ...snapshotBody, snapshotSha256 };

  await tx.execute(sql`
    insert into offer (
      id, workspace_id, project_id, contact_id, site_id,
      offer_number, number_year, number_sequence,
      price_audience_decision, contact_context, installation_site_context,
      source_bindings, inbound_receipt_id, inbound_payload_sha256,
      requirement_id, requirement_revision,
      calculation_revision_id, calculation_revision,
      calculation_input_sha256, calculation_result_sha256,
      resolution_id, resolution_revision, resolution_sha256,
      create_digest, created_by, created_at, updated_at
    ) values (
      ${offerId}::uuid, ${wsId}::uuid, ${source.project_id}::uuid,
      ${source.contact_id}::uuid, ${source.site_id}::uuid,
      'ANG-2026-000001', 2026, 1, ${JSON.stringify(audienceDecision)}::jsonb,
      ${JSON.stringify(contactContext)}::jsonb,
      ${JSON.stringify(installationSiteContext)}::jsonb,
      ${JSON.stringify(bindings)}::jsonb, ${source.inbound_receipt_id}::uuid,
      decode(${source.inbound_payload_sha256}, 'hex'),
      ${source.requirement_id}::uuid, ${source.requirement_revision},
      ${source.calculation_revision_id}::uuid, ${source.calculation_revision},
      decode(${source.calculation_input_sha256}, 'hex'),
      decode(${source.calculation_result_sha256}, 'hex'),
      ${source.resolution_id}::uuid, ${source.resolution_revision},
      decode(${source.resolution_sha256}, 'hex'), decode(repeat('aa', 32), 'hex'),
      ${source.actor_id}::uuid, ${createdAt}::timestamptz, ${createdAt}::timestamptz
    )
  `);
  await tx.execute(sql`
    insert into offer_variant (
      id, workspace_id, offer_id, ordinal, current_revision,
      name, description, created_by
    ) values (
      ${variantId}::uuid, ${wsId}::uuid, ${offerId}::uuid,
      1, 1, 'Basis', 'Vollständige Tenant-Fixture', ${source.actor_id}::uuid
    )
  `);
  await tx.execute(sql`
    insert into offer_variant_revision (
      id, workspace_id, offer_id, variant_id, project_id, revision,
      schema_version, canonicalization_version, revision_snapshot,
      snapshot_sha256, resolution_id, resolution_revision, resolution_sha256,
      basis_net_cents, basis_tax_cents, basis_gross_cents,
      optional_net_cents, optional_tax_cents, optional_gross_cents,
      created_by, created_at
    ) values (
      ${revisionId}::uuid, ${wsId}::uuid, ${offerId}::uuid, ${variantId}::uuid,
      ${source.project_id}::uuid, 1, 'offer-variant-snapshot.v1', 'offer-jcs.v1',
      ${JSON.stringify(snapshot)}::jsonb, decode(${snapshotSha256}, 'hex'),
      ${source.resolution_id}::uuid, ${source.resolution_revision},
      decode(${source.resolution_sha256}, 'hex'), 100, 19, 119, 0, 0, 0,
      ${source.actor_id}::uuid, ${createdAt}::timestamptz
    )
  `);
  await tx.execute(sql`
    insert into offer_variant_section (
      id, workspace_id, offer_id, variant_id, project_id,
      revision_id, revision, section_domain_id, position,
      category, title, discount_bps, section_snapshot
    ) values (
      ${sectionId}::uuid, ${wsId}::uuid, ${offerId}::uuid, ${variantId}::uuid,
      ${source.project_id}::uuid, ${revisionId}::uuid, 1,
      ${sectionDomainId}::uuid, 1, 'other', 'Tenant Fixture', 0,
      ${JSON.stringify(sectionSnapshot)}::jsonb
    )
  `);
  await tx.execute(sql`
    insert into offer_bom_line (
      id, workspace_id, offer_id, variant_id, project_id,
      revision_id, revision, section_id, section_domain_id, line_domain_id,
      position, component_category, position_type, is_hidden,
      quantity_milli, unit, source_kind,
      original_sales_unit_net_cents, effective_sales_unit_net_cents,
      original_purchase_unit_net_cents, effective_purchase_unit_net_cents,
      line_discount_bps, tax_treatment, tax_rate_bps,
      line_base_net_cents, line_discounted_net_cents,
      section_discounted_net_cents, final_sales_net_cents,
      sales_tax_cents, sales_gross_cents, purchase_net_cents, line_snapshot
    ) values (
      ${lineId}::uuid, ${wsId}::uuid, ${offerId}::uuid, ${variantId}::uuid,
      ${source.project_id}::uuid, ${revisionId}::uuid, 1, ${sectionId}::uuid,
      ${sectionDomainId}::uuid, ${lineDomainId}::uuid, 1, 'other', 'required',
      false, 1000, 'piece', 'custom', 100, 100, 50, 50, 0,
      'standard_19', 1900, 100, 100, 100, 100, 19, 119, 50,
      ${JSON.stringify(lineSnapshot)}::jsonb
    )
  `);
  await tx.execute(sql`
    insert into offer_number_series (
      workspace_id, series_year, last_sequence, created_at, updated_at
    ) values (${wsId}::uuid, 2026, 1, ${createdAt}::timestamptz, ${createdAt}::timestamptz)
  `);
  await tx.execute(sql`
    insert into offer_mutation_rate_window (
      workspace_id, scope, actor_id, window_start, attempts,
      created_at, updated_at
    ) values (
      ${wsId}::uuid, 'actor', ${source.actor_id}::uuid,
      timestamptz '2026-08-30 12:00:00+00', 1,
      ${createdAt}::timestamptz, ${createdAt}::timestamptz
    )
  `);
}

// Factory legt GENAU EINE Zeile im gegebenen Workspace an (workspace-Zeile existiert bereits).
// Jede neue Mandantentabelle MUSS hier eine Factory registrieren, sonst wird
// tests/db/tenant-invariants.test.ts rot — das ist der Mechanismus, der die
// Tenant-Isolations-Invariante über alle künftigen Module (M1–M8) trägt.
export const tenantFixtures: Record<string, (tx: TenantTx, wsId: string) => Promise<void>> = {
  workspace: async () => {}, // Zeile wird vom Suite-Setup selbst angelegt
  // Der Workspace-Provisioning-Trigger legt diese Zeilen bereits an. Die
  // Lesebaseline wird in tenant-invariants.test.ts explizit berücksichtigt;
  // Cross-Writes brauchen unten eigene Overrides, damit sie weiterhin an RLS
  // statt an einem No-op geprüft werden.
  kanban_board: async () => {},
  kanban_column: async () => {},
  membership: async (tx, wsId) => {
    // KEIN select von user_identity: dessen SELECT-Policy (Migration 0002)
    // verlangt eine bereits existierende Membership im aktuellen Workspace —
    // für eine frische Identität ohne Membership ist das chicken-egg. Aus
    // demselben Grund auch kein "insert ... returning" (RETURNING unterliegt
    // ebenfalls der SELECT-Policy). Stattdessen: client-seitige UUID, die
    // direkt in beide Inserts eingesetzt wird.
    const userId = randomUUID();
    await tx.execute(
      sql`insert into user_identity (id, email) values (${userId}, ${`${randomUUID()}@test.local`})`,
    );
    await tx.execute(
      sql`insert into membership (workspace_id, user_id, role) values (${wsId}, ${userId}, 'viewer')`,
    );
  },
  domain_events: async (tx, wsId) => {
    await tx.execute(sql`insert into domain_events (workspace_id, aggregate_type, aggregate_id, event_type, actor)
      values (${wsId}::uuid, 'workspace', ${wsId}::uuid, 'fixture', 'system')`);
  },
  audit_log: async (tx, wsId) => {
    await tx.execute(sql`insert into audit_log (workspace_id, actor, action, resource, allowed)
      values (${wsId}::uuid, 'system', 'fixture', 'none', true)`);
  },
  contact: async (tx, wsId) => {
    const id = randomUUID();
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, email_primary, email_normalized)
      values (${id}::uuid, ${wsId}::uuid, 'Fixture Contact',
        ${`${id}@test.local`}, ${`${id}@test.local`})
    `);
  },
  contact_legal_hold: async (tx, wsId) => {
    const contactId = randomUUID();
    await tx.execute(sql`
      insert into contact (id, workspace_id, display_name, email_primary, email_normalized)
      values (${contactId}::uuid, ${wsId}::uuid, 'Legal Hold Fixture',
        ${`${contactId}@test.local`}, ${`${contactId}@test.local`})
    `);
    await tx.execute(sql`
      insert into contact_legal_hold (workspace_id, contact_id, reason)
      values (${wsId}::uuid, ${contactId}::uuid, 'fixture')
    `);
  },
  erasure_tombstone: async (tx, wsId) => {
    const contactId = randomUUID();
    const operationId = randomUUID();
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, deleted_at
      ) values (
        ${contactId}::uuid, ${wsId}::uuid,
        ${`geloescht-${contactId}`}, now()
      )
    `);
    await tx.execute(sql`
      insert into erasure_operation_locator (operation_id, scope_id)
      values (${operationId}::uuid, ${wsId}::uuid)
    `);
    await tx.execute(sql`
      insert into erasure_tombstone (
        operation_id, workspace_id, contact_id, reason, graph_sha256,
        tombstone_sha256, graph_ids, eligible_at, erased_at
      ) values (
        ${operationId}::uuid, ${wsId}::uuid, ${contactId}::uuid,
        'inactive_lead_24_months', decode(repeat('55', 32), 'hex'),
        decode(repeat('66', 32), 'hex'),
        ${JSON.stringify({
          contactId,
          legalHoldIds: [],
          siteIds: [],
          projectIds: [],
          profileIds: [],
          jobIds: [],
          revisionIds: [],
          requirementIds: [],
          snapshotIds: [],
          receiptIds: [],
          offerIds: [],
          offerVariantIds: [],
          offerVariantRevisionIds: [],
          offerVariantSectionIds: [],
          offerBomLineIds: [],
        })}::jsonb,
        now() - interval '1 day', now()
      )
    `);
  },
  site: async (tx, wsId) => {
    await tx.execute(sql`insert into site (workspace_id, city) values (${wsId}::uuid, 'fixture')`);
  },
  project: async (tx, wsId) => {
    await fixtureProjectGraph(tx, wsId);
  },
  inbound_receipt: async (tx, wsId) => {
    await fixtureReceipt(tx, wsId);
  },
  calculator_snapshot: async (tx, wsId) => {
    await fixtureSnapshot(tx, wsId);
  },
  project_requirement: async (tx, wsId) => {
    const { snapshotId, projectId } = await fixtureSnapshot(tx, wsId);
    await tx.execute(sql`
      insert into project_requirement (
        workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${wsId}::uuid, ${projectId}::uuid, 1,
        'project-requirements.rechner.v1', ${snapshotId}::uuid,
        ${JSON.stringify(fixtureRequirements)}::jsonb
      )
    `);
  },
  site_energy_profile: async (tx, wsId) => {
    await fixtureEnergyGraph(tx, wsId);
  },
  project_calculation_job: async (tx, wsId) => {
    await fixtureCalculationJob(tx, wsId);
  },
  project_calculation_revision: async (tx, wsId) => {
    const graph = await fixtureCalculationJob(tx, wsId);
    const leaseToken = randomUUID();
    const inputSnapshot = {
      contractVersion: "planning-calculation.v1",
      canonicalizationVersion: "planning-jcs.v1",
      bindings: {
        workspaceId: wsId,
        projectId: graph.projectId,
        siteId: graph.siteId,
      },
    };
    const providerSnapshot = {
      provider: "pvgis",
      apiVersion: "5_3",
      recipeVersion: "pvgis-5.3-sarah3-2020.v1",
    };
    await tx.execute(sql`
      update project_calculation_job
      set state = 'running', attempt_count = 1, started_at = now(),
          lease_token = ${leaseToken}::uuid,
          lease_expires_at = now() + interval '5 minutes',
          input_sha256 = decode(repeat('33', 32), 'hex'),
          input_snapshot = ${JSON.stringify(inputSnapshot)}::jsonb,
          provider_snapshot = ${JSON.stringify(providerSnapshot)}::jsonb
      where workspace_id = ${wsId}::uuid and id = ${graph.jobId}::uuid
    `);
    const resultId = randomUUID();
    const result = {
      contractVersion: "planning-calculation.v1",
      model: {
        id: "wmee-solar",
        version: "1.0.0",
        sourceRevision: "a".repeat(40),
      },
      inputSha256: "33".repeat(32),
      resultSha256: "44".repeat(32),
      quality: "server_reproduced_estimate",
      validationStatus: "not_f4_reference_validated",
    };
    await tx.execute(sql`
      insert into project_calculation_revision (
        id, workspace_id, project_id, site_id, revision, job_id,
        address_revision, pin_confirmed_address_revision, profile_id,
        profile_revision, confirmed_profile_revision,
        confirmed_address_revision, requirement_id, requirement_revision,
        source_snapshot_id, contract_version, model_id, model_version,
        source_revision, defaults_version, quality, validation_status,
        input_sha256, result_sha256, input_snapshot, provider_snapshot,
        result, created_by
      ) values (
        ${resultId}::uuid, ${wsId}::uuid, ${graph.projectId}::uuid,
        ${graph.siteId}::uuid, 1, ${graph.jobId}::uuid, 1, 1,
        ${graph.profileId}::uuid, 1, 1, 1, ${graph.requirementId}::uuid, 1,
        ${graph.snapshotId}::uuid, 'planning-calculation.v1', 'wmee-solar',
        '1.0.0', ${"a".repeat(40)}, 'wmee-planning-defaults.v1',
        'server_reproduced_estimate', 'not_f4_reference_validated',
        decode(repeat('33', 32), 'hex'), decode(repeat('44', 32), 'hex'),
        ${JSON.stringify(inputSnapshot)}::jsonb,
        ${JSON.stringify(providerSnapshot)}::jsonb,
        ${JSON.stringify(result)}::jsonb, ${graph.actorId}::uuid
      )
    `);
  },
  catalog_component: fixtureCatalogGraph,
  catalog_component_revision: fixtureCatalogGraph,
  project_catalog_resolution: fixtureCatalogGraph,
  project_catalog_resolution_line: fixtureCatalogGraph,
  offer: fixtureOfferGraph,
  offer_bom_line: fixtureOfferGraph,
  offer_mutation_rate_window: fixtureOfferGraph,
  offer_number_series: fixtureOfferGraph,
  offer_variant: fixtureOfferGraph,
  offer_variant_revision: fixtureOfferGraph,
  offer_variant_section: fixtureOfferGraph,
};

// ═══════════════════════════════════════════════════════════════════════
// Cross-Write-Test (Codex-Review #3): dieselbe Factory wird mit einem FREMDEN
// Workspace-Parameter in einer Transaktion des EIGENEN Workspace aufgerufen —
// der Insert MUSS an der with-check-Klausel scheitern.
//
// Für die meisten Tabellen leistet die normale Factory das schon (sie schreibt
// workspace_id = <fremd>). `workspace` selbst hat keine eigene Factory (die
// Zeile legt das Suite-Setup an), deshalb hier ein expliziter Fall: eine
// FRISCHE UUID (weder A noch B). Eine bereits existierende fremde ID würde am
// Primary Key scheitern und den Test vacuum-grün machen — nur mit einer
// frischen UUID kann AUSSCHLIESSLICH die RLS-with-check-Klausel greifen.
// ═══════════════════════════════════════════════════════════════════════
export const crossWriteOverrides: Record<string, (tx: TenantTx) => Promise<void>> = {
  workspace: async (tx) => {
    await tx.execute(sql`insert into workspace (id, name) values (${randomUUID()}::uuid, 'cross-write')`);
  },
  project: async (tx) => {
    await tx.execute(sql`
      insert into project (
        workspace_id, contact_id, site_id, kanban_board_id,
        kanban_column_id, name, source_key
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'Cross Write', 'fixture'
      )
    `);
  },
  kanban_board: async (tx) => {
    await tx.execute(sql`
      insert into kanban_board (workspace_id, name, scope, is_default)
      values (${randomUUID()}::uuid, 'Cross Write', 'residential', false)
    `);
  },
  kanban_column: async (tx) => {
    await tx.execute(sql`
      insert into kanban_column (
        workspace_id, board_id, name, column_type, position, color, is_intake
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        'Cross Write', 'lead', 99, 'neutral', false
      )
    `);
  },
  inbound_receipt: async (tx) => {
    await tx.execute(sql`
      insert into inbound_receipt (
        workspace_id, source_key, submission_id, contract_version, body_sha256,
        auth_key_id, signed_at, submitted_at, producer_application,
        producer_git_revision, producer_environment, calculator_engine,
        acquisition, privacy_purpose, privacy_legal_basis,
        privacy_notice_version, privacy_notice_url, contact_resolution,
        contact_id, site_id, project_id
      ) values (
        ${randomUUID()}::uuid, 'wmee-rechner-v3', ${randomUUID()}::uuid,
        'rechner-intake.v1', decode(repeat('00', 32), 'hex'), 'fixture-key',
        now(), now(), 'wmee-rechner-v3', ${"0".repeat(40)}, 'development',
        'wmee-solar.v1', '{}'::jsonb, 'offer_request',
        'art_6_1_b_precontractual', 'fixture', 'https://example.test/privacy',
        'created', ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid
      )
    `);
  },
  calculator_snapshot: async (tx) => {
    const snapshot = {
      schemaVersion: "wmee-solar-snapshot.v1",
      calculatedAt: "2026-08-29T00:00:00.000Z",
      branch: "new_installation",
      questionnaireVariant: "short",
      resultIntegrity: "client_reported_unverified",
      inputs: {},
      provenance: { investment: "market_estimate" },
      result: { mode: "new_installation" },
    };
    await tx.execute(sql`
      insert into calculator_snapshot (
        workspace_id, receipt_id, project_id, schema_version,
        calculator_engine, result_integrity, investment_source, calculated_at,
        snapshot
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        'wmee-solar-snapshot.v1', 'wmee-solar.v1',
        'client_reported_unverified', 'market_estimate', now(),
        ${JSON.stringify(snapshot)}::jsonb
      )
    `);
  },
  project_requirement: async (tx) => {
    await tx.execute(sql`
      insert into project_requirement (
        workspace_id, project_id, revision, schema_version,
        source_snapshot_id, requirements
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1,
        'project-requirements.rechner.v1', ${randomUUID()}::uuid,
        ${JSON.stringify(fixtureRequirements)}::jsonb
      )
    `);
  },
  offer: async (tx) => {
    await tx.execute(sql`
      insert into offer (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  offer_bom_line: async (tx) => {
    await tx.execute(sql`
      insert into offer_bom_line (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  offer_mutation_rate_window: async (tx) => {
    await tx.execute(sql`
      insert into offer_mutation_rate_window (
        workspace_id, scope, actor_id, window_start, attempts
      ) values (
        ${randomUUID()}::uuid, 'actor', ${randomUUID()}::uuid,
        timestamptz '2026-08-30 12:00:00+00', 1
      )
    `);
  },
  offer_number_series: async (tx) => {
    await tx.execute(sql`
      insert into offer_number_series (workspace_id, series_year)
      values (${randomUUID()}::uuid, 2026)
    `);
  },
  offer_variant: async (tx) => {
    await tx.execute(sql`
      insert into offer_variant (
        workspace_id, offer_id, ordinal, current_revision, name, created_by
      ) values (
        ${randomUUID()}::uuid, ${randomUUID()}::uuid, 1, 1,
        'Cross Write', ${randomUUID()}::uuid
      )
    `);
  },
  offer_variant_revision: async (tx) => {
    await tx.execute(sql`
      insert into offer_variant_revision (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
  offer_variant_section: async (tx) => {
    await tx.execute(sql`
      insert into offer_variant_section (workspace_id)
      values (${randomUUID()}::uuid)
    `);
  },
};

// Globale Tabellen ohne workspace_id — jede Ausnahme ist hier begründet:
export const TENANT_EXEMPT = new Set<string>([
  // globale Identität, EIGENE membership-basierte RLS (Migration 0002), kein
  // workspace_id — von der generischen workspace_id-Suite ausgenommen, durch
  // tests/db/rls.test.ts abgedeckt
  "user_identity",
  // Migrations-Buchhaltung. Lebt tatsächlich im Schema "drizzle", nicht
  // "public" (drizzle-orm-Default), taucht in der public-Tabellenliste der
  // Suite also nie auf — der Eintrag ist harmlose, dokumentierende
  // Absicherung falls sich das je ändert.
  "__drizzle_migrations",
  // Globale, zweispaltige und WORM-geschützte ID-Route für
  // replay_erasure_tombstone(uuid). Sie enthält keine Fachdaten und bewusst
  // keine workspace_id-Spalte: Erst der Definer-Lookup setzt den Tenant-
  // Kontext, bevor der neunspaltige FORCE-RLS-Tombstone gelesen wird.
  "erasure_operation_locator",
]);

// ═══════════════════════════════════════════════════════════════════════
// EXAKTE Auth-Allowlist statt Präfix-Match (Codex-Review #4).
//
// Vorher stand hier TENANT_EXEMPT_PREFIXES = ["auth_", …]. Beim Doppeldefekt
// war das vakuum-grün: eine echte Mandantentabelle namens
// `auth_workspace_invitation`, bei der versehentlich auch workspace_id fehlt,
// wurde als Auth-Tabelle exemptiert UND erfüllte den Wächter anschließend
// gerade WEGEN der fehlenden Spalte. Mit exakten Namen ist jede unbekannte
// auth_*-Tabelle automatisch ein Suite-Fehler.
//
// Die Liste MUSS mit den modelName-Angaben in lib/auth.ts übereinstimmen.
// auth_rate_limit kommt aus rateLimit.modelName (Codex-Review #21).
//
// pg-boss steht bewusst NICHT hier: es legt seine Tabellen in einem EIGENEN
// Schema ("pgboss") an, nicht in "public" — die Suite scannt nur "public" und
// sieht sie deshalb ohnehin nie.
// ═══════════════════════════════════════════════════════════════════════
export const TENANT_EXEMPT_AUTH = new Set<string>([
  "auth_user",
  "auth_session",
  "auth_account",
  "auth_verification",
  "auth_rate_limit",
]);

// Regel 1 (UNIQUE (workspace_id, id)): existiert, damit ein
// zusammengesetzter FK auf die Tabelle zeigen kann. Append-only-Protokolle
// sind Blätter im Referenzgraph — auf sie zeigt nie ein FK.
export const COMPOSITE_KEY_EXEMPT = new Set<string>([
  "domain_events",
  "audit_log",
  // WORM-Blatt mit eigener operation_id-Identität; kein FK darf darauf zeigen.
  "erasure_tombstone",
]);

// Regel 3 (FK workspace_id -> workspace.id): koppelt die Löschbarkeit des
// Workspace an die der Zeile. Bei append-only-Protokollen (drizzle/0004,
// drizzle/0005 sperren DELETE und TRUNCATE) entstünde ein Workspace, der
// nicht mehr löschbar ist, ohne legalen Ausweg.
export const WORKSPACE_FK_EXEMPT = new Set<string>(["domain_events", "audit_log"]);

// ═══════════════════════════════════════════════════════════════════════
// Materialisierte Views (Codex-Review #5).
//
// Eine Matview speichert Cross-Tenant-Ergebnisse PHYSISCH und erbt die RLS
// ihrer Basistabellen NICHT. Die Architektur sieht materialisierte
// Reporting-Views vor — solange keine ein explizit tenantgeschütztes
// Cache-Muster mitbringt (eigener Schutznachweis + Eintrag hier), ist jede
// Matview in "public" ein Suite-Fehler.
// ═══════════════════════════════════════════════════════════════════════
export const MATVIEW_ALLOWLIST = new Set<string>([]);

export function isExempt(name: string): boolean {
  return TENANT_EXEMPT.has(name) || TENANT_EXEMPT_AUTH.has(name);
}
