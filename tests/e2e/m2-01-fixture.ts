import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { withTenantOn } from "../../lib/db/tenant";
import type { TenantTx } from "../../lib/db/types";
import {
  CALCULATION_CANONICALIZATION_VERSION,
  canonicalizeCalculationJson,
  PLANNING_CALCULATION_CONTRACT_VERSION,
  PLANNING_CALCULATION_SCHEMA_SHA256,
  type PlanningCalculationRequestV1,
} from "../../lib/integrations/calculation/contract";
import { calculatePlanningEstimate } from "../../lib/integrations/calculation/engine";
import {
  PLANNING_DEFAULTS_VERSION,
  PLANNING_MODEL_SOURCE_REVISION,
  PLANNING_PROVIDER_RECIPE_VERSION,
  PLANNING_RESERVATION_VERSION,
} from "../../lib/integrations/calculation/versions";
import {
  CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
  CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
  RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
  type CatalogComponentCreateCommandV1,
  type CatalogComponentRevisionV1,
} from "../../lib/integrations/catalog/contract";
import type { ServiceCtx } from "../../lib/permissions";
import {
  activateCatalogComponent,
  createCatalogComponent,
  resolveProjectCatalog,
  reviseCatalogComponentPricing,
} from "../../modules/catalog";

export const M2_01_E2E_CONTACT = "Erika M2-01 Browser";
export const M2_01_E2E_ADDRESS = "Testweg 7, 69168 Dielheim";

type ProductType = "module" | "inverter" | "battery" | "wallbox";

export type M201ProductIds = Record<ProductType, string>;

export type M201Seed = {
  projectId: string;
  products: M201ProductIds;
};

export type M201RuntimeState = {
  databaseUrl: string;
  editorEmail: string;
  editorIdentityId: string;
  m201BatteryId: string;
  m201InverterId: string;
  m201ModuleId: string;
  m201ProjectId: string;
  m201WallboxId: string;
  serverLogPath: string;
  workspaceId: string;
};

export type M201OfferIdentity = {
  offerId: string;
  variantId: string;
};

export type M201RevisionEvidence = {
  resolutionRevision: number;
  revision: number;
  snapshotSha256: string;
  snapshotText: string;
};

export type M201RedactedEditor = {
  email: string;
  identityId: string;
};

export type M201RedactedViewer = M201RedactedEditor;

const GOLDEN_REQUEST = JSON.parse(readFileSync(
  resolve(process.cwd(), "contracts/examples/planning-calculation.v1.new.request.json"),
  "utf8",
)) as PlanningCalculationRequestV1;

const PRODUCT_PRICES: Record<
  ProductType,
  { purchasePriceNetCents: number; salesPriceNetCents: number }
> = {
  module: { purchasePriceNetCents: 15_000, salesPriceNetCents: 25_000 },
  inverter: { purchasePriceNetCents: 100_000, salesPriceNetCents: 150_000 },
  battery: { purchasePriceNetCents: 250_000, salesPriceNetCents: 400_000 },
  wallbox: { purchasePriceNetCents: 60_000, salesPriceNetCents: 100_000 },
};

function editorContext(state: Pick<M201RuntimeState, "editorIdentityId" | "workspaceId">): ServiceCtx {
  return {
    workspaceId: state.workspaceId,
    actor: state.editorIdentityId,
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

async function asEditor<T>(
  tx: TenantTx,
  state: Pick<M201RuntimeState, "editorIdentityId" | "workspaceId">,
  callback: (ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  await tx.execute(sql`select set_config('app.actor_id', ${state.editorIdentityId}, true)`);
  return callback(editorContext(state));
}

function productCommand(type: ProductType, index: number): CatalogComponentCreateCommandV1 {
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
  const prices = PRODUCT_PRICES[type];
  return {
    schemaVersion: CATALOG_COMPONENT_CREATE_COMMAND_VERSION,
    internalSku: `E2E-M201-${type.toUpperCase()}-${index}`,
    componentType: type,
    presentation: {
      displayName: `Synthetische M2-01 ${type}-Komponente`,
      manufacturer: "WMEE Testwerk",
      model: `Browser-Fixture ${index}`,
      unit: "piece",
      keyPoints: ["Ausschließlich synthetische Browser-Testdaten"],
      image: null,
      datasheet: null,
    },
    technicalData,
    commercial: {
      currency: "EUR",
      basis: "net",
      purchasePriceNetCents: prices.purchasePriceNetCents,
      salesPriceNetCents: prices.salesPriceNetCents,
      purchaseProvenance: {
        sourceKind: "supplier_price_list",
        reference: `PRIVATE-E2E-M201-EK-${type}-${index}`,
        observedOn: "2026-08-30",
        rightsBasis: "supplier_authorized",
        sourceDocumentSha256: null,
      },
      salesProvenance: {
        sourceKind: "workspace_pricing",
        reference: `SYNTHETIC-E2E-M201-VK-${type}-${index}`,
        observedOn: "2026-08-30",
        rightsBasis: "workspace_owned",
        sourceDocumentSha256: null,
      },
    },
    technicalProvenance: {
      sourceKind: "workspace_manual",
      reference: `SYNTHETIC-E2E-M201-TECH-${type}-${index}`,
      observedOn: "2026-08-30",
      rightsBasis: "workspace_owned",
      sourceDocumentSha256: null,
    },
  };
}

async function insertPlanningProject(
  pool: Pool,
  state: Pick<M201RuntimeState, "editorIdentityId" | "workspaceId">,
): Promise<string> {
  const ids = {
    calculationRevisionId: randomUUID(),
    contactId: randomUUID(),
    jobId: randomUUID(),
    profileId: randomUUID(),
    projectId: randomUUID(),
    receiptId: randomUUID(),
    requirementId: randomUUID(),
    siteId: randomUUID(),
    snapshotId: randomUUID(),
  };
  const request = structuredClone(GOLDEN_REQUEST);
  request.bindings = {
    ...request.bindings,
    workspaceId: state.workspaceId,
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
        workspaceId: state.workspaceId,
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

  await withTenantOn(pool, state.workspaceId, async (tx) => {
    await tx.execute(sql`select set_config('app.actor_id', ${state.editorIdentityId}, true)`);
    await tx.execute(sql`
      insert into contact (
        id, workspace_id, display_name, email_primary, email_normalized
      ) values (
        ${ids.contactId}::uuid, ${state.workspaceId}::uuid,
        ${M2_01_E2E_CONTACT}, 'm201-browser@example.test',
        'm201-browser@example.test'
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
        ${ids.siteId}::uuid, ${state.workspaceId}::uuid,
        ${ids.contactId}::uuid, 'Synthetischer M2-01 Standort',
        ${M2_01_E2E_ADDRESS}, decode(repeat('ca', 32), 'hex'), 1,
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
      select ${ids.projectId}::uuid, ${state.workspaceId}::uuid,
             ${ids.contactId}::uuid, ${ids.siteId}::uuid,
             board.id, intake.id, 'Synthetisches M2-01 Angebotsprojekt',
             'wmee-rechner-v3'
        from kanban_board board
        join kanban_column intake
          on intake.workspace_id = board.workspace_id
         and intake.board_id = board.id
         and intake.is_intake = true
       where board.workspace_id = ${state.workspaceId}::uuid
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
        ${ids.receiptId}::uuid, ${state.workspaceId}::uuid, 'wmee-rechner-v3',
        ${randomUUID()}::uuid, 'rechner-intake.v1', decode(repeat('20', 32), 'hex'),
        'm201-e2e-fixture', now(), now(), now(), 'wmee-rechner-v3',
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
        ${ids.snapshotId}::uuid, ${state.workspaceId}::uuid,
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
        ${ids.requirementId}::uuid, ${state.workspaceId}::uuid,
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
        ${ids.profileId}::uuid, ${state.workspaceId}::uuid, ${ids.siteId}::uuid,
        1, 'site-energy-profile.v1', 'consumption', 'rechner_snapshot',
        ${ids.snapshotId}::uuid, ${ids.projectId}::uuid, 1,
        ${JSON.stringify(request.energyProfile)}::jsonb,
        decode(${profileSha256}, 'hex'), 1, 1, ${state.editorIdentityId}::uuid, now()
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
        ${ids.jobId}::uuid, ${state.workspaceId}::uuid, ${ids.projectId}::uuid,
        ${ids.siteId}::uuid, 1, 1, ${ids.profileId}::uuid, 1, 1, 1,
        ${ids.requirementId}::uuid, 1, ${ids.snapshotId}::uuid,
        decode(${reservationSha256}, 'hex'), ${PLANNING_PROVIDER_RECIPE_VERSION},
        ${PLANNING_CALCULATION_CONTRACT_VERSION}, ${result.model.id},
        ${result.model.version}, ${result.model.sourceRevision},
        ${PLANNING_DEFAULTS_VERSION}, 'running', 1, now(), ${randomUUID()}::uuid,
        now() + interval '15 minutes', decode(${result.inputSha256}, 'hex'),
        ${JSON.stringify(request)}::jsonb, ${JSON.stringify(request.yieldSnapshots)}::jsonb,
        ${state.editorIdentityId}::uuid, now()
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
        ${ids.calculationRevisionId}::uuid, ${state.workspaceId}::uuid,
        ${ids.projectId}::uuid, ${ids.siteId}::uuid, 1, ${ids.jobId}::uuid,
        1, 1, ${ids.profileId}::uuid, 1, 1, 1, ${ids.requirementId}::uuid, 1,
        ${ids.snapshotId}::uuid, ${PLANNING_CALCULATION_CONTRACT_VERSION},
        ${result.model.id}, ${result.model.version}, ${result.model.sourceRevision},
        ${PLANNING_DEFAULTS_VERSION}, ${result.quality}, ${result.validationStatus},
        decode(${result.inputSha256}, 'hex'), decode(${result.resultSha256}, 'hex'),
        ${JSON.stringify(request)}::jsonb, ${JSON.stringify(request.yieldSnapshots)}::jsonb,
        ${JSON.stringify(result)}::jsonb, ${state.editorIdentityId}::uuid
      )
    `);
    await tx.execute(sql`
      update project_calculation_job
         set state = 'succeeded', lease_token = null, lease_expires_at = null,
             finished_at = now(), result_revision_id = ${ids.calculationRevisionId}::uuid
       where workspace_id = ${state.workspaceId}::uuid
         and id = ${ids.jobId}::uuid
    `);
  });
  return ids.projectId;
}

async function createActiveProducts(
  pool: Pool,
  state: Pick<M201RuntimeState, "editorIdentityId" | "workspaceId">,
): Promise<M201ProductIds> {
  const products = {} as M201ProductIds;
  for (const [index, type] of (
    ["module", "inverter", "battery", "wallbox"] as const
  ).entries()) {
    const created = await withTenantOn(pool, state.workspaceId, (tx) =>
      asEditor(tx, state, (ctx) => createCatalogComponent(tx, ctx, productCommand(type, index + 1))));
    await withTenantOn(pool, state.workspaceId, (tx) =>
      asEditor(tx, state, (ctx) => activateCatalogComponent(tx, ctx, {
        componentId: created.componentId,
        expectedRevision: 1,
        expectedStatus: "draft",
      })));
    products[type] = created.componentId;
  }
  return products;
}

async function resolveInitialCatalog(
  pool: Pool,
  state: Pick<M201RuntimeState, "editorIdentityId" | "workspaceId">,
  projectId: string,
  products: M201ProductIds,
): Promise<void> {
  await withTenantOn(pool, state.workspaceId, (tx) =>
    asEditor(tx, state, (ctx) => resolveProjectCatalog(tx, ctx, {
      schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
      projectId,
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
    })));
}

export async function seedM201ReadyProject(
  databaseUrl: string,
  state: Pick<M201RuntimeState, "editorIdentityId" | "workspaceId">,
): Promise<M201Seed> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const projectId = await insertPlanningProject(pool, state);
    const products = await createActiveProducts(pool, state);
    await resolveInitialCatalog(pool, state, projectId, products);
    return { projectId, products };
  } finally {
    await pool.end();
  }
}

export async function withM201Database<T>(
  state: M201RuntimeState,
  callback: (tx: TenantTx, ctx: ServiceCtx) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: state.databaseUrl, max: 1 });
  try {
    return await withTenantOn(pool, state.workspaceId, (tx) =>
      asEditor(tx, state, (ctx) => callback(tx, ctx)));
  } finally {
    await pool.end();
  }
}

export async function readM201Offer(state: M201RuntimeState): Promise<M201OfferIdentity> {
  return withM201Database(state, async (tx) => {
    const result = await tx.execute<M201OfferIdentity & { [key: string]: unknown }>(sql`
      select offer.id as "offerId", variant.id as "variantId"
        from offer
        join offer_variant variant
          on variant.workspace_id = offer.workspace_id
         and variant.offer_id = offer.id
         and variant.ordinal = 1
       where offer.workspace_id = ${state.workspaceId}::uuid
         and offer.project_id = ${state.m201ProjectId}::uuid
       limit 1
    `);
    const offer = result.rows[0];
    if (!offer) {
      throw new Error("M2-01-E2E-Angebot wurde nicht über die Browser-Action erzeugt.");
    }
    return offer;
  });
}

export async function readM201RevisionEvidence(
  state: M201RuntimeState,
  offerId: string,
  variantId: string,
): Promise<M201RevisionEvidence> {
  return withM201Database(state, async (tx) => {
    const result = await tx.execute<M201RevisionEvidence & { [key: string]: unknown }>(sql`
      select revision, resolution_revision as "resolutionRevision",
             revision_snapshot::text as "snapshotText",
             encode(snapshot_sha256, 'hex') as "snapshotSha256"
        from offer_variant_revision
       where workspace_id = ${state.workspaceId}::uuid
         and offer_id = ${offerId}::uuid
         and variant_id = ${variantId}::uuid
       order by revision desc
       limit 1
    `);
    const row = result.rows[0];
    if (!row) throw new Error("M2-01-E2E-Variantenrevision fehlt.");
    return row;
  });
}

export async function exhaustM201ActorMutationWindow(
  state: M201RuntimeState,
): Promise<void> {
  await withM201Database(state, async (tx) => {
    await tx.execute(sql`
      delete from offer_mutation_rate_window
       where workspace_id = ${state.workspaceId}::uuid
         and scope = 'actor'
         and actor_id = ${state.editorIdentityId}::uuid
         and window_start = date_bin(
           interval '15 minutes', clock_timestamp(),
           timestamptz '1970-01-01 00:00:00+00'
         )
    `);
    await tx.execute(sql`
      insert into offer_mutation_rate_window (
        workspace_id, scope, actor_id, window_start, attempts
      ) values (
        ${state.workspaceId}::uuid, 'actor', ${state.editorIdentityId}::uuid,
        date_bin(
          interval '15 minutes', clock_timestamp(),
          timestamptz '1970-01-01 00:00:00+00'
        ),
        120
      )
    `);
  });
}

export async function clearM201ActorMutationWindow(
  state: M201RuntimeState,
): Promise<void> {
  await withM201Database(state, (tx) => tx.execute(sql`
    delete from offer_mutation_rate_window
     where workspace_id = ${state.workspaceId}::uuid
       and scope = 'actor'
       and actor_id = ${state.editorIdentityId}::uuid
  `).then(() => undefined));
}

export async function expireM201IdentitySessions(
  state: M201RuntimeState,
  email = state.editorEmail,
): Promise<void> {
  const pool = new Pool({ connectionString: state.databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `delete from auth_session as session
        using auth_user as identity
        where session.user_id = identity.id
          and lower(identity.email) = lower($1)`,
      [email],
    );
    if (result.rowCount === 0) {
      throw new Error("Für die synthetische M2-01-Identität wurde keine aktive Session gefunden.");
    }
  } finally {
    await pool.end();
  }
}

export async function createM201RedactedEditor(
  state: M201RuntimeState,
): Promise<M201RedactedEditor> {
  const identityId = randomUUID();
  const email = `m2-01-redacted-${randomUUID().slice(0, 8)}@example.test`;
  const pool = new Pool({ connectionString: state.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.actor_id', '', true), set_config('app.workspace_id', $1, true)",
      [state.workspaceId],
    );
    await client.query(
      "insert into user_identity (id, email) values ($1::uuid, $2)",
      [identityId, email],
    );
    await client.query(
      `insert into membership (workspace_id, user_id, role, capabilities)
       values ($1::uuid, $2::uuid, 'editor',
         '{"edit_prices":true,"discounts":true}'::jsonb)`,
      [state.workspaceId, identityId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
  return { email, identityId };
}

export async function createM201RedactedViewer(
  state: M201RuntimeState,
): Promise<M201RedactedViewer> {
  const identityId = randomUUID();
  const email = `m2-01-viewer-${randomUUID().slice(0, 8)}@example.test`;
  const pool = new Pool({ connectionString: state.databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      "select set_config('app.actor_id', '', true), set_config('app.workspace_id', $1, true)",
      [state.workspaceId],
    );
    await client.query(
      "insert into user_identity (id, email) values ($1::uuid, $2)",
      [identityId, email],
    );
    await client.query(
      `insert into membership (workspace_id, user_id, role)
       values ($1::uuid, $2::uuid, 'viewer')`,
      [state.workspaceId, identityId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
  return { email, identityId };
}

export async function seedM201AdditionalReadyProject(
  state: M201RuntimeState,
): Promise<string> {
  const pool = new Pool({ connectionString: state.databaseUrl, max: 1 });
  try {
    const projectId = await insertPlanningProject(pool, state);
    await withTenantOn(pool, state.workspaceId, async (tx) => {
      await asEditor(tx, state, async (ctx) => {
        const componentIds = [
          state.m201ModuleId,
          state.m201InverterId,
          state.m201BatteryId,
          state.m201WallboxId,
        ];
        const revisions = await tx.execute<{
          id: string;
          current_revision: number;
          status: string;
          [key: string]: unknown;
        }>(sql`
          select id, current_revision, status
           from catalog_component
           where workspace_id = ${state.workspaceId}::uuid
             and id in (
               ${state.m201ModuleId}::uuid,
               ${state.m201InverterId}::uuid,
               ${state.m201BatteryId}::uuid,
               ${state.m201WallboxId}::uuid
             )
        `);
        const byId = new Map(revisions.rows.map((row) => [row.id, row]));
        if (componentIds.some((id) => byId.get(id)?.status !== "active")) {
          throw new Error("Zusätzliche M2-01-Visual-Fixture braucht vier aktive Komponenten.");
        }
        await resolveProjectCatalog(tx, ctx, {
          schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
          projectId,
          expectedResolutionRevision: 0,
          expectedRequirementRevision: 1,
          expectedCalculationRevision: 1,
          selections: [
            {
              componentId: state.m201ModuleId,
              expectedComponentRevision: byId.get(state.m201ModuleId)!.current_revision,
              quantity: 26,
            },
            {
              componentId: state.m201InverterId,
              expectedComponentRevision: byId.get(state.m201InverterId)!.current_revision,
              quantity: 1,
            },
            {
              componentId: state.m201BatteryId,
              expectedComponentRevision: byId.get(state.m201BatteryId)!.current_revision,
              quantity: 1,
            },
            {
              componentId: state.m201WallboxId,
              expectedComponentRevision: byId.get(state.m201WallboxId)!.current_revision,
              quantity: 1,
            },
          ],
          acknowledgements: ["cross_component_compatibility_unverified"],
        });
      });
    });
    return projectId;
  } finally {
    await pool.end();
  }
}

export async function advanceM201Resolution(state: M201RuntimeState): Promise<void> {
  await withM201Database(state, async (tx, ctx) => {
    const component = await tx.execute<{
      current_revision: number;
      revision_snapshot: CatalogComponentRevisionV1;
      status: string;
      [key: string]: unknown;
    }>(sql`
      select component.current_revision, component.status,
             revision.revision_snapshot
        from catalog_component component
        join catalog_component_revision revision
          on revision.workspace_id = component.workspace_id
         and revision.component_id = component.id
         and revision.revision = component.current_revision
       where component.workspace_id = ${state.workspaceId}::uuid
         and component.id = ${state.m201BatteryId}::uuid
       for update of component
    `);
    const battery = component.rows[0];
    if (!battery?.revision_snapshot.commercial) {
      throw new Error("M2-01-E2E-Batteriepreis fehlt.");
    }
    if (battery.current_revision === 1) {
      await reviseCatalogComponentPricing(tx, ctx, {
        schemaVersion: CATALOG_COMPONENT_PRICING_COMMAND_VERSION,
        componentId: state.m201BatteryId,
        expectedRevision: 1,
        commercial: {
          ...battery.revision_snapshot.commercial,
          salesPriceNetCents:
            battery.revision_snapshot.commercial.salesPriceNetCents + 50_000,
          salesProvenance: {
            sourceKind: "workspace_pricing",
            reference: "SYNTHETIC-E2E-M201-VK-battery-REV-2",
            observedOn: "2026-08-30",
            rightsBasis: "workspace_owned",
            sourceDocumentSha256: null,
          },
        },
      });
    }

    const refreshed = await tx.execute<{
      current_revision: number;
      status: "active" | "archived" | "draft";
      [key: string]: unknown;
    }>(sql`
      select current_revision, status
        from catalog_component
       where workspace_id = ${state.workspaceId}::uuid
         and id = ${state.m201BatteryId}::uuid
       for update
    `);
    const currentBattery = refreshed.rows[0];
    if (!currentBattery) throw new Error("M2-01-E2E-Batterie fehlt.");
    if (currentBattery.status === "draft") {
      await activateCatalogComponent(tx, ctx, {
        componentId: state.m201BatteryId,
        expectedRevision: currentBattery.current_revision,
        expectedStatus: "draft",
      });
    }

    const currentResolution = await tx.execute<{
      revision: number;
      [key: string]: unknown;
    }>(sql`
      select revision
        from project_catalog_resolution
       where workspace_id = ${state.workspaceId}::uuid
         and project_id = ${state.m201ProjectId}::uuid
       order by revision desc
       limit 1
    `);
    const resolutionRevision = currentResolution.rows[0]?.revision;
    if (resolutionRevision === undefined) {
      throw new Error("M2-01-E2E-Projektauflösung fehlt.");
    }
    if (resolutionRevision >= 2) return;
    await resolveProjectCatalog(tx, ctx, {
      schemaVersion: RESOLVE_PROJECT_CATALOG_COMMAND_VERSION,
      projectId: state.m201ProjectId,
      expectedResolutionRevision: resolutionRevision,
      expectedRequirementRevision: 1,
      expectedCalculationRevision: 1,
      selections: [
        { componentId: state.m201ModuleId, expectedComponentRevision: 1, quantity: 26 },
        { componentId: state.m201InverterId, expectedComponentRevision: 1, quantity: 1 },
        {
          componentId: state.m201BatteryId,
          expectedComponentRevision: currentBattery.current_revision,
          quantity: 1,
        },
        { componentId: state.m201WallboxId, expectedComponentRevision: 1, quantity: 1 },
      ],
      acknowledgements: ["cross_component_compatibility_unverified"],
    });
  });
}
